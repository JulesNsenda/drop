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
import { getDeployTracker, getDeployDetailStore } from '../managers/deploy-tracker';
import { getDeployBreaker } from '../managers/guardrail/deploy-breaker';
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
  prepareDeployTarget: (appName: string, appPath: string, deployId: string) => Promise<string>;
  allocatePort: (appName: string, declared?: number) => number;
  handleStartApp: (
    appName: string,
    buildOutputDir: string | undefined,
    intent: { closeEpisode: boolean; callerOwnsTarget: boolean }
  ) => Promise<void>;
  expandMonorepo: (repoPath: string, repoName: string, config: unknown) => Promise<void | { suspended: string }>;
  reExpandContainer: (
    appName: string,
    appPath: string,
    config: unknown,
    actor: unknown,
    held?: () => void
  ) => Promise<void>;
  entryExists: (p: string) => Promise<boolean>;
  recordDeployOutcome: (appName: string, ok: boolean) => void;
  gitDeployService: unknown;
  appDatabaseUrlSource: (appName: string, appPath: string) => Promise<string | undefined>;
}

const servicesYaml = 'services:\n  web:\n    path: web\n    type: static\n';

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

  describe('a container-shaped tree under a suspended name is never expanded', () => {
    async function containerShaped(name: string): Promise<string> {
      const appPath = await createStaticApp(name);
      await fs.mkdir(path.join(appPath, 'web'), { recursive: true });
      await fs.writeFile(path.join(appPath, 'web', 'index.html'), '<h1>web</h1>');
      await fs.writeFile(path.join(appPath, 'drop.yaml'), servicesYaml);
      return appPath;
    }

    const expectNoChild = async (child: string): Promise<void> => {
      expect(getStateManager().getApp(child)).toBeUndefined();
      await expect(fs.access(path.join(webappsDir, child))).rejects.toThrow();
      expect(fakeRuntime.startCount).toBe(0);
    };

    it('expandMonorepo returns at once: no child is created, built or started', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await containerShaped('site');
      await getSuspensionStore().suspend('site', 'admin-1');
      const build = jest.spyOn(internals().builder!, 'build');

      await internals().expandMonorepo(appPath, 'site', { services: { web: { path: 'web', type: 'static' } } });

      expect(build).not.toHaveBeenCalled();
      await expectNoChild('site-web');
    }, 20000);

    it('handleAppDetected does not intercept and expand it either', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await containerShaped('site');
      await getSuspensionStore().suspend('site', 'admin-1');
      const build = jest.spyOn(internals().builder!, 'build');

      eventBus.publish('app:detected', { name: 'site', path: appPath, type: undefined });
      await waitFor(() => getStateManager().getApp('site') !== undefined);
      await new Promise((r) => setTimeout(r, 300));

      expect(build).not.toHaveBeenCalled();
      await expectNoChild('site-web');
    }, 20000);

    it('a git redeploy whose suspension lands mid-clone and whose landed tree adds a root services: creates no child', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await deploy('site');
      const url = 'https://github.com/user/site';
      await getStateManager().updateApp('site', { gitSource: { repoUrl: url, branch: 'main' } } as never);
      // The land: the suspension arrives while the clone runs, and the landed tree is now a container.
      internals().gitDeployService = {
        isAvailable: () => true,
        isCloning: () => false,
        recordedCloneUrl: () => url,
        supersedeQueued: () => undefined,
        landUnderHold: async () => {
          await getSuspensionStore().suspend('site', 'admin-1');
          await fs.mkdir(path.join(appPath, 'web'), { recursive: true });
          await fs.writeFile(path.join(appPath, 'web', 'index.html'), '<h1>web</h1>');
          await fs.writeFile(path.join(appPath, 'drop.yaml'), servicesYaml);
          return { appName: 'site', repoUrl: url };
        },
      };
      const build = jest.spyOn(internals().builder!, 'build');
      const starts = fakeRuntime.startCount;

      const out = await (platform as unknown as {
        redeployApp: (n: string, a: Record<string, unknown>, o: unknown) => Promise<unknown>;
      }).redeployApp('site', { principalId: 'p-1', actorUserId: 'u-1' }, { caller: null });
      expect(out).toEqual({ accepted: true });
      await waitFor(() => !internals().appsInProgress.has('site'));
      await new Promise((r) => setTimeout(r, 300));

      expect(build).not.toHaveBeenCalled();
      expect(getStateManager().getApp('site-web')).toBeUndefined();
      await expect(fs.access(path.join(webappsDir, 'site-web'))).rejects.toThrow();
      expect(fakeRuntime.startCount).toBe(starts);
    }, 30000);
  });

  describe('a suspension of the container landing mid-expansion', () => {
    it('copies, builds and starts no child, and says so', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await createStaticApp('site');
      await fs.mkdir(path.join(appPath, 'web'), { recursive: true });
      await fs.writeFile(path.join(appPath, 'web', 'index.html'), '<h1>web</h1>');
      await getStateManager().registerApp('site', appPath, 'static');
      // The await just before a child is copied: the suspension lands in it.
      const original = internals().entryExists.bind(platform);
      jest.spyOn(internals(), 'entryExists').mockImplementationOnce(async (target: string) => {
        const exists = await original(target);
        await getSuspensionStore().suspend('site', 'admin-1');
        return exists;
      });
      const build = jest.spyOn(internals().builder!, 'build');

      const out = await internals().expandMonorepo(appPath, 'site', { services: { web: { path: 'web', type: 'static' } } });

      expect(out).toEqual({ suspended: 'record' });
      expect(build).not.toHaveBeenCalled();
      expect(getStateManager().getApp('site-web')).toBeUndefined();
      await expect(fs.access(path.join(webappsDir, 'site-web'))).rejects.toThrow();
      expect(fakeRuntime.startCount).toBe(0);
    }, 20000);

    it('reExpandContainer does not record the refused expansion as a success: uncharged, and a held episode closes as stopped', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await deploy('site');
      jest.spyOn(internals(), 'expandMonorepo').mockResolvedValue({ suspended: 'record' });
      const outcome = jest.spyOn(internals(), 'recordDeployOutcome');
      const failure = jest.spyOn(getDeployBreaker(), 'recordFailure');
      const held = jest.fn();

      await internals().reExpandContainer(
        'site',
        appPath,
        { services: { web: { path: 'web', type: 'static' } } },
        { principalId: 'p-1' },
        held
      );

      expect(outcome).not.toHaveBeenCalledWith('site', true);
      expect(failure).not.toHaveBeenCalled();
      expect(held).toHaveBeenCalledTimes(1);
      const episodes = getDeployTracker().getEpisodes('site');
      const stopped = episodes.find((e) => getDeployDetailStore().getDetail(e.deployId)?.errorCode === 'DEPLOY_STOPPED');
      expect(stopped?.status).toBe('failed');
    }, 20000);
  });

  describe('the children of a suspended container (ported from #389, on the resolver)', () => {
    /**
     * A registered monorepo container 'site' and a deployed child 'site-web' of its group,
     * stamped as expansion stamps it. The container is CURRENT (in state, isGroupContainer,
     * for the group): a stamp to anything else names nothing.
     */
    async function groupedChild(): Promise<string> {
      const containerPath = await createStaticApp('site');
      await getStateManager().registerApp('site', containerPath, 'static');
      await getStateManager().updateApp('site', { group: 'site', isGroupContainer: true } as never);
      const childPath = await deploy('site-web');
      await getStateManager().updateApp('site-web', { group: 'site' } as never);
      await getAppConfigService().upsertSystemConfig('site-web', { groupContainer: 'site' });
      return childPath;
    }

    it("a child's redeploy waiting for a build slot is refused when its container is suspended during the wait", async () => {
      platform = makePlatform();
      await platform.start();
      const childPath = await groupedChild();
      const builder = internals().builder as unknown as {
        reserveSlot: (name: string) => Promise<() => void>;
        waitingApps: Set<string>;
      };
      const build = jest.spyOn(internals().builder!, 'build');
      const held = await Promise.all(['occ1', 'occ2', 'occ3'].map((n) => builder.reserveSlot(n)));

      const run = internals().handleAppUpdate('site-web', childPath, 'file change', true);
      for (let i = 0; i < 500 && !builder.waitingApps.has('site-web'); i++) await new Promise((r) => setTimeout(r, 10));
      expect(builder.waitingApps.has('site-web')).toBe(true);
      await getSuspensionStore().suspend('site', 'admin-1');
      held.forEach((release) => release());

      expect(await run).toBe(false);
      expect(build).not.toHaveBeenCalled();
      expect(internals().appsInProgress.has('site-web')).toBe(false);
    }, 20000);

    it('drainPendingBuilds does not build a queued child of a suspended container', async () => {
      platform = makePlatform();
      await platform.start();
      const childPath = await groupedChild();
      await getSuspensionStore().suspend('site', 'admin-1');
      const build = jest.spyOn(internals().builder!, 'build');
      const starts = fakeRuntime.startCount;
      const pending = platform as unknown as {
        pendingBuilds: Map<string, { appPath: string; appType: string }>;
        drainPendingBuilds: () => Promise<void>;
      };
      pending.pendingBuilds.set('site-web', { appPath: childPath, appType: 'static' });

      await pending.drainPendingBuilds();
      await new Promise((r) => setTimeout(r, 200));

      expect(build).not.toHaveBeenCalled();
      expect(fakeRuntime.startCount).toBe(starts);
      expect(internals().appsInProgress.has('site-web')).toBe(false);
    }, 20000);

    it("the owner's start of a registered child is refused, naming the container", async () => {
      platform = makePlatform();
      await platform.start();
      await groupedChild();
      await getSuspensionStore().suspend('site', 'admin-1');
      const starts = fakeRuntime.startCount;
      const restarts = fakeRuntime.restartCount;

      await expect(platform.restartApp('site-web')).rejects.toMatchObject({
        code: 'APP_SUSPENDED',
        reason: 'record',
        via: 'site',
      });

      expect(fakeRuntime.startCount).toBe(starts);
      expect(fakeRuntime.restartCount).toBe(restarts);
    }, 20000);

    it('a child of an UNsuspended container is unaffected', async () => {
      platform = makePlatform();
      await platform.start();
      const childPath = await groupedChild();
      await getSuspensionStore().suspend('other', 'admin-1');
      const build = jest.spyOn(internals().builder!, 'build');

      await expect(platform.restartApp('site-web')).resolves.toBeDefined();
      expect(await internals().handleAppUpdate('site-web', childPath, 'file change', true)).toBe(true);
      expect(build).toHaveBeenCalled();
    }, 30000);

    it('a bare stamp to an app that is not a container does not refuse the child', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      const childPath = await deploy('site-web');
      await getAppConfigService().upsertSystemConfig('site-web', { groupContainer: 'site' });
      await getSuspensionStore().suspend('site', 'admin-1');
      const build = jest.spyOn(internals().builder!, 'build');

      expect(await internals().handleAppUpdate('site-web', childPath, 'file change', true)).toBe(true);
      expect(build).toHaveBeenCalled();
    }, 30000);

    it("a child's suspension freezes the container's own redeploy, and not the sibling's", async () => {
      platform = makePlatform();
      await platform.start();
      const childPath = await groupedChild();
      const siblingPath = await deploy('site-api');
      await getStateManager().updateApp('site-api', { group: 'site' } as never);
      await getSuspensionStore().suspend('site-web', 'admin-1');
      const build = jest.spyOn(internals().builder!, 'build');

      // The sibling still deploys; the suspended child and the container do not.
      expect(await internals().handleAppUpdate('site-api', siblingPath, 'file change', true)).toBe(true);
      build.mockClear();
      expect(await internals().handleAppUpdate('site-web', childPath, 'file change', true)).toBe(false);
      expect(await internals().handleAppUpdate('site', path.join(webappsDir, 'site'), 'file change', true)).toBe(false);
      expect(build).not.toHaveBeenCalled();
    }, 40000);
  });

  describe('the episode code says why the start was refused (ported from #389)', () => {
    it('a reExpandContainer held while the store is unreadable closes its episode as DEPLOY_REFUSED', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await deploy('site');
      jest.spyOn(internals(), 'expandMonorepo').mockResolvedValue({ suspended: 'store-unreadable' });

      await internals().reExpandContainer(
        'site',
        appPath,
        { services: { web: { path: 'web', type: 'static' } } },
        { principalId: 'p-1' },
        jest.fn()
      );

      const episodes = getDeployTracker().getEpisodes('site');
      const codes = episodes.map((e) => getDeployDetailStore().getDetail(e.deployId)?.errorCode);
      expect(codes).toContain('DEPLOY_REFUSED');
      expect(codes).not.toContain('DEPLOY_STOPPED');
    }, 20000);

    it('a first deploy refused because the store went unreadable, with nothing live, is DEPLOY_STOPPED (the closer saw nothing serving)', async () => {
      platform = makePlatform();
      await platform.start();
      jest.spyOn(console, 'error').mockImplementation();
      const appPath = await createStaticApp('fresh');
      await getStateManager().registerApp('fresh', appPath, 'static');
      const original = internals().prepareDeployTarget.bind(platform);
      jest.spyOn(internals(), 'prepareDeployTarget').mockImplementationOnce(async (...args) => {
        const target = await original(...args);
        await fs.writeFile(path.join(tempDir, 'data', 'drop-svc', 'suspensions.json'), '{ broken');
        await getSuspensionStore().load();
        return target;
      });

      await internals().handleBuildApp(appPath, 'fresh', 'static');

      const [episode] = getDeployTracker().getEpisodes('fresh');
      expect(episode.status).toBe('failed');
      expect(getDeployDetailStore().getDetail(episode.deployId)?.errorCode).toBe('DEPLOY_STOPPED');
    }, 20000);

    it('the same refusal with an old instance still serving is DEPLOY_REFUSED', async () => {
      platform = makePlatform();
      await platform.start();
      jest.spyOn(console, 'error').mockImplementation();
      const appPath = await deploy('site');
      expect(fakeRuntime.runningNames()).toContain('site');
      const original = internals().prepareDeployTarget.bind(platform);
      jest.spyOn(internals(), 'prepareDeployTarget').mockImplementationOnce(async (...args) => {
        const target = await original(...args);
        await fs.writeFile(path.join(tempDir, 'data', 'drop-svc', 'suspensions.json'), '{ broken');
        await getSuspensionStore().load();
        return target;
      });
      const before = getDeployTracker().getEpisodes('site').length;

      await internals().handleBuildApp(appPath, 'site', 'static');

      const episodes = getDeployTracker().getEpisodes('site');
      expect(episodes.length).toBeGreaterThan(before);
      expect(getDeployDetailStore().getDetail(episodes[0].deployId)?.errorCode).toBe('DEPLOY_REFUSED');
      expect(fakeRuntime.runningNames()).toContain('site');
    }, 20000);
  });

  describe('the gate right before the swap', () => {
    const storeFile = (): string => path.join(tempDir, 'data', 'drop-svc', 'suspensions.json');

    async function stageRedeploy(): Promise<{ appPath: string; replace: jest.SpyInstance }> {
      platform = makePlatform();
      await platform.start();
      const appPath = await deploy('site');
      const replace = jest.spyOn(platform as unknown as { replaceLiveProcess: () => Promise<void> }, 'replaceLiveProcess');
      return { appPath, replace };
    }

    async function updateAndWaitForEpisode(appPath: string, episodesBefore: number): Promise<void> {
      await fs.writeFile(path.join(appPath, 'index.html'), 'v2');
      eventBus.publish('app:update', { name: 'site', path: appPath, reason: 'edit', bypassCooldown: true });
      await waitFor(
        () => getDeployTracker().getEpisodes('site').length > episodesBefore && !internals().appsInProgress.has('site')
      );
    }

    it('an unreadable store after the build, before the swap: the old version keeps serving and the episode is REFUSED', async () => {
      const { appPath, replace } = await stageRedeploy();
      jest.spyOn(console, 'error').mockImplementation();
      const episodesBefore = getDeployTracker().getEpisodes('site').length;
      jest.spyOn(platform as unknown as { tryCutover: () => Promise<false> }, 'tryCutover').mockImplementationOnce(async () => {
        await fs.writeFile(storeFile(), '{ broken');
        await getSuspensionStore().load();
        return false;
      });

      await updateAndWaitForEpisode(appPath, episodesBefore);

      expect(replace).not.toHaveBeenCalled();
      // The old version is still up: nothing was stopped, so nobody stopped anything.
      expect(fakeRuntime.runningNames()).toContain('site');
      const [episode] = getDeployTracker().getEpisodes('site');
      expect(episode.status).toBe('failed');
      expect(getDeployDetailStore().getDetail(episode.deployId)?.errorCode).toBe('DEPLOY_REFUSED');
    }, 40000);

    it("an administrator's record landing before the swap: nothing is replaced and the episode is STOPPED", async () => {
      const { appPath, replace } = await stageRedeploy();
      const episodesBefore = getDeployTracker().getEpisodes('site').length;
      jest.spyOn(platform as unknown as { tryCutover: () => Promise<false> }, 'tryCutover').mockImplementationOnce(async () => {
        await getSuspensionStore().suspend('site', 'admin-1');
        return false;
      });

      await updateAndWaitForEpisode(appPath, episodesBefore);

      expect(replace).not.toHaveBeenCalled();
      const [episode] = getDeployTracker().getEpisodes('site');
      expect(getDeployDetailStore().getDetail(episode.deployId)?.errorCode).toBe('DEPLOY_STOPPED');
    }, 40000);

    it('an unreadable store AFTER the swap (nothing left serving) closes the episode as STOPPED', async () => {
      const { appPath } = await stageRedeploy();
      jest.spyOn(console, 'error').mockImplementation();
      const episodesBefore = getDeployTracker().getEpisodes('site').length;
      const noteStart = jest.spyOn(platform as unknown as { noteRuntimeLogStart: (a: string) => Promise<void> }, 'noteRuntimeLogStart');
      const real = (platform as unknown as { noteRuntimeLogStart: (a: string) => Promise<void> }).noteRuntimeLogStart.bind(platform);
      noteStart.mockImplementationOnce(async (app: string) => {
        await real(app);
        await fs.writeFile(storeFile(), '{ broken');
        await getSuspensionStore().load();
      });

      await updateAndWaitForEpisode(appPath, episodesBefore);

      expect(fakeRuntime.runningNames()).not.toContain('site');
      const [episode] = getDeployTracker().getEpisodes('site');
      expect(getDeployDetailStore().getDetail(episode.deployId)?.errorCode).toBe('DEPLOY_STOPPED');
    }, 40000);
  });

  describe('a re-check right before the build runs tenant code', () => {
    it('a first deploy: a suspension landing after the target is prepared builds nothing and leaves the app stopped, not errored', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await createStaticApp('fresh');
      await getStateManager().registerApp('fresh', appPath, 'static');
      const original = internals().prepareDeployTarget.bind(platform);
      jest.spyOn(internals(), 'prepareDeployTarget').mockImplementationOnce(async (...args) => {
        const target = await original(...args);
        await getSuspensionStore().suspend('fresh', 'admin-1');
        return target;
      });
      const build = jest.spyOn(internals().builder!, 'build');
      const failure = jest.spyOn(getDeployBreaker(), 'recordFailure');
      const recorded = recordStatuses('fresh');

      await internals().handleBuildApp(appPath, 'fresh', 'static');
      recorded.stop();

      expect(build).not.toHaveBeenCalled();
      expect(recorded.statuses).not.toContain('errored');
      expect(getStateManager().getApp('fresh')?.status).toBe('stopped');
      expect(fakeRuntime.startCount).toBe(0);
      expect(internals().appsInProgress.has('fresh')).toBe(false);
      // A caller polling for an outcome gets one: a stopped deploy under the minted id, uncharged.
      const [episode] = getDeployTracker().getEpisodes('fresh');
      expect(episode.status).toBe('failed');
      expect(getDeployDetailStore().getDetail(episode.deployId)?.errorCode).toBe('DEPLOY_STOPPED');
      expect(failure).not.toHaveBeenCalled();
    }, 20000);

    it('a first deploy waiting for a build slot behind a full cap builds nothing when the suspension lands during the wait', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await createStaticApp('queued');
      await getStateManager().registerApp('queued', appPath, 'static');
      const builder = internals().builder as unknown as {
        reserveSlot: (name: string) => Promise<() => void>;
        waitingApps: Set<string>;
        build: (...args: unknown[]) => Promise<unknown>;
      };
      const build = jest.spyOn(builder, 'build');
      // Fill every slot (the platform's default cap is 3).
      const held = await Promise.all(['occ1', 'occ2', 'occ3'].map((n) => builder.reserveSlot(n)));

      const run = internals().handleBuildApp(appPath, 'queued', 'static');
      for (let i = 0; i < 500 && !builder.waitingApps.has('queued'); i++) await new Promise((r) => setTimeout(r, 10));
      expect(builder.waitingApps.has('queued')).toBe(true);
      await getSuspensionStore().suspend('queued', 'admin-1');
      held.forEach((release) => release());
      await run;

      expect(build).not.toHaveBeenCalled();
      expect(getStateManager().getApp('queued')?.status).toBe('stopped');
      expect(fakeRuntime.startCount).toBe(0);
      expect(internals().appsInProgress.has('queued')).toBe(false);
      // The slot it waited for was given back.
      const later = await Promise.race([
        builder.reserveSlot('later').then((release) => (release(), true)),
        new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
      ]);
      expect(later).toBe(true);
    }, 20000);

    it('a redeploy: the same window builds nothing, and nothing is written errored', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await deploy('site');
      const original = internals().prepareDeployTarget.bind(platform);
      jest.spyOn(internals(), 'prepareDeployTarget').mockImplementationOnce(async (...args) => {
        const target = await original(...args);
        await getSuspensionStore().suspend('site', 'admin-1');
        return target;
      });
      const build = jest.spyOn(internals().builder!, 'build');
      const recorded = recordStatuses('site');

      expect(await internals().handleAppUpdate('site', appPath, 'file change', true)).toBe(false);
      recorded.stop();

      expect(build).not.toHaveBeenCalled();
      expect(recorded.statuses).not.toContain('errored');
      expect(internals().appsInProgress.has('site')).toBe(false);
    }, 20000);

    it('handleStartApp refuses before the port, the data directory and any provisioning', async () => {
      platform = makePlatform();
      await platform.start();
      await deploy('site');
      await getSuspensionStore().suspend('site', 'admin-1');
      const port = jest.spyOn(internals(), 'allocatePort');
      const provision = getDatabaseProvisioner()!.provisionAppDatabase as jest.Mock;
      provision.mockClear();
      const starts = fakeRuntime.startCount;

      await expect(
        internals().handleStartApp('site', undefined, { closeEpisode: false, callerOwnsTarget: false })
      ).rejects.toBeInstanceOf(AppSuspendedError);

      expect(port).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      expect(fakeRuntime.startCount).toBe(starts);
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
