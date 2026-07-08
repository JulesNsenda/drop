/**
 * Git Deploy Service Tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { GitDeployService, resetGitDeployService } from './git-deploy';
import { resetStateManager, getStateManager } from '../../managers/app/state-manager';
import { resetSecretManager, getSecretManager } from '../../managers/secret';
import * as diskUtils from '../../utils/disk';
import { eventBus } from '../event-bus';
// AppUpdatePayload isn't re-exported by ../event-bus (index.ts) - see the same
// note in managers/deploy-tracker/deploy-tracker.ts.
import type { AppUpdatePayload } from '../event-bus/event-bus.types';

// Mock execFile to avoid actual git operations
jest.mock('child_process', () => ({
  execFile: jest.fn((_cmd: string, args: string[], opts: unknown, cb?: Function) => {
    // Handle promisify pattern (3 args = callback is last)
    const callback = cb || (typeof opts === 'function' ? opts : undefined);

    if (!callback) {
      // promisify returns the exec object with stdout/stderr
      return { stdout: '', stderr: '' };
    }

    if (args[0] === '--version') {
      callback(null, { stdout: 'git version 2.40.0', stderr: '' });
      return {} as any;
    }

    if (args[0] === 'clone') {
      callback(null, { stdout: '', stderr: '' });
      return {} as any;
    }

    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      callback(null, { stdout: 'abc123def456\n', stderr: '' });
      return {} as any;
    }

    if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      callback(null, { stdout: 'main\n', stderr: '' });
      return {} as any;
    }

    if (args[0] === 'pull') {
      callback(null, { stdout: '', stderr: '' });
      return {} as any;
    }

    if (args[0] === 'remote') {
      callback(null, { stdout: 'https://github.com/user/repo\n', stderr: '' });
      return {} as any;
    }

    callback(null, { stdout: '', stderr: '' });
    return {} as any;
  }),
}));

describe('GitDeployService', () => {
  let service: GitDeployService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-git-test-'));

    // Initialize state manager
    resetStateManager();
    const stateManager = getStateManager({
      stateFilePath: path.join(tempDir, 'apps.json'),
    });
    await stateManager.initialize();

    // Initialize secret manager
    resetSecretManager();
    const secretManager = getSecretManager({
      storePath: path.join(tempDir, 'secrets.json'),
    });
    await secretManager.initialize();

    // Create apps directory
    const appsDir = path.join(tempDir, 'webapps');
    await fs.mkdir(appsDir, { recursive: true });

    // Create service
    resetGitDeployService();
    service = new GitDeployService({ appsDirectory: appsDir });
    await service.initialize();

    // The child_process mock above intercepts the PowerShell/df calls that
    // hasEnoughDisk relies on, which would otherwise make every disk check
    // report 0 MB free. Stub it out so deploy/redeploy tests exercise the
    // rest of the pipeline; disk-preflight behavior itself is unit-tested
    // separately against src/utils/disk.ts.
    jest.spyOn(diskUtils, 'hasEnoughDisk').mockResolvedValue({ ok: true, freeMb: 10000 });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    resetGitDeployService();
    resetStateManager();
    resetSecretManager();
    try {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // ignore
    }
  });

  describe('initialize', () => {
    it('should detect git availability', () => {
      expect(service.isAvailable()).toBe(true);
    });
  });

  describe('deploy', () => {
    it('should reject invalid GitHub URLs', async () => {
      await expect(
        service.deploy({ repoUrl: 'https://gitlab.com/user/repo' })
      ).rejects.toThrow('Invalid GitHub URL');
    });

    it('should reject invalid app names', async () => {
      await expect(
        service.deploy({ repoUrl: 'https://github.com/user/repo', name: 'bad name!' })
      ).rejects.toThrow('Invalid app name');
    });

    it('should reject duplicate app names', async () => {
      const stateManager = getStateManager();
      await stateManager.registerApp('my-repo', '/some/path');

      await expect(
        service.deploy({ repoUrl: 'https://github.com/user/my-repo' })
      ).rejects.toThrow('already exists');
    });

    it('should deploy successfully from a valid URL', async () => {
      const result = await service.deploy({
        repoUrl: 'https://github.com/user/test-app',
        branch: 'main',
      });

      expect(result.appName).toBe('test-app');
      expect(result.repoUrl).toBe('https://github.com/user/test-app');
      expect(result.branch).toBe('main');
      expect(result.clonedAt).toBeDefined();
    });

    it('should use custom app name when provided', async () => {
      const result = await service.deploy({
        repoUrl: 'https://github.com/user/some-repo',
        name: 'my-custom-name',
      });

      expect(result.appName).toBe('my-custom-name');
    });

    it('rejects the deploy when disk space is below the watermark (P2-5)', async () => {
      (diskUtils.hasEnoughDisk as jest.Mock).mockResolvedValueOnce({ ok: false, freeMb: 10 });
      await expect(
        service.deploy({ repoUrl: 'https://github.com/user/low-disk-app', branch: 'main' })
      ).rejects.toThrow(/disk space/i);
    });

    it('should default branch to main', async () => {
      const result = await service.deploy({
        repoUrl: 'https://github.com/user/default-branch-test',
      });

      expect(result.branch).toBe('main');
    });

    it('should register the app in state manager with gitSource', async () => {
      await service.deploy({
        repoUrl: 'https://github.com/user/state-test',
        branch: 'develop',
        autoRedeploy: false,
      });

      const stateManager = getStateManager();
      const app = stateManager.getApp('state-test');
      expect(app).toBeDefined();
      expect(app?.gitSource).toBeDefined();
      expect(app?.gitSource?.repoUrl).toBe('https://github.com/user/state-test');
      expect(app?.gitSource?.branch).toBe('develop');
      expect(app?.gitSource?.autoRedeploy).toBe(false);
    });

    it('should normalize .git suffix in URL', async () => {
      const result = await service.deploy({
        repoUrl: 'https://github.com/user/dotgit-test.git',
      });

      expect(result.repoUrl).toBe('https://github.com/user/dotgit-test');
      expect(result.appName).toBe('dotgit-test');
    });
  });

  describe('redeploy', () => {
    it('publishes app:update with bypassCooldown after a successful pull', async () => {
      const appName = 'redeploy-app';
      await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });

      const received: AppUpdatePayload[] = [];
      const unsubscribe = eventBus.subscribe('app:update', (payload) => {
        received.push(payload);
      });

      try {
        const result = await service.redeploy(appName);

        expect(received).toHaveLength(1);
        expect(received[0].name).toBe(appName);
        expect(received[0].path).toBe(path.join(tempDir, 'webapps', appName));
        expect(received[0].bypassCooldown).toBe(true);
        expect(result.appName).toBe(appName);
      } finally {
        unsubscribe();
      }
    });

    it('clears isCloning before publishing app:update', async () => {
      const appName = 'redeploy-cloning-app';
      await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });

      let isCloningWhenEventFired: boolean | undefined;
      const unsubscribe = eventBus.subscribe('app:update', (payload) => {
        if (payload.name === appName) {
          isCloningWhenEventFired = service.isCloning(appName);
        }
      });

      try {
        await service.redeploy(appName);
        expect(isCloningWhenEventFired).toBe(false);
      } finally {
        unsubscribe();
      }
    });

    it('does not publish app:update and rejects when git pull fails', async () => {
      const appName = 'redeploy-fail-app';
      await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });

      // Override the NEXT execFile call only - the pull inside redeploy() is
      // the first (and, without a token, only) execFile call it makes.
      (execFile as unknown as jest.Mock).mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error) => void) => {
          if (cb) cb(new Error('fatal: could not read from remote repository'));
          return {} as unknown;
        }
      );

      const handler = jest.fn();
      const unsubscribe = eventBus.subscribe('app:update', handler);

      try {
        await expect(service.redeploy(appName)).rejects.toThrow();
        expect(handler).not.toHaveBeenCalled();
        expect(service.isCloning(appName)).toBe(false);
      } finally {
        unsubscribe();
      }
    });
  });

  describe('token management', () => {
    it('should store and list tokens', async () => {
      const token = await service.setToken('my-token', 'ghp_abc123');
      expect(token.id).toBeDefined();
      expect(token.name).toBe('my-token');

      const tokens = service.listTokens();
      expect(tokens.length).toBe(1);
      expect(tokens[0].name).toBe('my-token');
    });

    it('should remove tokens', async () => {
      const token = await service.setToken('to-delete', 'ghp_xyz');
      expect(service.listTokens().length).toBe(1);

      const deleted = await service.removeToken(token.id);
      expect(deleted).toBe(true);
      expect(service.listTokens().length).toBe(0);
    });

    it('should return false when removing non-existent token', async () => {
      const deleted = await service.removeToken('non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('findAppsForWebhook', () => {
    it('should find apps matching repo URL and branch', async () => {
      await service.deploy({
        repoUrl: 'https://github.com/user/webhook-test',
        branch: 'main',
        autoRedeploy: true,
      });

      const matches = service.findAppsForWebhook('https://github.com/user/webhook-test', 'main');
      expect(matches).toContain('webhook-test');
    });

    it('should not match apps with autoRedeploy disabled', async () => {
      await service.deploy({
        repoUrl: 'https://github.com/user/no-auto',
        branch: 'main',
        autoRedeploy: false,
      });

      const matches = service.findAppsForWebhook('https://github.com/user/no-auto', 'main');
      expect(matches).toHaveLength(0);
    });

    it('should not match apps on different branches', async () => {
      await service.deploy({
        repoUrl: 'https://github.com/user/branch-test',
        branch: 'develop',
        autoRedeploy: true,
      });

      const matches = service.findAppsForWebhook('https://github.com/user/branch-test', 'main');
      expect(matches).toHaveLength(0);
    });

    it('should normalize repo URLs when matching', async () => {
      await service.deploy({
        repoUrl: 'https://github.com/user/normalize-test.git',
        branch: 'main',
        autoRedeploy: true,
      });

      const matches = service.findAppsForWebhook('https://github.com/user/normalize-test', 'main');
      expect(matches).toContain('normalize-test');
    });
  });
});
