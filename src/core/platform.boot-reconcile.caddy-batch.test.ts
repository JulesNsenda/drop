/**
 * M1 review item G - batched Caddy reload:
 * docs/plans/2026-07-25-restart-isolation-and-marketing-split.md.
 *
 * reconcileAppsOnBoot must issue exactly ONE caddyServer.reload() for N
 * skipped apps, not N serialized reloads on the boot path (see
 * handleConfigureRoute's skipCaddyReload option and reconcileAppsOnBoot's
 * trailing reloadCaddyIfRunning() call after its per-app loop).
 *
 * Every other boot-reconcile suite runs against a REAL (unmocked) CaddyServer,
 * which on this dev box has no caddy binary - ensureReady() returns false,
 * start() is never called, getStatus() never becomes 'running', and
 * reload() is therefore never reached at all. That means none of those
 * suites can observe reload counts. Hence a dedicated file with its own
 * managers/router mock (so getStatus() reports 'running' and reload() is
 * spy-observable), isolated from the other suites so it doesn't change their
 * (currently caddy-inert) behaviour.
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { fakeRuntime } from './__testutils__/fake-runtime';

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

// No-op the watcher - same rationale as platform.boot-reconcile.test.ts: real
// chokidar over the temp dir would race these tests' manual app:detected
// publishes and reconciliation.
jest.mock('./watcher', () => ({
  WatcherService: jest.fn().mockImplementation(() => ({
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    markAppKnown: jest.fn(),
  })),
}));

jest.mock('../utils/disk', () => ({
  ...jest.requireActual('../utils/disk'),
  hasEnoughDisk: jest.fn().mockResolvedValue({ ok: true, freeMb: 999999 }),
}));

// A CaddyServer that reports 'running' so reloadCaddyIfRunning() actually
// reaches reload() - the stub object is created ONCE inside the factory
// closure and always returned by getCaddyServer(), so the test can retrieve
// the SAME instance via a plain call to the (mocked) getCaddyServer() and
// assert on its reload mock's call count.
jest.mock('../managers/router', () => {
  const mockCaddy = {
    ensureReady: jest.fn().mockResolvedValue(true),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    getStatus: jest.fn().mockReturnValue('running'),
    getPort: jest.fn().mockReturnValue(2019),
    reload: jest.fn().mockResolvedValue(true),
    getExpiringCertificates: jest.fn().mockResolvedValue([]),
  };
  return {
    CaddyServer: jest.fn(),
    getCaddyServer: jest.fn(() => mockCaddy),
    resetCaddyServer: jest.fn(),
  };
});

import { DropPlatform, createPlatform, PlatformConfig } from './platform';
import { eventBus } from './event-bus';
import { getStateManager, resetStateManager } from '../managers/app/state-manager';
import { resetAppConfigService } from '../managers/app/app-config';
import { getCaddyServer } from '../managers/router';

/** Poll until predicate holds or the timeout elapses (drives async handlers). */
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

describe('DropPlatform boot reconciliation (M1) - batched Caddy reload (item G)', () => {
  let tempDir: string;
  let webappsDir: string;
  let platform: DropPlatform | null = null;
  let platform2: DropPlatform | null = null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-boot-reconcile-caddy-'));
    webappsDir = path.join(tempDir, 'webapps');
    fakeRuntime.reset();
    const caddy = getCaddyServer();
    (caddy.reload as jest.Mock).mockClear();
  });

  afterEach(async () => {
    if (platform2 && platform2.isActive()) {
      await platform2.stop();
    }
    if (platform && platform.isActive()) {
      await platform.stop();
    }
    platform = null;
    platform2 = null;
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    jest.restoreAllMocks();
  }, 20000);

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

  async function createStaticApp(name: string): Promise<string> {
    const appPath = path.join(webappsDir, name);
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.html'), '<h1>' + name + '</h1>');
    return appPath;
  }

  async function deploy(name: string, appPath: string): Promise<void> {
    eventBus.publish('app:detected', { name, path: appPath, type: undefined });
    await waitFor(() => getStateManager().getApp(name)?.status === 'running');
  }

  async function crossPlatformRestart(): Promise<void> {
    await platform!.stop();
    resetStateManager();
    resetAppConfigService();
  }

  it('reloads Caddy exactly once for two skipped apps on the same boot pass, not twice', async () => {
    platform = makePlatform();
    await platform.start();
    const appA = await createStaticApp('alpha');
    const appB = await createStaticApp('beta');
    await deploy('alpha', appA);
    await deploy('beta', appB);
    await crossPlatformRestart();

    const caddy = getCaddyServer();
    (caddy.reload as jest.Mock).mockClear(); // ignore reloads from platform 1's own deploys

    const infoSpy = jest.fn();
    platform2 = makePlatform({ bootReconcileMode: 'on' });
    jest
      .spyOn(
        (platform2 as unknown as { logger: { info: (...a: unknown[]) => void } }).logger,
        'info'
      )
      .mockImplementation(infoSpy);

    await platform2.start();

    // Both apps must actually have been decided 'skip' - asserting reload
    // count alone would also pass if e.g. one app skipped and the other
    // redeployed or errored (count could coincidentally still be 1).
    await waitFor(() =>
      infoSpy.mock.calls.some(
        (call) => typeof call[0] === 'string' && call[0].indexOf("'alpha' unchanged") !== -1
      ) &&
      infoSpy.mock.calls.some(
        (call) => typeof call[0] === 'string' && call[0].indexOf("'beta' unchanged") !== -1
      )
    );

    // Give a (hypothetical) per-app reload a moment to fire before asserting
    // the batched count.
    await new Promise((r) => setTimeout(r, 300));

    expect(caddy.reload).toHaveBeenCalledTimes(1);
  }, 30000);
});
