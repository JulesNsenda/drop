/**
 * Git Deploy Service
 *
 * Orchestrates deploying applications from GitHub repositories.
 * Clones repos into the webapps directory and lets the existing
 * pipeline (detect → build → start) handle the rest.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
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
import { getAppConfigService } from '../../managers/app/app-config';
import { getSecretManager } from '../../managers/secret';
import { getLogger } from '../../utils/logger';
import { hasEnoughDisk, getMinFreeDiskMb } from '../../utils/disk';
import { eventBus } from '../event-bus';
import { admitDeploy } from '../../managers/guardrail/deploy-breaker';

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

  /** Deploy an app from a GitHub repository */
  async deploy(request: GitDeployRequest): Promise<GitDeployResult> {
    if (!this.gitAvailable) {
      throw new Error('git CLI is not available on this system');
    }

    const repoUrl = normalizeRepoUrl(request.repoUrl);
    const branch = request.branch || 'main';
    const appName = request.name || extractRepoName(repoUrl);

    // Validate
    if (!isValidGitHubUrl(repoUrl)) {
      throw new Error(`Invalid GitHub URL: ${repoUrl}`);
    }

    if (!appName || !/^[\w.-]+$/.test(appName)) {
      throw new Error(`Invalid app name: ${appName}`);
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

    const destPath = path.join(this.config.appsDirectory, appName);

    // Check if directory already exists
    try {
      await fs.access(destPath);
      throw new Error(`Directory already exists: ${destPath}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
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

    // Mark as cloning to prevent watcher from detecting mid-clone
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

    // Clone complete - allow watcher to detect
    this.activeClones.delete(appName);

    // Read commit SHA
    let commitSha: string | undefined;
    try {
      commitSha = await getCommitSha(destPath);
    } catch {
      // non-fatal
    }

    const clonedAt = new Date().toISOString();

    // Register app with git source metadata and userId atomically
    await stateManager.registerApp(appName, destPath);

    const gitSource: GitSource = {
      repoUrl,
      branch,
      lastCommitSha: commitSha,
      lastClonedAt: clonedAt,
      autoRedeploy: request.autoRedeploy !== false,
      tokenId: request.tokenId,
    };

    await stateManager.updateApp(appName, {
      gitSource,
      ...(request.userId ? { userId: request.userId } : {}),
    } as Record<string, unknown>);

    logger.info(`Cloned ${repoUrl} → ${appName} (${commitSha?.slice(0, 7) || 'unknown'})`, 'GIT-DEPLOY');

    // Publish the detection directly instead of waiting on the watcher: a
    // clone that writes for longer than the watcher's max-wait flush gets its
    // app:detected dropped mid-clone (isCloning guard) and never re-emitted -
    // the app would sit registered but never built until a lucky file change.
    // Same shape as the watcher's own publish; the detector resolves the type.
    // ONLY on first creation (SEC-11) — deploy() rejects an existing app name
    // above, so reaching here always means new. A redeploy goes through
    // redeploy(), which never touches this flag.
    if (request.agentCaller) {
      await getAppConfigService().updateConfig(appName, { agentCreated: true });
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

  /** Redeploy a git-deployed app (git pull + trigger rebuild) */
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

    const { repoUrl, branch, tokenId } = app.gitSource;

    // Resolve token if needed
    let token: string | undefined;
    if (tokenId) {
      token = await this.getTokenValue(tokenId);
      if (!token) {
        logger.warn(`Token '${tokenId}' not found for ${appName} - trying without auth`, 'GIT-DEPLOY');
      }
    }

    logger.info(`Redeploying ${appName} from ${repoUrl} (branch: ${branch})`, 'GIT-DEPLOY');

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

    const gitSource: GitSource = {
      ...app.gitSource,
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
    const sm = getSecretManager();
    const id = `git_${Date.now().toString(36)}`;
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
