/**
 * Zero-downtime cutover (#298 step 5).
 *
 * Same harness as the release tests, with one addition that makes the claims
 * testable: the fake runtime runs a REAL HTTP server per instance it starts,
 * on the instance's port, serving that release's index.html. Strict readiness,
 * the old-port liveness check and "is the old one still serving?" are then
 * answered by real sockets, not by assertions about mocks.
 *
 * What is pinned: the new version starts beside the old one and traffic moves
 * only after it answers; the old instance is removed only after the move; a new
 * version that never becomes ready leaves the old one serving, UNTOUCHED, and
 * the deploy is reported failed as READINESS_FAILED; the same under both
 * isolation modes; an app the cutover cannot serve falls back to stop/start;
 * and a leftover instance from a crash is removed at boot.
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

import * as http from 'http';
import type { AppStartSpec } from '../managers/runtime';
import { DropPlatform, createPlatform, PlatformConfig } from './platform';
import { eventBus } from './event-bus';
import { getStateManager } from '../managers/app/state-manager';
import { getAppConfigService } from '../managers/app/app-config';
import { getDeployTracker, getDeployDetailStore } from '../managers/deploy-tracker';

async function waitFor(predicate: () => boolean, timeoutMs = 10000, intervalMs = 25): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: condition not met within timeout');
}

const OPT_IN = 'type: static\ndeploy:\n  strategy: zero-downtime\n';

/** What the NEXT started instance does. */
type Behaviour = 'serve' | 'silent' | 'error-503';

describe('zero-downtime cutover (#298 step 5)', () => {
  let tempDir: string;
  let webappsDir: string;
  let platform: DropPlatform | null = null;
  const servers = new Map<string, http.Server>();
  let nextBehaviour: Behaviour = 'serve';
  const log: string[] = [];

  const get = (port: number) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path: '/' }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        })
        .on('error', reject);
    });

  async function closeServer(instance: string): Promise<void> {
    const server = servers.get(instance);
    servers.delete(instance);
    if (server) await new Promise((r) => server.close(() => r(undefined)));
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-cutover-'));
    webappsDir = path.join(tempDir, 'webapps');
    fakeRuntime.reset();
    nextBehaviour = 'serve';
    log.length = 0;
    process.env.DROP_CUTOVER_DRAIN_MS = '0';
    process.env.DROP_READINESS_TIMEOUT_MS = '1500';

    const realStart = fakeRuntime.start.bind(fakeRuntime);
    const realDelete = fakeRuntime.delete.bind(fakeRuntime);
    const realStop = fakeRuntime.stop.bind(fakeRuntime);
    jest.spyOn(fakeRuntime, 'start').mockImplementation(async (spec: AppStartSpec) => {
      const instance = spec.instance ?? spec.name;
      await closeServer(instance);
      const info = await realStart(spec);
      log.push(`start ${instance}:${spec.port}`);
      const behaviour = nextBehaviour;
      if (behaviour !== 'silent' && spec.port) {
        const html = await fs.readFile(path.join(spec.cwd, 'index.html'), 'utf-8').catch(() => '');
        const server = http.createServer((_req, res) => {
          res.writeHead(behaviour === 'error-503' ? 503 : 200);
          res.end(html);
        });
        await new Promise((r) => server.listen(spec.port, '127.0.0.1', () => r(undefined)));
        servers.set(instance, server);
      }
      // What PM2's ProcessManager publishes on start — with the PROCESS name,
      // i.e. the instance. The platform routes on this event, so it must be
      // modelled for the "no early reroute" claim to mean anything.
      eventBus.publish('app:started', { appId: instance, name: instance, port: spec.port ?? 0, pid: info.pid ?? undefined });
      return info;
    });
    jest.spyOn(fakeRuntime, 'delete').mockImplementation(async (name: string) => {
      const instance = fakeRuntime.runtimeNameOf(name);
      log.push(`delete ${instance}`);
      await closeServer(instance);
      return realDelete(name);
    });
    jest.spyOn(fakeRuntime, 'stop').mockImplementation(async (name: string) => {
      const instance = fakeRuntime.runtimeNameOf(name);
      log.push(`stop ${instance}`);
      await closeServer(instance);
      return realStop(name);
    });
  });

  afterEach(async () => {
    if (platform && platform.isActive()) await platform.stop();
    platform = null;
    for (const instance of [...servers.keys()]) await closeServer(instance);
    delete process.env.DROP_CUTOVER_DRAIN_MS;
    delete process.env.DROP_READINESS_TIMEOUT_MS;
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
      portRangeStart: 47100,
      portRangeEnd: 47199,
      ...overrides,
    });
  }

  const settled = (name: string) =>
    !(platform as unknown as { appsInProgress: Set<string> }).appsInProgress.has(name);
  const cfg = (name: string) => getAppConfigService().getConfig(name);
  const routeUpstreams = (owner: string) =>
    (platform as unknown as { router: { getRoutes(): Array<{ owner?: string; upstream: unknown }> } }).router
      .getRoutes()
      .filter((r) => r.owner === owner)
      .map((r) => r.upstream);

  async function deployV1(name: string, manifest = OPT_IN): Promise<string> {
    const appPath = path.join(webappsDir, name);
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.html'), 'v1');
    await fs.writeFile(path.join(appPath, 'drop.yaml'), manifest);
    eventBus.publish('app:detected', { name, path: appPath, type: undefined });
    await waitFor(
      () =>
        getStateManager().getApp(name)?.status === 'running' &&
        settled(name) &&
        routeUpstreams(name).length > 0
    );
    return appPath;
  }

  async function redeploy(name: string, appPath: string, html: string, onBuilt?: () => void): Promise<void> {
    (platform as unknown as { appDeployTimes: Map<string, number> }).appDeployTimes.clear();
    let built = false;
    const unsubscribe = eventBus.subscribe('build:completed', (p) => {
      if (p.appId === name && !built) {
        built = true;
        onBuilt?.();
      }
    });
    await fs.writeFile(path.join(appPath, 'index.html'), html);
    eventBus.publish('app:update', { name, path: appPath, reason: 'edit', bypassCooldown: true });
    await waitFor(() => built);
    await waitFor(() => settled(name));
    unsubscribe();
  }

  describe.each([
    ['isolation: none (pm2)', undefined],
    ['isolation: docker', 'docker' as const],
  ])('under %s', (_label, isolation) => {
    it('starts the new version beside the old, moves traffic only once it answers, then removes the old', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await deployV1('site');
      const oldPort = getStateManager().getApp('site')!.port!;
      expect((await get(oldPort)).body).toBe('v1');
      const setUpstream = jest.spyOn(
        (platform as unknown as { router: { setUpstream: (...a: unknown[]) => unknown } }).router,
        'setUpstream'
      );
      log.length = 0;

      await redeploy('site', appPath, 'v2', () => {
        // Parity: the start spec for the new instance is built AFTER this, in
        // the mode under test (a docker BUILD needs a container runtime).
        if (isolation) (platform as unknown as { config: { isolation: string } }).config.isolation = isolation;
      });

      const newPort = getStateManager().getApp('site')!.port!;
      expect(newPort).not.toBe(oldPort);
      // Order: new instance up, traffic moved, and only then the old removed.
      expect(log).toEqual([`start site.b:${newPort}`, 'delete site']);
      expect(setUpstream).toHaveBeenCalledWith('site', `localhost:${newPort}`);
      expect(routeUpstreams('site')).toEqual([`localhost:${newPort}`]);
      expect((await get(newPort)).body).toBe('v2');
      await expect(get(oldPort)).rejects.toThrow();

      expect(fakeRuntime.getLiveInstance('site')).toBe('b');
      expect(cfg('site')?.runtimeSlot).toBe('b');
      expect(cfg('site')?.port).toBe(newPort);
      expect(cfg('site')?.currentRelease?.instance).toBe('b');
      expect(getStateManager().getApp('site')?.status).toBe('running');
      expect(getDeployTracker().getEpisodes('site')[0].status).toBe('succeeded');
    }, 30000);
  });

  it('alternates slots: the next deploy goes back to slot a on a fresh port', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await deployV1('site');
    await redeploy('site', appPath, 'v2');
    const secondPort = getStateManager().getApp('site')!.port!;
    log.length = 0;

    await redeploy('site', appPath, 'v3');

    const thirdPort = getStateManager().getApp('site')!.port!;
    expect(log).toEqual([`start site:${thirdPort}`, 'delete site.b']);
    expect(fakeRuntime.getLiveInstance('site')).toBe('a');
    expect((await get(thirdPort)).body).toBe('v3');
    await expect(get(secondPort)).rejects.toThrow();
  }, 30000);

  it.each([
    ['never answers', 'silent' as Behaviour, 'never answered HTTP'],
    ['answers only 5xx', 'error-503' as Behaviour, 'HTTP 503'],
  ])('a new version that %s is discarded and the old one keeps serving, untouched', async (_l, behaviour, why) => {
    platform = makePlatform();
    await platform.start();
    const appPath = await deployV1('site');
    const oldPort = getStateManager().getApp('site')!.port!;
    const oldPid = fakeRuntime.pidOf('site');
    const serving = cfg('site')!.currentRelease!.path;
    nextBehaviour = behaviour;
    log.length = 0;

    await redeploy('site', appPath, 'v2-broken');

    expect(log).toEqual([expect.stringMatching(/^start site\.b:/), 'delete site.b']);
    // Untouched: same process, same port, same content, same route.
    expect(fakeRuntime.pidOf('site')).toBe(oldPid);
    expect((await get(oldPort)).body).toBe('v1');
    expect(routeUpstreams('site')).toEqual([`localhost:${oldPort}`]);
    expect(fakeRuntime.getLiveInstance('site')).toBe('a');
    expect(cfg('site')?.port).toBe(oldPort);
    expect(cfg('site')?.runtimeSlot).toBeUndefined();
    expect(cfg('site')?.currentRelease?.path).toBe(serving);

    const app = getStateManager().getApp('site')!;
    expect(app.status).toBe('running');
    expect(app.port).toBe(oldPort);
    expect(app.error).toContain(why);
    expect(app.error).toContain('previous version is still serving');

    const [episode] = getDeployTracker().getEpisodes('site');
    expect(episode.status).toBe('failed');
    expect(getDeployDetailStore().getDetail(episode.deployId)?.errorCode).toBe('READINESS_FAILED');
  }, 30000);

  it('never routes traffic to the new instance on its start event', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await deployV1('site');

    const oldPort = getStateManager().getApp('site')!.port!;
    nextBehaviour = 'silent';
    const configure = jest.spyOn(
      platform as unknown as { handleConfigureRoute: (...a: unknown[]) => Promise<void> },
      'handleConfigureRoute'
    );

    await redeploy('site', appPath, 'v2-broken');

    expect(configure).not.toHaveBeenCalled();
    expect(routeUpstreams('site')).toEqual([`localhost:${oldPort}`]);
  }, 30000);

  it('falls back to stop/start for an app that does not listen on its port (a worker)', async () => {
    nextBehaviour = 'silent';
    platform = makePlatform();
    await platform.start();
    const appPath = await deployV1('worker');
    log.length = 0;

    await redeploy('worker', appPath, 'v2');

    expect(log).toEqual(['stop worker', expect.stringMatching(/^start worker:/)]);
    expect(fakeRuntime.getLiveInstance('worker')).toBe('a');
  }, 30000);

  it('an in-place app is never cut over', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await deployV1('plain', 'type: static\n');
    log.length = 0;

    await redeploy('plain', appPath, 'v2');

    expect(log).toEqual(['stop plain', expect.stringMatching(/^start plain:/)]);
  }, 30000);

  it('restarts the LIVE slot after a cutover', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await deployV1('site');
    await redeploy('site', appPath, 'v2');
    log.length = 0;

    await platform.restartApp('site');

    expect(log).toEqual(['delete site.b', expect.stringMatching(/^start site\.b:/)]);
  }, 30000);

  it('removes an orphaned instance at boot, keeping the live one', async () => {
    platform = makePlatform();
    await platform.start();
    await deployV1('site');
    await platform.stop();
    // A cutover died after starting slot b, before recording it as live.
    fakeRuntime.seedRunning('site.b', 47150);
    log.length = 0;

    platform = makePlatform();
    await platform.start();

    expect(log).toContain('delete site.b');
    expect(log).not.toContain('delete site');
    expect(fakeRuntime.getLiveInstance('site')).toBe('a');
  }, 30000);

  it('deleting the app removes the idle slot too', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await deployV1('site');
    await redeploy('site', appPath, 'v2');
    log.length = 0;

    await platform.purgeAppArtifacts('site');

    expect(log).toContain('delete site');
    expect(fakeRuntime.getLiveInstance('site')).toBe('a');
  }, 30000);
});
