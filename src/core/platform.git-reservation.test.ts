/**
 * A git deploy writes an app's folder only while nothing else can: it claims
 * the platform's in-progress slot (`tryReserveApp`), builds that arrive meanwhile
 * are deferred (never dropped), and a leftover or live build container blocks
 * the land.
 *
 * Exercised on a constructed-but-never-started platform, as
 * `platform.quiesce.test.ts` does.
 */

import * as os from 'os';
import * as path from 'path';
import { createPlatform, DropPlatform } from './platform';
import { loadEmptySuspensionStore } from './__testutils__/suspension';

// An unloaded suspension store fails closed; these tests never start the platform that loads it.
beforeEach(loadEmptySuspensionStore);
import { reapBuildContainers } from './builder/container-build-runner';
import * as dropYaml from './detector/drop-yaml-parser';
import { sanitizeBuildEnv } from './builder/strategies/base';

type Internals = {
  appsInProgress: Set<string>;
  gitReserved: Set<string>;
  pendingBuilds: Map<string, unknown>;
  builder: unknown;
  detector: unknown;
  runtime: unknown;
  tryReserveApp(name: string): (() => void) | null;
  hasLiveBuildContainer(name: string): Promise<boolean>;
  handleBuildApp(p: string, n: string, t: string): Promise<void>;
  drainPendingBuilds(): Promise<void>;
  scheduleBuildDrain(): void;
};

describe('git deploy folder reservation', () => {
  let platform: DropPlatform;
  let p: Internals;
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(
      os.tmpdir(),
      `drop-test-git-reserve-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
    });
    p = platform as unknown as Internals;
    p.builder = {};
    p.detector = {};
  });

  afterEach(async () => {
    if (platform.isActive()) await platform.stop();
  });

  it('claims the in-progress slot, refuses a second claim, and releases once', () => {
    const release = p.tryReserveApp('web');
    expect(release).not.toBeNull();
    expect(p.appsInProgress.has('web')).toBe(true);
    expect(p.tryReserveApp('web')).toBeNull();

    release!();
    release!(); // idempotent
    expect(p.appsInProgress.has('web')).toBe(false);
    expect(p.gitReserved.has('web')).toBe(false);
    expect(p.tryReserveApp('web')).not.toBeNull();
  });

  it('refuses while the app is already building or deploying', () => {
    p.appsInProgress.add('web');
    expect(p.tryReserveApp('web')).toBeNull();
  });

  it('refuses while an upload of the app is in flight', () => {
    (platform as unknown as { uploadDeployService: unknown }).uploadDeployService = {
      isUploading: (n: string) => n === 'web',
    };
    expect(p.tryReserveApp('web')).toBeNull();
    expect(p.tryReserveApp('other')).not.toBeNull();
  });

  it('counts a git reservation as busy for the ops predicate too', () => {
    const release = p.tryReserveApp('web')!;
    expect((p as unknown as { isBusy(n: string): boolean }).isBusy('web')).toBe(true);
    release();
    expect((p as unknown as { isBusy(n: string): boolean }).isBusy('web')).toBe(false);
  });

  it('refuses while the platform is quiesced', async () => {
    await platform.quiesce(60_000);
    expect(p.tryReserveApp('web')).toBeNull();
  });

  it('defers (queues) a build that arrives during a land, instead of starting or dropping it', async () => {
    jest.spyOn(p, 'scheduleBuildDrain').mockImplementation(() => undefined);
    const release = p.tryReserveApp('web')!;

    await p.handleBuildApp('/apps/web', 'web', 'static');

    expect(p.pendingBuilds.has('web')).toBe(true);
    // Still just our reservation: no build claimed the slot.
    expect(p.appsInProgress.has('web')).toBe(true);
    release();
  });

  it('keeps a deferred build queued while reserved, and dispatches it after release', async () => {
    jest.spyOn(p, 'scheduleBuildDrain').mockImplementation(() => undefined);
    const dispatched = jest.fn().mockResolvedValue(undefined);
    const original = p.handleBuildApp.bind(p);
    p.pendingBuilds.set('web', { appPath: '/apps/web', appType: 'static' });
    const release = p.tryReserveApp('web')!;
    p.handleBuildApp = dispatched;

    await p.drainPendingBuilds();
    expect(dispatched).not.toHaveBeenCalled();
    expect(p.pendingBuilds.has('web')).toBe(true);

    release();
    await p.drainPendingBuilds();
    expect(dispatched).toHaveBeenCalledWith('/apps/web', 'web', 'static', undefined);
    p.handleBuildApp = original;
  });

  describe('an upload writing the folder', () => {
    let uploading: boolean;
    beforeEach(() => {
      uploading = true;
      (platform as unknown as { uploadDeployService: unknown }).uploadDeployService = {
        isUploading: (n: string) => n === 'web' && uploading,
      };
    });

    it('counts as busy for the ops predicate', () => {
      const busy = (p as unknown as { isBusy(n: string): boolean }).isBusy.bind(p);
      expect(busy('web')).toBe(true);
      expect(busy('other')).toBe(false);
      uploading = false;
      expect(busy('web')).toBe(false);
    });

    it('does not stop a route being re-emitted (uploads write no routes)', async () => {
      const internals = platform as unknown as {
        reconfigureRoute(n: string): Promise<void>;
        handleConfigureRoute: unknown;
        appConfigService: unknown;
      };
      const configure = jest.fn().mockResolvedValue(undefined);
      internals.handleConfigureRoute = configure;
      internals.appConfigService = { getConfig: () => ({ port: 3001 }) };

      await expect(internals.reconfigureRoute('web')).resolves.toBeUndefined();

      expect(configure).toHaveBeenCalledWith('web', 3001, { routeOnly: true });
      expect(p.appsInProgress.has('web')).toBe(false);
    });

    it('still refuses a route re-emit while a deploy holds the slot', async () => {
      const internals = platform as unknown as { reconfigureRoute(n: string): Promise<void> };
      p.appsInProgress.add('web');
      await expect(internals.reconfigureRoute('web')).rejects.toThrow(/operation in progress/);
    });

    it('defers a build that arrives meanwhile instead of starting or dropping it', async () => {
      jest.spyOn(p, 'scheduleBuildDrain').mockImplementation(() => undefined);

      await p.handleBuildApp('/apps/web', 'web', 'static');

      expect(p.pendingBuilds.has('web')).toBe(true);
      expect(p.appsInProgress.has('web')).toBe(false);
    });

    it('keeps a deferred build queued while the upload is in flight, and runs it after', async () => {
      jest.spyOn(p, 'scheduleBuildDrain').mockImplementation(() => undefined);
      const dispatched = jest.fn().mockResolvedValue(undefined);
      const original = p.handleBuildApp.bind(p);
      p.pendingBuilds.set('web', { appPath: '/apps/web', appType: 'static' });
      p.handleBuildApp = dispatched;

      await p.drainPendingBuilds();
      expect(dispatched).not.toHaveBeenCalled();
      expect(p.pendingBuilds.has('web')).toBe(true);

      uploading = false;
      await p.drainPendingBuilds();
      expect(dispatched).toHaveBeenCalledWith('/apps/web', 'web', 'static', undefined);
      p.handleBuildApp = original;
    });
  });

  describe('chained redeploys (A\'s update arrives after A released, B takes the slot)', () => {
    it('A\'s update never builds beside B\'s land and never releases B\'s reservation', async () => {
      const internals = platform as unknown as Internals & {
        stateManager: unknown;
        handleAppUpdate(n: string, p: string, r: string, bypass?: boolean): Promise<boolean>;
        isBusy(n: string): boolean;
      };
      const build = jest.fn().mockResolvedValue({ success: true, duration: 1, errors: [] });
      internals.builder = { build };
      internals.detector = { detect: jest.fn().mockResolvedValue({ type: 'static', framework: null, suggestedConfig: {} }) };
      (internals as unknown as { runtime: unknown }).runtime = { type: 'pm2' };
      internals.stateManager = {
        getApp: jest.fn().mockReturnValue({ name: 'web', status: 'running', port: 3005 }),
        setAppStatus: jest.fn().mockResolvedValue(undefined),
        updateApp: jest.fn().mockResolvedValue(undefined),
      };

      // B reserves in the await gap that A's update has between its first
      // "is it busy" look and its claim of the slot.
      let releaseB: (() => void) | null = null;
      jest.spyOn(dropYaml, 'parseDropYaml').mockImplementation(async () => {
        releaseB = internals.tryReserveApp('web');
        return { success: false } as never;
      });

      const logged: string[] = [];
      const logger = (platform as unknown as { logger: { info: (m: string, ...r: unknown[]) => void } }).logger;
      const original = logger.info.bind(logger);
      // Every level is captured so a failure shows which guard returned instead.
      for (const level of ['debug', 'warn', 'error'] as const) {
        jest.spyOn(logger as unknown as Record<string, (m: string) => void>, level).mockImplementation((m: string) => {
          logged.push(`${level}: ${m}`);
        });
      }
      jest.spyOn(logger, 'info').mockImplementation((m: string, ...rest: unknown[]) => {
        logged.push(m);
        original(m, ...rest);
      });

      const ran = await internals.handleAppUpdate('web', '/apps/web', 'git redeploy', true);

      expect(ran).toBe(false);
      // B reserved during the drop.yaml read, so only a re-check AFTER that
      // await can see it: the single inProgressSkip before the claim, which
      // covers the git reservation as well as the in-progress set.
      expect(logged).toContainEqual(expect.stringMatching(/Dropped redeploy for web - already in progress/));
      expect(releaseB).not.toBeNull();
      expect(build).not.toHaveBeenCalled();
      // B's reservation is intact: still busy, still reserved.
      expect(internals.isBusy('web')).toBe(true);
      expect(internals.gitReserved.has('web')).toBe(true);
      expect(internals.appsInProgress.has('web')).toBe(true);

      releaseB!();
      expect(internals.isBusy('web')).toBe(false);
    });

    it('every other claimer (restart, rollback, attach, detach, promote) refuses a reserved app', async () => {
      const internals = platform as unknown as {
        restartApp(n: string): Promise<unknown>;
        rollbackApp(n: string): Promise<unknown>;
        attachService(n: string, s: string): Promise<unknown>;
        detachService(n: string, s: string): Promise<unknown>;
        tryReserveApp(n: string): (() => void) | null;
        gitReserved: Set<string>;
        appsInProgress: Set<string>;
      };
      const release = internals.tryReserveApp('web')!;
      // Even if only the reservation set holds the app (the in-progress entry
      // lost), the predicate still says busy.
      internals.appsInProgress.delete('web');

      await expect(internals.restartApp('web')).rejects.toThrow(/operation in progress/);
      await expect(internals.rollbackApp('web')).rejects.toThrow(/operation in progress/);
      await expect(internals.attachService('web', 'postgres')).rejects.toThrow(/operation in progress/);
      await expect(internals.detachService('web', 'postgres')).rejects.toThrow(/operation in progress/);

      internals.gitReserved.delete('web');
      release();
    });
  });

  describe('the build env of a git-deployed app', () => {
    it('carries DROP_GIT_COMMIT (its own commit, or that of its group container) and survives the build-env sanitiser', async () => {
      const internals = platform as unknown as {
        stateManager: unknown;
        appConfigService: unknown;
        resolveDependencies: jest.Mock;
        resolveBuildEnv(p: string, n: string): Promise<Record<string, string>>;
      };
      internals.resolveDependencies = jest.fn().mockResolvedValue({});
      internals.appConfigService = {
        getConfig: (n: string) => (n === 'child' ? { groupContainer: 'box' } : undefined),
      };
      const apps: Record<string, unknown> = {
        web: { name: 'web', gitSource: { repoUrl: 'x', branch: 'main', lastCommitSha: 'a'.repeat(40) } },
        box: { name: 'box', gitSource: { repoUrl: 'x', branch: 'main', lastCommitSha: 'b'.repeat(40) } },
        child: { name: 'child' },
        plain: { name: 'plain' },
      };
      internals.stateManager = { getApp: (n: string) => apps[n] };

      const web = await internals.resolveBuildEnv(path.join(tempDir, 'web'), 'web');
      const child = await internals.resolveBuildEnv(path.join(tempDir, 'child'), 'child');
      const plain = await internals.resolveBuildEnv(path.join(tempDir, 'plain'), 'plain');

      expect(web.DROP_GIT_COMMIT).toBe('a'.repeat(40));
      expect(child.DROP_GIT_COMMIT).toBe('b'.repeat(40));
      expect(plain.DROP_GIT_COMMIT).toBeUndefined();
      // And it reaches the build command: the sanitiser keeps it.
      expect(sanitizeBuildEnv(web).DROP_GIT_COMMIT).toBe('a'.repeat(40));
    });
  });

  describe('hasLiveBuildContainer', () => {
    interface FakeContainer {
      Id: string;
      Names: string[];
      Labels: Record<string, string>;
    }
    /** A daemon that honours `filters.label`, as the real one does. */
    function fakeDocker(all: FakeContainer[]): {
      listContainers: jest.Mock;
      getContainer: jest.Mock;
      removed: string[];
    } {
      const removed: string[] = [];
      return {
        removed,
        listContainers: jest.fn(async (opts: { filters?: { label?: string[]; name?: string[] } }) =>
          all.filter(
            (c) =>
              (opts.filters?.label ?? []).every((l) => {
                const [k, v] = l.split('=');
                return v === undefined ? k in c.Labels : c.Labels[k] === v;
              }) && (opts.filters?.name ?? []).every((n) => c.Names.some((cn) => cn.includes(n)))
          )
        ),
        getContainer: jest.fn((id: string) => ({
          remove: jest.fn(async () => {
            removed.push(id);
          }),
        })),
      };
    }
    const build = (app: string, id = app): FakeContainer => ({
      Id: id,
      Names: [`/drop-build-${app}-1730000000000`],
      Labels: { 'drop.build': app },
    });
    /** An ordinary app container that merely LOOKS like a build container by name. */
    const lookalike: FakeContainer = { Id: 'look', Names: ['/drop-build-victim-1'], Labels: {} };

    function dockerPlatform(names: string[]): Internals {
      const pl = createPlatform({
        dropRoot: tempDir,
        appsDirectory: path.join(tempDir, 'apps'),
        logLevel: 'error',
        isolation: 'docker',
      }) as unknown as Internals;
      pl.runtime = {
        type: 'docker',
        docker: fakeDocker(names.map((n) => build(n))),
      };
      return pl;
    }

    it('is true for a build container labelled for the app', async () => {
      expect(await dockerPlatform(['web']).hasLiveBuildContainer('web')).toBe(true);
    });

    it("is not held up by another app's build whose name starts the same", async () => {
      expect(await dockerPlatform(['web-2']).hasLiveBuildContainer('web')).toBe(false);
    });

    it('is not fooled by an unlabelled container whose NAME looks like a build container', async () => {
      const pl = createPlatform({
        dropRoot: tempDir,
        appsDirectory: path.join(tempDir, 'apps'),
        logLevel: 'error',
        isolation: 'docker',
      }) as unknown as Internals;
      pl.runtime = { type: 'docker', docker: fakeDocker([lookalike, build('build-victim-1', 'b1')]) };
      expect(await pl.hasLiveBuildContainer('victim')).toBe(false);
      expect(await pl.hasLiveBuildContainer('build-victim-1')).toBe(true);
    });

    // A build started by the binary from before containers were labelled.
    const legacy: FakeContainer = { Id: 'old', Names: ['/drop-build-web-1730000000000'], Labels: {} };
    // A RUNTIME container (managed) for an app whose own name looks like a build container.
    const managedLookalike: FakeContainer = {
      Id: 'managed',
      Names: ['/drop-build-foo-1730000000000'],
      Labels: { 'drop.managed': 'true' },
    };

    it('reaps a legacy (unlabelled) build container left by the previous binary', async () => {
      const docker = fakeDocker([legacy, build('api', 'a1')]);
      expect(await reapBuildContainers(docker as never)).toBe(2);
      expect(docker.removed.sort()).toEqual(['a1', 'old']);
    });

    it('a legacy build container blocks EVERY app (fail closed) until it is reaped', async () => {
      const pl = createPlatform({
        dropRoot: tempDir,
        appsDirectory: path.join(tempDir, 'apps'),
        logLevel: 'error',
        isolation: 'docker',
      }) as unknown as Internals;
      const docker = fakeDocker([legacy]);
      pl.runtime = { type: 'docker', docker };
      expect(await pl.hasLiveBuildContainer('unrelated')).toBe(true);

      await reapBuildContainers(docker as never);
      const after = fakeDocker([]);
      pl.runtime = { type: 'docker', docker: after };
      expect(await pl.hasLiveBuildContainer('unrelated')).toBe(false);
    });

    it('a drop.managed runtime container with a build-like name is neither counted nor reaped', async () => {
      const pl = createPlatform({
        dropRoot: tempDir,
        appsDirectory: path.join(tempDir, 'apps'),
        logLevel: 'error',
        isolation: 'docker',
      }) as unknown as Internals;
      const docker = fakeDocker([managedLookalike]);
      pl.runtime = { type: 'docker', docker };
      expect(await pl.hasLiveBuildContainer('foo')).toBe(false);
      expect(await pl.hasLiveBuildContainer('other')).toBe(false);
      expect(await reapBuildContainers(docker as never)).toBe(0);
      expect(docker.removed).toEqual([]);
    });

    it('reaping removes labelled build containers only, never a look-alike', async () => {
      const docker = fakeDocker([lookalike, build('web', 'w1'), build('api', 'a1')]);
      const n = await reapBuildContainers(docker as never);
      expect(n).toBe(2);
      expect(docker.removed.sort()).toEqual(['a1', 'w1']);
    });

    it('is false with no build container, and false off docker isolation', async () => {
      expect(await dockerPlatform([]).hasLiveBuildContainer('web')).toBe(false);
      expect(await p.hasLiveBuildContainer('web')).toBe(false);
    });

    it('fails closed when docker cannot be asked', async () => {
      const pl = dockerPlatform([]);
      (pl.runtime as { docker: { listContainers: jest.Mock } }).docker.listContainers.mockRejectedValue(
        new Error('daemon down')
      );
      expect(await pl.hasLiveBuildContainer('web')).toBe(true);
    });
  });
});
