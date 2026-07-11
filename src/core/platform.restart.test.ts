/**
 * DropPlatform.restartApp (env re-injection on restart/start).
 *
 * Exercises the REAL orchestration — real EventBus, AppStateManager,
 * AppConfigService, DetectorService, BuilderService — with the same faked OS
 * boundary as platform.integration.test.ts: a FakeRuntime replaces PM2, the
 * bundled Postgres is stubbed, the watcher is a no-op, and disk preflight
 * always passes. fs is REAL, under a temp dropRoot.
 *
 * '../api' is mocked so requiring platform.ts never pulls in the API
 * server/route module graph — those files are edited concurrently by another
 * agent on this branch and are irrelevant to restartApp's own behavior.
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
import { getAppConfigService } from '../managers/app/app-config';
import { AppInProgressError } from '../api/platform-ops';

/** Poll until `predicate` holds or the timeout elapses (drives async handlers). */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8000,
  intervalMs = 25
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: condition not met within timeout');
}

describe('DropPlatform.restartApp', () => {
  let tempDir: string;
  let webappsDir: string;
  let platform: DropPlatform | null = null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-restart-'));
    webappsDir = path.join(tempDir, 'webapps');
    fakeRuntime.reset();
  });

  afterEach(async () => {
    if (platform && platform.isActive()) {
      await platform.stop();
    }
    platform = null;
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    // fakeRuntime is a module-level singleton (survives across tests by
    // design — see fake-runtime.ts). jest.spyOn on an already-mocked method
    // returns the SAME spy rather than a fresh one, so per-test spies on it
    // (and on the platform instance) must be restored or their call counts
    // leak into the next test.
    jest.restoreAllMocks();
  });

  /** Drop a minimal static app into the watched webapps dir. */
  async function createStaticApp(name: string): Promise<string> {
    const appPath = path.join(webappsDir, name);
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.html'), `<h1>${name}</h1>`);
    return appPath;
  }

  /**
   * Add a drop.yaml healthCheck override to an already-deployed app. Written
   * AFTER the initial deploy deliberately: manifestDetector (priority 100,
   * confidence 1.0) fires on ANY drop.yaml and resolves to type 'unknown'
   * unless the manifest also sets `type` — but `type` is not one of
   * parseDropYaml's ALLOWED_TOP_KEYS, so adding it here to appease detection
   * would make parseDropYaml reject the whole file and drop healthCheck
   * again. A restart re-detecting this app as 'unknown' is harmless for
   * these tests (FakeRuntime never executes the spec); the healthCheck path
   * still round-trips correctly through parseDropYaml either way.
   */
  async function addHealthCheck(appPath: string, healthCheckPath: string): Promise<void> {
    await fs.writeFile(path.join(appPath, 'drop.yaml'), `healthCheck: ${healthCheckPath}\n`);
  }

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

  /** Deploy a static app end-to-end (detect -> build -> start) and wait for it to be running. */
  async function deploy(name: string, appPath: string): Promise<void> {
    eventBus.publish('app:detected', { name, path: appPath, type: undefined });
    await waitFor(() => getStateManager().getApp(name)?.status === 'running');
  }

  it('deletes the runtime process before starting the fresh one (ordering)', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    await deploy('site', appPath);

    const deleteSpy = jest.spyOn(fakeRuntime, 'delete');
    const startSpy = jest.spyOn(fakeRuntime, 'start');

    const result = await platform!.restartApp('site');

    expect(deleteSpy).toHaveBeenCalledWith('site');
    expect(startSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'site' }));
    expect(deleteSpy.mock.invocationCallOrder[0]).toBeLessThan(startSpy.mock.invocationCallOrder[0]);
    expect(result.status).toBe('running');
  }, 20000);

  it('reflects a secret value changed since the last deploy in the restart spec', async () => {
    platform = makePlatform();
    await platform.start();
    const secretManager = (platform as unknown as { secretManager: { set: Function } }).secretManager;
    await secretManager.set('site', 'API_KEY', 'v1');

    const appPath = await createStaticApp('site');
    await deploy('site', appPath);

    // Secret rotated after the app was deployed — restart must pick up v2, not
    // whatever was baked into the process at first start.
    await secretManager.set('site', 'API_KEY', 'v2');

    const startSpy = jest.spyOn(fakeRuntime, 'start');
    await platform!.restartApp('site');

    const spec = startSpy.mock.calls[startSpy.mock.calls.length - 1][0];
    expect(spec.env!.API_KEY).toBe('v2');
  }, 20000);

  it('omits a secret removed since the last deploy from the restart spec', async () => {
    platform = makePlatform();
    await platform.start();
    const secretManager = (platform as unknown as {
      secretManager: { set: Function; delete: Function };
    }).secretManager;
    await secretManager.set('site', 'DOOMED_KEY', 'temp');

    const appPath = await createStaticApp('site');
    await deploy('site', appPath);

    await secretManager.delete('site', 'DOOMED_KEY');

    const startSpy = jest.spyOn(fakeRuntime, 'start');
    await platform!.restartApp('site');

    const spec = startSpy.mock.calls[startSpy.mock.calls.length - 1][0];
    expect(spec.env!.DOOMED_KEY).toBeUndefined();
  }, 20000);

  it('includes DATABASE_URL and DROP_DATA_DIR in the restart spec env', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    await deploy('site', appPath);

    const startSpy = jest.spyOn(fakeRuntime, 'start');
    await platform!.restartApp('site');

    const spec = startSpy.mock.calls[startSpy.mock.calls.length - 1][0];
    expect(spec.env!.DATABASE_URL).toBe('postgresql://mock-db/app');
    expect(spec.env!.DROP_DATA_DIR).toBe(path.join(tempDir, 'data', 'appdata', 'site'));
  }, 20000);

  it('includes DROP_API_URL in the restart spec env (re-injected via buildFreshStartSpec -> buildStartSpec)', async () => {
    platform = makePlatform({ isolation: 'none', apiPort: 4114 });
    await platform.start();
    const appPath = await createStaticApp('site');
    await deploy('site', appPath);

    const startSpy = jest.spyOn(fakeRuntime, 'start');
    await platform!.restartApp('site');

    const spec = startSpy.mock.calls[startSpy.mock.calls.length - 1][0];
    expect(spec.env!.DROP_API_URL).toBe('http://127.0.0.1:4114');
  }, 20000);

  it('reuses the app\'s existing port on restart', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    await deploy('site', appPath);
    const originalPort = getStateManager().getApp('site')?.port;
    expect(originalPort).toBeGreaterThan(0);

    const result = await platform!.restartApp('site');

    expect(result.port).toBe(originalPort);
    expect(getAppConfigService().getConfig('site')?.port).toBe(originalPort);
  }, 20000);

  it('rejects with AppInProgressError when the app already has an operation in flight, without touching the runtime', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    await deploy('site', appPath);

    const deleteSpy = jest.spyOn(fakeRuntime, 'delete');
    (platform as unknown as { appsInProgress: Set<string> }).appsInProgress.add('site');

    await expect(platform!.restartApp('site')).rejects.toThrow(AppInProgressError);
    expect(deleteSpy).not.toHaveBeenCalled();

    // Cleanup so afterEach's stop()/drain doesn't wait on a guard we set manually.
    (platform as unknown as { appsInProgress: Set<string> }).appsInProgress.delete('site');
  }, 20000);

  it('rejects when the app is not running and the concurrent-app capacity is reached, without starting it', async () => {
    // Deploy with capacity uncapped so the first app can actually reach
    // 'running' (handleStartApp counts the app being started against the cap
    // too, so a cap of 1 would reject even the very first deploy — a
    // pre-existing handleStartApp property, not something restartApp changes).
    platform = makePlatform();
    await platform.start();

    const appPathA = await createStaticApp('appa');
    await deploy('appa', appPathA);

    // A second app the platform knows about (registered in state) but has
    // never been deployed/started — restartApp degenerates to a fresh start
    // for it, which must be capacity-gated exactly like handleStartApp.
    const appPathB = await createStaticApp('appb');
    await getStateManager().registerApp('appb', appPathB);

    // Now simulate the cap being reached by the one already-running app.
    (platform as unknown as { config: PlatformConfig }).config.maxConcurrentApps = 1;

    const startsBefore = fakeRuntime.startCount;

    await expect(platform!.restartApp('appb')).rejects.toThrow(/capacity/i);
    expect(fakeRuntime.startCount).toBe(startsBefore);
  }, 20000);

  it('marks the app errored and releases the in-progress guard when the runtime fails to start; a later restart is not blocked', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    await deploy('site', appPath);
    const originalPort = getStateManager().getApp('site')?.port as number;

    jest.spyOn(fakeRuntime, 'start').mockRejectedValueOnce(new Error('boom'));

    await expect(platform!.restartApp('site')).rejects.toThrow('boom');

    expect(getStateManager().getApp('site')?.status).toBe('errored');
    expect(getStateManager().getApp('site')?.error).toContain('boom');
    expect((platform as unknown as { appsInProgress: Set<string> }).appsInProgress.has('site')).toBe(false);
    // The port reservation must survive a failed restart — releasing it here
    // would let a concurrent deploy steal it out from under the errored app.
    expect(
      (platform as unknown as { usedPorts: Map<number, string> }).usedPorts.has(originalPort)
    ).toBe(true);

    // The busy guard must not still be held — a subsequent restart proceeds
    // (and, since the rejection above was mockRejectedValueOnce, succeeds).
    const result = await platform!.restartApp('site');
    expect(result.status).toBe('running');
  }, 20000);

  it('never writes an intermediate "stopped" status during a restart', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    await deploy('site', appPath);

    const setStatusSpy = jest.spyOn(
      (platform as unknown as { stateManager: { setAppStatus: (...args: unknown[]) => unknown } })
        .stateManager,
      'setAppStatus'
    );

    await platform!.restartApp('site');

    // A 'stopped' write would trip statusSub's prober-kill and webhook
    // fan-out for a state the user never requested — restartApp must only
    // ever move the app through 'running' (or 'errored' on failure).
    for (const call of setStatusSpy.mock.calls) {
      expect(call[1]).not.toBe('stopped');
    }
  }, 20000);

  it('re-arms the health prober on a successful restart when the spec has a healthCheckPath (pm2 runtime)', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    await deploy('site', appPath);
    await addHealthCheck(appPath, '/health');
    const port = getStateManager().getApp('site')?.port;

    const proberSpy = jest.spyOn(
      platform as unknown as { startHealthProber: (...args: unknown[]) => void },
      'startHealthProber'
    );

    await platform!.restartApp('site');

    expect(proberSpy).toHaveBeenCalledWith('site', port, '/health');
  }, 20000);
});
