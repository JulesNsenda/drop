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

  describe('hasLiveBuildContainer', () => {
    function dockerPlatform(names: string[]): Internals {
      const pl = createPlatform({
        dropRoot: tempDir,
        appsDirectory: path.join(tempDir, 'apps'),
        logLevel: 'error',
        isolation: 'docker',
      }) as unknown as Internals;
      pl.runtime = {
        type: 'docker',
        docker: {
          listContainers: jest.fn().mockResolvedValue(names.map((n) => ({ Names: [n], Id: n }))),
        },
      };
      return pl;
    }

    it('is true for an exact build container of the app', async () => {
      expect(await dockerPlatform(['/drop-build-web-1730000000000']).hasLiveBuildContainer('web')).toBe(true);
    });

    it("is not held up by another app's build whose name starts the same", async () => {
      expect(await dockerPlatform(['/drop-build-web-2-1730000000000']).hasLiveBuildContainer('web')).toBe(false);
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
