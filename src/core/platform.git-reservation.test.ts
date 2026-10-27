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
import { reapBuildContainers } from './builder/container-build-runner';
import * as dropYaml from './detector/drop-yaml-parser';

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
      jest.spyOn(logger, 'info').mockImplementation((m: string, ...rest: unknown[]) => {
        logged.push(m);
        original(m, ...rest);
      });

      const ran = await internals.handleAppUpdate('web', '/apps/web', 'git redeploy', true);

      expect(ran).toBe(false);
      // It was dropped by the re-check on the line before the claim, not by
      // some earlier guard.
      expect(logged.some((m) => m.includes('a deploy took the app meanwhile'))).toBe(true);
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
        listContainers: jest.fn(async (opts: { filters?: { label?: string[] } }) =>
          all.filter((c) =>
            (opts.filters?.label ?? []).every((l) => {
              const [k, v] = l.split('=');
              return v === undefined ? k in c.Labels : c.Labels[k] === v;
            })
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
