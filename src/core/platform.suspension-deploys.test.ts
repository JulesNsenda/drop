/**
 * App suspension (follow-up F2, Item 2): the build choke point and the
 * re-checks right before the irreversible steps, against the REAL platform
 * orchestration.
 *
 * Same faked OS boundary as platform.suspension.test.ts (FakeRuntime for PM2,
 * the bundled Postgres stubbed, the watcher a no-op, fs real under a temp
 * root). The re-check cases land the suspension from a spy on the await that
 * precedes the irreversible step: after the entry check, before the step,
 * which is the window the re-check exists for. A record written up front would
 * test the entry refusal instead.
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { fakeRuntime } from './__testutils__/fake-runtime';

jest.mock('../api', () => ({
  createApiServer: jest.fn(() => ({
    initialize: jest.fn().mockResolvedValue(undefined),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  })),
  ApiServer: jest.fn(),
}));

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
    getConnectionString: jest.fn().mockReturnValue('postgresql://postgres@localhost:5433/postgres'),
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
    provisionAppDatabase: jest.fn().mockResolvedValue({ connectionString: 'postgresql://u:p@localhost:5433/app' }),
    getAppCredentials: jest.fn().mockReturnValue(null),
    getEnvVars: jest.fn().mockReturnValue({ DATABASE_URL: 'postgresql://mock-db/app' }),
    hasAppDatabase: jest.fn().mockReturnValue(false),
    listDatabases: jest.fn().mockReturnValue([]),
    deleteAppDatabase: jest.fn().mockResolvedValue(undefined),
    isProvisioned: jest.fn().mockReturnValue(true),
    orphanDatabaseExists: jest.fn().mockResolvedValue(false),
    backupAndDeleteAppDatabase: jest.fn().mockResolvedValue({ dropped: true }),
    dbNameForApp: jest.fn((name: string) => `drop_${name}`),
    ownerDumpDir: jest.fn((userId?: string | null) => `/nonexistent-pre-delete/${userId ?? '_ownerless'}`),
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

import { DropPlatform, createPlatform, PlatformConfig } from './platform';
import { eventBus } from './event-bus';
import { getStateManager } from '../managers/app/state-manager';
import { getSuspensionStore } from '../managers/suspension';
import { AppSuspendedError } from '../api/platform-ops';
import { getAppConfigService } from '../managers/app/app-config';
import { getDatabaseProvisioner } from '../managers/database';
import { captureBeforeRedeploy, getRollbackStore } from '../managers/rollback';

async function waitFor(predicate: () => boolean, timeoutMs = 8000, intervalMs = 25): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: condition not met within timeout');
}

interface PlatformInternals {
  appsInProgress: Set<string>;
  builder: { build: (...args: unknown[]) => Promise<unknown> } | null;
  handleBuildApp: (appPath: string, appName: string, appType: string) => Promise<void>;
  handleAppUpdate: (appName: string, appPath: string, reason: string, bypassCooldown?: boolean) => Promise<boolean>;
  staleCheckToolchainId: (appType: string) => Promise<string | null>;
  appDatabaseUrlSource: (appName: string, appPath: string) => Promise<string | undefined>;
}

describe('app suspension (platform, Item 2: the build choke point and the re-checks)', () => {
  let tempDir: string;
  let webappsDir: string;
  let platform: DropPlatform | null = null;
  const internals = (): PlatformInternals => platform as unknown as PlatformInternals;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-suspension-deploys-'));
    webappsDir = path.join(tempDir, 'webapps');
    fakeRuntime.reset();
  });

  afterEach(async () => {
    if (platform && platform.isActive()) await platform.stop();
    platform = null;
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    jest.restoreAllMocks();
  });

  async function createStaticApp(name: string): Promise<string> {
    const appPath = path.join(webappsDir, name);
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.html'), `<h1>${name}</h1>`);
    return appPath;
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

  async function deploy(name: string): Promise<string> {
    const appPath = await createStaticApp(name);
    eventBus.publish('app:detected', { name, path: appPath, type: undefined });
    await waitFor(
      () => getStateManager().getApp(name)?.status === 'running' && !internals().appsInProgress.has(name)
    );
    return appPath;
  }

  /** Every status an app is written to, in order, from now on. */
  function recordStatuses(name: string): { statuses: string[]; stop: () => void } {
    const statuses: string[] = [];
    const unsubscribe = eventBus.subscribe('app:updated', (payload) => {
      const status = (payload.changes as { status?: string })?.status;
      if (payload.appId === name && status) statuses.push(status);
    });
    return { statuses, stop: unsubscribe };
  }

  describe('the build choke point', () => {
    it('handleBuildApp builds nothing for a suspended app and never writes "building"', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await createStaticApp('site');
      await getStateManager().registerApp('site', appPath, 'static');
      await getSuspensionStore().suspend('site', 'admin-1');
      const build = jest.spyOn(internals().builder!, 'build');
      const recorded = recordStatuses('site');
      const before = getStateManager().getApp('site')?.status;

      await internals().handleBuildApp(appPath, 'site', 'static');
      recorded.stop();

      expect(build).not.toHaveBeenCalled();
      expect(recorded.statuses).toEqual([]);
      expect(getStateManager().getApp('site')?.status).toBe(before);
      expect(fakeRuntime.startCount).toBe(0);
      // No claim, no deferral left behind to replay it.
      expect(internals().appsInProgress.has('site')).toBe(false);
      expect((platform as unknown as { pendingBuilds: Map<string, unknown> }).pendingBuilds.has('site')).toBe(false);
    }, 20000);

    it('a dropped folder with a suspended name is detected but neither built nor started', async () => {
      platform = makePlatform();
      await platform.start();
      await getSuspensionStore().suspend('site', 'admin-1');
      const build = jest.spyOn(internals().builder!, 'build');
      const recorded = recordStatuses('site');

      const appPath = await createStaticApp('site');
      eventBus.publish('app:detected', { name: 'site', path: appPath, type: undefined });
      await waitFor(() => getStateManager().getApp('site') !== undefined);
      await new Promise((r) => setTimeout(r, 200));
      recorded.stop();

      expect(build).not.toHaveBeenCalled();
      expect(recorded.statuses).not.toContain('building');
      expect(recorded.statuses).not.toContain('running');
      expect(fakeRuntime.startCount).toBe(0);
    }, 20000);

    it('an undetectable folder with a suspended name is not marked errored over its status', async () => {
      platform = makePlatform();
      await platform.start();
      await getSuspensionStore().suspend('site', 'admin-1');
      const recorded = recordStatuses('site');

      const appPath = path.join(webappsDir, 'site');
      await fs.mkdir(appPath, { recursive: true });
      eventBus.publish('app:detected', { name: 'site', path: appPath, type: 'unknown' });
      await waitFor(() => getStateManager().getApp('site') !== undefined);
      await new Promise((r) => setTimeout(r, 200));
      recorded.stop();

      expect(recorded.statuses).not.toContain('errored');
    }, 20000);

    it('a file change on a suspended app is dropped: no rebuild, no restart', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await deploy('site');
      await getSuspensionStore().suspend('site', 'admin-1');
      const build = jest.spyOn(internals().builder!, 'build');
      const starts = fakeRuntime.startCount;

      expect(await internals().handleAppUpdate('site', appPath, 'file change', true)).toBe(false);

      expect(build).not.toHaveBeenCalled();
      expect(fakeRuntime.startCount).toBe(starts);
      expect(fakeRuntime.restartCount).toBe(0);
      expect(internals().appsInProgress.has('site')).toBe(false);
    }, 20000);
  });

  describe('a re-check right before the irreversible step', () => {
    it('rollbackApp: a suspension landing after the entry check stops it before restoreInto empties the tree', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await deploy('site');
      expect((await captureBeforeRedeploy('site')).captured).toBe(true);
      await fs.writeFile(path.join(appPath, 'index.html'), '<h1>v2 broken</h1>');
      await fs.writeFile(path.join(appPath, 'extra.js'), 'only in v2');
      // The await just before restoreInto: the suspension lands in it.
      const original = internals().staleCheckToolchainId.bind(platform);
      jest.spyOn(internals(), 'staleCheckToolchainId').mockImplementationOnce(async (type: string) => {
        const id = await original(type);
        await getSuspensionStore().suspend('site', 'admin-1');
        return id;
      });
      const restore = jest.spyOn(getRollbackStore()!, 'restoreInto');
      const starts = fakeRuntime.startCount;

      await expect(platform.rollbackApp('site')).rejects.toBeInstanceOf(AppSuspendedError);

      expect(restore).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(appPath, 'index.html'), 'utf-8')).toBe('<h1>v2 broken</h1>');
      await expect(fs.access(path.join(appPath, 'extra.js'))).resolves.toBeUndefined();
      expect(await getRollbackStore()?.get('site')).toBeTruthy();
      expect(fakeRuntime.startCount).toBe(starts);
      expect(internals().appsInProgress.has('site')).toBe(false);
    }, 30000);

    it('attachService: a suspension landing after the entry check stops it before the provisioner is called', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      const provision = getDatabaseProvisioner()!.provisionAppDatabase as jest.Mock;
      provision.mockClear();
      // The last await before the provisioner call.
      const original = internals().appDatabaseUrlSource.bind(platform);
      jest.spyOn(internals(), 'appDatabaseUrlSource').mockImplementationOnce(async (name: string, appPath: string) => {
        const source = await original(name, appPath);
        await getSuspensionStore().suspend('site', 'admin-1');
        return source;
      });

      await expect(platform.attachService('site', 'postgres')).rejects.toBeInstanceOf(AppSuspendedError);

      expect(provision).not.toHaveBeenCalled();
      expect(getAppConfigService().getConfig('site')?.services?.postgres).toBeUndefined();
      expect(internals().appsInProgress.has('site')).toBe(false);
    }, 30000);
  });
});
