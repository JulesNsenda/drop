/**
 * Git Deploy Service Tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { GitDeployService, resetGitDeployService } from './git-deploy';
import { resetStateManager, getStateManager, AppStateManager } from '../../managers/app/state-manager';
import { resetSecretManager, getSecretManager } from '../../managers/secret';
import {
  AppConfigService,
  getAppConfigService,
  resetAppConfigService,
} from '../../managers/app/app-config';
import * as diskUtils from '../../utils/disk';
import * as breakerModule from '../../managers/guardrail/deploy-breaker';
import { tryReserve, ownerOf, isReserved, resetDeployReservations } from '../deploy-reservations';
import { eventBus } from '../event-bus';
import { setPlatformOps, resetPlatformOps, AppInProgressError } from '../../api/platform-ops';
import { PlatformNotReadyError } from './git-deploy';
import type { PlatformOps } from '../../api/platform-ops';
import { makePlatformOpsStub } from '../../api/__testutils__/platform-ops';
import * as activity from '../../managers/activity';
import { getDeployTracker, resetDeployTracker } from '../../managers/deploy-tracker';
// AppUpdatePayload isn't re-exported by ../event-bus (index.ts) - see the same
// note in managers/deploy-tracker/deploy-tracker.ts.
import type { AppDetectedPayload, AppUpdatePayload } from '../event-bus/event-bus.types';

// What the mocked `git clone` puts in its destination: these files (and a
// `.git/`, as a real clone has), and the same list from `ls-files`. A gate
// lets a test hold a clone open to observe overlap.
let mockCloneFiles: Record<string, string> = { 'index.html': '<h1>v1</h1>' };
let mockCloneGate: Promise<void> | null = null;
let mockCloneActive = 0;
let mockCloneMaxActive = 0;

// Mock execFile to avoid actual git operations
jest.mock('child_process', () => ({
  execFile: jest.fn((_cmd: string, args: string[], opts: unknown, cb?: Function) => {
    // Handle promisify pattern (3 args = callback is last)
    const callback = cb || (typeof opts === 'function' ? opts : undefined);

    if (!callback) {
      // promisify returns the exec object with stdout/stderr
      return { stdout: '', stderr: '' };
    }

    // Dispatch on the SUBCOMMAND, not args[0]. git-client prepends global
    // options — `-c credential.…` for an authenticated call and
    // `--git-dir`/`--work-tree` to stop repository discovery walking up the
    // ancestor chain — so args[0] is routinely a flag. Matching on args[0]
    // silently fell through to the empty default for every one of those,
    // which reads as "git succeeded and printed nothing" rather than as a
    // broken fixture.
    const GLOBAL_OPTS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree']);
    let i = 0;
    while (i < args.length && GLOBAL_OPTS_WITH_VALUE.has(args[i])) i += 2;
    const sub = args.slice(i);

    if (sub[0] === '--version') {
      callback(null, { stdout: 'git version 2.40.0', stderr: '' });
      return {} as any;
    }

    if (sub[0] === 'clone') {
      const dest = args[args.length - 1];
      mockCloneActive++;
      mockCloneMaxActive = Math.max(mockCloneMaxActive, mockCloneActive);
      Promise.resolve(mockCloneGate).then(() => {
        const nodeFs = require('fs');
        const nodePath = require('path');
        nodeFs.mkdirSync(nodePath.join(dest, '.git'), { recursive: true });
        nodeFs.writeFileSync(nodePath.join(dest, '.git', 'config'), '[core]');
        for (const [rel, content] of Object.entries(mockCloneFiles)) {
          nodeFs.mkdirSync(nodePath.dirname(nodePath.join(dest, rel)), { recursive: true });
          nodeFs.writeFileSync(nodePath.join(dest, rel), content);
        }
        mockCloneActive--;
        callback(null, { stdout: '', stderr: '' });
      });
      return {} as any;
    }

    if (sub[0] === 'ls-files') {
      const out = Object.keys(mockCloneFiles)
        .map(
          (rel) =>
            '100644 ' +
            require('crypto').createHash('sha1').update(mockCloneFiles[rel]).digest('hex') +
            ' 0\t' +
            rel +
            '\0'
        )
        .join('');
      callback(null, { stdout: out, stderr: '' });
      return {} as any;
    }

    if (sub[0] === 'rev-parse' && sub[1] === 'HEAD') {
      callback(null, { stdout: 'abc123def456\n', stderr: '' });
      return {} as any;
    }

    if (sub[0] === 'rev-parse' && sub[1] === '--abbrev-ref') {
      callback(null, { stdout: 'main\n', stderr: '' });
      return {} as any;
    }

    if (sub[0] === 'pull') {
      callback(null, { stdout: '', stderr: '' });
      return {} as any;
    }

    if (sub[0] === 'remote') {
      callback(null, { stdout: 'https://github.com/user/repo\n', stderr: '' });
      return {} as any;
    }

    callback(null, { stdout: '', stderr: '' });
    return {} as any;
  }),
}));

import {
  getDeployBreaker,
  resetDeployBreaker,
  DeployRefusedError,
  guardrailKeysFor,
} from '../../managers/guardrail/deploy-breaker';
import {
  getPrincipalQuota,
  resetPrincipalQuota,
} from '../../managers/guardrail/principal-quota';

// The platform ops a redeploy requires: a reservation that is exclusive per app.
const reservedNow = new Set<string>();
function installOps(over: Partial<PlatformOps> = {}): void {
  setPlatformOps(
    makePlatformOpsStub({
      tryReserveApp: (name: string) => {
        if (reservedNow.has(name)) return null;
        reservedNow.add(name);
        return () => {
          reservedNow.delete(name);
        };
      },
      ...over,
    })
  );
}

describe('GitDeployService', () => {
  let service: GitDeployService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-git-test-'));

    // The deploy quota is a singleton whose DEFAULT store path is relative and
    // resolves against the process CWD. Left alone these tests would write into
    // the repo and accumulate counts across runs until every deploy is refused.
    resetDeployBreaker();
    resetPrincipalQuota();
    getPrincipalQuota(path.join(tempDir, 'principal-quotas.json'));

    // Initialize state manager
    resetStateManager();
    const stateManager = getStateManager({
      stateFilePath: path.join(tempDir, 'apps.json'),
    });
    await stateManager.initialize();
    // The new-app name rules read recorded groups and containers, and fail
    // closed without a config service.
    resetAppConfigService();
    await getAppConfigService({
      configDir: path.join(tempDir, 'appconf'),
      webappsDir: path.join(tempDir, 'webapps'),
    }).initialize();

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
    reservedNow.clear();
    installOps();

    // The child_process mock above intercepts the PowerShell/df calls that
    // hasEnoughDisk relies on, which would otherwise make every disk check
    // report 0 MB free. Stub it out so deploy/redeploy tests exercise the
    // rest of the pipeline; disk-preflight behavior itself is unit-tested
    // separately against src/utils/disk.ts.
    jest.spyOn(diskUtils, 'hasEnoughDisk').mockResolvedValue({ ok: true, freeMb: 10000 });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    resetDeployReservations();
    resetAppConfigService();
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

    it('refuses a name whose folder already exists, without leaking the path', async () => {
      const folder = path.join(tempDir, 'webapps', 'taken-folder');
      await fs.mkdir(folder, { recursive: true });
      await fs.writeFile(path.join(folder, 'keep.txt'), 'operator data');

      const attempt = service.deploy({ repoUrl: 'https://github.com/user/taken-folder' });

      await expect(attempt).rejects.toThrow("Application 'taken-folder' already exists");
      await expect(attempt).rejects.not.toThrow(tempDir);
      expect(await fs.readFile(path.join(folder, 'keep.txt'), 'utf-8')).toBe('operator data');
      expect(service.isCloning('taken-folder')).toBe(false);
    });

    it('reads a dangling link as a taken name', async () => {
      const link = path.join(tempDir, 'webapps', 'dangling');
      try {
        await fs.symlink(path.join(tempDir, 'nowhere'), link);
      } catch {
        return; // no symlink privilege on this machine
      }

      await expect(
        service.deploy({ repoUrl: 'https://github.com/user/dangling' })
      ).rejects.toThrow("Application 'dangling' already exists");
    });

    it('a concurrent deploy of one name: exactly one wins, the other is refused', async () => {
      // The claim is taken after admission, so either call may get there
      // first — the guarantee is that exactly one of them creates the app.
      const results = await Promise.allSettled([
        service.deploy({ repoUrl: 'https://github.com/user/racing' }),
        service.deploy({ repoUrl: 'https://github.com/user/racing' }),
      ]);

      const won = results.filter((r) => r.status === 'fulfilled');
      const refused = results.filter((r) => r.status === 'rejected');
      expect(won).toHaveLength(1);
      expect((won[0] as PromiseFulfilledResult<{ appName: string }>).value).toMatchObject({ appName: 'racing' });
      expect(refused).toHaveLength(1);
      expect(String((refused[0] as PromiseRejectedResult).reason)).toMatch('already exists');
    });

    it('refuses a name another deploy path holds, and does not release its claim', async () => {
      expect(tryReserve('uploading', 'someone-else')).toBe(true);

      const attempt = service.deploy({ repoUrl: 'https://github.com/user/uploading', userId: 'alice' });

      await expect(attempt).rejects.toThrow("Application 'uploading' already exists");
      // Plain wording: no hint that a deploy is in flight.
      await expect(attempt).rejects.not.toThrow(/progress/);
      expect(ownerOf('uploading')).toBe('someone-else');
      expect(service.isCloning('uploading')).toBe(false);
    });

    it('releases only its own reservation when it fails, and frees the name', async () => {
      await expect(
        service.deploy({ repoUrl: 'https://github.com/user/whatever', name: 'bad name!', userId: 'alice' })
      ).rejects.toThrow('Invalid app name');
      expect(isReserved('bad name!')).toBe(false);

      jest.spyOn(getStateManager(), 'registerApp').mockRejectedValueOnce(new Error('register failed'));
      await expect(
        service.deploy({ repoUrl: 'https://github.com/user/frees', userId: 'alice' })
      ).rejects.toThrow('register failed');
      expect(isReserved('frees')).toBe(false);
    });

    it('does not hold the watcher off the name through its pre-clone awaits', async () => {
      let cloningDuringAdmission: boolean | undefined;
      jest.spyOn(breakerModule, 'admitDeploy').mockImplementationOnce(async () => {
        cloningDuringAdmission = service.isCloning('late-clone');
      });

      await service.deploy({ repoUrl: 'https://github.com/user/late-clone' });

      expect(cloningDuringAdmission).toBe(false);
    });

    it('does not remove an app it never registered when registration fails', async () => {
      const stateManager = getStateManager();
      jest.spyOn(stateManager, 'registerApp').mockRejectedValue(new Error('register failed'));
      const removeApp = jest.spyOn(stateManager, 'removeApp');

      await expect(
        service.deploy({ repoUrl: 'https://github.com/user/never-registered' })
      ).rejects.toThrow('register failed');

      expect(removeApp).not.toHaveBeenCalled();
      expect(service.isCloning('never-registered')).toBe(false);
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

    it('registers the app and its owner BEFORE the name leaves activeClones', async () => {
      // Once the name is released the watcher may detect a monorepo container
      // and expand it; without an owner on record it would adopt unowned group
      // children as unowned.
      const appName = 'owner-order';
      const stateManager = getStateManager();
      const seen: Array<{ cloning: boolean; userId?: string }> = [];
      const realUpdate = stateManager.updateApp.bind(stateManager);
      jest.spyOn(stateManager, 'updateApp').mockImplementation(async (name, updates) => {
        await realUpdate(name, updates);
        seen.push({ cloning: service.isCloning(appName), userId: stateManager.getApp(name)?.userId });
        return stateManager.getApp(name) as never;
      });

      await service.deploy({
        repoUrl: `https://github.com/user/${appName}`,
        branch: 'main',
        userId: 'owner',
      });

      expect(seen).toEqual([{ cloning: true, userId: 'owner' }]);
      expect(service.isCloning(appName)).toBe(false);
    });

    it('removes the registration and the clone, and releases the name, when registering fails', async () => {
      const appName = 'register-fails';
      const stateManager = getStateManager();
      jest.spyOn(stateManager, 'updateApp').mockRejectedValue(new Error('state write failed'));

      await expect(
        service.deploy({
          repoUrl: `https://github.com/user/${appName}`,
          branch: 'main',
          userId: 'owner',
        })
      ).rejects.toThrow('state write failed');

      expect(stateManager.hasApp(appName)).toBe(false);
      expect(service.isCloning(appName)).toBe(false);
      await expect(fs.stat(path.join(tempDir, 'webapps', appName))).rejects.toThrow();
    });

    it('publishes app:detected after a successful clone', async () => {
      const appName = 'detected-app';

      const received: AppDetectedPayload[] = [];
      let isCloningWhenEventFired: boolean | undefined;
      const unsubscribe = eventBus.subscribe('app:detected', (payload) => {
        received.push(payload);
        isCloningWhenEventFired = service.isCloning(appName);
      });

      try {
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });

        expect(received).toHaveLength(1);
        expect(received[0].name).toBe(appName);
        expect(received[0].path).toBe(path.join(tempDir, 'webapps', appName));
        expect(received[0].type).toBeUndefined();
        // Cleared before the publish - the platform's isCloning guard would
        // drop the detection otherwise.
        expect(isCloningWhenEventFired).toBe(false);
      } finally {
        unsubscribe();
      }
    });

    it('does not publish app:detected when the clone fails', async () => {
      // Override the NEXT execFile call only - the clone is the first execFile
      // call deploy() makes (disk preflight and token lookup do not shell out).
      (execFile as unknown as jest.Mock).mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error) => void) => {
          if (cb) cb(new Error('fatal: repository not found'));
          return {} as unknown;
        }
      );

      const handler = jest.fn();
      const unsubscribe = eventBus.subscribe('app:detected', handler);

      try {
        await expect(
          service.deploy({ repoUrl: 'https://github.com/user/clone-fail-app', branch: 'main' })
        ).rejects.toThrow();
        expect(handler).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
      }
    });

    it('should normalize .git suffix in URL', async () => {
      const result = await service.deploy({
        repoUrl: 'https://github.com/user/dotgit-test.git',
      });

      expect(result.repoUrl).toBe('https://github.com/user/dotgit-test');
      expect(result.appName).toBe('dotgit-test');
    });
  });

  describe('deploy - new app name rules', () => {
    const deployAs = (repo: string, extra: Record<string, unknown> = {}) =>
      service.deploy({ repoUrl: `https://github.com/user/${repo}`, userId: 'alice', ...extra });

    it('refuses a dotted name, given or derived from the URL (a slot-b instance name)', async () => {
      await expect(deployAs('shop', { name: 'shop.b' })).rejects.toThrow('Invalid app name');
      await expect(deployAs('shop.b')).rejects.toThrow('Invalid app name');
      // Admins are held to the syntax rule too.
      await expect(deployAs('shop', { name: 'shop.b', callerIsAdmin: true })).rejects.toThrow(
        'Invalid app name'
      );
    });

    it('refuses a name differing from an existing app only in case', async () => {
      await getStateManager().registerApp('Blog', '/x/Blog');

      await expect(deployAs('blog')).rejects.toThrow("Application 'blog' already exists");
    });

    it('refuses a name equal to a group in state', async () => {
      await getStateManager().registerApp('ezs-web', '/x/ezs-web');
      await getStateManager().updateApp('ezs-web', { group: 'ezs' });

      await expect(deployAs('ezs')).rejects.toThrow("Application 'ezs' already exists");
      await expect(deployAs('EZS')).rejects.toThrow('already exists');
    });

    it("refuses a deleted container's name while its stamped children live on", async () => {
      const acs = getAppConfigService({
        configDir: path.join(tempDir, 'appconf'),
        webappsDir: path.join(tempDir, 'webapps'),
      });
      await acs.initialize();
      await acs.upsertSystemConfig('legacy-web', {
        type: 'static',
        group: 'legacy',
        groupContainer: 'legacy-repo',
      });

      await expect(deployAs('legacy-repo')).rejects.toThrow("Application 'legacy-repo' already exists");
      await expect(deployAs('Legacy')).rejects.toThrow('already exists');
    });

    it('counts the name rules against quota: a probe is admitted before it is refused', async () => {
      await getStateManager().registerApp('ezs-web', '/x/ezs-web');
      await getStateManager().updateApp('ezs-web', { group: 'ezs' });
      const admit = jest.spyOn(breakerModule, 'admitDeploy');

      await expect(deployAs('ezs')).rejects.toThrow('already exists');

      expect(admit).toHaveBeenCalledTimes(1);
    });

    it('re-decides the name just before registering, and removes the clone if it was taken meanwhile', async () => {
      const stateManager = getStateManager();
      const register = jest.spyOn(stateManager, 'registerApp');
      // A group claims the name while the deploy is between its checks and the clone.
      jest.spyOn(diskUtils, 'hasEnoughDisk').mockImplementationOnce(async () => {
        await stateManager.registerApp('claimer-web', '/x/claimer-web');
        await stateManager.updateApp('claimer-web', { group: 'racy' });
        return { ok: true, freeMb: 10000 };
      });

      await expect(deployAs('racy')).rejects.toThrow("Application 'racy' already exists");

      expect(register).not.toHaveBeenCalledWith('racy', expect.anything());
      expect(isReserved('racy')).toBe(false);
      await expect(fs.stat(path.join(tempDir, 'webapps', 'racy'))).rejects.toThrow();
    });

    it('says how to pick another name when the derived one is invalid', async () => {
      await expect(deployAs('my.repo')).rejects.toThrow('pass `name` to choose a different app name');
    });

    it('lets an admin take such a name, and a plain new name through', async () => {
      await getStateManager().registerApp('ezs-web', '/x/ezs-web');
      await getStateManager().updateApp('ezs-web', { group: 'ezs' });

      await expect(deployAs('ezs', { callerIsAdmin: true })).resolves.toMatchObject({ appName: 'ezs' });
      await expect(deployAs('fresh')).resolves.toMatchObject({ appName: 'fresh' });
    });
  });

  describe('deploy - guardrail pre-check', () => {
    // The platform's gates sit at the BUILD, so without this a refused caller
    // could still make DROP clone an arbitrary repository on every attempt —
    // network, disk and time spent before the event that would refuse it is
    // even published.
    afterEach(() => resetDeployBreaker());

    const actor = { userId: 'human-1', principalId: 'key:looper' };

    const trip = (appName: string) => {
      const keys = guardrailKeysFor(appName, true, {
        principalId: actor.principalId,
        actorUserId: actor.userId,
      });
      const breaker = getDeployBreaker();
      for (let i = 0; i < 5; i++) breaker.recordFailure(keys[0].key, Date.now(), keys[0].threshold);
    };

    it('refuses BEFORE cloning', async () => {
      trip('test-app');

      await expect(
        service.deploy({ repoUrl: 'https://github.com/user/test-app', ...actor })
      ).rejects.toBeInstanceOf(DeployRefusedError);
    });

    it('keys on the caller, not the app name — a fresh name does not reset it', async () => {
      // Every new-app deploy shares one `<principal>::__new__` bucket precisely
      // so that inventing a new repo name each time accumulates rather than
      // starting over.
      trip('test-app');

      await expect(
        service.deploy({ repoUrl: 'https://github.com/user/a-different-name', ...actor })
      ).rejects.toBeInstanceOf(DeployRefusedError);
    });

    it('lets an UNRELATED caller clone', async () => {
      trip('test-app');

      await expect(
        service.deploy({
          repoUrl: 'https://github.com/user/test-app',
          userId: 'human-2',
          principalId: 'key:innocent',
        })
      ).resolves.toBeDefined();
    });
  });

  describe('redeploy', () => {
    // service.deploy()'s clone is mocked (see the module mock above) and never
    // creates a real directory, but redeploy() now fails fast when `.git` is
    // missing on disk (DROP-142 Fix 4) — every test below that expects the
    // pull itself to run must create it, the same workaround the config
    // write-ordering tests below already use for the missing clone side effect.
    async function makeGitDir(appName: string): Promise<void> {
      await fs.mkdir(path.join(tempDir, 'webapps', appName, '.git'), { recursive: true });
    }

    /**
     * Make the next `git clone` fail, whatever else redeploy() runs around it.
     *
     * These tests used to call `mockImplementationOnce` on the premise that
     * "the pull is the first execFile call redeploy() makes". It is not, and
     * the premise is the fragile part, not the mock: `gitPull` now runs a
     * `git remote get-url origin` first to evict a PAT an older DROP baked
     * into the remote URL, and that helper SWALLOWS its own errors. So the
     * once-mock landed on the strip instead, the pull then succeeded, and
     * three tests asserting a rejection inverted at once. Matching on the
     * subcommand cannot drift that way again.
     */
    function failNextPull(message = 'fatal: could not read from remote repository'): void {
      const mock = execFile as unknown as jest.Mock;
      const original = mock.getMockImplementation() as (...a: unknown[]) => unknown;
      let fired = false;
      mock.mockImplementation((cmd: string, args: string[], opts: unknown, cb?: Function) => {
        if (!fired && Array.isArray(args) && args.includes('clone')) {
          fired = true;
          mock.mockImplementation(original);
          const callback = cb || (typeof opts === 'function' ? opts : undefined);
          if (callback) (callback as (e: Error) => void)(new Error(message));
          return {} as unknown;
        }
        return original(cmd, args, opts, cb);
      });
    }

    it('publishes app:update with bypassCooldown after a successful pull', async () => {
      const appName = 'redeploy-app';
      await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
      await makeGitDir(appName);

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
      await makeGitDir(appName);

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
      await makeGitDir(appName);

      failNextPull();

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

    describe('landing tracked files (fresh clone per redeploy)', () => {
      const appDir = (name: string): string => path.join(tempDir, 'webapps', name);
      const exists = (p: string): Promise<boolean> =>
        fs.lstat(p).then(
          () => true,
          () => false
        );

      beforeEach(() => {
        mockCloneFiles = { 'index.html': '<h1>v1</h1>', 'src/app.js': 'v1' };
        mockCloneGate = null;
        mockCloneActive = 0;
        mockCloneMaxActive = 0;
      });

      afterEach(() => {
        resetPlatformOps();
      });

      it('clones the recorded URL into the clone base, runs nothing in the app folder, and removes the clone', async () => {
        const appName = 'redeploy-fresh-clone';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        (execFile as unknown as jest.Mock).mockClear();

        await service.redeploy(appName);

        const calls = (execFile as unknown as jest.Mock).mock.calls;
        const clone = calls.find((c) => (c[1] as string[]).includes('clone'));
        expect(clone).toBeDefined();
        const args = clone![1] as string[];
        expect(args.slice(-2)[0]).toBe(`https://github.com/user/${appName}`);
        const dest = args[args.length - 1];
        expect(dest.startsWith(path.join(tempDir, 'webapps'))).toBe(false);
        expect(dest).toContain(path.join(tempDir, 'temp', '.git-clones'));
        await expect(fs.access(dest)).rejects.toThrow();
        for (const c of calls) {
          const opts = c[2] as { cwd?: string } | undefined;
          expect(opts?.cwd ?? '').not.toContain(path.join(tempDir, 'webapps'));
          expect((c[1] as string[]).includes('pull')).toBe(false);
        }
        const env = (clone![2] as { env: NodeJS.ProcessEnv }).env;
        expect(env.GIT_TERMINAL_PROMPT).toBe('0');
      });

      it('lands the tracked files but not the clone\'s .git', async () => {
        const appName = 'land-files';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });

        expect(await fs.readFile(path.join(appDir(appName), 'src', 'app.js'), 'utf-8')).toBe('v1');
        expect(await exists(path.join(appDir(appName), '.git'))).toBe(false);
      });

      it('removes a leftover .git from the app folder on redeploy', async () => {
        const appName = 'redeploy-removes-dotgit';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        await makeGitDir(appName);

        await service.redeploy(appName);

        expect(await exists(path.join(appDir(appName), '.git'))).toBe(false);
      });

      it('leaves untracked files alone, and deletes upstream-removed files only because the saved list names them', async () => {
        const appName = 'land-prune';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        await fs.writeFile(path.join(appDir(appName), 'app-data.db'), 'state');

        // Upstream drops src/app.js and adds a file.
        mockCloneFiles = { 'index.html': '<h1>v2</h1>', 'new.txt': 'n' };
        await service.redeploy(appName);

        expect(await fs.readFile(path.join(appDir(appName), 'index.html'), 'utf-8')).toBe('<h1>v2</h1>');
        expect(await exists(path.join(appDir(appName), 'src', 'app.js'))).toBe(false);
        expect(await fs.readFile(path.join(appDir(appName), 'app-data.db'), 'utf-8')).toBe('state');
      });

      it('prunes nothing on the first redeploy of an app that has no saved list', async () => {
        const appName = 'land-no-manifest';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        await fs.rm(path.join(tempDir, 'drop-svc', 'git-manifests'), { recursive: true, force: true });

        mockCloneFiles = { 'index.html': '<h1>v2</h1>' };
        await service.redeploy(appName);

        expect(await exists(path.join(appDir(appName), 'src', 'app.js'))).toBe(true);
      });

      it('refuses a repository over the entry cap, and leaves the app as it was', async () => {
        const appName = 'land-capped';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        const capped = new GitDeployService({
          appsDirectory: path.join(tempDir, 'webapps'),
          maxEntries: 1,
        });
        await capped.initialize();
        mockCloneFiles = { 'a.txt': 'a', 'b.txt': 'b' };

        await expect(capped.redeploy(appName)).rejects.toThrow(/maximum of 1 entries/);

        expect(await fs.readFile(path.join(appDir(appName), 'index.html'), 'utf-8')).toBe('<h1>v1</h1>');
      });

      it('refuses a redeploy while the platform is building or deploying the app', async () => {
        const appName = 'land-in-progress';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        setPlatformOps({ isAppInProgress: () => true } as unknown as PlatformOps);
        (execFile as unknown as jest.Mock).mockClear();

        await expect(service.redeploy(appName)).rejects.toBeInstanceOf(AppInProgressError);

        const cloned = (execFile as unknown as jest.Mock).mock.calls.some((c) =>
          (c[1] as string[]).includes('clone')
        );
        expect(cloned).toBe(false);
      });

      it('serialises two redeploys of one app: their clone-and-land never overlap, and isCloning holds until the last ends', async () => {
        const appName = 'land-serial';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        mockCloneMaxActive = 0;
        let release!: () => void;
        mockCloneGate = new Promise<void>((r) => {
          release = r;
        });

        const first = service.redeploy(appName);
        const second = service.redeploy(appName);
        // Both are admitted and waiting; the gate keeps the first clone open.
        await new Promise((r) => setTimeout(r, 50));
        expect(service.isCloning(appName)).toBe(true);
        release();
        mockCloneGate = null;
        await Promise.all([first, second]);

        expect(mockCloneMaxActive).toBe(1);
        expect(service.isCloning(appName)).toBe(false);
      });

      it('the platform sweeps leftovers from the clone base at initialize(); a CLI process never does', async () => {
        const leftover = path.join(tempDir, 'temp', '.git-clones', 'crashed-abc');
        await fs.mkdir(leftover, { recursive: true });

        await service.initialize(); // no sweepCloneBase: the CLI shape
        expect(await exists(leftover)).toBe(true);

        const platformShaped = new GitDeployService({
          appsDirectory: path.join(tempDir, 'webapps'),
          sweepCloneBase: true,
        });
        await platformShaped.initialize();
        expect(await exists(leftover)).toBe(false);
      });

      it('holds the platform reservation across clone and land, and releases it before app:update', async () => {
        const appName = 'land-reserved';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        let open!: () => void;
        mockCloneGate = new Promise<void>((r) => {
          open = r;
        });
        const heldAtPublish: boolean[] = [];
        const unsub = eventBus.subscribe('app:update', (p) => {
          if (p.name === appName) heldAtPublish.push(reservedNow.has(appName));
        });
        try {
          const run = service.redeploy(appName);
          await new Promise((r) => setTimeout(r, 50));
          // The clone is open: the slot is ours, so a build could not start.
          expect(reservedNow.has(appName)).toBe(true);
          open();
          mockCloneGate = null;
          await run;
        } finally {
          unsub();
        }

        expect(heldAtPublish).toEqual([false]);
        expect(reservedNow.has(appName)).toBe(false);
      });

      it('reserves BEFORE charging the deploy quota: a refused attempt costs nothing', async () => {
        const appName = 'land-no-charge';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        const admit = jest.spyOn(breakerModule, 'admitDeploy');
        admit.mockClear();
        try {
          reservedNow.add(appName);
          await expect(service.redeploy(appName)).rejects.toBeInstanceOf(AppInProgressError);
          reservedNow.clear();
          installOps({ hasLiveBuildContainer: jest.fn().mockResolvedValue(true) });
          await expect(service.redeploy(appName)).rejects.toBeInstanceOf(AppInProgressError);

          expect(admit).not.toHaveBeenCalled();
        } finally {
          admit.mockRestore();
        }
      });

      it('a first deploy appears in the apps folder whole, in one step, never half-landed', async () => {
        const appName = 'land-atomic-first';
        mockCloneFiles = { 'index.html': '<h1>v1</h1>', 'src/app.js': 'v1' };
        let open!: () => void;
        mockCloneGate = new Promise<void>((r) => {
          open = r;
        });

        const run = service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        await new Promise((r) => setTimeout(r, 50));
        expect(await exists(appDir(appName))).toBe(false);
        open();
        mockCloneGate = null;
        await run;

        expect(await fs.readFile(path.join(appDir(appName), 'src', 'app.js'), 'utf-8')).toBe('v1');
        expect(await exists(path.join(appDir(appName), '.git'))).toBe(false);
        // No staging directory is left in the clone base.
        const base = path.join(tempDir, 'temp', '.git-clones');
        expect(await fs.readdir(base).catch(() => [])).toEqual([]);
        // The saved list was written for the next redeploy.
        expect(await exists(path.join(tempDir, 'drop-svc', 'git-manifests', `${appName}.json`))).toBe(true);
      });

      it('a first deploy refused as busy (quiesced, or a stale build container) is an AppInProgressError', async () => {
        installOps({ tryReserveApp: () => null });
        await expect(
          service.deploy({ repoUrl: 'https://github.com/user/land-first-busy', branch: 'main' })
        ).rejects.toBeInstanceOf(AppInProgressError);
        expect(getStateManager().hasApp('land-first-busy')).toBe(false);
        expect(await exists(appDir('land-first-busy'))).toBe(false);

        installOps({ hasLiveBuildContainer: jest.fn().mockResolvedValue(true) });
        await expect(
          service.deploy({ repoUrl: 'https://github.com/user/land-first-busy', branch: 'main' })
        ).rejects.toBeInstanceOf(AppInProgressError);
        expect(reservedNow.size).toBe(0);
      });

      it('queued redeploys are saved to disk and come back after a restart', async () => {
        const appName = 'land-queue-persist';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });

        service.queueRedeploy(appName, { automation: 'webhook' });
        await new Promise((r) => setTimeout(r, 50));
        const file = path.join(tempDir, 'drop-svc', 'git-pending-redeploys.json');
        expect(JSON.parse(await fs.readFile(file, 'utf-8'))).toEqual({
          [appName]: { automation: 'webhook' },
        });
        service.dispose();

        const restarted = new GitDeployService({
          appsDirectory: path.join(tempDir, 'webapps'),
          resumeQueue: true,
        });
        await restarted.initialize();
        expect((restarted as unknown as { pending: Map<string, unknown> }).pending.has(appName)).toBe(true);
        restarted.dispose();

        // A CLI-shaped service does not pick the queue up.
        const cli = new GitDeployService({ appsDirectory: path.join(tempDir, 'webapps') });
        await cli.initialize();
        expect((cli as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
        cli.dispose();
      });

      it('a queued redeploy that fails is recorded as a failed deploy and in the activity log', async () => {
        const appName = 'land-queue-fails';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        resetDeployTracker();
        getDeployTracker(path.join(tempDir, 'deploys.json'));
        const logSpy = jest.spyOn(activity, 'logActivityFor').mockResolvedValue();
        const failed: Array<{ appId: string }> = [];
        const unsub = eventBus.subscribe('build:failed', (p) => {
          failed.push({ appId: p.appId });
        });
        try {
          service.queueRedeploy(appName, { automation: 'webhook' });
          failNextPull('fatal: repository not found');

          await (service as unknown as { flushPending(): Promise<void> }).flushPending();

          expect(logSpy).toHaveBeenCalledTimes(1);
          expect(logSpy.mock.calls[0][1]).toMatchObject({ action: 'redeploy', appName });
          expect(String(logSpy.mock.calls[0][1].detail)).toContain('queued redeploy failed');
          expect(failed).toEqual([{ appId: appName }]);
        } finally {
          unsub();
          logSpy.mockRestore();
          resetDeployTracker();
          service.dispose();
        }
      });

      it('a failure listing the tracked files carries no argv or absolute path either', async () => {
        const appName = 'land-lsfiles-fails';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        const mock = execFile as unknown as jest.Mock;
        const original = mock.getMockImplementation() as (...a: unknown[]) => unknown;
        mock.mockImplementation((cmd: string, args: string[], opts: unknown, cb?: Function) => {
          if (Array.isArray(args) && args.includes('ls-files')) {
            mock.mockImplementation(original);
            const callback = (cb || opts) as (e: Error) => void;
            callback(
              Object.assign(new Error('Command failed: git ' + args.join(' ') + ' in ' + tempDir), {
                code: 128,
                stderr: 'fatal: index file corrupt',
              })
            );
            return {} as unknown;
          }
          return original(cmd, args, opts, cb);
        });

        const err = await service.redeploy(appName).catch((e: Error) => e);

        expect((err as Error).message).toContain('exit 128');
        expect((err as Error).message).not.toContain('ls-files');
        expect((err as Error).message).not.toContain(tempDir);
      });

      it('refuses to land while the reservation is taken, a build container is alive, or a monorepo child is busy', async () => {
        const appName = 'land-refused';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        (execFile as unknown as jest.Mock).mockClear();

        reservedNow.add(appName);
        await expect(service.redeploy(appName)).rejects.toBeInstanceOf(AppInProgressError);
        reservedNow.clear();

        installOps({ hasLiveBuildContainer: jest.fn().mockResolvedValue(true) });
        await expect(service.redeploy(appName)).rejects.toBeInstanceOf(AppInProgressError);
        // The failed attempt released what it took.
        expect(reservedNow.has(appName)).toBe(false);

        const cloned = (execFile as unknown as jest.Mock).mock.calls.some((c) =>
          (c[1] as string[]).includes('clone')
        );
        expect(cloned).toBe(false);

        const group = 'grp';
        await getStateManager().registerApp('grp-container', path.join(tempDir, 'webapps', 'grp-container'));
        await getStateManager().updateApp('grp-container', {
          group,
          isGroupContainer: true,
          gitSource: { repoUrl: 'https://github.com/user/grp', branch: 'main' },
        } as Record<string, unknown>);
        await getStateManager().registerApp('grp-child', path.join(tempDir, 'webapps', 'grp-child'));
        await getStateManager().updateApp('grp-child', { group } as Record<string, unknown>);
        installOps({ isAppInProgress: (n: string) => n === 'grp-child' });
        await expect(service.redeploy('grp-container')).rejects.toBeInstanceOf(AppInProgressError);
      });

      it('fails closed when platform operations are unavailable, as a busy-kind error', async () => {
        const appName = 'land-no-ops';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        resetPlatformOps();

        const err = await service.redeploy(appName).catch((e: Error) => e);
        expect(err).toBeInstanceOf(PlatformNotReadyError);
        expect(err).toBeInstanceOf(AppInProgressError);
        expect((err as Error).message).toMatch(/unavailable/);
      });

      it('the queue keeps its entries while the platform has not published its operations (boot) or has withdrawn them (shutdown)', async () => {
        const appName = 'land-queue-boot';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        const pending = (): Map<string, unknown> =>
          (service as unknown as { pending: Map<string, unknown> }).pending;
        const flush = (): Promise<void> =>
          (service as unknown as { flushPending(): Promise<void> }).flushPending();
        const redeploy = jest.spyOn(service, 'redeploy');
        const failures: string[] = [];
        const unsub = eventBus.subscribe('build:failed', (p) => {
          failures.push(p.appId);
        });
        try {
          // Boot: the timer fires before setPlatformOps.
          resetPlatformOps();
          service.queueRedeploy(appName, { automation: 'webhook' });
          await flush();
          expect(redeploy).not.toHaveBeenCalled();
          expect(pending().has(appName)).toBe(true);
          expect(failures).toEqual([]);

          // Shutdown race: the operations vanish after the flush started.
          installOps();
          redeploy.mockRejectedValueOnce(new PlatformNotReadyError(appName));
          await flush();
          expect(pending().has(appName)).toBe(true);
          expect(failures).toEqual([]);

          // Once ready, it runs and leaves the queue.
          redeploy.mockRestore();
          await flush();
          expect(pending().has(appName)).toBe(false);
        } finally {
          unsub();
          service.dispose();
        }
      });

      it('a first deploy is staged inside the apps folder (one volume) under a hidden name, and renamed into place', async () => {
        const appName = 'land-stage-parent';
        const rename = jest.spyOn(require('fs/promises'), 'rename');
        try {
          await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
          const call = rename.mock.calls.find((c) => String(c[1]) === appDir(appName));
          expect(call).toBeDefined();
          expect(path.dirname(String(call![0]))).toBe(path.join(tempDir, 'webapps'));
          expect(path.basename(String(call![0])).startsWith('.drop-stage-')).toBe(true);
        } finally {
          rename.mockRestore();
        }
      });

      it('only EEXIST/ENOTEMPTY mean "already exists"; any other rename error surfaces as it is', async () => {
        const realFs = require('fs/promises');
        const original = realFs.rename.bind(realFs);
        const rename = jest.spyOn(realFs, 'rename');
        // Fail only the rename INTO the app folder (the platform's own atomic
        // state writes also rename, and must keep working).
        const failInto = (name: string, code: string): void => {
          rename.mockImplementation(async (from: unknown, to: unknown) => {
            if (String(to) === appDir(name)) {
              throw Object.assign(new Error(`${code}: simulated`), { code });
            }
            return original(from, to);
          });
        };
        try {
          failInto('land-rename-a', 'EEXIST');
          await expect(
            service.deploy({ repoUrl: 'https://github.com/user/land-rename-a', branch: 'main' })
          ).rejects.toThrow(/already exists/);

          failInto('land-rename-b', 'EPERM');
          const err = await service
            .deploy({ repoUrl: 'https://github.com/user/land-rename-b', branch: 'main' })
            .catch((e: Error) => e);
          expect((err as Error).message).toContain('EPERM');
          expect((err as Error).message).not.toMatch(/already exists/);
        } finally {
          rename.mockRestore();
        }
      });

      it('the platform removes a stage left by a crashed first deploy at boot', async () => {
        const leftover = path.join(tempDir, 'webapps', '.drop-stage-crashed-abc123');
        await fs.mkdir(leftover, { recursive: true });

        const platformShaped = new GitDeployService({
          appsDirectory: path.join(tempDir, 'webapps'),
          sweepCloneBase: true,
        });
        await platformShaped.initialize();

        expect(await exists(leftover)).toBe(false);
      });

      it('a push refused as busy is queued (latest wins) and runs once the app is free', async () => {
        const appName = 'land-queued';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        installOps({ isAppInProgress: () => true });
        await expect(service.redeploy(appName, { automation: 'webhook' })).rejects.toBeInstanceOf(
          AppInProgressError
        );
        service.queueRedeploy(appName, { automation: 'webhook' });
        service.queueRedeploy(appName, { automation: 'webhook' });
        mockCloneFiles = { 'index.html': '<h1>queued</h1>' };
        const flush = (): Promise<void> =>
          (service as unknown as { flushPending(): Promise<void> }).flushPending();

        await flush(); // still busy: stays queued
        expect(await exists(path.join(appDir(appName), 'queued.txt'))).toBe(false);
        expect(await fs.readFile(path.join(appDir(appName), 'index.html'), 'utf-8')).toBe('<h1>v1</h1>');

        installOps();
        await flush();
        expect(await fs.readFile(path.join(appDir(appName), 'index.html'), 'utf-8')).toBe('<h1>queued</h1>');
        service.dispose();
      });

      it('a first deploy that loses the folder race leaves the other creator\'s folder alone', async () => {
        const appName = 'land-race';
        let open!: () => void;
        mockCloneGate = new Promise<void>((r) => {
          open = r;
        });

        const run = service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        await new Promise((r) => setTimeout(r, 50));
        // Someone else takes the folder while the clone is in flight.
        await fs.mkdir(appDir(appName), { recursive: true });
        await fs.writeFile(path.join(appDir(appName), 'theirs.txt'), 'not ours');
        open();
        mockCloneGate = null;

        await expect(run).rejects.toThrow(/already exists/);
        expect(await fs.readFile(path.join(appDir(appName), 'theirs.txt'), 'utf-8')).toBe('not ours');
      });

      it('a clone error carries no argv or absolute temp path', async () => {
        const appName = 'land-error-text';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        const mock = execFile as unknown as jest.Mock;
        const original = mock.getMockImplementation() as (...a: unknown[]) => unknown;
        mock.mockImplementation((cmd: string, args: string[], opts: unknown, cb?: Function) => {
          if (Array.isArray(args) && args.includes('clone')) {
            mock.mockImplementation(original);
            const callback = (cb || opts) as (e: Error) => void;
            callback(
              Object.assign(new Error('Command failed: git clone ' + args.join(' ')), {
                code: 128,
                stderr: 'fatal: could not read from remote repository',
              })
            );
            return {} as unknown;
          }
          return original(cmd, args, opts, cb);
        });

        const err = await service.redeploy(appName).catch((e: Error) => e);

        expect((err as Error).message).toContain('exit 128');
        expect((err as Error).message).not.toContain('--depth');
        expect((err as Error).message).not.toContain(tempDir);
      });
    });

    describe('token attach (DROP-142)', () => {
      it('a successfully attached tokenId is persisted after a SUCCESSFUL pull — the inverted case', async () => {
        // A naive fix that spreads the STALE captured `app.gitSource` when
        // building the post-pull update would silently revert this attach on
        // exactly this path; a test that only covers a failing pull cannot
        // catch that (see the test below and the comment on git-deploy.ts).
        const appName = 'redeploy-attach-success';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        await makeGitDir(appName);
        const stored = await service.setToken('recovery-token', 'ghp_recoveryvalue');

        const result = await service.redeploy(appName, { tokenId: stored.id });

        expect(result.appName).toBe(appName);
        const app = getStateManager().getApp(appName);
        expect(app?.gitSource?.tokenId).toBe(stored.id);
      });

      it('attaching a tokenId whose pull then FAILS does not persist the attach — resend it on retry', async () => {
        // redeploy() writes gitSource exactly once, after a successful pull —
        // there is no separate pre-pull write to revert. On a failing pull the
        // function throws before that write is ever reached, so a fresh
        // attach requested on THIS call is not recorded; a caller must resend
        // tokenId on the next attempt.
        const appName = 'redeploy-attach-fails';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        await makeGitDir(appName);
        const stored = await service.setToken('doomed-token', 'ghp_doomedvalue');

        failNextPull();

        await expect(service.redeploy(appName, { tokenId: stored.id })).rejects.toThrow();
        const app = getStateManager().getApp(appName);
        expect(app?.gitSource?.tokenId).toBeUndefined();
      });

      it('an already-stored tokenId survives a redeploy call whose pull fails (no unrelated token change)', async () => {
        // Complements the test above: a redeploy that does NOT request a
        // token change (actor.tokenId omitted) and then fails must not wipe
        // out a token attached by an earlier, successful redeploy.
        const appName = 'redeploy-keeps-token-on-fail';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        await makeGitDir(appName);
        const stored = await service.setToken('kept-token', 'ghp_keptvalue');
        await service.redeploy(appName, { tokenId: stored.id });
        expect(getStateManager().getApp(appName)?.gitSource?.tokenId).toBe(stored.id);

        failNextPull();

        await expect(service.redeploy(appName)).rejects.toThrow();
        expect(getStateManager().getApp(appName)?.gitSource?.tokenId).toBe(stored.id);
      });

      it('tokenId: null clears a previously attached token', async () => {
        const appName = 'redeploy-clear-token';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        await makeGitDir(appName);
        const stored = await service.setToken('to-clear', 'ghp_toclear');
        await service.redeploy(appName, { tokenId: stored.id });
        expect(getStateManager().getApp(appName)?.gitSource?.tokenId).toBe(stored.id);

        await service.redeploy(appName, { tokenId: null });

        const app = getStateManager().getApp(appName);
        expect(app?.gitSource?.tokenId).toBeUndefined();
        // Cleared as `undefined`, never persisted as the literal string "null".
        expect(app?.gitSource?.tokenId).not.toBe('null');
      });

      it('a CLEAR survives a pull that then fails — revocation is not a deploy outcome', async () => {
        // The asymmetry with the attach direction, and the reason for it: a
        // cleared credential makes the very next pull unauthenticated, so on
        // a private repo that pull throws. If the clear were written only
        // after a successful pull (as the attach is), it would be discarded
        // every single time and there would be NO route to detach a
        // compromised PAT short of hand-editing apps.json.
        const appName = 'redeploy-clear-survives-failure';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        await makeGitDir(appName);
        const stored = await service.setToken('leaked-token', 'ghp_leaked');
        await service.redeploy(appName, { tokenId: stored.id });
        expect(getStateManager().getApp(appName)?.gitSource?.tokenId).toBe(stored.id);

        failNextPull();

        await expect(service.redeploy(appName, { tokenId: null })).rejects.toThrow();
        expect(getStateManager().getApp(appName)?.gitSource?.tokenId).toBeUndefined();
      });

      it('a tokenId supplied on THIS request that resolves to nothing is rejected, not warned past', async () => {
        // deploy() throws for the identical condition. Warning past it here
        // returned 200 while persisting a dangling reference, which then
        // degraded every later unattended webhook redeploy to unauthenticated.
        const appName = 'redeploy-unknown-token';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        await makeGitDir(appName);

        await expect(
          service.redeploy(appName, { tokenId: 'git_doesnotexist' })
        ).rejects.toThrow(/GitHub token 'git_doesnotexist' not found/);
        expect(getStateManager().getApp(appName)?.gitSource?.tokenId).toBeUndefined();
      });

      it('an INHERITED tokenId that no longer resolves still redeploys, unauthenticated', async () => {
        // The other half of the provenance branch: the operator deleted the
        // token from the store after attaching it. Refusing to redeploy an
        // existing app over that is worse than trying — and a public repo
        // still pulls fine.
        const appName = 'redeploy-inherited-missing-token';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        await makeGitDir(appName);
        const stored = await service.setToken('vanishing', 'ghp_vanishing');
        await service.redeploy(appName, { tokenId: stored.id });
        await service.removeToken(stored.id);

        await expect(service.redeploy(appName)).resolves.toBeDefined();
      });

      it('an omitted tokenId leaves a previously attached token unchanged', async () => {
        const appName = 'redeploy-leave-token';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        await makeGitDir(appName);
        const stored = await service.setToken('unchanged', 'ghp_unchanged');
        await service.redeploy(appName, { tokenId: stored.id });

        await service.redeploy(appName);

        expect(getStateManager().getApp(appName)?.gitSource?.tokenId).toBe(stored.id);
      });

      it('a redeploy with no actor at all (webhook shape) is unaffected by the tokenId change', async () => {
        // routes/git-deploy.ts's webhook handler calls redeploy(appName,
        // { automation: 'webhook' }) with no tokenId — must keep working
        // exactly as before.
        const appName = 'redeploy-webhook-app';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        await makeGitDir(appName);

        const result = await service.redeploy(appName, { automation: 'webhook' });

        expect(result.appName).toBe(appName);
        expect(getStateManager().getApp(appName)?.gitSource?.tokenId).toBeUndefined();
      });

      it('leaves no token text in any execFile argv (ps-visibility)', async () => {
        const appName = 'redeploy-no-argv-leak';
        await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
        await makeGitDir(appName);
        const secretValue = 'ghp_totallysecretvalue';
        const stored = await service.setToken('argv-check', secretValue);

        await service.redeploy(appName, { tokenId: stored.id });

        for (const call of (execFile as unknown as jest.Mock).mock.calls) {
          const args = (call[1] ?? []) as string[];
          for (const arg of args) {
            expect(String(arg)).not.toContain(secretValue);
          }
        }
      });

      it('a monorepo child resolution invariant: redeploying the container writes gitSource there, never to a sibling child', async () => {
        // Mirrors what routes/git-deploy.ts does (resolve a child to its
        // container, then call redeploy(target.name, ...)) at the service
        // level, with a REAL state manager rather than a mocked route.
        const sm = getStateManager();
        await sm.registerApp('grp-container', path.join(tempDir, 'webapps', 'grp-container'));
        await sm.updateApp('grp-container', {
          group: 'grp',
          isGroupContainer: true,
          gitSource: {
            repoUrl: 'https://github.com/acme/grp',
            branch: 'main',
            autoRedeploy: true,
          },
        });
        await sm.registerApp('grp-child', path.join(tempDir, 'webapps', 'grp-child'));
        await fs.mkdir(path.join(tempDir, 'webapps', 'grp-container', '.git'), { recursive: true });
        const stored = await service.setToken('group-token', 'ghp_groupvalue');

        await service.redeploy('grp-container', { tokenId: stored.id });

        expect(sm.getApp('grp-container')?.gitSource?.tokenId).toBe(stored.id);
        expect(sm.getApp('grp-child')?.gitSource).toBeUndefined();
      });
    });
  });

  describe('attached tokenId survives a platform restart (DROP-142)', () => {
    // gitSource has no second store (unlike port, mirrored into
    // data/appconf/webapps/): it lives ONLY in apps.json. A fresh
    // StateManager instance re-reading that file IS the persistence boundary
    // a platform restart crosses.
    it('is present after a fresh StateManager reloads apps.json, and survives boot reconciliation re-registering the app', async () => {
      const appName = 'redeploy-restart-app';
      await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
      await fs.mkdir(path.join(tempDir, 'webapps', appName, '.git'), { recursive: true });
      const stored = await service.setToken('restart-token', 'ghp_restartvalue');
      await service.redeploy(appName, { tokenId: stored.id });

      // Flush the debounced save and tear down the live instance, mirroring
      // an actual shutdown.
      await getStateManager().close();

      const stateFilePath = path.join(tempDir, 'apps.json');
      const reloaded = new AppStateManager({ stateFilePath });
      await reloaded.initialize();
      expect(reloaded.getApp(appName)?.gitSource?.tokenId).toBe(stored.id);

      // Boot reconciliation's syncStateWithConfigs calls registerApp() for
      // every app on every boot, which MERGES over the existing entry
      // (`...existing`) rather than rebuilding it from a literal — confirm
      // that pass doesn't drop the attach either.
      await reloaded.registerApp(appName, path.join(tempDir, 'webapps', appName));
      expect(reloaded.getApp(appName)?.gitSource?.tokenId).toBe(stored.id);

      await reloaded.close();
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

  /**
   * The same write-ordering seam as upload-deploy: these flags are set before
   * `app:detected` is published, so the app's config does not exist yet and
   * `updateConfig` silently wrote nothing. Asserted through a fresh service
   * loading from disk, because every consumer reads the config after a restart.
   */
  describe('per-app flag persistence (config write ordering)', () => {
    let configDir: string;
    let webappsDir: string;

    beforeEach(async () => {
      configDir = path.join(tempDir, 'appconf');
      webappsDir = path.join(tempDir, 'webapps');
      resetAppConfigService();
      await getAppConfigService({ configDir, webappsDir }).initialize();
    });

    afterEach(() => {
      resetAppConfigService();
    });

    async function reloadConfig(appName: string) {
      const fresh = new AppConfigService({ configDir, webappsDir });
      await fresh.initialize();
      return fresh.getConfig(appName);
    }

    it('persists agentCreated and the ephemeral deadline for a cloned app', async () => {
      await service.deploy({
        repoUrl: 'https://github.com/user/eph-clone',
        userId: 'user-1',
        principalId: 'oauth:sub-1::sid-1',
        agentCaller: true,
        ephemeral: true,
        ttlMinutes: 5,
      });

      // git is mocked here, so the clone never creates the app folder — and a
      // fresh service's cleanupStaleConfigs would (correctly) delete a config
      // whose app directory is missing. A real clone lands this directory.
      await fs.mkdir(path.join(webappsDir, 'eph-clone'), { recursive: true });

      const config = await reloadConfig('eph-clone');
      expect(config?.agentCreated).toBe(true);
      expect(config?.ephemeral).toBe(true);
      expect(config?.ephemeralPrincipalId).toBe('oauth:sub-1::sid-1');
      expect(new Date(config?.expiresAt ?? '').getTime()).toBeGreaterThan(Date.now());
    });
  });
});
