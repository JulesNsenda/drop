/**
 * Boot must not rebuild a monorepo child that is already running, current and
 * routed (docs/plans/2026-10-26-monorepo-boot-outage.md).
 *
 * The bug: the watcher's initial scan reports the container folder as new on
 * every boot, so `handleAppDetected` -> `expandMonorepo` re-copied and rebuilt
 * every child even when nothing had changed — and a static child serves
 * nothing while it rebuilds.
 *
 * Two halves work together and both are exercised here end to end:
 *   - boot reconcile (mode 'on') decides each group child like an ordinary app
 *     and records the ones it would skip in `bootCurrentChildren`;
 *   - `expandMonorepo` leaves such a child alone only when the call is the
 *     watcher's first sight AND the child's `groupSourceHash` still matches.
 *
 * The "was it rebuilt?" signal is deliberately twofold: `handleAppUpdate` is
 * the build dispatch, and a sentinel file planted in the child folder (not in
 * the source) survives only if `syncTree` never ran, since the sync prunes
 * whatever the source does not have.
 *
 * fs, the state manager and AppConfigService are REAL, under a temp root; the
 * runtime, watcher, routing and build dispatch are stubbed.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import { DropPlatform, createPlatform, decideBootReconciliationCheap } from './platform';
import { getStateManager, resetStateManager, AppStateManager } from '../managers/app/state-manager';
import { AppConfigService } from '../managers/app/app-config';
import * as treeSync from '../utils/tree-sync';

const repoName = 'ezsign';
const childName = 'ezsign-frontend';
const ROOT_YAML = 'name: ezsign\nservices:\n  frontend:\n    path: frontend\n    type: static\n';
const rootYamlFor = (services: string[], withType = true) =>
  'name: ezsign\nservices:\n' +
  services
    .map((n) => `  ${n}:\n    path: ${n}\n${withType ? '    type: static\n' : ''}`)
    .join('');

describe('monorepo children at boot', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let appsDir: string;
  let repoPath: string;
  let childPath: string;
  let stateManager: AppStateManager;
  let acs: AppConfigService;
  let handleAppUpdate: jest.Mock;
  let realHandleAppUpdate: (...args: unknown[]) => Promise<void>;
  let handleBuildApp: jest.Mock;
  let handleConfigureRoute: jest.Mock;
  let armPostDeployWatches: jest.Mock;
  let publish: jest.SpyInstance;
  let fingerprint: jest.Mock;
  let staleDeps: jest.Mock;
  let runtimeStatus: Array<{ name: string; status: string; port: number }>;

  const priv = () => platform as any;

  async function succeedingBuild(name: string): Promise<boolean> {
    await new Promise((r) => setTimeout(r, 3));
    await stateManager.setAppStatus(name, 'running');
    return true;
  }

  /** What handleAppUpdate does when the rebuild fails: 'running' again, WITH an error, and false. */
  async function failingBuild(name: string): Promise<boolean> {
    await new Promise((r) => setTimeout(r, 3));
    await stateManager.setAppStatus(name, 'running', { error: 'Build failed: boom' });
    return false;
  }

  function newConfigService(): AppConfigService {
    return new AppConfigService({
      configDir: path.join(tempDir, 'appconf'),
      webappsDir: appsDir,
    });
  }

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `drop-monorepo-boot-skip-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    appsDir = path.join(tempDir, 'apps');
    repoPath = path.join(appsDir, repoName);
    childPath = path.join(appsDir, childName);
    await fs.mkdir(path.join(repoPath, 'frontend'), { recursive: true });
    await fs.writeFile(path.join(repoPath, 'drop.yaml'), ROOT_YAML);
    await fs.writeFile(path.join(repoPath, 'frontend', 'index.html'), '<h1>v1</h1>');

    resetStateManager();
    stateManager = getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    await stateManager.initialize();
    acs = newConfigService();
    await acs.initialize();

    // A realistic deploy: it reports success the way handleAppUpdate does,
    // by stamping 'running' on the child and returning true.
    handleAppUpdate = jest.fn(succeedingBuild);
    realHandleAppUpdate = (DropPlatform.prototype as any).handleAppUpdate;
    handleBuildApp = jest.fn().mockResolvedValue(undefined);
    handleConfigureRoute = jest.fn().mockResolvedValue(undefined);
    armPostDeployWatches = jest.fn();
    fingerprint = jest.fn().mockReturnValue('fp');
    staleDeps = jest.fn().mockResolvedValue(false);
    runtimeStatus = [];

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: appsDir,
      logLevel: 'error',
      autoBuild: true,
      bootReconcileMode: 'on',
    });
    priv().stateManager = stateManager;
    priv().appConfigService = acs;
    priv().handleAppUpdate = handleAppUpdate;
    priv().handleBuildApp = handleBuildApp;
    priv().handleConfigureRoute = handleConfigureRoute;
    priv().armPostDeployWatches = armPostDeployWatches;
    priv().reloadCaddyIfRunning = jest.fn().mockResolvedValue('ok');
    priv().servingTreeIsStale = staleDeps;
    priv().probeSkipReadiness = jest.fn().mockResolvedValue(true);
    priv().secretManager = { fingerprint };
    priv().watcher = { markAppKnown: jest.fn() };
    priv().runtime = { getAllStatus: jest.fn(async () => runtimeStatus) };
    publish = jest.spyOn(priv().eventBus, 'publish');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await stateManager.close();
    resetStateManager();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
      () => undefined
    );
  });

  // `initialScan` defaults to what the watcher's ready scan sends: only that
  // detection may leave a current child unbuilt.
  const detect = (origin?: 'watcher' | 'upload', initialScan = origin === 'watcher') =>
    priv().handleAppDetected({
      name: repoName,
      path: repoPath,
      type: undefined,
      origin,
      ...(initialScan ? { initialScan: true } : {}),
    });
  const reconcile = (mode: 'on' | 'off' | 'observe' = 'on') => {
    priv().config.bootReconcileMode = mode;
    return priv().reconcileAppsOnBoot();
  };
  const bootCurrent = (): string[] => [...priv().bootCurrentChildren];
  const exists = (p: string) =>
    fs.lstat(p).then(
      () => true,
      () => false
    );
  const sentinel = () => path.join(childPath, 'marker.txt');
  const childPublished = () =>
    publish.mock.calls.some((c) => c[0] === 'app:detected' && c[1]?.name === childName);

  /**
   * A child that was deployed earlier and is running now: first expansion
   * (new child, so it takes handleBuildApp), then the state/config a real
   * deploy would have left behind. Recorded AFTER the sentinel so the child's
   * own signature (the reconcile decision) matches the tree as it stands.
   */
  async function seedRunningChild(services = ['frontend'], withType = true): Promise<void> {
    await fs.writeFile(path.join(repoPath, 'drop.yaml'), rootYamlFor(services, withType));
    for (const svc of services) {
      await fs.mkdir(path.join(repoPath, svc), { recursive: true });
      await fs.writeFile(path.join(repoPath, svc, 'index.html'), `<h1>${svc}</h1>`);
    }
    // First sight: every child is new, so it takes handleBuildApp and records
    // no fingerprint (a first-ever child is fingerprinted by the NEXT rebuild).
    await detect('watcher');
    expect(handleBuildApp).toHaveBeenCalledTimes(services.length);
    for (const svc of services) {
      await stateManager.updateApp(`ezsign-${svc}`, { status: 'running', port: 4001 });
    }
    // The rebuild a running child gets, which records the fingerprint.
    await detect('watcher', false);
    runtimeStatus = [];
    for (const svc of services) {
      const name = `ezsign-${svc}`;
      const dir = path.join(appsDir, name);
      expect(acs.getConfig(name)?.groupSourceHash).toBeDefined();
      await fs.writeFile(path.join(dir, 'marker.txt'), 'planted after the sync — a re-sync would prune it');
      // The signature a real deploy records, so the seeded fingerprints stay in
      // step with production (source hash, secret set, runtime spec revision).
      await priv().recordDeploySignature(name, dir);
      await acs.upsertSystemConfig(name, { port: 4001 });
      runtimeStatus.push({ name, status: 'running', port: 4001 });
    }
    handleBuildApp.mockClear();
    handleAppUpdate.mockClear();
    handleConfigureRoute.mockClear();
    armPostDeployWatches.mockClear();
    publish.mockClear();
  }

  const wasRebuilt = async () =>
    handleAppUpdate.mock.calls.some((c) => c[0] === childName) &&
    !(await exists(sentinel()));

  describe('a running, current child', () => {
    it('is left alone: routed and watched by reconcile, not copied, not rebuilt', async () => {
      await seedRunningChild();
      const yamlBefore = await fs.readFile(path.join(childPath, 'drop.yaml'), 'utf-8');
      const recordSignature = jest.spyOn(priv(), 'recordDeploySignature');

      await reconcile();
      expect(bootCurrent()).toEqual([childName]);
      expect(handleConfigureRoute).toHaveBeenCalledWith(childName, 4001, { skipCaddyReload: true });
      expect(armPostDeployWatches).toHaveBeenCalledWith(childName, 4001, undefined);
      expect(childPublished()).toBe(false);

      await detect('watcher');

      expect(handleAppUpdate).not.toHaveBeenCalled();
      expect(handleBuildApp).not.toHaveBeenCalled();
      expect(await exists(sentinel())).toBe(true);
      expect(await fs.readFile(path.join(childPath, 'drop.yaml'), 'utf-8')).toBe(yamlBefore);
      expect(recordSignature).not.toHaveBeenCalled();
      // Metadata still runs, and the verdict is consumed.
      expect(stateManager.getApp(childName)?.group).toBe(repoName);
      expect(acs.getConfig(childName)?.group).toBe(repoName);
      expect(bootCurrent()).toEqual([]);
    });

    it('is rebuilt the NEXT time the watcher sees the container (verdict is one-shot)', async () => {
      await seedRunningChild();
      await reconcile();
      await detect('watcher');
      expect(handleAppUpdate).not.toHaveBeenCalled();

      await detect('watcher');

      expect(await wasRebuilt()).toBe(true);
    });
  });

  describe('a child the container must rebuild', () => {
    /** The skip candidate's copy no longer matches its source. */
    const sourceChanges: Array<[string, () => Promise<void>]> = [
      [
        'a changed service source',
        () => fs.writeFile(path.join(repoPath, 'frontend', 'index.html'), '<h1>v2 — longer</h1>'),
      ],
      [
        'a changed root drop.yaml (what the child drop.yaml is rendered from)',
        () =>
          fs.writeFile(
            path.join(repoPath, 'drop.yaml'),
            rootYamlFor(['frontend']) + '    env:\n      FEATURE: on\n'
          ),
      ],
      [
        'a change only under vendor/',
        async () => {
          await fs.mkdir(path.join(repoPath, 'frontend', 'vendor'), { recursive: true });
          await fs.writeFile(path.join(repoPath, 'frontend', 'vendor', 'lib.js'), 'x');
        },
      ],
    ];

    it.each(sourceChanges)('copies and rebuilds it for %s', async (_label, change) => {
      await seedRunningChild();
      await reconcile();
      expect(bootCurrent()).toEqual([childName]);
      await change();

      await detect('watcher');

      expect(await wasRebuilt()).toBe(true);
      expect(handleAppUpdate).toHaveBeenCalledWith(
        childName,
        childPath,
        'monorepo re-expansion',
        true,
        expect.anything()
      );
    });

    /** Reconcile's own verdict is anything but skip: nothing may be left unbuilt. */
    const verdicts: Array<[string, () => Promise<void> | void]> = [
      ['a stale runtime spec', () => acs.upsertSystemConfig(childName, { runtimeSpecFingerprint: 'stale' })],
      ['stale dependencies', () => staleDeps.mockResolvedValue(true)],
      ['a changed secret fingerprint', () => fingerprint.mockReturnValue('rotated')],
      ['granted API scopes', () => acs.upsertSystemConfig(childName, { grantedApiScopes: ['users:create'] })],
      [
        'a crash-looping status in the boot snapshot',
        () => {
          priv().bootStatusSnapshot = new Map([[childName, 'crash-looping']]);
        },
      ],
      ['a runtime that does not report it running', () => (runtimeStatus = [])],
    ];

    it.each(verdicts)('copies and rebuilds it for %s', async (_label, arrange) => {
      await seedRunningChild();
      await arrange();

      await reconcile();
      // Reconcile never builds a child itself, whatever it decided.
      expect(childPublished()).toBe(false);
      expect(bootCurrent()).toEqual([]);

      await detect('watcher');

      expect(await wasRebuilt()).toBe(true);
    });

    it('still routes a running child whose verdict is redeploy, without publishing it', async () => {
      await seedRunningChild();
      await acs.upsertSystemConfig(childName, { runtimeSpecFingerprint: 'stale' });

      await reconcile();

      expect(handleConfigureRoute).toHaveBeenCalledWith(childName, 4001, { skipCaddyReload: true });
      expect(armPostDeployWatches).not.toHaveBeenCalled();
    });
  });

  describe('children that are not skipped by design', () => {
    it('leaves a user-stopped child alone and neither routes nor builds it', async () => {
      await seedRunningChild();
      await stateManager.updateApp(childName, { status: 'stopped' });
      runtimeStatus = []; // a stopped child is not running

      await reconcile();
      expect(bootCurrent()).toEqual([]);
      expect(handleConfigureRoute).not.toHaveBeenCalled();

      await detect('watcher');

      expect(handleAppUpdate).not.toHaveBeenCalled();
      expect(await exists(sentinel())).toBe(true);
    });

    it.each(['off', 'observe'] as const)(
      'mode %s records nothing, so the child is fully re-expanded as before',
      async (mode) => {
        await seedRunningChild();

        await reconcile(mode);
        expect(bootCurrent()).toEqual([]);
        expect(handleConfigureRoute).not.toHaveBeenCalled();
        await detect('watcher');

        expect(await wasRebuilt()).toBe(true);
      }
    );

    it.each([
      ['an upload-originated detection', 'upload' as const],
      ['a detection with no origin (git deploy, migrate-runtime)', undefined],
    ])('rebuilds every child for %s even when reconcile skipped it', async (_label, origin) => {
      await seedRunningChild();
      await reconcile();
      expect(bootCurrent()).toEqual([childName]);

      await detect(origin);

      expect(await wasRebuilt()).toBe(true);
    });

    it('rebuilds on a direct expandMonorepo call (explicit redeploy), skip candidate or not', async () => {
      await seedRunningChild();
      await reconcile();

      await priv().expandMonorepo(
        repoPath,
        repoName,
        { services: { frontend: { path: 'frontend', type: 'static' } } },
        undefined
      );

      expect(await wasRebuilt()).toBe(true);
    });
  });

  describe('the recorded fingerprint', () => {
    it('upgrade path: no hash is synced and rebuilt once, then recorded, then skipped next boot', async () => {
      await seedRunningChild();
      // A child materialized by a platform from before this change.
      await acs.upsertSystemConfig(childName, { groupSourceHash: undefined });
      acs = newConfigService();
      await acs.initialize();
      priv().appConfigService = acs;
      expect(acs.getConfig(childName)?.groupSourceHash).toBeUndefined();

      await reconcile();
      expect(bootCurrent()).toEqual([childName]);
      await detect('watcher');

      expect(await wasRebuilt()).toBe(true);

      // Persisted: a fresh service reading from disk sees it.
      const reloaded = newConfigService();
      await reloaded.initialize();
      expect(reloaded.getConfig(childName)?.groupSourceHash).toMatch(/^[0-9a-f]{64}$/);

      // The rebuilt child is running again; the next boot leaves it alone.
      acs = reloaded;
      priv().appConfigService = acs;
      await fs.writeFile(sentinel(), 'planted again');
      await stateManager.updateApp(childName, { status: 'running' });
      const sig = await priv().computeSourceMtimeMs(childPath);
      await acs.upsertSystemConfig(childName, { sourceHash: sig.hash });
      handleAppUpdate.mockClear();

      await reconcile();
      expect(bootCurrent()).toEqual([childName]);
      await detect('watcher');

      expect(handleAppUpdate).not.toHaveBeenCalled();
      expect(await exists(sentinel())).toBe(true);
    });

    it('is a system-tier field: a general upsert cannot write it', async () => {
      await seedRunningChild();
      const before = acs.getConfig(childName)?.groupSourceHash;
      expect(before).toBeDefined();

      await acs.upsertConfig(childName, { groupSourceHash: 'forged' } as never);

      expect(acs.getConfig(childName)?.groupSourceHash).toBe(before);
    });

    it('a scan error means "differs": rebuilt, with a warning that names the child', async () => {
      await seedRunningChild();
      await reconcile();
      const before = acs.getConfig(childName)?.groupSourceHash;
      const original = priv().computeSourceMtimeMs.bind(platform);
      // Only the group fingerprint passes an ignore predicate.
      jest
        .spyOn(priv(), 'computeSourceMtimeMs')
        .mockImplementation(async (...args: unknown[]) => {
          const [p, ignore] = args as [string, unknown];
          if (ignore) throw new Error('boot-reconcile scan exceeded entry cap (20000)');
          return original(p);
        });
      const warn = jest.spyOn(priv().logger, 'warn');

      await detect('watcher');

      expect(await wasRebuilt()).toBe(true);
      expect(warn.mock.calls.some((c) => String(c[0]).includes(childName))).toBe(true);
      // The stale record is cleared before the rewrite, and nothing is
      // recorded for a copy that could not be fingerprinted.
      expect(before).toBeDefined();
      expect(acs.getConfig(childName)?.groupSourceHash).toBeUndefined();
    });
  });

  describe('guard order', () => {
    it('a collision-refused child is neither fingerprinted, copied nor built', async () => {
      await seedRunningChild();
      await reconcile();
      const before = acs.getConfig(childName)?.groupSourceHash;
      // Someone else's app now owns the name — and the source changed, so a
      // skip check moved above the guard would have copied and rebuilt it.
      // The unchanged hash (a fingerprint clear sits after the guards) and the
      // source change are the load-bearing pair: either alone is also true of
      // a child that was simply skipped as current.
      await acs.upsertConfig(childName, { group: 'another-group' });
      await fs.writeFile(path.join(repoPath, 'frontend', 'index.html'), '<h1>changed source</h1>');

      await detect('watcher');

      expect(handleAppUpdate).not.toHaveBeenCalled();
      expect(await exists(sentinel())).toBe(true);
      expect(acs.getConfig(childName)?.group).toBe('another-group');
      expect(await fs.readFile(path.join(childPath, 'index.html'), 'utf-8')).toBe('<h1>frontend</h1>');
      expect(acs.getConfig(childName)?.groupSourceHash).toBe(before);
      // The refused child was never visited, so this expansion does not touch
      // its verdict: it belongs to someone else's app, not to this container.
      expect(bootCurrent()).toEqual([childName]);
    });

    it('a containment-rejected child (symlink in its tree) is neither copied nor built', async () => {
      await seedRunningChild();
      await reconcile();
      const outside = path.join(tempDir, 'outside');
      await fs.mkdir(outside, { recursive: true });
      fssync.symlinkSync(
        outside,
        path.join(repoPath, 'frontend', 'link'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      const before = acs.getConfig(childName)?.groupSourceHash;

      await detect('watcher');

      expect(handleAppUpdate).not.toHaveBeenCalled();
      expect(await exists(sentinel())).toBe(true);
      expect(acs.getConfig(childName)?.groupSourceHash).toBe(before);
      expect(bootCurrent()).toEqual([]);
    });
  });

  describe('what makes a skip candidate current', () => {
    it('only the watcher ready scan may skip: a later watcher detection rebuilds', async () => {
      await seedRunningChild();
      await reconcile();

      await detect('watcher', false);

      expect(await wasRebuilt()).toBe(true);
    });

    it('a child drop.yaml edited on disk after the verdict is not current', async () => {
      await seedRunningChild();
      await reconcile();
      expect(bootCurrent()).toEqual([childName]);
      await fs.writeFile(path.join(childPath, 'drop.yaml'), 'name: ezsign-frontend\ntype: nodejs\n');

      await detect('watcher');

      expect(await wasRebuilt()).toBe(true);
      expect(await fs.readFile(path.join(childPath, 'drop.yaml'), 'utf-8')).toContain('type: static');
    });

    it('a changed child drop.yaml generator (after an upgrade) is not current', async () => {
      await seedRunningChild();
      await reconcile();
      const render = priv().renderChildConfig.bind(platform);
      jest
        .spyOn(priv(), 'renderChildConfig')
        .mockImplementation((...args: unknown[]) => ({ ...render(...args), newField: true }));

      await detect('watcher');

      expect(await wasRebuilt()).toBe(true);
    });

    describe('the child drop.yaml on disk', () => {
      it.each([
        [
          'a symlink',
          async () => {
            const target = path.join(tempDir, 'elsewhere.yaml');
            await fs.copyFile(path.join(childPath, 'drop.yaml'), target);
            await fs.rm(path.join(childPath, 'drop.yaml'));
            fssync.symlinkSync(target, path.join(childPath, 'drop.yaml'), 'file');
          },
          process.platform === 'win32', // creating a file symlink needs privileges there
        ],
        [
          'an oversize file',
          async () => {
            await fs.appendFile(path.join(childPath, 'drop.yaml'), '#'.repeat(300 * 1024));
          },
          false,
        ],
      ])('%s is never current: re-copied and rebuilt', async (_label, tamper, skipIt) => {
        if (skipIt) return;
        await seedRunningChild();
        await reconcile();
        await tamper();

        await detect('watcher');

        expect(await wasRebuilt()).toBe(true);
      });

      (process.platform === 'win32' ? it.skip : it)('a FIFO is never current (and does not block)', async () => {
        await seedRunningChild();
        await reconcile();
        await fs.rm(path.join(childPath, 'drop.yaml'));
        require('child_process').execFileSync('mkfifo', [path.join(childPath, 'drop.yaml')]);

        await detect('watcher');

        expect(await wasRebuilt()).toBe(true);
      });

      it.each([
        ['an incidental (boot) expansion', 'watcher' as const],
        ['an explicit redeploy', undefined],
      ])('a child folder that is a link is refused outright by %s', async (_label, origin) => {
        await seedRunningChild();
        await reconcile();
        const moved = path.join(tempDir, 'moved-child');
        await fs.rename(childPath, moved);
        fssync.symlinkSync(moved, childPath, process.platform === 'win32' ? 'junction' : 'dir');
        const before = (await fs.readdir(moved)).sort();
        const yamlBefore = await fs.readFile(path.join(moved, 'drop.yaml'), 'utf-8');
        handleBuildApp.mockClear();
        await fs.writeFile(path.join(repoPath, 'frontend', 'index.html'), '<h1>changed source</h1>');

        await detect(origin);

        expect(handleAppUpdate).not.toHaveBeenCalled();
        expect(handleBuildApp).not.toHaveBeenCalled();
        // Nothing was written under the link's target.
        expect((await fs.readdir(moved)).sort()).toEqual(before);
        expect(await fs.readFile(path.join(moved, 'index.html'), 'utf-8')).toBe('<h1>frontend</h1>');
        expect(await fs.readFile(path.join(moved, 'drop.yaml'), 'utf-8')).toBe(yamlBefore);
      });
    });

    describe('the child drop.yaml as the decide phase reads it', () => {
      /** Re-record the child's own signature so only the drop.yaml read can refuse. */
      const resignChild = async () => {
        const sig = await priv().computeSourceMtimeMs(childPath);
        await acs.upsertSystemConfig(childName, { sourceHash: sig.hash });
      };

      it('a missing drop.yaml redeploys, never skips', async () => {
        await seedRunningChild();
        await fs.rm(path.join(childPath, 'drop.yaml'));
        await resignChild();

        await reconcile();

        expect(bootCurrent()).toEqual([]);
      });

      (process.platform === 'win32' ? it.skip : it)('a symlinked drop.yaml redeploys, never skips', async () => {
        await seedRunningChild();
        const target = path.join(tempDir, 'elsewhere.yaml');
        await fs.copyFile(path.join(childPath, 'drop.yaml'), target);
        await fs.rm(path.join(childPath, 'drop.yaml'));
        fssync.symlinkSync(target, path.join(childPath, 'drop.yaml'), 'file');
        await resignChild();

        await reconcile();

        expect(bootCurrent()).toEqual([]);
      });

      (process.platform === 'win32' ? it.skip : it)('a FIFO drop.yaml redeploys and does not hang', async () => {
        await seedRunningChild();
        await fs.rm(path.join(childPath, 'drop.yaml'));
        require('child_process').execFileSync('mkfifo', [path.join(childPath, 'drop.yaml')]);
        await resignChild();

        await reconcile();

        expect(bootCurrent()).toEqual([]);
      }, 10000);

      it('a VALID but comment-padded drop.yaml over 256 KiB redeploys (parseDropYaml would have accepted it)', async () => {
        await seedRunningChild();
        await fs.appendFile(path.join(childPath, 'drop.yaml'), '#'.repeat(300 * 1024));
        await resignChild();

        await reconcile();

        expect(bootCurrent()).toEqual([]);
      });

      it('an invalid drop.yaml redeploys with its own reason, not the readiness-probe one', async () => {
        await seedRunningChild();
        await fs.writeFile(path.join(childPath, 'drop.yaml'), 'name: ezsign-frontend\nbogus_key: 1\n');
        await resignChild();
        const info = jest.spyOn(priv().logger, 'info');

        await reconcile();

        expect(bootCurrent()).toEqual([]);
        expect(
          info.mock.calls.some((c) => String(c[0]).includes('group child drop.yaml unreadable (invalid)'))
        ).toBe(true);
      });

      it('a child folder that is a link redeploys, never skips', async () => {
        await seedRunningChild();
        const moved = path.join(tempDir, 'moved-child');
        await fs.rename(childPath, moved);
        fssync.symlinkSync(moved, childPath, process.platform === 'win32' ? 'junction' : 'dir');

        await reconcile();

        expect(bootCurrent()).toEqual([]);
      });
    });

    it('keeps the recorded type when the root drop.yaml declares none', async () => {
      // Detection (not the default) decides the type, so a fallback to
      // 'static' would be visible.
      priv().detector = { detect: jest.fn(async () => ({ type: 'nodejs' })) };
      await seedRunningChild(['frontend'], false);
      expect(acs.getConfig(childName)?.type).toBe('nodejs');
      await reconcile();
      expect(bootCurrent()).toEqual([childName]);
      // From here on detection would say something else, so the type can only
      // survive by being taken from the record (and detect never being asked).
      const detect2 = jest.fn(async () => ({ type: 'python' }));
      priv().detector = { detect: detect2 };

      await detect('watcher');

      expect(detect2).not.toHaveBeenCalled();
      expect(handleAppUpdate).not.toHaveBeenCalled();
      expect(await exists(sentinel())).toBe(true);
      expect(acs.getConfig(childName)?.type).toBe('nodejs');
      expect(stateManager.getApp(childName)?.type).toBe('nodejs');
    });
  });

  describe('recording the fingerprint', () => {
    it('a failed rebuild leaves no fingerprint, so the next boot rebuilds', async () => {
      await seedRunningChild();
      await reconcile();
      await fs.writeFile(path.join(repoPath, 'frontend', 'index.html'), '<h1>broken change</h1>');
      // The stamp is fresh and the status is 'running': only the error and the
      // false return can keep the fingerprint from being recorded.
      handleAppUpdate.mockImplementation(failingBuild);

      await detect('watcher');
      expect(handleAppUpdate).toHaveBeenCalledTimes(1);
      expect(acs.getConfig(childName)?.groupSourceHash).toBeUndefined();

      // Next boot. Everything ELSE says current — the child's own signature is
      // re-recorded from the tree as it stands and the failure is forgotten —
      // so the only thing that can force the rebuild is the missing fingerprint.
      handleAppUpdate.mockClear();
      await stateManager.updateApp(childName, { status: 'running', error: undefined });
      const sig = await priv().computeSourceMtimeMs(childPath);
      await acs.upsertSystemConfig(childName, { sourceHash: sig.hash });
      handleAppUpdate.mockImplementation(succeedingBuild);
      await reconcile();
      expect(bootCurrent()).toEqual([childName]);
      await detect('watcher');
      expect(handleAppUpdate).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        'the pipeline is quiesced',
        () => {
          priv().quiescedUntil = Date.now() + 60_000;
        },
      ],
      [
        'the child is already being deployed',
        () => {
          priv().appsInProgress.add(childName);
        },
      ],
    ])('records nothing when handleAppUpdate returns without building (%s)', async (_label, arrange) => {
      await seedRunningChild();
      await reconcile();
      await fs.writeFile(path.join(repoPath, 'frontend', 'index.html'), '<h1>changed source</h1>');
      priv().handleAppUpdate = realHandleAppUpdate;
      arrange();

      await detect('watcher');

      // The real handleAppUpdate declined (child still 'running', no error) …
      expect(stateManager.getApp(childName)?.status).toBe('running');
      expect(stateManager.getApp(childName)?.error).toBeUndefined();
      // … so a copy that was synced but never built is not called current.
      expect(acs.getConfig(childName)?.groupSourceHash).toBeUndefined();
    });

    it('a handleAppUpdate that reports false records nothing, even with a running child', async () => {
      await seedRunningChild();
      await reconcile();
      await fs.writeFile(path.join(repoPath, 'frontend', 'index.html'), '<h1>changed source</h1>');
      handleAppUpdate.mockReset().mockResolvedValue(false);

      await detect('watcher');

      expect(handleAppUpdate).toHaveBeenCalledTimes(1);
      expect(acs.getConfig(childName)?.groupSourceHash).toBeUndefined();
    });

    it('a failing pre-sync clear leaves the child untouched: no sync, no write, no rebuild', async () => {
      await seedRunningChild();
      await reconcile();
      await fs.writeFile(path.join(repoPath, 'frontend', 'index.html'), '<h1>changed source</h1>');
      const stale = acs.getConfig(childName)?.groupSourceHash;
      const yamlBefore = await fs.readFile(path.join(childPath, 'drop.yaml'), 'utf-8');
      const original = acs.upsertSystemConfig.bind(acs);
      const writes: unknown[] = [];
      jest.spyOn(acs, 'upsertSystemConfig').mockImplementation(async (...args) => {
        const updates = args[1] as { groupSourceHash?: string };
        if ('groupSourceHash' in updates) {
          if (updates.groupSourceHash === undefined) throw new Error('config disk is read-only');
          writes.push(updates.groupSourceHash);
        }
        return original(...args);
      });
      const warn = jest.spyOn(priv().logger, 'warn');
      const sync = jest.spyOn(treeSync, 'syncTree');

      await detect('watcher');

      expect(sync).not.toHaveBeenCalled();
      expect(handleAppUpdate).not.toHaveBeenCalled();
      expect(await exists(sentinel())).toBe(true);
      expect(await fs.readFile(path.join(childPath, 'drop.yaml'), 'utf-8')).toBe(yamlBefore);
      expect(await fs.readFile(path.join(childPath, 'index.html'), 'utf-8')).toBe('<h1>frontend</h1>');
      expect(writes).toEqual([]);
      expect(stale).toBeDefined();
      expect(acs.getConfig(childName)?.groupSourceHash).toBe(stale);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('leaving it untouched'))).toBe(true);
    });

    it('says so when an EXPLICIT redeploy could not update a child', async () => {
      await seedRunningChild();
      await fs.writeFile(path.join(repoPath, 'frontend', 'index.html'), '<h1>changed source</h1>');
      const original = acs.upsertSystemConfig.bind(acs);
      jest.spyOn(acs, 'upsertSystemConfig').mockImplementation(async (...args) => {
        if ((args[1] as { groupSourceHash?: string }).groupSourceHash === undefined && 'groupSourceHash' in args[1]) {
          throw new Error('config disk is read-only');
        }
        return original(...args);
      });
      const warn = jest.spyOn(priv().logger, 'warn');

      await detect(undefined);

      expect(handleAppUpdate).not.toHaveBeenCalled();
      expect(warn.mock.calls.some((c) => String(c[0]).includes('did NOT update or rebuild'))).toBe(true);
    });

    it('a sync that throws leaves no fingerprint and builds nothing', async () => {
      await seedRunningChild();
      await reconcile();
      await fs.writeFile(path.join(repoPath, 'frontend', 'index.html'), '<h1>changed source</h1>');
      jest.spyOn(treeSync, 'syncTree').mockRejectedValue(new Error('disk full'));

      await detect('watcher');

      expect(handleAppUpdate).not.toHaveBeenCalled();
      expect(acs.getConfig(childName)?.groupSourceHash).toBeUndefined();
    });

    it('records nothing for a first-ever child', async () => {
      await fs.writeFile(path.join(repoPath, 'drop.yaml'), rootYamlFor(['frontend']));

      await detect('watcher');

      expect(handleBuildApp).toHaveBeenCalledTimes(1);
      expect(acs.getConfig(childName)?.groupSourceHash).toBeUndefined();
    });
  });

  describe('reconcile act phase', () => {
    it('skips one child and rebuilds its sibling, routing both', async () => {
      await seedRunningChild(['frontend', 'backend']);
      await fs.writeFile(path.join(repoPath, 'backend', 'index.html'), '<h1>backend v2 — longer</h1>');

      await reconcile();
      expect(bootCurrent().sort()).toEqual(['ezsign-backend', 'ezsign-frontend']);
      expect(handleConfigureRoute.mock.calls.map((c) => c[0]).sort()).toEqual([
        'ezsign-backend',
        'ezsign-frontend',
      ]);
      await detect('watcher');

      const calls = handleAppUpdate.mock.calls.map((c) => c[0]);
      expect(calls).toEqual(['ezsign-backend']);
      expect(await exists(path.join(appsDir, 'ezsign-frontend', 'marker.txt'))).toBe(true);
      expect(await exists(path.join(appsDir, 'ezsign-backend', 'marker.txt'))).toBe(false);
    });

    it('a failure acting on a child never publishes it and leaves no verdict behind', async () => {
      await seedRunningChild();
      handleConfigureRoute.mockRejectedValue(new Error('caddy is down'));

      await reconcile();

      expect(childPublished()).toBe(false);
      expect(bootCurrent()).toEqual([]);
      expect(handleBuildApp).not.toHaveBeenCalled();
    });

    it('does not decide, mark known or publish a container that has an AppConfig of its own', async () => {
      await seedRunningChild();
      // As git/upload deploys of agent/ephemeral apps leave it.
      await stateManager.registerApp(repoName, repoPath, 'static');
      await stateManager.updateApp(repoName, { group: repoName, isGroupContainer: true });
      await acs.upsertConfig(repoName, { type: 'static', path: repoPath, hostname: 'ezsign.localhost' });
      priv().watcher.markAppKnown.mockClear();
      publish.mockClear();

      await reconcile();

      expect(publish.mock.calls.some((c) => c[0] === 'app:detected')).toBe(false);
      expect(priv().watcher.markAppKnown).not.toHaveBeenCalledWith(repoName);
      // ...so the ready scan finds it as usual, and the child is still skipped.
      expect(bootCurrent()).toEqual([childName]);
      await detect('watcher');
      expect(handleAppUpdate).not.toHaveBeenCalled();
    });
  });

  describe('containment guard', () => {
    it('refuses a symlink in a service whose own location contains a build/ segment', async () => {
      // The copy exclusion was tested against the ABSOLUTE path, so a `build`
      // or `dist` segment anywhere above the service made the scan skip all.
      const svcDir = path.join(repoPath, 'build', 'web');
      await fs.mkdir(svcDir, { recursive: true });
      await fs.writeFile(path.join(svcDir, 'index.html'), 'x');
      const outside = path.join(tempDir, 'outside');
      await fs.mkdir(outside, { recursive: true });
      fssync.symlinkSync(outside, path.join(svcDir, 'link'), process.platform === 'win32' ? 'junction' : 'dir');

      await priv().expandMonorepo(repoPath, repoName, {
        services: { web: { path: 'build/web', type: 'static' } },
      });

      expect(handleBuildApp).not.toHaveBeenCalled();
      expect(await exists(path.join(appsDir, 'ezsign-web'))).toBe(false);
    });
  });

  describe('decideBootReconciliationCheap with the group gate bypassed', () => {
    const base = {
      status: 'running' as const,
      isRuntimeRunning: true,
      hasPort: true,
      portDrifted: false,
      grantedApiScopesCount: 0,
      runtimeSpecCurrent: true,
      dependenciesStale: false,
    };

    it('still refuses a group child when the gate is not bypassed (every other caller)', () => {
      expect(decideBootReconciliationCheap({ ...base, group: repoName })?.action).toBe('redeploy');
    });

    it('defers to the signature phase when bypassed', () => {
      expect(decideBootReconciliationCheap({ ...base, group: undefined })).toBeNull();
    });
  });
});
