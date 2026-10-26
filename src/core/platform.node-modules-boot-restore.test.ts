/**
 * Boot restore of a node_modules a build parked and never settled (plan
 * docs/plans/2026-10-23-node-abi-rebuild.md, item 2, loop 3 fix plan point 6).
 *
 * A build parks a stale node_modules in a per-source-path slot while its
 * replacement installs. A crash between the park and the settle leaves the
 * original ONLY in that slot, so the platform puts it back at boot — through a
 * REAL second DropPlatform sharing the first one's on-disk root, with the same
 * faked OS boundary as platform.boot-reconcile.test.ts (a FakeRuntime instead
 * of PM2, a stubbed Postgres, a no-op watcher). fs is REAL, under a temp root.
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

import { DropPlatform, createPlatform } from './platform';
import { eventBus } from './event-bus';
import { getStateManager, resetStateManager } from '../managers/app/state-manager';
import { getAppConfigService, resetAppConfigService } from '../managers/app/app-config';
import { parkedTreePaths } from './builder/toolchain';

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

describe('boot restore of a parked node_modules', () => {
  const realFs = jest.requireActual('fs/promises');
  let tempDir: string;
  let webappsDir: string;
  let platform: DropPlatform | null = null;
  let platform2: DropPlatform | null = null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-boot-parked-'));
    webappsDir = path.join(tempDir, 'webapps');
    fakeRuntime.reset();
  });

  afterEach(async () => {
    if (platform2 && platform2.isActive()) await platform2.stop();
    if (platform && platform.isActive()) await platform.stop();
    platform = null;
    platform2 = null;
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 20000);

  const exists = (p: string): Promise<boolean> =>
    fs.access(p).then(
      () => true,
      () => false
    );

  const makePlatform = (): DropPlatform =>
    createPlatform({
      dropRoot: tempDir,
      appsDirectory: webappsDir,
      logLevel: 'error',
      autoBuild: true,
      autoStart: true,
      enableApi: false,
      enableHttps: false,
      caddyfilePath: path.join(tempDir, 'Caddyfile'),
    });

  const asideRootOf = (app: string): string =>
    path.join(tempDir, 'data', 'temp', '.node-modules-aside', app);

  /** Park a tree for `appPath`, exactly where a build would have left it. */
  const park = async (app: string, appPath: string): Promise<string> => {
    const { parked } = parkedTreePaths(appPath, asideRootOf(app));
    await fs.mkdir(parked, { recursive: true });
    await fs.writeFile(path.join(parked, 'pkg.txt'), 'x');
    return parked;
  };

  /** Deploy a static app once, stop the platform, and reload the singletons as a real restart would. */
  const deployAndStop = async (
    name: string,
    afterDeploy?: () => Promise<void>
  ): Promise<string> => {
    platform = makePlatform();
    await platform.start();
    const appPath = path.join(webappsDir, name);
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.html'), `<h1>${name}</h1>`);
    eventBus.publish('app:detected', { name, path: appPath, type: undefined });
    await waitFor(() => getStateManager().getApp(name)?.status === 'running');
    await waitFor(() => getAppConfigService().getConfig(name)?.sourceHash !== undefined);
    if (afterDeploy) await afterDeploy();
    await platform.stop();
    resetStateManager();
    resetAppConfigService();
    return appPath;
  };

  it('puts the source path\'s parked tree back BEFORE any app is reconciled', async () => {
    const appPath = await deployAndStop('site');
    const parked = await park('site', appPath);

    let restoredAtReconcile: boolean | null = null;
    const original = (DropPlatform.prototype as any).syncStateWithConfigs;
    jest
      .spyOn(DropPlatform.prototype as any, 'syncStateWithConfigs')
      .mockImplementation(async function (this: DropPlatform) {
        restoredAtReconcile = await exists(path.join(appPath, 'node_modules', 'pkg.txt'));
        return original.call(this);
      });

    platform2 = makePlatform();
    await platform2.start();

    expect(restoredAtReconcile).toBe(true);
    expect(await fs.readFile(path.join(appPath, 'node_modules', 'pkg.txt'), 'utf-8')).toBe('x');
    expect(await exists(parked)).toBe(false);
  }, 30000);

  it("every deploy puts the source path's parked tree back before it stages or builds", async () => {
    // A release build of the app runs in another slot and would otherwise leave
    // the source folder's original parked; the deploy target step restores it.
    platform = makePlatform();
    await platform.start();
    const appPath = path.join(webappsDir, 'site');
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.html'), '<h1>site</h1>');
    const parked = await park('site', appPath);

    await (platform as any).prepareDeployTarget('site', appPath, 'deploy-1');

    expect(await fs.readFile(path.join(appPath, 'node_modules', 'pkg.txt'), 'utf-8')).toBe('x');
    expect(await exists(parked)).toBe(false);
  }, 30000);

  it('also restores the slot of the persisted currentRelease, when it is a release path of the app', async () => {
    const releasePath = path.join(tempDir, 'data', 'releases', 'site', 'rel-1');
    await fs.mkdir(releasePath, { recursive: true });
    await deployAndStop('site', async () => {
      await getAppConfigService().updateSystemConfig('site', {
        currentRelease: { id: 'rel-1', path: releasePath, createdAt: new Date().toISOString() },
      });
    });
    const parked = await park('site', releasePath);

    platform2 = makePlatform();
    await platform2.start();

    expect(await fs.readFile(path.join(releasePath, 'node_modules', 'pkg.txt'), 'utf-8')).toBe('x');
    expect(await exists(parked)).toBe(false);
  }, 30000);

  it('never trusts a persisted currentRelease path that is not a release of the app', async () => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-boot-elsewhere-'));
    try {
      await deployAndStop('site', async () => {
        await getAppConfigService().updateSystemConfig('site', {
          currentRelease: { id: 'rel-x', path: elsewhere, createdAt: new Date().toISOString() },
        });
      });
      const parked = await park('site', elsewhere);

      platform2 = makePlatform();
      await platform2.start();

      expect(await exists(path.join(elsewhere, 'node_modules'))).toBe(false);
      expect(await exists(parked)).toBe(true);
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  }, 30000);

  it('does not restore another path\'s slot of the same app', async () => {
    const appPath = await deployAndStop('site');
    const other = path.join(tempDir, 'somewhere-else');
    await fs.mkdir(other);
    const parked = await park('site', other);

    platform2 = makePlatform();
    await platform2.start();

    expect(await exists(path.join(other, 'node_modules'))).toBe(false);
    expect(await exists(path.join(appPath, 'node_modules'))).toBe(false);
    expect(await exists(parked)).toBe(true);
  }, 30000);

  it('a restore that fails never blocks boot, and leaves the parked tree for the next build', async () => {
    const appPath = await deployAndStop('site');
    const parked = await park('site', appPath);
    const realRename = realFs.rename.bind(realFs) as typeof fs.rename;
    jest.spyOn(realFs, 'rename').mockImplementation(((src: string, dest: string) =>
      String(src).includes('.node-modules-aside')
        ? Promise.reject(Object.assign(new Error(`EBUSY: ${src}`), { code: 'EBUSY' }))
        : realRename(src, dest)) as never);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    platform2 = makePlatform();
    await expect(platform2.start()).resolves.toBeUndefined();

    expect(platform2.isActive()).toBe(true);
    expect(await exists(path.join(appPath, 'node_modules'))).toBe(false);
    expect(await exists(path.join(parked, 'pkg.txt'))).toBe(true);
  }, 30000);
});
