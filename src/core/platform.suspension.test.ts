/**
 * App suspension (follow-up F2, Item 1): the store, the start choke point and
 * the mid-deploy closer, against the REAL platform orchestration.
 *
 * Same faked OS boundary as platform.restart.test.ts (FakeRuntime for PM2, the
 * bundled Postgres stubbed, the watcher a no-op, fs real under a temp root).
 *
 * The mid-deploy cases inject the suspension from a spy on `noteRuntimeLogStart`,
 * which runs immediately before every start site: the record lands AFTER the
 * entry checks and BEFORE the runtime call, which is the window the closer
 * exists for. A record written up front would test a refusal instead.
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
import { getDeployTracker, getDeployDetailStore } from '../managers/deploy-tracker';
import { getDeployBreaker } from '../managers/guardrail/deploy-breaker';
import { getPrincipalQuota } from '../managers/guardrail/principal-quota';
import { AppSuspendedError } from '../api/platform-ops';
import { getAppConfigService } from '../managers/app/app-config';
import { getDatabaseProvisioner } from '../managers/database';
import { captureBeforeRedeploy, getRollbackStore } from '../managers/rollback';
import * as authModule from '../api/middleware/auth';

async function waitFor(predicate: () => boolean, timeoutMs = 8000, intervalMs = 25): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: condition not met within timeout');
}

interface PlatformInternals {
  noteRuntimeLogStart: (appName: string) => Promise<void>;
  noteRuntimeLogEnd: (appName: string) => Promise<void>;
  startHealthProber: (appName: string, port: number, healthPath: string) => void;
  healthProbers: Map<string, unknown>;
  crashLoopWatchers: Map<string, unknown>;
  router: { removeRoutesForApp: (name: string) => Promise<void> };
}

describe('app suspension (platform, Item 1)', () => {
  let tempDir: string;
  let webappsDir: string;
  let platform: DropPlatform | null = null;
  const internals = (): PlatformInternals => platform as unknown as PlatformInternals;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-suspension-'));
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
      () =>
        getStateManager().getApp(name)?.status === 'running' &&
        !(platform as unknown as { appsInProgress: Set<string> }).appsInProgress.has(name)
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

  /** Suspend the app the moment its next start is about to be attempted. */
  function suspendBeforeNextStart(name: string): void {
    const original = internals().noteRuntimeLogStart.bind(platform);
    jest
      .spyOn(internals(), 'noteRuntimeLogStart')
      .mockImplementationOnce(async (app: string) => {
        await original(app);
        await getSuspensionStore().suspend(name, 'admin-1');
      });
  }

  describe('suspendApp', () => {
    it('records the suspension, deletes BOTH slots by explicit reference and leaves the app stopped', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      const deleteSpy = jest.spyOn(fakeRuntime, 'delete');
      const removeRoutes = jest.spyOn(internals().router, 'removeRoutesForApp');
      const revoke = jest.spyOn(authModule, 'deleteApiKeysByName');

      const result = await platform.suspendApp('site', 'admin-1', 'abuse');

      expect(result).toMatchObject({ suspended: true });
      expect('stopErrors' in result).toBe(false);
      expect(getSuspensionStore().get('site')).toMatchObject({ by: 'admin-1', reason: 'abuse' });
      // Never the bare name: it only ever means the live slot.
      expect(deleteSpy.mock.calls.map((c) => c[0])).toEqual(['site.a', 'site.b']);
      expect(fakeRuntime.runningNames()).toEqual([]);
      expect(removeRoutes).toHaveBeenCalledWith('site');
      expect(revoke).toHaveBeenCalledWith('app:site:provision');
      const app = getStateManager().getApp('site')!;
      expect(app.status).toBe('stopped');
      expect(app.error).toBe('Suspended by admin');
    }, 20000);

    it('stops the prober and the crash-loop watch', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      internals().startHealthProber('site', 1, '/health');
      expect(internals().healthProbers.has('site')).toBe(true);

      await platform.suspendApp('site', 'admin-1');

      expect(internals().healthProbers.has('site')).toBe(false);
      expect(internals().crashLoopWatchers.has('site')).toBe(false);
    }, 20000);

    it('reports what is still live as stopErrors, never a bare success', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      // A delete that swallows its error and leaves the process in place.
      jest.spyOn(fakeRuntime, 'delete').mockImplementation(async () => undefined);

      const result = await platform.suspendApp('site', 'admin-1');

      expect(result).toMatchObject({ suspended: true });
      expect((result as { stopErrors?: string[] }).stopErrors).toEqual(['site: still present after delete']);
      // The suspension holds regardless.
      expect(getSuspensionStore().isSuspended('site')).toBe(true);
    }, 20000);

    it('reports a delete that throws', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      jest.spyOn(fakeRuntime, 'delete').mockRejectedValue(new Error('pm2 down'));

      const result = await platform.suspendApp('site', 'admin-1');

      // Each failed delete, then the verification: the process is still there.
      expect((result as { stopErrors?: string[] }).stopErrors).toEqual([
        'site.a: pm2 down',
        'site.b: pm2 down',
        'site: still present after delete',
      ]);
    }, 20000);

    it('refuses a monorepo container, naming its services, and records nothing', async () => {
      platform = makePlatform();
      await platform.start();
      const sm = getStateManager();
      await sm.registerApp('mono', path.join(webappsDir, 'mono'));
      await sm.updateApp('mono', { group: 'mono', isGroupContainer: true });
      await sm.registerApp('mono-api', path.join(webappsDir, 'mono-api'));
      await sm.updateApp('mono-api', { group: 'mono' });
      await sm.registerApp('mono-web', path.join(webappsDir, 'mono-web'));
      await sm.updateApp('mono-web', { group: 'mono' });

      const result = await platform.suspendApp('mono', 'admin-1');

      expect(result).toEqual({ refused: 'group-container', services: ['mono-api', 'mono-web'] });
      expect(getSuspensionStore().isSuspended('mono')).toBe(false);
    }, 20000);

    it('rejects, touching nothing, when the record cannot be written', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      jest.spyOn(getSuspensionStore(), 'suspend').mockRejectedValue(new Error('disk full'));
      const deleteSpy = jest.spyOn(fakeRuntime, 'delete');

      await expect(platform.suspendApp('site', 'admin-1')).rejects.toThrow('disk full');

      expect(deleteSpy).not.toHaveBeenCalled();
      expect(getStateManager().getApp('site')?.status).toBe('running');
    }, 20000);
  });

  describe('names', () => {
    it('refuses to suspend or unsuspend an app that differs only in case from another, changing nothing', async () => {
      platform = makePlatform();
      await platform.start();
      const sm = getStateManager();
      await sm.registerApp('Shop', path.join(webappsDir, 'Shop'));
      await sm.registerApp('shop', path.join(webappsDir, 'shop'));
      await getSuspensionStore().suspend('shop', 'admin-1');

      expect(await platform.suspendApp('Shop', 'admin-1')).toEqual({ refused: 'case-collision', names: ['shop'] });
      expect(await platform.unsuspendApp('shop')).toEqual({ refused: 'case-collision', names: ['Shop'] });

      // Neither touched the record or the apps.
      expect(getSuspensionStore().refusalFor('shop')).toBe('record');
      expect(getSuspensionStore().list()).toHaveLength(1);
    }, 20000);

    it('counts a variant that exists only as a config name', async () => {
      platform = makePlatform();
      await platform.start();
      await getAppConfigService().upsertSystemConfig('Shop', { type: 'static' });

      expect(await platform.suspendApp('shop', 'admin-1')).toEqual({ refused: 'case-collision', names: ['Shop'] });
      expect(getSuspensionStore().list()).toHaveLength(0);
    }, 20000);

    it('does NOT count a tenant-authored group or container name: the suspension still goes through', async () => {
      platform = makePlatform();
      await platform.start();
      await createStaticApp('evil');
      await getStateManager().registerApp('evil', path.join(webappsDir, 'evil'));
      await getAppConfigService().upsertSystemConfig('evil-web', { type: 'static', group: 'EVIL', groupContainer: 'Evil' });

      const result = await platform.suspendApp('evil', 'admin-1');

      expect(result).toMatchObject({ suspended: true });
      expect(getSuspensionStore().refusalFor('evil')).toBe('record');
      expect(await platform.unsuspendApp('evil')).toEqual({ unsuspended: true });
    }, 20000);

    it('a start with no usable name is refused, not read as "not suspended"', async () => {
      platform = makePlatform();
      await platform.start();
      const assertStartable = (name: unknown) =>
        (platform as unknown as { assertStartable: (n: unknown) => void }).assertStartable(name);

      expect(() => assertStartable(undefined)).toThrow('without a name');
      expect(() => assertStartable('')).toThrow('without a name');
      expect(() => assertStartable(42)).toThrow('without a name');
      expect(() => assertStartable('fine')).not.toThrow();
    }, 20000);
  });

  describe('the start choke point', () => {
    it('refuses start and restart of a suspended app with zero start AND zero restart calls', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      await platform.suspendApp('site', 'admin-1');
      const starts = fakeRuntime.startCount;
      const restarts = fakeRuntime.restartCount;

      await expect(platform.restartApp('site')).rejects.toBeInstanceOf(AppSuspendedError);
      await expect(platform.restartApp('site')).rejects.toMatchObject({ code: 'APP_SUSPENDED' });

      expect(fakeRuntime.startCount).toBe(starts);
      expect(fakeRuntime.restartCount).toBe(restarts);
      expect(getStateManager().getApp('site')?.status).toBe('stopped');
    }, 20000);

    it('refuses every start when the store is corrupt, and says the store is the reason, not an administrator', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      await fs.writeFile(path.join(tempDir, 'data', 'drop-svc', 'suspensions.json'), '{ broken');
      jest.spyOn(console, 'error').mockImplementation();
      await getSuspensionStore().load();
      const starts = fakeRuntime.startCount;

      const refused = await platform.restartApp('site').catch((e) => e);
      expect(refused).toBeInstanceOf(AppSuspendedError);
      expect(refused.reason).toBe('store-unreadable');
      expect(refused.message).toContain('suspension store is unreadable');
      expect(refused.message).not.toContain('by an administrator');

      expect(fakeRuntime.startCount).toBe(starts);
      expect(fakeRuntime.restartCount).toBe(0);
    }, 20000);

    it('loads a stored suspension at boot, so a restart of the platform keeps it', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      await platform.suspendApp('site', 'admin-1');
      await platform.stop();

      platform = makePlatform();
      await platform.start();

      expect(getSuspensionStore().isSuspended('site')).toBe(true);
      await expect(platform.restartApp('site')).rejects.toBeInstanceOf(AppSuspendedError);
    }, 30000);

    it('the health prober leaves a suspended app down instead of restarting it', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      const intervals: Array<() => Promise<void>> = [];
      const realSetInterval = global.setInterval;
      jest.spyOn(global, 'setInterval').mockImplementation(((fn: () => Promise<void>, ms?: number) => {
        if (ms === 30_000) {
          intervals.push(fn);
          return realSetInterval(() => undefined, 1 << 30);
        }
        return realSetInterval(fn, ms);
      }) as typeof setInterval);

      // Control: with no suspension, the third failed probe DOES restart the app.
      internals().startHealthProber('site', 1, '/health');
      for (let i = 0; i < 3; i++) await intervals[0]();
      expect(fakeRuntime.restartCount).toBe(1);

      // A record written directly (not suspendApp), so the prober is still armed.
      await getSuspensionStore().suspend('site', 'admin-1');
      internals().startHealthProber('site', 1, '/health');
      for (let i = 0; i < 3; i++) await intervals[1]();

      expect(fakeRuntime.restartCount).toBe(1);
      expect(internals().healthProbers.has('site')).toBe(false);
    }, 20000);

    it('unsuspend leaves the app stopped with its error cleared, and a start then works', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      await platform.suspendApp('site', 'admin-1');
      expect(getStateManager().getApp('site')?.error).toBe('Suspended by admin');

      expect(await platform.unsuspendApp('site')).toEqual({ unsuspended: true });

      const app = getStateManager().getApp('site')!;
      expect(app.status).toBe('stopped');
      expect(app.error).toBeUndefined();
      expect(getSuspensionStore().isSuspended('site')).toBe(false);

      const info = await platform.restartApp('site');
      expect(info.status).toBe('running');
      expect(getStateManager().getApp('site')?.status).toBe('running');
    }, 20000);

    it('unsuspend of a name with a record but no app just drops the record; of an unsuspended name it says so', async () => {
      platform = makePlatform();
      await platform.start();
      await getSuspensionStore().suspend('ghost', 'admin-1');

      expect(await platform.unsuspendApp('ghost')).toEqual({ unsuspended: true });
      expect(getSuspensionStore().isSuspended('ghost')).toBe(false);
      expect(await platform.unsuspendApp('ghost')).toEqual({ unsuspended: false });
    }, 20000);
  });

  describe('refusals at the entry of an operation that changes state first', () => {
    it('rollbackApp refuses a suspended app and leaves the tree, the snapshot and the process untouched', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await deploy('site');
      expect((await captureBeforeRedeploy('site')).captured).toBe(true);
      await fs.writeFile(path.join(appPath, 'index.html'), '<h1>v2 broken</h1>');
      await fs.writeFile(path.join(appPath, 'extra.js'), 'only in v2');
      await getSuspensionStore().suspend('site', 'admin-1');
      const starts = fakeRuntime.startCount;

      await expect(platform.rollbackApp('site')).rejects.toBeInstanceOf(AppSuspendedError);

      // The tree was NOT restored, and the snapshot is still there to restore later.
      expect(await fs.readFile(path.join(appPath, 'index.html'), 'utf-8')).toBe('<h1>v2 broken</h1>');
      await expect(fs.access(path.join(appPath, 'extra.js'))).resolves.toBeUndefined();
      expect(await getRollbackStore()?.get('site')).toBeTruthy();
      expect(fakeRuntime.startCount).toBe(starts);
      expect(fakeRuntime.restartCount).toBe(0);
      expect((platform as unknown as { appsInProgress: Set<string> }).appsInProgress.has('site')).toBe(false);
    }, 30000);

    it('attachService refuses a suspended app before provisioning anything or recording the intent', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      await getSuspensionStore().suspend('site', 'admin-1');
      const provision = getDatabaseProvisioner()!.provisionAppDatabase as jest.Mock;
      provision.mockClear();

      await expect(platform.attachService('site', 'postgres')).rejects.toBeInstanceOf(AppSuspendedError);

      expect(provision).not.toHaveBeenCalled();
      expect(getAppConfigService().getConfig('site')?.services?.postgres).toBeUndefined();
      expect((platform as unknown as { appsInProgress: Set<string> }).appsInProgress.has('site')).toBe(false);
    }, 30000);

    it('promoteApp refuses a suspended app and the held build stays held', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      const pendingPromotion = { builtAt: '2026-07-27T00:00:00.000Z', outputDirectory: '.' };
      await getAppConfigService().updateConfig('site', { pendingPromotion } as never);
      await getStateManager().updateApp('site', { awaitingPromotion: true });
      await getSuspensionStore().suspend('site', 'admin-1');
      const starts = fakeRuntime.startCount;

      await expect(platform.promoteApp('site')).rejects.toBeInstanceOf(AppSuspendedError);

      expect(getAppConfigService().getConfig('site')?.pendingPromotion).toEqual(pendingPromotion);
      expect(getStateManager().getApp('site')?.awaitingPromotion).toBe(true);
      expect(fakeRuntime.startCount).toBe(starts);
    }, 30000);

    it('detachService is still allowed on a suspended app', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      await getSuspensionStore().suspend('site', 'admin-1');

      await expect(platform.detachService('site', 'postgres')).resolves.toBeDefined();
    }, 30000);
  });

  describe('the mid-deploy closer', () => {
    it('a suspension landing during an in-place redeploy stops the app, closes the episode once as DEPLOY_STOPPED and charges nothing', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await deploy('site');
      const recordFailure = jest.spyOn(getDeployBreaker(), 'recordFailure');
      const recordQuota = jest.spyOn(getPrincipalQuota(), 'record');
      const revoke = jest.spyOn(authModule, 'deleteApiKeysByName');
      const recorded = recordStatuses('site');
      const starts = fakeRuntime.startCount;
      suspendBeforeNextStart('site');

      await fs.writeFile(path.join(appPath, 'index.html'), 'v2');
      eventBus.publish('app:update', { name: 'site', path: appPath, reason: 'edit', bypassCooldown: true });
      await waitFor(() => getStateManager().getApp('site')?.status === 'stopped');
      await waitFor(
        () => !(platform as unknown as { appsInProgress: Set<string> }).appsInProgress.has('site')
      );
      recorded.stop();

      expect(fakeRuntime.startCount).toBe(starts);
      expect(fakeRuntime.restartCount).toBe(0);
      // Never 'errored', and never 'running' again.
      expect(recorded.statuses).not.toContain('errored');
      expect(recorded.statuses).not.toContain('running');
      expect(getStateManager().getApp('site')?.error).toBe('Suspended by admin');
      expect(internals().healthProbers.has('site')).toBe(false);
      expect(internals().crashLoopWatchers.has('site')).toBe(false);

      expect(getDeployTracker().hasOpenEpisode('site')).toBe(false);
      const episodes = getDeployTracker().getEpisodes('site');
      expect(episodes).toHaveLength(2);
      expect(episodes[0].status).toBe('failed');
      expect(getDeployDetailStore().getDetail(episodes[0].deployId)?.errorCode).toBe('DEPLOY_STOPPED');
      expect(recordFailure).not.toHaveBeenCalled();
      expect(recordQuota).not.toHaveBeenCalled();
      // Every start re-mints the provisioning key before the guard throws; the closer revokes it.
      expect(revoke).toHaveBeenCalledWith('app:site:provision');
    }, 30000);

    it('a first deploy that hits the guard in handleStartApp ends stopped, not errored', async () => {
      platform = makePlatform();
      await platform.start();
      const recordFailure = jest.spyOn(getDeployBreaker(), 'recordFailure');
      const recorded = recordStatuses('fresh');
      const appPath = await createStaticApp('fresh');
      const episodesBefore = getDeployTracker().getEpisodes('fresh').length;
      suspendBeforeNextStart('fresh');

      eventBus.publish('app:detected', { name: 'fresh', path: appPath, type: undefined });
      await waitFor(() => getStateManager().getApp('fresh')?.status === 'stopped');
      await waitFor(
        () => !(platform as unknown as { appsInProgress: Set<string> }).appsInProgress.has('fresh')
      );
      recorded.stop();

      expect(fakeRuntime.startCount).toBe(0);
      expect(recorded.statuses).not.toContain('errored');
      expect(recorded.statuses).not.toContain('running');
      expect(getDeployTracker().hasOpenEpisode('fresh')).toBe(false);
      // Closed exactly once: one episode for the whole deploy, not a second one for the closure.
      expect(getDeployTracker().getEpisodes('fresh')).toHaveLength(episodesBefore + 1);
      const [episode] = getDeployTracker().getEpisodes('fresh');
      expect(episode.status).toBe('failed');
      expect(getDeployDetailStore().getDetail(episode.deployId)?.errorCode).toBe('DEPLOY_STOPPED');
      expect(recordFailure).not.toHaveBeenCalled();
      expect(internals().healthProbers.has('fresh')).toBe(false);
    }, 30000);

    it('an unreadable store mid-deploy parks the app errored with the store as the reason, not stopped by an administrator', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await deploy('site');
      jest.spyOn(console, 'error').mockImplementation();
      const original = internals().noteRuntimeLogStart.bind(platform);
      jest.spyOn(internals(), 'noteRuntimeLogStart').mockImplementationOnce(async (app: string) => {
        await original(app);
        await fs.writeFile(path.join(tempDir, 'data', 'drop-svc', 'suspensions.json'), '{ broken');
        await getSuspensionStore().load();
      });

      await fs.writeFile(path.join(appPath, 'index.html'), 'v2');
      eventBus.publish('app:update', { name: 'site', path: appPath, reason: 'edit', bypassCooldown: true });
      await waitFor(() => getStateManager().getApp('site')?.status === 'errored');

      const app = getStateManager().getApp('site')!;
      // Tenants read AppState.error: the generic refusal, not the store's state and not an admin's act.
      expect(app.error).toBe("Starting 'site' is refused right now; contact your administrator");
      expect(app.error).not.toContain('Suspended by admin');
      expect(app.error).not.toContain('suspension store');
      const [episode] = getDeployTracker().getEpisodes('site');
      // Nobody stopped anything (the store cannot answer): a refusal, not a stop.
      expect(getDeployDetailStore().getDetail(episode.deployId)?.errorCode).toBe('DEPLOY_REFUSED');
      // The episode detail is tenant-readable too: no store state there either.
      expect(JSON.stringify(getDeployDetailStore().getDetail(episode.deployId))).not.toContain('suspension store');
    }, 30000);

    describe('a refused promotion gives the held build back exactly as it was', () => {
      /** A deployed app with a HELD release (as a manual-promotion deploy leaves it), and its held episode open. */
      async function holdBuild(): Promise<{ pending: Record<string, unknown>; releasePath: string }> {
        const appPath = await deploy('site');
        const releaseStore = (platform as unknown as {
          releaseStore: { stage: (a: string, s: string, id: string) => Promise<string> };
        }).releaseStore;
        const releasePath = await releaseStore.stage('site', appPath, 'held-1');
        const pending = {
          deployId: 'held-1',
          builtAt: '2026-07-27T00:00:00.000Z',
          outputDirectory: getAppConfigService().getConfig('site')?.outputDirectory,
          releasePath,
        };
        await getAppConfigService().updateConfig('site', { pendingPromotion: pending } as never);
        await getStateManager().updateApp('site', { awaitingPromotion: true });
        // The held build's episode is left open by design.
        eventBus.publish('build:started', { appId: 'site', buildId: 'b-held', deployId: 'held-1' });
        expect(getDeployTracker().hasOpenEpisode('site')).toBe(true);
        return { pending, releasePath };
      }

      async function expectHeldIntact(
        pending: Record<string, unknown>,
        releasePath: string,
        status = 'running'
      ): Promise<void> {
        // The app as it was at entry: the transient 'starting' is undone (or, when the
        // suspension really stopped it, the truth is left).
        expect(getStateManager().getApp('site')?.status).toBe(status);
        expect(getAppConfigService().getConfig('site')?.pendingPromotion).toEqual(pending);
        expect(getStateManager().getApp('site')?.awaitingPromotion).toBe(true);
        await expect(fs.access(releasePath)).resolves.toBeUndefined();
        expect(getDeployTracker().hasOpenEpisode('site')).toBe(true);
        expect((platform as unknown as { deployTargets: Map<string, string> }).deployTargets.has('site')).toBe(false);
        expect((platform as unknown as { appsInProgress: Set<string> }).appsInProgress.has('site')).toBe(false);
      }

      it('start branch: rejects with AppSuspendedError, restores the hold, keeps the release and the open episode, revokes the key', async () => {
        platform = makePlatform();
        await platform.start();
        const { pending, releasePath } = await holdBuild();
        const revoke = jest.spyOn(authModule, 'deleteApiKeysByName');
        // A real suspension (it takes the instances down), landing just before the start.
        const original = internals().noteRuntimeLogStart.bind(platform);
        jest.spyOn(internals(), 'noteRuntimeLogStart').mockImplementationOnce(async (app: string) => {
          await original(app);
          await platform!.suspendApp('site', 'admin-1');
        });
        revoke.mockClear();

        await expect(platform.promoteApp('site')).rejects.toBeInstanceOf(AppSuspendedError);

        expect(getStateManager().getApp('site')?.status).toBe('stopped');
        await expectHeldIntact(pending, releasePath, 'stopped');
        // The closer's own revoke (suspendApp's came first and was cleared above).
        expect(revoke).toHaveBeenCalledWith('app:site:provision');
      }, 30000);

      it('an unreadable store with the old version still serving: the held episode stays open and no status closes it', async () => {
        platform = makePlatform();
        await platform.start();
        const { pending, releasePath } = await holdBuild();
        jest.spyOn(console, 'error').mockImplementation();
        const recorded = recordStatuses('site');
        const original = internals().noteRuntimeLogStart.bind(platform);
        jest.spyOn(internals(), 'noteRuntimeLogStart').mockImplementationOnce(async (app: string) => {
          await original(app);
          await fs.writeFile(path.join(tempDir, 'data', 'drop-svc', 'suspensions.json'), '{ broken');
          await getSuspensionStore().load();
        });

        await expect(platform.promoteApp('site')).rejects.toBeInstanceOf(AppSuspendedError);
        recorded.stop();

        // The tracker closes an episode on exactly these two.
        expect(recorded.statuses).not.toContain('running');
        expect(recorded.statuses).not.toContain('errored');
        await expectHeldIntact(pending, releasePath);
      }, 30000);

      it('a runtime that cannot be listed: the same, nothing closes the held episode', async () => {
        platform = makePlatform();
        await platform.start();
        const { pending, releasePath } = await holdBuild();
        const recorded = recordStatuses('site');
        const original = internals().noteRuntimeLogStart.bind(platform);
        jest.spyOn(internals(), 'noteRuntimeLogStart').mockImplementationOnce(async (app: string) => {
          await original(app);
          await getSuspensionStore().suspend('site', 'admin-1');
          jest.spyOn(fakeRuntime, 'getAllStatus').mockRejectedValue(new Error('pm2 down'));
        });

        await expect(platform.promoteApp('site')).rejects.toBeInstanceOf(AppSuspendedError);
        recorded.stop();

        expect(recorded.statuses).not.toContain('running');
        expect(recorded.statuses).not.toContain('errored');
        // A real suspension with the runtime unlistable is 'stopped' (which the tracker ignores).
        await expectHeldIntact(pending, releasePath, 'stopped');
      }, 30000);

      it('start branch: a closer step that throws still hands the refusal back and restores the hold', async () => {
        platform = makePlatform();
        await platform.start();
        const { pending, releasePath } = await holdBuild();
        jest.spyOn(internals(), 'noteRuntimeLogEnd').mockRejectedValue(new Error('closer step broke'));
        jest.spyOn(authModule, 'deleteApiKeysByName').mockRejectedValue(new Error('credentials unwritable'));
        const original = internals().noteRuntimeLogStart.bind(platform);
        jest.spyOn(internals(), 'noteRuntimeLogStart').mockImplementationOnce(async (app: string) => {
          await original(app);
          await getSuspensionStore().suspend('site', 'admin-1');
        });

        await expect(platform.promoteApp('site')).rejects.toBeInstanceOf(AppSuspendedError);

        await expectHeldIntact(pending, releasePath);
      }, 30000);

      it('cutover branch: a closer step that throws still restores the hold', async () => {
        platform = makePlatform();
        await platform.start();
        const { pending, releasePath } = await holdBuild();
        jest.spyOn(platform as never, 'cutoverEligibility' as never).mockResolvedValue(3001 as never);
        jest
          .spyOn(platform as never, 'cutoverTo' as never)
          .mockRejectedValue(new AppSuspendedError('site') as never);
        jest.spyOn(internals(), 'noteRuntimeLogEnd').mockRejectedValue(new Error('closer step broke'));
        jest.spyOn(authModule, 'deleteApiKeysByName').mockRejectedValue(new Error('credentials unwritable'));

        await expect(platform.promoteApp('site')).rejects.toBeInstanceOf(AppSuspendedError);

        await expectHeldIntact(pending, releasePath);
      }, 30000);

      it('a restore write that throws does not replace the AppSuspendedError', async () => {
        platform = makePlatform();
        await platform.start();
        await holdBuild();
        jest.spyOn(platform as never, 'cutoverEligibility' as never).mockResolvedValue(3001 as never);
        jest
          .spyOn(platform as never, 'cutoverTo' as never)
          .mockRejectedValue(new AppSuspendedError('site') as never);
        const acs = getAppConfigService();
        const real = acs.updateConfig.bind(acs);
        jest.spyOn(acs, 'updateConfig').mockImplementationOnce(real).mockRejectedValue(new Error('config unwritable'));

        await expect(platform.promoteApp('site')).rejects.toBeInstanceOf(AppSuspendedError);
        expect((platform as unknown as { appsInProgress: Set<string> }).appsInProgress.has('site')).toBe(false);
      }, 30000);

      it('cutover branch: the same, with the key revoked and the release kept', async () => {
        platform = makePlatform();
        await platform.start();
        const { pending, releasePath } = await holdBuild();
        jest.spyOn(platform as never, 'cutoverEligibility' as never).mockResolvedValue(3001 as never);
        jest
          .spyOn(platform as never, 'cutoverTo' as never)
          .mockRejectedValue(new AppSuspendedError('site') as never);
        const revoke = jest.spyOn(authModule, 'deleteApiKeysByName');
        revoke.mockClear();

        await expect(platform.promoteApp('site')).rejects.toBeInstanceOf(AppSuspendedError);

        await expectHeldIntact(pending, releasePath);
        expect(revoke).toHaveBeenCalledWith('app:site:provision');
      }, 30000);
    });

    describe('the closer leaves a TRUE status, by reason and by what the runtime shows', () => {
      type Cause = { kind: 'suspended'; reason: AppSuspendedError['reason'] } | { kind: 'stopped'; error?: string };
      type Settle = (a: string, c: Cause, o: { closeEpisode: boolean }) => Promise<void>;
      const settleCause = (cause: Cause) =>
        (platform as unknown as { settleRefusedStart: Settle }).settleRefusedStart('site', cause, {
          closeEpisode: false,
        });
      const settle = (error: AppSuspendedError) => settleCause({ kind: 'suspended', reason: error.reason });

      async function deployed(): Promise<void> {
        platform = makePlatform();
        await platform.start();
        await deploy('site');
        await getStateManager().setAppStatus('site', 'building');
      }

      it('a suspension record and a live instance: left alone (suspendApp writes stopped once it is down)', async () => {
        await deployed();
        await settle(new AppSuspendedError('site', 'record'));
        expect(getStateManager().getApp('site')?.status).toBe('building');
      });

      it('a suspension record and nothing live: stopped, "Suspended by admin"', async () => {
        await deployed();
        fakeRuntime.reset();
        await settle(new AppSuspendedError('site', 'record'));
        expect(getStateManager().getApp('site')).toMatchObject({ status: 'stopped', error: 'Suspended by admin' });
      });

      it('the store refusing and a live instance: running, because something IS serving and nothing is suspended', async () => {
        await deployed();
        const warn = jest.spyOn((platform as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, 'warn');
        await settle(new AppSuspendedError('site', 'store-unreadable'));
        // Tenants read the stored error: generic. The specific reason is for the log.
        expect(getStateManager().getApp('site')).toMatchObject({ status: 'running', error: "Starting 'site' is refused right now; contact your administrator" });
        expect(getStateManager().getApp('site')?.error).not.toContain('suspension store');
        expect(getStateManager().getApp('site')?.error).not.toContain('not loaded');
        expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('suspension store is unreadable');
        await settle(new AppSuspendedError('site', 'not-loaded'));
        expect(getStateManager().getApp('site')?.error).not.toContain('not loaded');
        expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('not loaded yet');
      });

      it('the store refusing and nothing live: errored with the generic text, for unreadable and not-loaded alike', async () => {
        await deployed();
        fakeRuntime.reset();
        await settle(new AppSuspendedError('site', 'store-unreadable'));
        expect(getStateManager().getApp('site')).toMatchObject({ status: 'errored', error: "Starting 'site' is refused right now; contact your administrator" });
        await getStateManager().setAppStatus('site', 'building');
        await settle(new AppSuspendedError('site', 'not-loaded'));
        expect(getStateManager().getApp('site')).toMatchObject({ status: 'errored', error: "Starting 'site' is refused right now; contact your administrator" });
      });

      it('a stop cause: nothing live is stopped with its text, a live instance is left alone', async () => {
        await deployed();
        await settleCause({ kind: 'stopped', error: 'Stopped by user' });
        expect(getStateManager().getApp('site')?.status).toBe('building');

        fakeRuntime.reset();
        await settleCause({ kind: 'stopped', error: 'Stopped by user' });
        expect(getStateManager().getApp('site')).toMatchObject({ status: 'stopped', error: 'Stopped by user' });
      });

      it('an open episode this call does not own: nothing live falls back to stopped, never errored', async () => {
        await deployed();
        fakeRuntime.reset();
        eventBus.publish('build:started', { appId: 'site', buildId: 'b-held', deployId: 'held-2' });
        expect(getDeployTracker().hasOpenEpisode('site')).toBe(true);

        await settle(new AppSuspendedError('site', 'store-unreadable'));

        expect(getStateManager().getApp('site')).toMatchObject({ status: 'stopped', error: "Starting 'site' is refused right now; contact your administrator" });
        expect(getDeployTracker().hasOpenEpisode('site')).toBe(true);
      });

      it('liveness unknown (the runtime cannot be listed) and the store refusing: errored', async () => {
        await deployed();
        jest.spyOn(fakeRuntime, 'getAllStatus').mockRejectedValue(new Error('pm2 down'));
        await settle(new AppSuspendedError('site', 'store-unreadable'));
        expect(getStateManager().getApp('site')).toMatchObject({
          status: 'errored',
          error: 'runtime unreadable after a refused start',
        });
      });

      it('liveness unknown and an administrator\'s suspension: stopped, not errored', async () => {
        await deployed();
        jest.spyOn(fakeRuntime, 'getAllStatus').mockRejectedValue(new Error('pm2 down'));
        await settle(new AppSuspendedError('site', 'record'));
        expect(getStateManager().getApp('site')).toMatchObject({ status: 'stopped', error: 'Suspended by admin' });
      });

      it('liveness unknown and a stop cause: stopped with its text, not errored', async () => {
        await deployed();
        jest.spyOn(fakeRuntime, 'getAllStatus').mockRejectedValue(new Error('pm2 down'));
        await settleCause({ kind: 'stopped', error: 'Stopped by user' });
        expect(getStateManager().getApp('site')).toMatchObject({ status: 'stopped', error: 'Stopped by user' });
      });

      it('a step that throws does not stop the closer: the status is still written', async () => {
        await deployed();
        fakeRuntime.reset();
        jest.spyOn(internals(), 'noteRuntimeLogEnd').mockRejectedValue(new Error('disk gone'));
        await expect(settle(new AppSuspendedError('site', 'record'))).resolves.toBeUndefined();
        expect(getStateManager().getApp('site')?.status).toBe('stopped');
      });

      it('while the platform is stopping: no status write at all', async () => {
        await deployed();
        fakeRuntime.reset();
        (platform as unknown as { stopping: boolean }).stopping = true;
        await settle(new AppSuspendedError('site', 'record'));
        expect(getStateManager().getApp('site')?.status).toBe('building');
      });
    });

    it('a restart still answers suspended (not a broken closer) when a closer step throws', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      suspendBeforeNextStart('site');
      jest.spyOn(getStateManager(), 'setAppStatus').mockRejectedValue(new Error('state unwritable'));
      jest.spyOn(internals(), 'noteRuntimeLogEnd').mockRejectedValue(new Error('disk gone'));

      await expect(platform.restartApp('site')).rejects.toBeInstanceOf(AppSuspendedError);
    }, 30000);

    it('a suspension landing during a restart rejects it as suspended and leaves the app stopped, with no phantom deploy', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      const before = getDeployTracker().getEpisodes('site').length;
      const recorded = recordStatuses('site');
      suspendBeforeNextStart('site');

      await expect(platform.restartApp('site')).rejects.toBeInstanceOf(AppSuspendedError);
      recorded.stop();

      expect(getStateManager().getApp('site')?.status).toBe('stopped');
      expect(recorded.statuses).not.toContain('errored');
      expect(recorded.statuses).not.toContain('running');
      // A plain restart opens no episode, so the closer must not invent one.
      expect(getDeployTracker().getEpisodes('site')).toHaveLength(before);
      expect(fakeRuntime.restartCount).toBe(0);
    }, 30000);
  });
});
