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
import { eventBus } from '../event-bus';
// AppUpdatePayload isn't re-exported by ../event-bus (index.ts) - see the same
// note in managers/deploy-tracker/deploy-tracker.ts.
import type { AppDetectedPayload, AppUpdatePayload } from '../event-bus/event-bus.types';

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
      callback(null, { stdout: '', stderr: '' });
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
     * Make the next `git pull` fail, whatever else redeploy() runs around it.
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
        if (!fired && Array.isArray(args) && args.includes('pull')) {
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

    it('rejects fast when .git is missing on disk, without attempting a pull (Fix 4)', async () => {
      const appName = 'redeploy-no-git-app';
      await service.deploy({ repoUrl: `https://github.com/user/${appName}`, branch: 'main' });
      // Deliberately do NOT create .git — simulates an upload-deploy prune or
      // a monorepo re-materialization that removed the real repository while
      // gitSource stayed behind in state.

      const pullCallsBefore = (execFile as unknown as jest.Mock).mock.calls.filter(
        (call) => call[1]?.[0] === 'pull' || call[1]?.includes('pull')
      ).length;

      await expect(service.redeploy(appName)).rejects.toThrow(/has no git repository on disk/);

      const pullCallsAfter = (execFile as unknown as jest.Mock).mock.calls.filter(
        (call) => call[1]?.[0] === 'pull' || call[1]?.includes('pull')
      ).length;
      expect(pullCallsAfter).toBe(pullCallsBefore);
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
