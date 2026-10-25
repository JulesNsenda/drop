/**
 * The start guard (plan docs/plans/2026-10-23-node-abi-rebuild.md, item 4):
 * every path that would run a node_modules tree built for another Node
 * runtime refuses with StaleDependenciesError BEFORE its first side effect,
 * and an explicit redeploy is the way out, a stopped app included.
 *
 * Same faked OS boundary as platform.toolchain-backfill.test.ts: a FakeRuntime,
 * a stubbed Postgres, a no-op watcher; fs is REAL, under a temp root. The
 * toolchain id is pinned so the tests never depend on the host Node.
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
import { getStateManager } from '../managers/app/state-manager';
import { getAppConfigService } from '../managers/app/app-config';
import { getDatabaseProvisioner } from '../managers/database';
import { StaleDependenciesError } from '../api/platform-ops';
import { TOOLCHAIN_MARKER } from './builder/toolchain';

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

describe('start guard: a tree built for another Node runtime is never started', () => {
  let tempDir: string;
  let webappsDir: string;
  let platform: DropPlatform | null = null;
  let appPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-start-guard-'));
    webappsDir = path.join(tempDir, 'webapps');
    fakeRuntime.reset();
    jest
      .spyOn(DropPlatform.prototype as any, 'toolchainIdForBuild')
      .mockImplementation(async () => ID);

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: webappsDir,
      logLevel: 'error',
      autoBuild: true,
      autoStart: true,
      enableApi: false,
      enableHttps: false,
      caddyfilePath: path.join(tempDir, 'Caddyfile'),
    });
    await platform.start();

    // A running app, deployed as static (the type the harness can build).
    // Each test then turns the tree it starts into a Node app or leaves it.
    appPath = path.join(webappsDir, 'site');
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.html'), '<h1>site</h1>');
    eventBus.publish('app:detected', { name: 'site', path: appPath, type: undefined });
    await waitFor(() => getStateManager().getApp('site')?.status === 'running');
    await waitFor(() => getAppConfigService().getConfig('site')?.sourceHash !== undefined);
  }, 30000);

  afterEach(async () => {
    if (platform && platform.isActive()) await platform.stop();
    platform = null;
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }, 20000);

  /** A tree the detector reads as a Node app, with node_modules carrying `marker`. */
  const nodeTree = async (tree: string, marker?: string): Promise<void> => {
    await fs.mkdir(path.join(tree, 'node_modules'), { recursive: true });
    await fs.writeFile(
      path.join(tree, 'package.json'),
      JSON.stringify({ name: 'site', version: '1.0.0', scripts: { start: 'node index.js' } })
    );
    await fs.writeFile(path.join(tree, 'index.js'), '');
    if (marker !== undefined) {
      await fs.writeFile(path.join(tree, 'node_modules', TOOLCHAIN_MARKER), marker);
    }
  };

  const releaseDir = (id: string): string => path.join(tempDir, 'data', 'releases', 'site', id);

  it('restart: refused before anything is stopped, and the app keeps running', async () => {
    await nodeTree(appPath, OTHER_ID);
    const startsBefore = fakeRuntime.startCount;

    await expect(platform!.restartApp('site')).rejects.toBeInstanceOf(StaleDependenciesError);

    expect(fakeRuntime.runningNames()).toContain('site');
    expect(fakeRuntime.startCount).toBe(startsBefore);
    expect(getStateManager().getApp('site')?.status).toBe('running');
  }, 30000);

  it('the message names no path, marker or Node version', async () => {
    await nodeTree(appPath, OTHER_ID);
    const err = await platform!.restartApp('site').catch((e: Error) => e);
    expect(err).toBeInstanceOf(StaleDependenciesError);
    const message = (err as Error).message;
    for (const leak of [ID, OTHER_ID, tempDir, TOOLCHAIN_MARKER, 'node-abi']) {
      expect(message).not.toContain(leak);
    }
  }, 30000);

  it.each([
    ['a matching tree', ID],
    ['an unmarked tree (a custom install the build never stamps)', undefined],
  ])('restart: %s starts', async (_label, marker) => {
    await nodeTree(appPath, marker);
    await expect(platform!.restartApp('site')).resolves.toBeDefined();
  }, 30000);

  it('restart: a tree that detects as static is exempt, whatever type is recorded', async () => {
    await getStateManager().updateApp('site', { type: 'nodejs' });
    await fs.mkdir(path.join(appPath, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(appPath, 'node_modules', TOOLCHAIN_MARKER), OTHER_ID);
    await expect(platform!.restartApp('site')).resolves.toBeDefined();
  }, 30000);

  it('restart: the detected type wins over a recorded static type', async () => {
    expect(getStateManager().getApp('site')?.type).toBe('static');
    await nodeTree(appPath, OTHER_ID);
    await expect(platform!.restartApp('site')).rejects.toBeInstanceOf(StaleDependenciesError);
  }, 30000);

  it('restart: nothing is refused before the backfill has vouched for the trees', async () => {
    (platform as any).toolchainBackfilled = false;
    await nodeTree(appPath, OTHER_ID);
    await expect(platform!.restartApp('site')).resolves.toBeDefined();
  }, 30000);

  it('rollback to a snapshot: refused before the app directory is emptied', async () => {
    await getStateManager().updateApp('site', { type: 'nodejs' }); // a snapshot is judged by the recorded type
    const snapshot = path.join(tempDir, 'data', 'rollback', 'site');
    await nodeTree(path.join(snapshot, 'tree'), OTHER_ID);
    await fs.writeFile(path.join(snapshot, 'meta.json'), JSON.stringify({ appName: 'site', takenAt: 'x', bytes: 0 }));
    const startsBefore = fakeRuntime.startCount;

    await expect(platform!.rollbackApp('site')).rejects.toBeInstanceOf(StaleDependenciesError);

    await expect(fs.readFile(path.join(appPath, 'index.html'), 'utf-8')).resolves.toBe('<h1>site</h1>');
    expect(fakeRuntime.startCount).toBe(startsBefore);
    expect(getStateManager().getApp('site')?.status).toBe('running');
  }, 30000);

  it('rollback to the previous release: refused before the releases rotate', async () => {
    const previous = { id: 'rel-0', path: releaseDir('rel-0'), createdAt: new Date().toISOString() };
    await nodeTree(previous.path, OTHER_ID);
    await getAppConfigService().updateSystemConfig('site', { previousRelease: previous });
    const startsBefore = fakeRuntime.startCount;

    await expect(platform!.rollbackApp('site')).rejects.toBeInstanceOf(StaleDependenciesError);

    const config = getAppConfigService().getConfig('site');
    expect(config?.previousRelease?.path).toBe(previous.path);
    expect(config?.currentRelease).toBeUndefined();
    expect(fakeRuntime.startCount).toBe(startsBefore);
    expect(getStateManager().getApp('site')?.status).toBe('running');
  }, 30000);

  it('promote: refused, and the build stays held', async () => {
    const held = releaseDir('rel-2');
    await nodeTree(held, OTHER_ID);
    const pending = { builtAt: new Date().toISOString(), releasePath: held };
    await getAppConfigService().updateSystemConfig('site', { pendingPromotion: pending });
    await getStateManager().updateApp('site', { awaitingPromotion: true });

    await expect(platform!.promoteApp('site')).rejects.toBeInstanceOf(StaleDependenciesError);

    expect(getAppConfigService().getConfig('site')?.pendingPromotion).toEqual(pending);
    expect(getStateManager().getApp('site')?.awaitingPromotion).toBe(true);
    expect(getStateManager().getApp('site')?.status).toBe('running');
  }, 30000);

  it('attach: refused as a returned refusal, before a database is provisioned', async () => {
    await nodeTree(appPath, OTHER_ID);
    const provision = getDatabaseProvisioner()!.provisionAppDatabase as jest.Mock;
    provision.mockClear();

    const result = await platform!.attachService('site', 'postgres');

    expect(result).toEqual({
      attached: false,
      reason: 'stale-dependencies',
      detail: new StaleDependenciesError('site').message,
    });
    expect(provision).not.toHaveBeenCalled();
    expect(getAppConfigService().getConfig('site')?.services?.postgres).toBeUndefined();
  }, 30000);

  it('buildStartSpec refuses too: the backstop for start paths with no pre-check', async () => {
    await nodeTree(appPath, OTHER_ID);
    const detection = { type: 'nodejs', framework: null, confidence: 1, suggestedConfig: {} };
    await expect(
      (platform as any).buildStartSpec('site', appPath, detection, 4100, path.join(tempDir, 'd'), {})
    ).rejects.toBeInstanceOf(StaleDependenciesError);
  }, 30000);

  describe('an explicit redeploy of a stopped app', () => {
    const redeployStopped = async (marker: string): Promise<jest.Mock> => {
      await nodeTree(appPath, marker);
      await fakeRuntime.stop('site');
      await getStateManager().setAppStatus('site', 'stopped');
      const build = jest.fn().mockResolvedValue({ success: false, duration: 1, errors: [{ message: 'stub' }] });
      (platform as any).builder = { build };
      await (platform as any).handleAppUpdate('site', appPath, 'redeploy', true);
      return build;
    };

    it('rebuilds a stale tree: the way out the refusal names', async () => {
      expect(await redeployStopped(OTHER_ID)).toHaveBeenCalledTimes(1);
    }, 30000);

    it('is still dropped for a tree that is current', async () => {
      expect(await redeployStopped(ID)).not.toHaveBeenCalled();
      expect(getStateManager().getApp('site')?.status).toBe('stopped');
    }, 30000);
  });
});
