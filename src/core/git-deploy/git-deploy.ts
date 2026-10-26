/**
 * Git Deploy Service
 *
 * Orchestrates deploying applications from GitHub repositories.
 * Clones repos into the webapps directory and lets the existing
 * pipeline (detect → build → start) handle the rest.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import {
  DeployActor,
  GitDeployRequest,
  GitDeployResult,
  GitSource,
  GitTokenInfo,
} from './git-deploy.types';
import {
  gitClone,
  gitPull,
  getCommitSha,
  normalizeRepoUrl,
  extractRepoName,
  isValidGitHubUrl,
  isGitAvailable,
} from './git-client';
import { getStateManager } from '../../managers/app/state-manager';
import { getAppConfigService, getAppConfigServiceOrNull } from '../../managers/app/app-config';
import { getSecretManager } from '../../managers/secret';
import { getLogger } from '../../utils/logger';
import { pathTaken } from '../../utils/paths';
import { isValidAppName } from '../../api/middleware/validate';
import { isNameTaken, isNewNameRefused } from '../app-names';
import { tryReserve, release, reservationPrincipal } from '../deploy-reservations';
import { hasEnoughDisk, getMinFreeDiskMb } from '../../utils/disk';
import { eventBus } from '../event-bus';
import { captureBeforeRedeploy } from '../../managers/rollback';
import { admitDeploy } from '../../managers/guardrail/deploy-breaker';
import {
  checkEphemeralQuota,
  resolveTtlMinutes,
  EphemeralQuotaError,
} from '../../managers/guardrail/ephemeral';

const logger = getLogger();

const GIT_TOKEN_APP_NAME = '__drop_git_tokens';

export interface GitDeployServiceConfig {
  appsDirectory: string;
}

export class GitDeployService {
  private readonly config: GitDeployServiceConfig;
  private gitAvailable = false;
  private activeClones: Set<string> = new Set();

  constructor(config: GitDeployServiceConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    this.gitAvailable = await isGitAvailable();
    if (!this.gitAvailable) {
      logger.warn('git CLI not found - git deploy features will be unavailable', 'GIT-DEPLOY');
    } else {
      logger.info('Git deploy service initialized', 'GIT-DEPLOY');
    }
  }

  isAvailable(): boolean {
    return this.gitAvailable;
  }

  /** Check if an app is currently being cloned */
  isCloning(appName: string): boolean {
    return this.activeClones.has(appName);
  }

  /**
   * Deploy an app from a GitHub repository.
   *
   * Once the cheap refusals and guardrail admission are behind it, the name is
   * re-checked and reserved (see deploy-reservations) with no await between the
   * two: the later checks (disk, token, clone) span many, and two concurrent
   * creates of one name, from git or upload, would otherwise both pass and race
   * to land into one folder. A refusal reads as an existing app. Only this
   * call's own reservation is released.
   */
  async deploy(request: GitDeployRequest): Promise<GitDeployResult> {
    if (!this.gitAvailable) {
      throw new Error('git CLI is not available on this system');
    }

    const principal = reservationPrincipal(request.userId, request.principalId);
    let reservedName: string | undefined;
    try {
      return await this.deployReserved(request, (name) => {
        if (!tryReserve(name, principal)) return false;
        reservedName = name;
        return true;
      });
    } finally {
      if (reservedName) release(reservedName, principal);
    }
  }

  /** The new-app name rules, for a non-admin caller only (admins name things freely). */
  private nameIsTakenForCaller(
    request: GitDeployRequest,
    appName: string,
    stateManager: ReturnType<typeof getStateManager>
  ): boolean {
    if (!request.userId || request.callerIsAdmin) return false;
    return isNameTaken(appName, {
      stateManager,
      appConfigService: getAppConfigServiceOrNull() ?? undefined,
    });
  }

  private async deployReserved(
    request: GitDeployRequest,
    reserve: (name: string) => boolean
  ): Promise<GitDeployResult> {
    const repoUrl = normalizeRepoUrl(request.repoUrl);
    const branch = request.branch || 'main';
    const appName = request.name || extractRepoName(repoUrl);

    // Validate
    if (!isValidGitHubUrl(repoUrl)) {
      throw new Error(`Invalid GitHub URL: ${repoUrl}`);
    }

    // The FINAL name, whether given or derived from the URL: the shared rule,
    // which also refuses dots (`<app>.b` is a runtime slot-b instance name).
    if (!appName || !isValidAppName(appName)) {
      throw new Error(
        `Invalid app name: ${appName} (pass \`name\` to choose a different app name)`
      );
    }

    // Check for conflicts
    const stateManager = getStateManager();
    if (stateManager.hasApp(appName)) {
      throw new Error(`Application '${appName}' already exists`);
    }

    // GUARDRAIL PRE-CHECK, before the clone. The platform's gates sit at the
    // BUILD, so a refused caller could still make DROP clone an arbitrary
    // repository on every attempt — network, disk and time spent before the
    // event that would refuse it is even published. Always a new app here
    // (the conflict check above rejects existing ones), so the key is the
    // caller's shared `__new__` bucket.
    await admitDeploy(appName, true, {
      principalId: request.principalId,
      actorUserId: request.userId,
    });

    // A name that is a group, a container's, or differs only in case from an
    // existing app. Answered as an existing app is. Admins, and callers with no
    // account, name things freely. AFTER admission, as upload does, so probing
    // for names costs quota.
    if (
      await isNewNameRefused(appName, {
        callerIsAdmin: !request.userId || !!request.callerIsAdmin,
        appsDirectory: this.config.appsDirectory,
        stateManager,
        appConfigService: getAppConfigServiceOrNull() ?? undefined,
      })
    ) {
      throw new Error(`Application '${appName}' already exists`);
    }

    // Re-checked and claimed back to back, with NO await between them: nothing
    // can take the name in the gap, and a concurrent create is turned away here.
    if (
      stateManager.hasApp(appName) ||
      this.nameIsTakenForCaller(request, appName, stateManager) ||
      !reserve(appName)
    ) {
      throw new Error(`Application '${appName}' already exists`);
    }

    // Ephemeral quota, before the clone. Same reasoning as the guardrail: a
    // refusal after the clone would not undo the network, disk and time.
    if (request.ephemeral) {
      const verdict = checkEphemeralQuota(
        getAppConfigService()
          .getAllConfigs()
          .filter((c) => c.ephemeral)
          .map((c) => ({
            name: c.name,
            principalId: c.ephemeralPrincipalId,
            userId: stateManager.getApp(c.name)?.userId,
            expiresAt: c.expiresAt ?? '',
          })),
        { principalId: request.principalId, userId: request.userId },
        Date.now()
      );
      if (!verdict.allowed) throw new EphemeralQuotaError(verdict.reason ?? 'Quota exceeded');
    }

    const destPath = path.join(this.config.appsDirectory, appName);

    // A folder (or a dangling link) already holding the name is taken. Same
    // answer as an existing app, and no absolute path in it.
    if (await pathTaken(destPath)) {
      throw new Error(`Application '${appName}' already exists`);
    }

    // Preflight: ensure enough free disk space before cloning
    const disk = await hasEnoughDisk(this.config.appsDirectory);
    if (!disk.ok) {
      throw new Error(
        `Insufficient disk space to deploy: ${Math.round(disk.freeMb)} MB free, need ${getMinFreeDiskMb()} MB`
      );
    }

    // Resolve token if provided
    let token: string | undefined;
    if (request.tokenId) {
      token = await this.getTokenValue(request.tokenId);
      if (!token) {
        throw new Error(`GitHub token '${request.tokenId}' not found`);
      }
    }

    // Mark as cloning to prevent watcher from detecting mid-clone. Added only
    // now, after every await above, so the watcher is not held off the name
    // through quota and auth checks; held until the app is registered (below).
    this.activeClones.add(appName);

    // Clone
    logger.info(`Cloning ${repoUrl} (branch: ${branch}) into ${appName}`, 'GIT-DEPLOY');
    try {
      await gitClone({
        url: repoUrl,
        dest: destPath,
        branch,
        token,
        shallow: true,
      });
    } catch (err) {
      this.activeClones.delete(appName);
      // Clean up partial clone
      try {
        await fs.rm(destPath, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
      throw err;
    }

    // Read commit SHA
    let commitSha: string | undefined;
    try {
      commitSha = await getCommitSha(destPath);
    } catch {
      // non-fatal
    }

    const clonedAt = new Date().toISOString();

    const gitSource: GitSource = {
      repoUrl,
      branch,
      lastCommitSha: commitSha,
      lastClonedAt: clonedAt,
      autoRedeploy: request.autoRedeploy !== false,
      tokenId: request.tokenId,
    };

    // Register app with git source metadata and userId BEFORE the name leaves
    // activeClones (upload-deploy's order): once it does, the watcher may
    // detect a monorepo container and expand it, and a container expanded
    // without its owner would adopt unowned group children as unowned.
    let registered = false;
    try {
      // The clone took time: the name may have been taken meanwhile (an app
      // registered, a group claimed). Re-decided now, and the clone is removed
      // below as for any failed registration.
      if (stateManager.hasApp(appName) || this.nameIsTakenForCaller(request, appName, stateManager)) {
        throw new Error(`Application '${appName}' already exists`);
      }
      await stateManager.registerApp(appName, destPath);
      registered = true;
      await stateManager.updateApp(appName, {
        gitSource,
        ...(request.userId ? { userId: request.userId } : {}),
      } as Record<string, unknown>);
    } catch (err) {
      // Same cleanup as a failed clone: an app that never got its owner must
      // not be left registered, nor its tree left for the watcher to detect.
      // Only what THIS call did: the registration only if its own registerApp
      // resolved, and the tree because the clone above just created it (the
      // folder-exists refusal means nothing was there before).
      if (registered) {
        await stateManager.removeApp(appName).catch(() => undefined);
      }
      await fs.rm(destPath, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    } finally {
      // Clone complete - allow watcher to detect
      this.activeClones.delete(appName);
    }

    logger.info(`Cloned ${repoUrl} → ${appName} (${commitSha?.slice(0, 7) || 'unknown'})`, 'GIT-DEPLOY');

    // Publish the detection directly instead of waiting on the watcher: a
    // clone that writes for longer than the watcher's max-wait flush gets its
    // app:detected dropped mid-clone (isCloning guard) and never re-emitted -
    // the app would sit registered but never built until a lucky file change.
    // Same shape as the watcher's own publish; the detector resolves the type.
    // ONLY on first creation (SEC-11) — deploy() rejects an existing app name
    // above, so reaching here always means new. A redeploy goes through
    // redeploy(), which never touches this flag.
    //
    // upsertSystemConfig, NOT updateConfig — the config does not exist yet
    // here (the app:detected handler below creates it) and updateConfig
    // no-ops when it is missing, silently dropping every flag. Same defect
    // as upload-deploy.ts; see the longer note there. upsertSystemConfig
    // (not upsertConfig) because these are SYSTEM_CONFIG_FIELDS.
    if (request.agentCaller) {
      await getAppConfigService().upsertSystemConfig(appName, {
        agentCreated: true,
        path: destPath,
      });
    }
    if (request.ephemeral) {
      const ttl = resolveTtlMinutes(request.ttlMinutes);
      await getAppConfigService().upsertSystemConfig(appName, {
        ephemeral: true,
        expiresAt: new Date(Date.now() + ttl * 60_000).toISOString(),
        ephemeralPrincipalId: request.principalId,
        path: destPath,
        agentCreated: true,
      });
    }

    eventBus.publish('app:detected', {
      name: appName,
      path: destPath,
      type: undefined,
      principalId: request.principalId,
      actorUserId: request.userId,
    });

    return {
      appName,
      repoUrl,
      branch,
      commitSha,
      clonedAt,
    };
  }

  /**
   * Redeploy a git-deployed app (git pull + trigger rebuild). Not reserved:
   * two redeploys of one app (a webhook burst, a dashboard click) are the
   * platform's own `appsInProgress` dedup to sort out, as they always were, and
   * refusing them here would drop a push.
   */
  async redeploy(appName: string, actor: DeployActor = {}): Promise<GitDeployResult> {
    if (!this.gitAvailable) {
      throw new Error('git CLI is not available on this system');
    }

    const stateManager = getStateManager();
    const app = stateManager.getApp(appName);

    if (!app) {
      throw new Error(`Application '${appName}' not found`);
    }

    if (!app.gitSource) {
      throw new Error(`Application '${appName}' was not deployed from git`);
    }

    // Fail fast if the source tree no longer has a git repository. An upload
    // deploy (syncTree's prune) or a monorepo re-materialization can remove
    // the real .git while state still carries a gitSource; without this check
    // `git pull` walks UP the ancestor chain looking for a repository instead
    // of failing with a clear message.
    try {
      await fs.access(path.join(app.path, '.git'));
    } catch {
      throw new Error(`Application '${appName}' has no git repository on disk (.git is missing)`);
    }

    // GUARDRAIL + QUOTA, before the pull. A redeploy is the request an agent
    // repeats, and git pull + rebuild is not free.
    await admitDeploy(appName, false, {
      principalId: actor.principalId,
      actorUserId: actor.userId,
      automationSource: actor.automation,
    });

    // Preflight: ensure enough free disk space before pulling
    const disk = await hasEnoughDisk(app.path);
    if (!disk.ok) {
      throw new Error(
        `Insufficient disk space to redeploy: ${Math.round(disk.freeMb)} MB free, need ${getMinFreeDiskMb()} MB`
      );
    }

    const { repoUrl, branch } = app.gitSource;

    // undefined (the default, via omission) leaves the stored token
    // unchanged; null clears it; a string attaches/replaces it. Resolved once
    // and used for BOTH the pull and the final gitSource below — `app` is a
    // snapshot captured above, and updateApp REPLACES the map entry rather
    // than mutating it, so a second read of app.gitSource after this point
    // would still see the pre-redeploy value.
    const effectiveTokenId = actor.tokenId !== undefined ? actor.tokenId : app.gitSource.tokenId;

    // A CLEAR is a revocation, not a deploy outcome, so it is persisted BEFORE
    // the pull — the one deliberate asymmetry with the attach direction.
    //
    // Both directions cannot use the post-pull write: clearing a credential
    // makes the very next pull unauthenticated, so on a private repo it throws
    // and the write below never runs. The clear would be silently discarded
    // every time, which leaves NO route to detach a compromised PAT short of
    // hand-editing apps.json. The stale-snapshot trap that forced the attach
    // AFTER the pull does not apply here: there is nothing a later spread can
    // resurrect once the field is gone, and `effectiveTokenId` (null) drives
    // the post-pull write too, so the two agree.
    if (actor.tokenId === null && app.gitSource.tokenId) {
      const cleared: GitSource = { ...app.gitSource, tokenId: undefined };
      await stateManager.updateApp(appName, { gitSource: cleared } as Record<string, unknown>);
      logger.info(`Cleared the stored git credential for ${appName}`, 'GIT-DEPLOY');
    }

    // Resolve token if needed
    let token: string | undefined;
    if (effectiveTokenId) {
      token = await this.getTokenValue(effectiveTokenId);
      if (!token) {
        // Branch on PROVENANCE. An id the caller supplied on THIS request that
        // resolves to nothing is a caller error — deploy() throws for exactly
        // this condition — and warning past it returns 200 while persisting a
        // dangling reference that silently degrades every later unattended
        // webhook redeploy to unauthenticated. An INHERITED id is different:
        // the token may have been deleted since, and refusing to redeploy an
        // existing app over that is worse than trying.
        if (actor.tokenId) {
          throw new Error(`GitHub token '${actor.tokenId}' not found`);
        }
        logger.warn(`Token '${effectiveTokenId}' not found for ${appName} - trying without auth`, 'GIT-DEPLOY');
      }
    }

    logger.info(`Redeploying ${appName} from ${repoUrl} (branch: ${branch})`, 'GIT-DEPLOY');

    // Rollback snapshot of the tree that is SERVING, before it is replaced
    // (#296). Best-effort by contract: it never throws, and a skipped or
    // failed snapshot never fails the deploy — it only means this redeploy
    // cannot be rolled back, which the rollback route reports as such.
    // The snapshot includes .git, so a restore also puts HEAD back and the
    // next git redeploy fast-forwards from the restored commit.
    const snapshot = await captureBeforeRedeploy(appName);
    if (!snapshot.captured) {
      logger.info(`No rollback snapshot for ${appName}: ${snapshot.reason}`, 'GIT-DEPLOY');
    }

    // Mark as cloning for the duration of the pull only - mirrors deploy()'s
    // guard against the watcher building a half-pulled tree. Cleared before
    // the deterministic publish below, or the platform's isCloning guards
    // (platform.ts) would eat that event too.
    this.activeClones.add(appName);
    try {
      await gitPull(app.path, branch, token);
    } finally {
      this.activeClones.delete(appName);
    }

    let commitSha: string | undefined;
    try {
      commitSha = await getCommitSha(app.path);
    } catch {
      // non-fatal
    }

    const clonedAt = new Date().toISOString();

    // Built from effectiveTokenId, NOT app.gitSource.tokenId — see the note
    // above. Spreading the stale field here would silently revert an attach
    // on this success path (the defect two independent reviewers found).
    const gitSource: GitSource = {
      ...app.gitSource,
      tokenId: effectiveTokenId === null ? undefined : effectiveTokenId,
      lastCommitSha: commitSha,
      lastClonedAt: clonedAt,
    };

    await stateManager.updateApp(appName, { gitSource } as Record<string, unknown>);

    logger.info(`Redeployed ${appName} (${commitSha?.slice(0, 7) || 'unknown'})`, 'GIT-DEPLOY');

    // Publish the rebuild trigger directly instead of waiting on the watcher
    // to notice file changes: a no-change pull touches nothing on disk (the
    // watcher would never fire), and on a slow pull the watcher's mid-pull
    // flush could otherwise race this with a half-pulled tree.
    eventBus.publish('app:update', {
      name: appName,
      path: app.path,
      reason: 'git redeploy',
      bypassCooldown: true,
      principalId: actor.principalId,
      actorUserId: actor.userId,
      automationSource: actor.automation,
    });

    return {
      appName,
      repoUrl,
      branch,
      commitSha,
      clonedAt,
    };
  }

  /** Store a GitHub Personal Access Token */
  async setToken(name: string, tokenValue: string): Promise<GitTokenInfo> {
    // The credential helper emits the token as a LINE in git's credential
    // protocol (`password=<token>`), so a value carrying a newline would
    // append further `key=value` attributes of the caller's choosing —
    // `username=`, `url=`, `quit=1`. Every real PAT is printable ASCII, so
    // refuse anything else at the door rather than escaping it downstream.
    if (!/^[\x21-\x7e]+$/.test(tokenValue)) {
      throw new Error('Invalid token: must be printable ASCII with no whitespace');
    }
    const sm = getSecretManager();
    // Random, not `Date.now().toString(36)`: two tokens created in the same
    // millisecond shared an id, and ids are resolved by prefix match
    // (`startsWith(`${id}:`)`), so `getTokenValue` would return whichever the
    // store listed first. Harmless while ids were only picked from a UI list;
    // now that an id is persisted into `gitSource` and re-read on every
    // unattended webhook redeploy, a collision means an app quietly
    // authenticating with a different tenant's PAT. Still matches
    // GIT_TOKEN_ID_RE, so existing ids keep resolving — no migration.
    const id = `git_${crypto.randomBytes(8).toString('hex')}`;
    const key = `${id}:${name}`;

    await sm.set(GIT_TOKEN_APP_NAME, key, tokenValue);

    return {
      id,
      name,
      createdAt: new Date().toISOString(),
    };
  }

  /** Remove a stored GitHub token */
  async removeToken(id: string): Promise<boolean> {
    const sm = getSecretManager();
    const keys = sm.list(GIT_TOKEN_APP_NAME);
    const key = keys.find((k) => k.startsWith(`${id}:`));
    if (!key) return false;
    return sm.delete(GIT_TOKEN_APP_NAME, key);
  }

  /** List stored tokens (without values) */
  listTokens(): GitTokenInfo[] {
    const sm = getSecretManager();
    const keys = sm.list(GIT_TOKEN_APP_NAME);

    return keys.map((key) => {
      const [id, ...nameParts] = key.split(':');
      return {
        id,
        name: nameParts.join(':'),
        createdAt: '', // We don't track creation time in the key
      };
    });
  }

  /** Get a token value by ID (internal use only) */
  private async getTokenValue(id: string): Promise<string | undefined> {
    const sm = getSecretManager();
    const keys = sm.list(GIT_TOKEN_APP_NAME);
    const key = keys.find((k) => k.startsWith(`${id}:`));
    if (!key) return undefined;
    return sm.get(GIT_TOKEN_APP_NAME, key) ?? undefined;
  }

  /** Find apps that match a repo URL and branch for webhook auto-redeploy */
  findAppsForWebhook(repoUrl: string, branch: string): string[] {
    const normalizedUrl = normalizeRepoUrl(repoUrl);
    const stateManager = getStateManager();
    const allApps = stateManager.getAllApps();

    return allApps
      .filter((app) => {
        if (!app.gitSource?.autoRedeploy) return false;
        return (
          normalizeRepoUrl(app.gitSource.repoUrl) === normalizedUrl &&
          app.gitSource.branch === branch
        );
      })
      .map((app) => app.name);
  }
}

// Singleton
let instance: GitDeployService | null = null;

export function getGitDeployService(config?: GitDeployServiceConfig): GitDeployService {
  if (!instance) {
    if (!config) {
      throw new Error('GitDeployService config required on first call');
    }
    instance = new GitDeployService(config);
  }
  return instance;
}

export function resetGitDeployService(): void {
  instance = null;
}
