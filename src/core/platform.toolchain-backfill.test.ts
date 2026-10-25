/**
 * One-shot boot backfill of the toolchain marker, and stale-tree detection at
 * boot reconcile (plan docs/plans/2026-10-23-node-abi-rebuild.md, item 3).
 *
 * Same faked OS boundary as platform.node-modules-boot-restore.test.ts: a
 * FakeRuntime, a stubbed Postgres, a no-op watcher; fs is REAL, under a temp
 * root. The toolchain id is pinned so the tests never depend on the host Node.
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

import { DropPlatform, createPlatform, decideBootReconciliationCheap } from './platform';
import { eventBus } from './event-bus';
import { getStateManager, resetStateManager } from '../managers/app/state-manager';
import { getAppConfigService, resetAppConfigService } from '../managers/app/app-config';
import { PRE_MARKER_DOCKER_TOOLCHAIN, TOOLCHAIN_MARKER } from './builder/toolchain';

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

const ID = 'node-abi-115-linux-x64-glibc';
const OTHER_ID = 'node-abi-127-linux-x64-glibc';
const itPosix = process.platform === 'win32' ? it.skip : it;

describe('boot backfill of the toolchain marker', () => {
  let tempDir: string;
  let webappsDir: string;
  let platform: DropPlatform | null = null;
  let platform2: DropPlatform | null = null;
  let toolchainId: string | null;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-backfill-'));
    webappsDir = path.join(tempDir, 'webapps');
    fakeRuntime.reset();
    toolchainId = ID;
    jest
      .spyOn(DropPlatform.prototype as any, 'toolchainIdForBuild')
      .mockImplementation(async () => toolchainId);
  });

  afterEach(async () => {
    if (platform2 && platform2.isActive()) await platform2.stop();
    if (platform && platform.isActive()) await platform.stop();
    platform = null;
    platform2 = null;
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 20000);

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

  const flagPath = (): string => path.join(tempDir, 'data', 'drop-svc', 'toolchain-backfill.json');

  const markerOf = (tree: string): Promise<string | null> =>
    fs.readFile(path.join(tree, 'node_modules', TOOLCHAIN_MARKER), 'utf-8').catch(() => null);

  const withModules = async (tree: string, marker?: string): Promise<void> => {
    await fs.mkdir(path.join(tree, 'node_modules'), { recursive: true });
    if (marker !== undefined) {
      await fs.writeFile(path.join(tree, 'node_modules', TOOLCHAIN_MARKER), marker);
    }
  };

  /**
   * Deploy a static app (static is a node_modules BUILD type), stop, and reload
   * the singletons as a real restart would. That first boot wrote the flag
   * (no apps yet, nothing to stamp), so it is removed: the next boot is the
   * first boot of the release that introduced the marker.
   */
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
    await fs.rm(flagPath(), { force: true });
    return appPath;
  };

  it('stamps unmarked source, release and snapshot trees, and nothing else', async () => {
    const releasePath = path.join(tempDir, 'data', 'releases', 'site', 'rel-1');
    const previousPath = path.join(tempDir, 'data', 'releases', 'site', 'rel-0');
    const heldPath = path.join(tempDir, 'data', 'releases', 'site', 'rel-2');
    const snapshotTree = path.join(tempDir, 'data', 'rollback', 'site', 'tree');
    const appPath = await deployAndStop('site', async () => {
      const now = new Date().toISOString();
      await getAppConfigService().updateSystemConfig('site', {
        currentRelease: { id: 'rel-1', path: releasePath, createdAt: now },
        previousRelease: { id: 'rel-0', path: previousPath, createdAt: now },
        pendingPromotion: { builtAt: now, releasePath: heldPath },
      });
    });
    await withModules(appPath);
    await withModules(releasePath);
    await withModules(heldPath);
    await withModules(previousPath, OTHER_ID); // stale: must stay stale
    await withModules(snapshotTree);
    await fs.writeFile(path.join(tempDir, 'data', 'rollback', 'site', 'meta.json'), '{}');

    platform2 = makePlatform();
    await platform2.start();

    expect(await markerOf(appPath)).toBe(ID);
    expect(await markerOf(releasePath)).toBe(ID);
    expect(await markerOf(heldPath)).toBe(ID);
    expect(await markerOf(snapshotTree)).toBe(ID);
    expect(await markerOf(previousPath)).toBe(OTHER_ID);
    const flag = JSON.parse(await fs.readFile(flagPath(), 'utf-8'));
    expect(flag.completedAt).toEqual(expect.any(String));
  }, 30000);

  it('never follows a persisted release path that is not a release of the app', async () => {
    const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-backfill-elsewhere-'));
    try {
      await deployAndStop('site', async () => {
        await getAppConfigService().updateSystemConfig('site', {
          currentRelease: { id: 'x', path: elsewhere, createdAt: new Date().toISOString() },
        });
      });
      await withModules(elsewhere);

      platform2 = makePlatform();
      await platform2.start();

      expect(await markerOf(elsewhere)).toBeNull();
    } finally {
      await fs.rm(elsewhere, { recursive: true, force: true });
    }
  }, 30000);

  it('runs once: after the flag, a new unmarked tree is left for its build', async () => {
    const appPath = await deployAndStop('site');
    await fs.writeFile(flagPath(), '{}');
    await withModules(appPath);

    platform2 = makePlatform();
    await platform2.start();

    expect(await markerOf(appPath)).toBeNull();
    expect(await (platform2 as any).buildToolchainIdFor('static')).toBe(ID);
  }, 30000);

  it('an unknown toolchain stamps nothing and writes no flag; the first build retries it', async () => {
    const appPath = await deployAndStop('site');
    await withModules(appPath);
    toolchainId = null;

    platform2 = makePlatform();
    await platform2.start();

    expect(await markerOf(appPath)).toBeNull();
    await expect(fs.access(flagPath())).rejects.toThrow();
    expect(await (platform2 as any).buildToolchainIdFor('static')).toBeNull();
    // Before the backfill, a stale tree must not trigger a redeploy: that build
    // would have no id, strip the marker, and keep the old tree.
    await withModules(appPath, OTHER_ID);
    await getStateManager().registerApp('api', appPath, 'nodejs');
    toolchainId = ID;
    expect(await (platform2 as any).servingTreeIsStale({ name: 'api', path: appPath })).toBe(false);

    // The probe recovers: the next build runs the backfill first, then gets an id.
    await fs.rm(path.join(appPath, 'node_modules', TOOLCHAIN_MARKER));
    expect(await (platform2 as any).buildToolchainIdFor('static')).toBe(ID);
    expect(await markerOf(appPath)).toBe(ID);
    await expect(fs.access(flagPath())).resolves.toBeUndefined();
  }, 30000);

  it('docker: stamps the image every unmarked tree was built in, whatever the image is now', async () => {
    const appPath = await deployAndStop('site');
    await withModules(appPath);
    platform2 = makePlatform();
    await platform2.start(); // isolation none: stamps with ID
    const backfillAs = async (id: string | null): Promise<void> => {
      await fs.rm(flagPath(), { force: true });
      await fs.rm(path.join(appPath, 'node_modules', TOOLCHAIN_MARKER), { force: true });
      (platform2 as any).toolchainBackfilled = false;
      (platform2 as any).config.isolation = 'docker';
      toolchainId = id;
      await (platform2 as any).runToolchainBackfill();
    };

    // A later image (an upgrade that skipped the marker's release): the tree was
    // still built on the old one, so it is stamped that, and so reads stale.
    await backfillAs(OTHER_ID);
    expect(await markerOf(appPath)).toBe(PRE_MARKER_DOCKER_TOOLCHAIN);
    expect(JSON.parse(await fs.readFile(flagPath(), 'utf-8')).toolchains).toEqual([
      PRE_MARKER_DOCKER_TOOLCHAIN,
    ]);
    await getStateManager().registerApp('api', appPath, 'nodejs');
    expect(await (platform2 as any).servingTreeIsStale({ name: 'api', path: appPath })).toBe(true);

    await backfillAs(PRE_MARKER_DOCKER_TOOLCHAIN);
    expect(await markerOf(appPath)).toBe(PRE_MARKER_DOCKER_TOOLCHAIN);
  }, 30000);

  itPosix('never writes through a symlinked node_modules', async () => {
    const appPath = await deployAndStop('site');
    const target = path.join(tempDir, 'outside');
    await fs.mkdir(target);
    await fs.symlink(target, path.join(appPath, 'node_modules'));

    platform2 = makePlatform();
    await platform2.start();

    await expect(fs.readdir(target)).resolves.toEqual([]);
  }, 30000);

  it('flags a node-runtime app whose serving tree was built for another Node, and only that', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = path.join(webappsDir, 'api');
    await fs.mkdir(appPath, { recursive: true });
    await getStateManager().registerApp('api', appPath, 'nodejs');
    const stale = (): Promise<boolean> =>
      (platform as any).servingTreeIsStale({ name: 'api', path: appPath });

    expect(await stale()).toBe(false); // no node_modules
    await withModules(appPath);
    expect(await stale()).toBe(false); // unmarked is not evidence of a change
    await withModules(appPath, ID);
    expect(await stale()).toBe(false);
    await withModules(appPath, OTHER_ID);
    expect(await stale()).toBe(true);
    toolchainId = null;
    expect(await stale()).toBe(false); // an unknown toolchain never forces a redeploy

    // static is served by nginx and never loads node_modules
    toolchainId = ID;
    await getStateManager().registerApp('web', appPath, 'static');
    expect(await (platform as any).servingTreeIsStale({ name: 'web', path: appPath })).toBe(false);
  }, 30000);
});

describe('decideBootReconciliationCheap — stale dependencies', () => {
  const base = {
    status: 'running' as const,
    isRuntimeRunning: true,
    hasPort: true,
    portDrifted: false,
    group: undefined,
    grantedApiScopesCount: 0,
    runtimeSpecCurrent: true,
    dependenciesStale: false,
  };

  it('redeploys a running app whose node_modules were built for another Node', () => {
    expect(decideBootReconciliationCheap({ ...base, dependenciesStale: true })).toEqual({
      action: 'redeploy',
      reason: 'node_modules were built for a different Node runtime',
    });
  });

  it('leaves a stopped app alone even when its tree is stale', () => {
    const decision = decideBootReconciliationCheap({
      ...base,
      status: 'stopped',
      dependenciesStale: true,
    });
    expect(decision?.action).toBe('leave');
  });
});
