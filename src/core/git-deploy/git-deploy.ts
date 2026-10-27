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
  configureCloneBase,
  stripUrlCredentials,
  normalizeRepoUrl,
  extractRepoName,
  isValidGitHubUrl,
  isGitAvailable,
} from './git-client';
import { landTracked, readManifest, writeManifest, gitManifestDir } from './land';
import { writeJsonAtomic } from '../../utils/atomic-write';
import { logActivityFor } from '../../managers/activity';
import { getDeployTracker } from '../../managers/deploy-tracker';
import { getPlatformOps, AppInProgressError } from '../../api/platform-ops';
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
  /**
   * Platform temp root (`data/temp`). Clones live in `.git-clones` under it —
   * dot-prefixed so no app name can collide, and outside every watched, served
   * or container-mounted folder. Defaults to a `temp` folder beside the apps.
   */
  tempDirectory?: string;
  /** Where the per-app landed-file lists live (`data/drop-svc/git-manifests`). */
  manifestDirectory?: string;
  /** Cap on the summed size of a repository's tracked files (see `gitCheckoutCaps`). */
  maxUnpackedBytes?: number;
  /** Cap on files plus directories (see `gitCheckoutCaps`). */
  maxEntries?: number;
  /**
   * Remove everything under the clone base at `initialize()`. ONLY the
   * platform sets this: it is the one process that knows nothing is in flight.
   * A CLI process sharing the directory must never sweep another process's
   * clone out from under it.
   */
  sweepCloneBase?: boolean;
  /**
   * Reload redeploys that were queued before a restart and keep running the
   * queue. Platform only, for the same reason as `sweepCloneBase`.
   */
  resumeQueue?: boolean;
}

const DEFAULT_MAX_GIT_ENTRIES = 200_000;

/**
 * Prefix of a first deploy's staging directory, created in the apps folder
 * itself so the final rename never crosses a volume. Dot-prefixed: the watcher
 * (path-parser isValidAppName) and the initial scan both skip hidden names, so
 * a stage is never mistaken for an app.
 */
const STAGE_PREFIX = '.drop-stage-';

/**
 * The platform has not (or no longer) published its operations: during boot,
 * before they are set, and during shutdown, after they are reset. It is a kind
 * of "busy" - nothing is lost, the redeploy just cannot run YET - so it is an
 * AppInProgressError: callers map it to 409, the webhook queues it, and the
 * queue keeps the entry instead of recording a failure.
 */
export class PlatformNotReadyError extends AppInProgressError {
  constructor(appName: string) {
    super(appName);
    this.name = 'PlatformNotReadyError';
    this.message = 'Platform operations are unavailable; not writing the app folder';
  }
}

/**
 * The caps a git checkout is held to. A repository is not an upload: its
 * history-free tree is routinely larger than a tarball a person built, so the
 * size cap is its own setting (`DROP_MAX_GIT_CHECKOUT_MB`), defaulting to twice
 * the upload unpacked cap, with a larger entry cap.
 */
export function gitCheckoutCaps(uploadUnpackedMb: number): {
  maxUnpackedBytes: number;
  maxEntries: number;
} {
  const configured = parseInt(process.env.DROP_MAX_GIT_CHECKOUT_MB || '', 10);
  const mb = Number.isFinite(configured) && configured > 0 ? configured : uploadUnpackedMb * 2;
  return { maxUnpackedBytes: mb * 1024 * 1024, maxEntries: DEFAULT_MAX_GIT_ENTRIES };
}

/** The same caps from the environment alone (a process without the platform's config). */
function envDefaultCaps(): ReturnType<typeof gitCheckoutCaps> {
  return gitCheckoutCaps(parseInt(process.env.DROP_MAX_UPLOAD_UNPACKED_MB || '1024', 10));
}

export class GitDeployService {
  private readonly config: GitDeployServiceConfig;
  private gitAvailable = false;
  /** Per-app count of clones/lands in flight; the watcher guard is "any". */
  private activeClones: Map<string, number> = new Map();
  /** Tail of each app's land chain: two lands for one app never overlap. */
  private landChains: Map<string, Promise<unknown>> = new Map();
  private readonly cloneBase: string;
  private readonly manifestDir: string;
  /** Redeploys that were refused as busy; one per app, latest actor wins. */
  private pending: Map<string, DeployActor> = new Map();
  private pendingTimer: NodeJS.Timeout | null = null;
  private readonly pendingFile: string;

  constructor(config: GitDeployServiceConfig) {
    this.config = config;
    const dataDir = path.dirname(config.appsDirectory);
    this.cloneBase = path.join(config.tempDirectory ?? path.join(dataDir, 'temp'), '.git-clones');
    this.manifestDir = config.manifestDirectory ?? gitManifestDir(dataDir);
    this.pendingFile = path.join(path.dirname(this.manifestDir), 'git-pending-redeploys.json');
    configureCloneBase(this.cloneBase);
  }

  private beginClone(appName: string): void {
    this.activeClones.set(appName, (this.activeClones.get(appName) ?? 0) + 1);
  }

  private endClone(appName: string): void {
    const n = (this.activeClones.get(appName) ?? 0) - 1;
    if (n > 0) this.activeClones.set(appName, n);
    else this.activeClones.delete(appName);
  }

  /** Run `fn` after every earlier land for this app has finished. */
  private serialised<T>(appName: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.landChains.get(appName) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.landChains.set(appName, tail);
    void tail.then(() => {
      if (this.landChains.get(appName) === tail) this.landChains.delete(appName);
    });
    return run;
  }

  /**
   * The clone base, verified to be a real directory (not a link) owned by this
   * user. Anything left in it by a crash is swept at boot (`initialize`).
   */
  private async ensureCloneBase(): Promise<string> {
    await fs.mkdir(path.dirname(this.cloneBase), { recursive: true, mode: 0o700 });
    await fs.mkdir(this.cloneBase, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
    const st = await fs.lstat(this.cloneBase);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      throw new Error('Clone directory is not a plain directory');
    }
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
      throw new Error('Clone directory is not owned by the platform user');
    }
    return this.cloneBase;
  }

  async initialize(): Promise<void> {
    // Boot sweep, platform only: nothing is in flight yet, so anything here is a
    // crash's leftover. A CLI process never sweeps (it shares the directory).
    if (this.config.sweepCloneBase) {
      await fs.rm(this.cloneBase, { recursive: true, force: true }).catch(() => undefined);
      // A first deploy that died between staging and the rename leaves its stage
      // beside the apps (dot-prefixed, so never an app).
      for (const entry of await fs.readdir(this.config.appsDirectory).catch(() => [] as string[])) {
        if (entry.startsWith(STAGE_PREFIX)) {
          await fs
            .rm(path.join(this.config.appsDirectory, entry), { recursive: true, force: true })
            .catch(() => undefined);
        }
      }
    }
    if (this.config.resumeQueue) await this.loadPending();
    this.gitAvailable = await isGitAvailable();
    if (!this.gitAvailable) {
      logger.warn('git CLI not found - git deploy features will be unavailable', 'GIT-DEPLOY');
    } else {
      logger.info('Git deploy service initialized', 'GIT-DEPLOY');
    }
    if (this.pending.size > 0) this.schedulePending();
  }

  /** Reload the redeploys that were queued when the platform last stopped. */
  private async loadPending(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.pendingFile, 'utf-8')) as Record<string, DeployActor>;
      for (const [name, actor] of Object.entries(parsed)) {
        if (isValidAppName(name) && actor && typeof actor === 'object') this.pending.set(name, actor);
      }
    } catch {
      // No file, or unreadable: nothing was queued.
    }
  }

  private async persistPending(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.pendingFile), { recursive: true, mode: 0o700 });
      await writeJsonAtomic(this.pendingFile, Object.fromEntries(this.pending), { mode: 0o600 });
    } catch (err) {
      logger.warn('Could not save the queued redeploys', 'GIT-DEPLOY', err);
    }
  }

  /** A queued redeploy that failed must leave a deploy record and an audit entry, not only a log line. */
  private async recordQueuedFailure(appName: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : 'unknown error';
    logger.warn(`Queued redeploy of ${appName} failed: ${message}`, 'GIT-DEPLOY');
    try {
      const tracker = getDeployTracker();
      const buildId = `deploy-${appName}-${Date.now()}`;
      if (!tracker.hasOpenEpisode(appName)) eventBus.publish('build:started', { appId: appName, buildId });
      eventBus.publish('build:failed', {
        appId: appName,
        buildId,
        error: err instanceof Error ? err : new Error(message),
        stage: 'pre-build',
      });
    } catch {
      // Tracker not initialised (isolated tests): observability only.
    }
    await logActivityFor(undefined, {
      action: 'redeploy',
      appName,
      detail: `queued redeploy failed: ${message.slice(0, 200)}`,
    }).catch(() => undefined);
  }

  isAvailable(): boolean {
    return this.gitAvailable;
  }

  /** Stop the pending-redeploy timer. */
  dispose(): void {
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pending.clear();
  }

  /**
   * Remember a redeploy that was refused because the app was busy, and run it
   * once the app frees up. One per app: a later request replaces an earlier
   * one (the latest push is the one that matters), keeping what it set.
   */
  queueRedeploy(appName: string, actor: DeployActor = {}): void {
    this.pending.set(appName, { ...this.pending.get(appName), ...actor });
    void this.persistPending();
    this.schedulePending();
  }

  private schedulePending(): void {
    if (this.pendingTimer || this.pending.size === 0) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.flushPending();
    }, 2000);
    this.pendingTimer.unref?.();
  }

  private async flushPending(): Promise<void> {
    // Never flush before the platform has published its operations (the timer
    // fires about two seconds after boot, ahead of setPlatformOps), nor after
    // it has withdrawn them (shutdown): keep every entry and look again later.
    if (!getPlatformOps()) {
      this.schedulePending();
      return;
    }
    for (const [appName, actor] of [...this.pending]) {
      this.pending.delete(appName);
      await this.persistPending();
      try {
        await this.redeploy(appName, actor);
        logger.info(`Ran the queued redeploy of ${appName}`, 'GIT-DEPLOY');
      } catch (err) {
        if (err instanceof AppInProgressError) {
          // Still busy: keep it, unless a newer request arrived meanwhile.
          this.pending.set(appName, { ...actor, ...this.pending.get(appName) });
        } else {
          await this.recordQueuedFailure(appName, err);
        }
      }
    }
    await this.persistPending();
    this.schedulePending();
  }

  /**
   * Take the exclusive right to write an app's folder, or throw
   * `AppInProgressError`. Nothing may build, restart or deploy the app while a
   * land is under way, so the platform claims its in-progress slot and we
   * confirm no build container is alive. A monorepo container is also refused
   * while any of its children is busy.
   *
   * Without platform operations (a CLI process, or startup) nothing can be
   * guaranteed, so a REDEPLOY fails closed. A first deploy of a name that does
   * not exist yet has nothing to collide with and may proceed.
   */
  private async reserveFolder(
    appName: string,
    app: { isGroupContainer?: boolean; group?: string } | undefined,
    requireOps: boolean
  ): Promise<() => void> {
    const ops = getPlatformOps();
    if (!ops) {
      if (requireOps) throw new PlatformNotReadyError(appName);
      return () => undefined;
    }
    if (app?.isGroupContainer && app.group) {
      const busyChild = getStateManager()
        .getAllApps()
        .some((a) => a.group === app.group && !a.isGroupContainer && ops.isAppInProgress(a.name));
      if (busyChild) throw new AppInProgressError(appName);
    }
    const release = ops.tryReserveApp(appName);
    if (!release) throw new AppInProgressError(appName);
    try {
      if (await ops.hasLiveBuildContainer(appName)) throw new AppInProgressError(appName);
    } catch (err) {
      release();
      throw err;
    }
    return release;
  }

  /** Check if an app is currently being cloned */
  isCloning(appName: string): boolean {
    return (this.activeClones.get(appName) ?? 0) > 0;
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
    this.beginClone(appName);

    // Clone into a platform-owned temp dir, then land the tracked files without .git.
    logger.info(`Cloning ${repoUrl} (branch: ${branch}) into ${appName}`, 'GIT-DEPLOY');
    let commitSha: string | undefined;
    // Whether THIS deploy created the folder: only then is it ours to remove.
    const landState = { created: false };
    try {
      commitSha = await this.serialised(appName, async () => {
        const release = await this.reserveFolder(appName, undefined, false);
        try {
          return await this.cloneAndLand(appName, repoUrl, branch, token, destPath, true, landState);
        } finally {
          release();
        }
      });
    } catch (err) {
      this.endClone(appName);
      // Clean up a partial land, but only a folder this call made.
      if (landState.created) {
        await fs.rm(destPath, { recursive: true, force: true }).catch(() => undefined);
      }
      throw err;
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
      if (landState.created) {
        await fs.rm(destPath, { recursive: true, force: true }).catch(() => undefined);
      }
      throw err;
    } finally {
      // Clone complete - allow watcher to detect
      this.endClone(appName);
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
   * Fresh shallow clone into a temp dir the platform owns, then copy the
   * repository's TRACKED files (no `.git`) into `destPath`; the clone is
   * always removed. The CALLER holds the per-app chain (`serialised`) and the
   * folder reservation (`reserveFolder`) around this.
   *
   * What gets deleted is decided by the app's saved file list (see `land.ts`):
   * only files the repository once tracked and no longer does. Untracked files
   * are never touched, and with no saved list nothing is deleted. Returns the
   * cloned commit SHA, best-effort.
   */
  private async cloneAndLand(
    appName: string,
    url: string,
    branch: string,
    token: string | undefined,
    destPath: string,
    firstDeploy = false,
    state?: { created: boolean }
  ): Promise<string | undefined> {
    {
      const base = await this.ensureCloneBase();
      // The clones live on the temp volume, which may not be the apps volume.
      const tempDisk = await hasEnoughDisk(base);
      if (!tempDisk.ok) {
        throw new Error(
          `Insufficient disk space to clone: ${Math.round(tempDisk.freeMb)} MB free, need ${getMinFreeDiskMb()} MB`
        );
      }
      const cloneDir = await fs.mkdtemp(path.join(base, `${appName}-`));
      try {
        const caps = {
          maxBytes: this.config.maxUnpackedBytes ?? envDefaultCaps().maxUnpackedBytes,
          maxEntries: this.config.maxEntries ?? envDefaultCaps().maxEntries,
        };
        const info = await gitClone({ url, dest: cloneDir, branch, token, ...caps });
        if (info.symlinks.length > 0) {
          const shown = info.symlinks.slice(0, 5).join(', ');
          logger.warn(
            `${appName}: ${info.symlinks.length} symbolic link(s) tracked in the repository are not recreated (${shown}${info.symlinks.length > 5 ? ', ...' : ''})`,
            'GIT-DEPLOY'
          );
        }
        // Last look before writing: another create may have taken the folder
        // while the clone ran.
        if (firstDeploy && (await pathTaken(destPath))) {
          throw new Error(`Application '${appName}' already exists`);
        }
        const limits = { maxBytes: caps.maxBytes, maxEntries: caps.maxEntries };
        if (firstDeploy) {
          // A new app is built in a hidden directory INSIDE the apps folder (the
          // same volume as its destination, which the watcher ignores) and renamed
          // into place in one step, so the watcher, the CLI and every other reader
          // see either nothing or the whole tree, never half of it.
          const stage = await fs.mkdtemp(path.join(path.dirname(destPath), `${STAGE_PREFIX}${appName}-`));
          try {
            const landed = await landTracked({
              cloneDir,
              appDir: stage,
              files: info.files,
              previous: null,
              limits,
            });
            await fs.chmod(stage, 0o755);
            try {
              await fs.rename(stage, destPath);
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code === 'EEXIST' || code === 'ENOTEMPTY') {
                throw new Error(`Application '${appName}' already exists`);
              }
              throw err;
            }
            if (state) state.created = true;
            await writeManifest(this.manifestDir, appName, landed);
          } finally {
            await fs.rm(stage, { recursive: true, force: true }).catch(() => undefined);
          }
          return info.commitSha;
        }
        const previous = await readManifest(this.manifestDir, appName);
        const landed = await landTracked({
          cloneDir,
          appDir: destPath,
          files: info.files,
          previous,
          limits,
        });
        await writeManifest(this.manifestDir, appName, landed);
        return info.commitSha;
      } finally {
        await fs.rm(cloneDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  /**
   * Redeploy a git-deployed app (fresh clone + land tracked files + trigger
   * rebuild). Refused while the platform is building or deploying the app (the
   * land would write under a running build); redeploys of one app that do
   * overlap are serialised in `cloneAndLand`.
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

    // A build, restart or deploy in flight reads this folder; landing files
    // under it would hand that operation a half-written tree.
    // Cheap early refusal; the reservation below is the real guard.
    const ops = getPlatformOps();
    if (!ops) {
      throw new PlatformNotReadyError(appName);
    }
    if (ops.isAppInProgress(appName)) {
      throw new AppInProgressError(appName);
    }

    // The recorded URL, credential-stripped and re-validated (an older install
    // may have stored one with userinfo). It is what is logged, cloned,
    // persisted and returned.
    const { branch } = app.gitSource;
    const cloneUrl = normalizeRepoUrl(stripUrlCredentials(app.gitSource.repoUrl) ?? app.gitSource.repoUrl);
    if (!isValidGitHubUrl(cloneUrl)) {
      throw new Error(`Invalid recorded repository URL for ${appName}`);
    }
    const baseSource: GitSource = app.gitSource;

    return this.serialised(appName, async () => {
      // The reservation comes BEFORE the quota is charged: an attempt that is
      // refused as busy must not consume a deploy. From here until just before
      // the publish below, the platform's in-progress slot for this app is ours:
      // no build, restart or deploy can start, and one that arrives is
      // deferred rather than dropped.
      const releaseReservation = await this.reserveFolder(appName, app, true);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        releaseReservation();
      };
      // This run supersedes any queued one for the app.
      if (this.pending.delete(appName)) void this.persistPending();
      try {
    // GUARDRAIL + QUOTA, before the clone. A redeploy is the request an agent
    // repeats, and a clone + rebuild is not free.
    await admitDeploy(appName, false, {
      principalId: actor.principalId,
      actorUserId: actor.userId,
      automationSource: actor.automation,
    });

    // Preflight: ensure enough free disk space before cloning
    const disk = await hasEnoughDisk(app.path);
    if (!disk.ok) {
      throw new Error(
        `Insufficient disk space to redeploy: ${Math.round(disk.freeMb)} MB free, need ${getMinFreeDiskMb()} MB`
      );
    }

    // undefined (the default, via omission) leaves the stored token
    // unchanged; null clears it; a string attaches/replaces it. Resolved once
    // and used for BOTH the clone and the final gitSource below — `app` is a
    // snapshot captured above, and updateApp REPLACES the map entry rather
    // than mutating it, so a second read of app.gitSource after this point
    // would still see the pre-redeploy value.
    const effectiveTokenId = actor.tokenId !== undefined ? actor.tokenId : baseSource.tokenId;

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
    if (actor.tokenId === null && baseSource.tokenId) {
      const cleared: GitSource = { ...baseSource, tokenId: undefined };
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

    logger.info(`Redeploying ${appName} from ${cloneUrl} (branch: ${branch})`, 'GIT-DEPLOY');

    // Rollback snapshot of the tree that is SERVING, before it is replaced
    // (#296). Best-effort by contract: it never throws, and a skipped or
    // failed snapshot never fails the deploy — it only means this redeploy
    // cannot be rolled back, which the rollback route reports as such.
    // The tree carries no .git (every git deploy clones fresh), so a restore
    // puts the files back and the next redeploy simply clones again.
        const snapshot = await captureBeforeRedeploy(appName);
        if (!snapshot.captured) {
          logger.info(`No rollback snapshot for ${appName}: ${snapshot.reason}`, 'GIT-DEPLOY');
        }

        // Mark as cloning for the duration of the land only - mirrors deploy()'s
        // guard against the watcher building a half-written tree. Cleared before
        // the deterministic publish below, or the platform's isCloning guards
        // (platform.ts) would eat that event too.
        this.beginClone(appName);
        let commitSha: string | undefined;
        try {
          // Clone the recorded URL into a platform-owned temp dir; git never
          // runs inside the app folder.
          commitSha = await this.cloneAndLand(appName, cloneUrl, branch, token, app.path);
        } finally {
          this.endClone(appName);
        }

        const clonedAt = new Date().toISOString();

    // Built from effectiveTokenId, NOT app.gitSource.tokenId — see the note
    // above. Spreading the stale field here would silently revert an attach
    // on this success path (the defect two independent reviewers found).
    const gitSource: GitSource = {
      ...baseSource,
      repoUrl: cloneUrl,
      tokenId: effectiveTokenId === null ? undefined : effectiveTokenId,
      lastCommitSha: commitSha,
      lastClonedAt: clonedAt,
    };

    await stateManager.updateApp(appName, { gitSource } as Record<string, unknown>);

    logger.info(`Redeployed ${appName} (${commitSha?.slice(0, 7) || 'unknown'})`, 'GIT-DEPLOY');

    // The land is finished: free the app for the rebuild this publish triggers
    // (handleAppUpdate drops an update for an app that is still in progress).
    release();

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
      repoUrl: cloneUrl,
      branch,
      commitSha,
      clonedAt,
    };
      } finally {
        release();
      }
    });
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
  instance?.dispose();
  instance = null;
}
