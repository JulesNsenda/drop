/**
 * Platform integration tests (P2-1).
 *
 * Exercises the REAL orchestration — real EventBus, AppStateManager,
 * AppConfigService, DetectorService, BuilderService, and the DropPlatform
 * handlers — with only the OS boundary faked:
 *   - a FakeRuntime replaces PM2 (no real processes / daemon),
 *   - the bundled Postgres is stubbed,
 *   - Caddy is not started (enableHttps:false),
 *   - fs is REAL, under a temp dropRoot.
 *
 * This is the coverage that platform.test.ts (which mocks every manager) can't
 * provide: port reconciliation, re-adoption across a restart, hot-reload, and
 * the appsInProgress re-entrancy guard.
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { fakeRuntime } from './__testutils__/fake-runtime';

// Partial-mock the runtime module: keep the real types/exports the platform
// imports, but return the shared FakeRuntime from getAppRuntime and make
// resetAppRuntime a no-op so the fake survives platform.stop() (models PM2
// outliving the platform process — required for the re-adoption scenario).
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

// Stub the bundled Postgres (no real DB server / binaries in tests).
jest.mock('../managers/database', () => {
  const mockPostgresServer = {
    getStatus: jest.fn().mockReturnValue('running'),
    getPort: jest.fn().mockReturnValue(5433),
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
    getEnvVars: jest.fn().mockReturnValue(null),
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

// No-op the watcher: these tests drive the pipeline purely via events, so real
// chokidar (which would fire its OWN app:detected/app:update on the temp-dir
// file changes and race the manual events) must not run.
jest.mock('./watcher', () => ({
  WatcherService: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  })),
}));

// Stub the free-disk preflight (P2-5): getDiskFreeMb shells out to the OS
// (PowerShell/df) — an OS boundary this harness otherwise fakes. Left real, the
// build-boundary check in handleBuildApp would couple these deploy tests to the
// runner's actual free disk (or fail-close when the subprocess is denied).
// Keep the rest of the module real; force hasEnoughDisk to pass.
jest.mock('../utils/disk', () => ({
  ...jest.requireActual('../utils/disk'),
  hasEnoughDisk: jest.fn().mockResolvedValue({ ok: true, freeMb: 999999 }),
}));

import { DropPlatform, createPlatform } from './platform';
import { eventBus } from './event-bus';
import { getStateManager, resetStateManager } from '../managers/app/state-manager';
import { getAppConfigService, resetAppConfigService } from '../managers/app/app-config';
import { getDeployTracker } from '../managers/deploy-tracker';

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

describe('Platform integration (P2-1)', () => {
  let tempDir: string;
  let webappsDir: string;
  let platform: DropPlatform | null = null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-integration-'));
    webappsDir = path.join(tempDir, 'webapps');
    fakeRuntime.reset();
  });

  /** Drop a minimal static app into the watched webapps dir. */
  async function createStaticApp(name: string): Promise<string> {
    const appPath = path.join(webappsDir, name);
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.html'), `<h1>${name}</h1>`);
    return appPath;
  }

  afterEach(async () => {
    if (platform && platform.isActive()) {
      await platform.stop();
    }
    platform = null;
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  function makePlatform(): DropPlatform {
    return createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'webapps'),
      logLevel: 'error',
      autoBuild: true,
      autoStart: true,
      enableApi: false,
      enableHttps: false,
      caddyfilePath: path.join(tempDir, 'Caddyfile'),
    });
  }

  // Feasibility spike (advisor gate #1): does start() come up with the REAL
  // state-manager/app-config + real fs + stubbed Postgres + FakeRuntime?
  it('starts and stops with real managers + FakeRuntime', async () => {
    platform = makePlatform();
    await platform.start();
    expect(platform.isActive()).toBe(true);
    await platform.stop();
    expect(platform.isActive()).toBe(false);
    platform = null;
  }, 20000);

  // Scenario 1: deploy happy path — the full real chain (detect → build →
  // start → runtime) driven by an app:detected event.
  it('deploys a dropped static app end-to-end', async () => {
    platform = makePlatform();
    await platform.start();

    const appPath = await createStaticApp('site');
    eventBus.publish('app:detected', { name: 'site', path: appPath, type: undefined });

    const state = getStateManager();
    await waitFor(() => state.getApp('site')?.status === 'running');

    const app = state.getApp('site');
    expect(app?.status).toBe('running');
    expect(app?.port).toBeGreaterThan(0);

    // FakeRuntime actually "started" it, on the app's allocated port.
    expect(fakeRuntime.runningNames()).toContain('site');

    // Config file is the port source-of-truth and must persist the same port.
    const cfg = getAppConfigService().getConfig('site');
    expect(cfg?.port).toBe(app?.port);
  }, 20000);

  // Scenario 2 (highest value): a platform restart must RE-ADOPT the running
  // app on its persisted port, not re-allocate a new one.
  it('re-adopts a running app on the same port after a platform restart', async () => {
    // Deploy on platform 1.
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    eventBus.publish('app:detected', { name: 'site', path: appPath, type: undefined });
    await waitFor(() => getStateManager().getApp('site')?.status === 'running');
    const originalPort = getStateManager().getApp('site')?.port;
    expect(originalPort).toBeGreaterThan(0);
    // Capture the surviving process's pid — adoption must REUSE it, whereas a
    // rebuild+restart would mint a new one (and still land on originalPort,
    // since config is the port source of truth — so port-equality alone can't
    // tell adoption from redeploy).
    const pidBefore = fakeRuntime.pidOf('site');
    const startsBefore = fakeRuntime.startCount;

    // Stop platform 1. The FakeRuntime SURVIVES (models PM2 outliving the
    // platform process); reset the file-backed singletons so platform 2
    // reloads state + config from disk, as a real restart would.
    await platform.stop();
    resetStateManager();
    resetAppConfigService();
    expect(fakeRuntime.runningNames()).toContain('site');

    // Start platform 2 on the same root — it must ADOPT the surviving process.
    platform = makePlatform();
    await platform.start();
    await waitFor(() => getStateManager().getApp('site')?.status === 'running');
    expect(getStateManager().getApp('site')?.port).toBe(originalPort);
    // The proof of adoption: same pid, and no new start() on the runtime.
    expect(fakeRuntime.pidOf('site')).toBe(pidBefore);
    expect(fakeRuntime.startCount).toBe(startsBefore);
  }, 30000);

  // Scenario 3: a file-change hot-reload rebuilds and restarts on the SAME port.
  it('hot-reloads a running app on its original port', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    eventBus.publish('app:detected', { name: 'site', path: appPath, type: undefined });
    await waitFor(() => getStateManager().getApp('site')?.status === 'running');
    const port = getStateManager().getApp('site')?.port;
    const pidBefore = fakeRuntime.pidOf('site');

    // Clear the post-deploy cooldown (models enough time since the deploy), edit
    // a file, and trigger the update path.
    (platform as unknown as { appDeployTimes: Map<string, number> }).appDeployTimes.clear();
    await fs.writeFile(path.join(appPath, 'index.html'), '<h1>site v2</h1>');
    eventBus.publish('app:update', { name: 'site', path: appPath, reason: 'edit' });

    // Reload = stop + start on the same port → running again with a new pid.
    await waitFor(
      () => fakeRuntime.runningNames().includes('site') && fakeRuntime.pidOf('site') !== pidBefore
    );
    expect(getStateManager().getApp('site')?.status).toBe('running');
    expect(getStateManager().getApp('site')?.port).toBe(port);
  }, 20000);

  // Regression: a hot-reload is ONE stop+rebuild+start transaction. Its
  // builder.build emits build:completed, but that must not also drive
  // buildSub -> handleStartApp on top of handleAppUpdate's own start. Before the
  // fix this asserted 2 (the double-start).
  it('starts the runtime exactly once per hot-reload (no double-start)', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    eventBus.publish('app:detected', { name: 'site', path: appPath, type: undefined });
    await waitFor(() => getStateManager().getApp('site')?.status === 'running');

    (platform as unknown as { appDeployTimes: Map<string, number> }).appDeployTimes.clear();
    const startsBefore = fakeRuntime.startCount;
    const pidBefore = fakeRuntime.pidOf('site');

    await fs.writeFile(path.join(appPath, 'index.html'), '<h1>site v2</h1>');
    eventBus.publish('app:update', { name: 'site', path: appPath, reason: 'edit' });

    await waitFor(
      () => fakeRuntime.runningNames().includes('site') && fakeRuntime.pidOf('site') !== pidBefore
    );
    await new Promise((r) => setTimeout(r, 200)); // let any second (buildSub) start settle

    expect(fakeRuntime.startCount - startsBefore).toBe(1);
    expect(getStateManager().getApp('site')?.status).toBe('running');
  }, 20000);

  // Scenario 4: the re-entrancy guard drops an update that arrives while a
  // deploy for the same app is already in progress (the realistic case — the
  // watcher debounces bursts, and a redeploy takes real time during which a new
  // edit can land). We assert the guard's DROP directly — the app never leaves
  // 'running' and the runtime is never touched — which is robust and doesn't
  // depend on any reload internals.
  it('drops an update while a deploy for the same app is in progress', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createStaticApp('site');
    eventBus.publish('app:detected', { name: 'site', path: appPath, type: undefined });
    await waitFor(() => getStateManager().getApp('site')?.status === 'running');

    const inProgress = (platform as unknown as { appsInProgress: Set<string> }).appsInProgress;
    (platform as unknown as { appDeployTimes: Map<string, number> }).appDeployTimes.clear();
    const startsBefore = fakeRuntime.startCount;

    // A deploy is already running for 'site'; a new update must hit the guard
    // (line ~1565) and return before touching state/build/runtime.
    inProgress.add('site');
    eventBus.publish('app:update', { name: 'site', path: appPath, reason: 'edit' });
    await new Promise((r) => setTimeout(r, 200)); // give the (dropped) handler time to run

    expect(fakeRuntime.startCount).toBe(startsBefore); // guard dropped it: no rebuild/start
    expect(getStateManager().getApp('site')?.status).toBe('running');

    inProgress.delete('site'); // cleanup so afterEach stop()/drain doesn't wait
  }, 20000);

  // P2-4: a REAL deploy through the real detector/builder/state-transitions must
  // produce a retrievable, owner-scoped deploy episode. This is the seam the
  // tracker's own unit tests (synthetic events) and the route tests (mocked
  // tracker) can't prove — that the platform actually emits build:started ->
  // app:updated{running} in the shape the tracker expects, closing on the
  // runtime-agnostic status transition (the D1 Docker regression, exercised
  // here for real since FakeRuntime never emits app:started either).
  it('records a retrievable, owner-scoped deploy episode end-to-end (P2-4)', async () => {
    platform = makePlatform();
    await platform.start();

    const appPath = await createStaticApp('owned');
    // Set the owner BEFORE detection, mirroring the API deploy where the route
    // sets userId before the pipeline builds — so the build:started snapshot is
    // populated and the owner can actually see their own deploy.
    const state = getStateManager();
    await state.registerApp('owned', appPath);
    await state.updateApp('owned', { userId: 'user-123' });

    eventBus.publish('app:detected', { name: 'owned', path: appPath, type: undefined });
    await waitFor(() => state.getApp('owned')?.status === 'running');

    const episodes = getDeployTracker().getEpisodes('owned');
    expect(episodes).toHaveLength(1);
    const ep = episodes[0];
    expect(ep.status).toBe('succeeded');
    expect(ep.appName).toBe('owned');
    // Closed on the runtime-agnostic app:updated{running}, not PM2's app:started.
    const stageNames = ep.stages.map((s) => s.stage);
    expect(stageNames).toEqual(expect.arrayContaining(['build-started', 'build', 'running']));
    // Owner snapshot is populated — the route filters tenants on THIS, so an
    // undefined here would hide the deploy from its own owner.
    expect(ep.userId).toBe('user-123');
  }, 20000);
});
