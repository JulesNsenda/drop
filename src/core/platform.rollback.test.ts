/**
 * DropPlatform.rollbackApp (#296): restore the last-good tree and restart,
 * identically under both isolation modes.
 *
 * Same harness as platform.restart.test.ts (REAL platform, EventBus, state and
 * config services, REAL fs under a temp dropRoot; FakeRuntime in place of
 * PM2/Docker). Both modes run an app straight from its directory, so the
 * parity claim is concrete: after a rollback the runtime is handed the same
 * cwd, and that directory holds the captured tree, in either mode.
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { fakeRuntime } from './__testutils__/fake-runtime';

// See file header — shields this suite from src/api/server.ts + routes/*,
// which are being edited concurrently on this branch.
jest.mock('../api', () => ({
  createApiServer: jest.fn(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  })),
  ApiServer: jest.fn(),
}));

// Partial-mock the runtime module: keep the real types/exports the platform
// imports, but return the shared FakeRuntime from getAppRuntime — same
// technique as platform.integration.test.ts, required so getAppRuntime()
// stays reachable from inside the mock factory without a hoisting violation.
jest.mock('../managers/runtime', () => {
  const actual = jest.requireActual('../managers/runtime');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { fakeRuntime: shared } = require('./__testutils__/fake-runtime');
  return {
    ...actual,
    getAppRuntime: jest.fn(() => shared),
    resetAppRuntime: jest.fn(),
  };
});

// Stub the bundled Postgres (no real DB server / binaries in tests). Always
// reports a DATABASE_URL so restart-spec assertions have something to check.
jest.mock('../managers/database', () => {
  const mockPostgresServer = {
    getStatus: jest.fn().mockReturnValue('running'),
    getPort: jest.fn().mockReturnValue(5433),
    getSocketDir: jest.fn().mockReturnValue(undefined),
    getConnectionString: jest
      .fn()
      .mockReturnValue('postgresql://postgres@localhost:5433/postgres'),
    ensureReady: jest.fn().mockResolvedValue(undefined),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  };
  const mockDbProvisioner = {
    initialize: jest.fn().mockResolvedValue(undefined),
    ensureInternalDatabase: jest.fn().mockResolvedValue({
      host: 'localhost',
      port: 5433,
      database: 'drop_internal',
      user: 'drop_admin',
      password: 'test',
      connectionString: 'postgresql://drop_admin:test@localhost:5433/drop_internal',
    }),
    provisionAppDatabase: jest.fn().mockResolvedValue({
      connectionString: 'postgresql://u:p@localhost:5433/app',
    }),
    getAppCredentials: jest.fn().mockReturnValue(null),
    getEnvVars: jest.fn().mockReturnValue({ DATABASE_URL: 'postgresql://mock-db/app' }),
    hasAppDatabase: jest.fn().mockReturnValue(false),
    listDatabases: jest.fn().mockReturnValue([]),
    deleteAppDatabase: jest.fn().mockResolvedValue(undefined),
    // DROP-151 Phase 3 (detachService, isolation-parity block below): a
    // provisioned app by default, whose dump-then-drop succeeds cleanly.
    isProvisioned: jest.fn().mockReturnValue(true),
    orphanDatabaseExists: jest.fn().mockResolvedValue(false),
    backupAndDeleteAppDatabase: jest
      .fn()
      .mockResolvedValue({ dropped: true, databaseDropped: true, roleDropped: true, dumpPath: undefined }),
    dbNameForApp: jest.fn((name: string) => `drop_${name}`),
    // detachService's byte-budget gate calls this directly. The directory
    // never exists on disk in this suite, which is fine — checkDumpByteBudget
    // treats a missing owner directory as "nothing charged yet" (allowed).
    ownerDumpDir: jest.fn(
      (userId?: string | null) => `/nonexistent-pre-delete/${userId ?? '_ownerless'}`
    ),
  };
  return {
    PostgresBinaries: jest.fn(),
    PostgresServer: jest.fn().mockImplementation(() => mockPostgresServer),
    getPostgresServer: jest.fn().mockReturnValue(mockPostgresServer),
    resetPostgresServer: jest.fn(),
    DatabaseProvisioner: jest.fn().mockImplementation(() => mockDbProvisioner),
    getDatabaseProvisioner: jest.fn().mockReturnValue(mockDbProvisioner),
    resetDatabaseProvisioner: jest.fn(),
  };
});

// No-op the watcher: these tests drive the pipeline purely via events, so
// real chokidar (which would fire its OWN app:detected/app:update on the temp
// dir and race the manual events) must not run.
jest.mock('./watcher', () => ({
  WatcherService: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    markAppKnown: jest.fn(),
  })),
}));

// Stub the free-disk preflight — shells out to the OS and would otherwise
// couple this suite to the runner's actual free disk.
jest.mock('../utils/disk', () => ({
  ...jest.requireActual('../utils/disk'),
  hasEnoughDisk: jest.fn().mockResolvedValue({ ok: true, freeMb: 999999 }),
}));

import { DropPlatform, createPlatform, PlatformConfig } from './platform';
import { eventBus } from './event-bus';
import { getStateManager } from '../managers/app/state-manager';
import { AppInProgressError } from '../api/platform-ops';
import { captureBeforeRedeploy, getRollbackStore, NoRollbackSnapshotError } from '../managers/rollback';

async function waitFor(predicate: () => boolean, timeoutMs = 8000, intervalMs = 25): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: condition not met within timeout');
}

describe('DropPlatform.rollbackApp (#296)', () => {
  let tempDir: string;
  let webappsDir: string;
  let platform: DropPlatform | null = null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-rollback-platform-'));
    webappsDir = path.join(tempDir, 'webapps');
    fakeRuntime.reset();
  });

  afterEach(async () => {
    delete process.env.DROP_MAX_APP_DISK_MB;
    if (platform && platform.isActive()) await platform.stop();
    platform = null;
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    jest.restoreAllMocks();
  });

  function makePlatform(overrides?: Partial<PlatformConfig>): DropPlatform {
    return createPlatform({
      dropRoot: tempDir,
      appsDirectory: webappsDir,
      logLevel: 'error',
      autoBuild: true,
      autoStart: true,
      enableApi: false,
      enableHttps: false,
      caddyfilePath: path.join(tempDir, 'Caddyfile'),
      ...overrides,
    });
  }

  /** Deploy a static app (v1) and wait until it is serving. */
  async function deployV1(name: string): Promise<string> {
    const appPath = path.join(webappsDir, name);
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.html'), '<h1>v1</h1>');
    eventBus.publish('app:detected', { name, path: appPath, type: undefined });
    await waitFor(() => getStateManager().getApp(name)?.status === 'running');
    return appPath;
  }

  /** What upload-deploy does before landing a redeploy, then the bad deploy's files. */
  async function badRedeploy(name: string, appPath: string): Promise<void> {
    expect((await captureBeforeRedeploy(name)).captured).toBe(true);
    await fs.writeFile(path.join(appPath, 'index.html'), '<h1>v2 broken</h1>');
    await fs.writeFile(path.join(appPath, 'extra.js'), 'only in v2');
  }

  describe.each([
    ['isolation: none (pm2)', undefined],
    ['isolation: docker', 'docker' as const],
  ])('under %s', (_label, isolation) => {
    it('restores the tree, then restarts from it on the same port without rebuilding', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await deployV1('site');
      const port = getStateManager().getApp('site')!.port;
      await badRedeploy('site', appPath);
      // Same technique as the restart suite's parity block: buildFreshStartSpec
      // reads config.isolation at call time, so flip it on the running platform.
      if (isolation) (platform as unknown as { config: { isolation: string } }).config.isolation = isolation;

      const buildSpy = jest.spyOn(eventBus, 'publish');
      const realStart = fakeRuntime.start.bind(fakeRuntime);
      let contentAtStart = '';
      const startSpy = jest.spyOn(fakeRuntime, 'start').mockImplementation(async (spec) => {
        contentAtStart = await fs.readFile(path.join(appPath, 'index.html'), 'utf-8');
        return realStart(spec);
      });

      const { meta, info } = await platform.rollbackApp('site');

      expect(meta.appName).toBe('site');
      expect(info.status).toBe('running');
      // The runtime started AFTER the restore, from the app's own directory.
      expect(contentAtStart).toBe('<h1>v1</h1>');
      expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'site', cwd: appPath }));
      await expect(fs.access(path.join(appPath, 'extra.js'))).rejects.toThrow();
      expect(getStateManager().getApp('site')).toEqual(expect.objectContaining({ status: 'running', port }));
      // No rebuild: nothing asked the builder to run.
      expect(buildSpy.mock.calls.map((c) => c[0])).not.toContain('build:started');
    }, 20000);
  });

  it('refuses when no snapshot was captured, touching nothing', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await deployV1('site');
    await fs.writeFile(path.join(appPath, 'index.html'), '<h1>v2</h1>');
    const startSpy = jest.spyOn(fakeRuntime, 'start');

    await expect(platform.rollbackApp('site')).rejects.toBeInstanceOf(NoRollbackSnapshotError);

    expect(await fs.readFile(path.join(appPath, 'index.html'), 'utf-8')).toBe('<h1>v2</h1>');
    expect(startSpy).not.toHaveBeenCalled();
  }, 20000);

  it('refuses while the app is busy, and releases its own guard afterwards', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await deployV1('site');
    await badRedeploy('site', appPath);
    const inProgress = (platform as unknown as { appsInProgress: Set<string> }).appsInProgress;

    inProgress.add('site');
    await expect(platform.rollbackApp('site')).rejects.toBeInstanceOf(AppInProgressError);
    inProgress.delete('site');

    await platform.rollbackApp('site');
    expect(inProgress.has('site')).toBe(false);
  }, 20000);

  it('removes the snapshot when the app is deleted, even with keepData', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await deployV1('site');
    await badRedeploy('site', appPath);

    await platform.purgeAppArtifacts('site', { keepData: true });

    expect(await getRollbackStore()!.get('site')).toBeNull();
  }, 20000);

  it('drops the snapshot instead of parking the app when it is what tips the ceiling', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await deployV1('site');
    await fs.writeFile(path.join(appPath, 'bundle.js'), Buffer.alloc(600 * 1024));
    await badRedeploy('site', appPath);
    expect(await getRollbackStore()!.get('site')).not.toBeNull();

    process.env.DROP_MAX_APP_DISK_MB = '1'; // tree ~600 KB + snapshot ~600 KB > 1 MB
    await (platform as unknown as { sweepDiskCeiling(): Promise<void> }).sweepDiskCeiling();

    expect(await getRollbackStore()!.get('site')).toBeNull();
    expect(getStateManager().getApp('site')!.status).toBe('running');
  }, 20000);
});
