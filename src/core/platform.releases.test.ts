/**
 * Release directories (#298 step 3): an app on `deploy.strategy: zero-downtime`
 * is built into `data/releases/<app>/<deployId>/` and served from there.
 *
 * Same harness as platform.restart/rollback tests: REAL platform, EventBus,
 * state/config services, builder and fs under a temp dropRoot; FakeRuntime in
 * place of PM2/Docker. The claims pinned here are the ones the design rests on:
 * the runtime is started FROM the release, the source folder is never built
 * into, the previous release survives a redeploy (and older ones are pruned),
 * a failed start leaves the serving release untouched, opting out goes back to
 * in-place cleanly, and an app that never opted in is unaffected.
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

import { DropPlatform, createPlatform, PlatformConfig } from './platform';
import { eventBus } from './event-bus';
import { getStateManager } from '../managers/app/state-manager';
import { getAppConfigService } from '../managers/app/app-config';

async function waitFor(predicate: () => boolean, timeoutMs = 8000, intervalMs = 25): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('waitFor: condition not met within timeout');
}

const OPT_IN = 'type: static\ndeploy:\n  strategy: zero-downtime\n';

describe('release directories (#298 step 3)', () => {
  let tempDir: string;
  let webappsDir: string;
  let platform: DropPlatform | null = null;

  const releasesOf = (app: string) => path.join(tempDir, 'data', 'releases', app);
  const exists = (p: string) => fs.access(p).then(() => true, () => false);
  const current = (app: string) => getAppConfigService().getConfig(app)?.currentRelease;
  const previous = (app: string) => getAppConfigService().getConfig(app)?.previousRelease;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-releases-platform-'));
    webappsDir = path.join(tempDir, 'webapps');
    fakeRuntime.reset();
  });

  afterEach(async () => {
    if (platform && platform.isActive()) await platform.stop();
    platform = null;
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
      ...overrides,
    });
  }

  async function createApp(name: string, manifest?: string): Promise<string> {
    const appPath = path.join(webappsDir, name);
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.html'), `<h1>${name} v1</h1>`);
    if (manifest) await fs.writeFile(path.join(appPath, 'drop.yaml'), manifest);
    return appPath;
  }

  const settled = (name: string) =>
    !(platform as unknown as { appsInProgress: Set<string> }).appsInProgress.has(name);

  /**
   * Deploy and wait until the deploy has fully SETTLED — not just `running`:
   * the release is committed after the status write, just before the
   * in-progress guard is released.
   */
  async function deploy(name: string, appPath: string): Promise<void> {
    eventBus.publish('app:detected', { name, path: appPath, type: undefined });
    await waitFor(() => getStateManager().getApp(name)?.status === 'running' && settled(name));
  }

  /** A hot-reload redeploy, and wait until the runtime was started again. */
  async function redeploy(name: string, appPath: string, html: string): Promise<void> {
    (platform as unknown as { appDeployTimes: Map<string, number> }).appDeployTimes.clear();
    const startsBefore = fakeRuntime.startCount;
    await fs.writeFile(path.join(appPath, 'index.html'), html);
    eventBus.publish('app:update', { name, path: appPath, reason: 'edit', bypassCooldown: true });
    await waitFor(
      () =>
        fakeRuntime.startCount > startsBefore &&
        getStateManager().getApp(name)?.status === 'running' &&
        settled(name)
    );
  }

  const lastStartCwd = (spy: jest.SpyInstance) => spy.mock.calls[spy.mock.calls.length - 1][0].cwd;

  it('starts from the release, keeps the previous one, and prunes older ones', async () => {
    platform = makePlatform();
    await platform.start();
    const startSpy = jest.spyOn(fakeRuntime, 'start');
    const appPath = await createApp('site', OPT_IN);

    await deploy('site', appPath);
    const first = current('site')!;
    expect(path.dirname(first.path)).toBe(releasesOf('site'));
    expect(lastStartCwd(startSpy)).toBe(first.path);
    expect(await fs.readFile(path.join(first.path, 'index.html'), 'utf-8')).toContain('v1');

    await redeploy('site', appPath, '<h1>site v2</h1>');
    const second = current('site')!;
    expect(second.path).not.toBe(first.path);
    expect(previous('site')?.path).toBe(first.path);
    expect(lastStartCwd(startSpy)).toBe(second.path);
    expect(await fs.readFile(path.join(second.path, 'index.html'), 'utf-8')).toContain('v2');
    // The release that was serving is untouched by the redeploy.
    expect(await fs.readFile(path.join(first.path, 'index.html'), 'utf-8')).toContain('v1');

    await redeploy('site', appPath, '<h1>site v3</h1>');
    expect(previous('site')?.path).toBe(second.path);
    expect(await exists(first.path)).toBe(false);
    expect((await fs.readdir(releasesOf('site'))).length).toBe(2);
  }, 30000);

  // Isolation parity is on the START path, as in the restart suite: booting
  // with isolation 'docker' refuses to build without a container runtime, so
  // the mode is flipped on the running platform after the deploy. Both
  // runtimes run an app from `spec.cwd`, which is the claim under test.
  describe.each([
    ['isolation: none (pm2)', undefined],
    ['isolation: docker', 'docker' as const],
  ])('under %s', (_label, isolation) => {
    it('a restart starts from the current release, not the source', async () => {
      platform = makePlatform();
      await platform.start();
      const appPath = await createApp('site', OPT_IN);
      await deploy('site', appPath);
      const release = current('site')!.path;
      if (isolation) (platform as unknown as { config: { isolation: string } }).config.isolation = isolation;
      const startSpy = jest.spyOn(fakeRuntime, 'start');

      await platform.restartApp('site');

      expect(lastStartCwd(startSpy)).toBe(release);
      expect(lastStartCwd(startSpy)).not.toBe(appPath);
    }, 20000);
  });

  it('a rollback restores into the current release and restarts from it', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createApp('site', OPT_IN);
    await deploy('site', appPath);
    const firstRelease = current('site')!.path;
    // What upload-deploy does before replacing a running app.
    const { captureBeforeRedeploy } = jest.requireActual('../managers/rollback') as typeof import('../managers/rollback');
    expect((await captureBeforeRedeploy('site')).captured).toBe(true);
    await redeploy('site', appPath, '<h1>site v2</h1>');
    const secondRelease = current('site')!.path;
    const startSpy = jest.spyOn(fakeRuntime, 'start');

    await platform.rollbackApp('site');

    expect(lastStartCwd(startSpy)).toBe(secondRelease);
    // The snapshot was of the SERVING tree (the first release), not the source.
    expect(await fs.readFile(path.join(secondRelease, 'index.html'), 'utf-8')).toContain('v1');
    expect(firstRelease).not.toBe(secondRelease);
  }, 30000);

  it('a failed start discards the new release and leaves the serving one recorded', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createApp('site', OPT_IN);
    await deploy('site', appPath);
    const serving = current('site')!.path;

    (platform as unknown as { appDeployTimes: Map<string, number> }).appDeployTimes.clear();
    jest.spyOn(fakeRuntime, 'start').mockRejectedValueOnce(new Error('boom'));
    eventBus.publish('app:update', { name: 'site', path: appPath, reason: 'edit', bypassCooldown: true });
    await waitFor(() => getStateManager().getApp('site')?.status === 'errored');
    await waitFor(
      () => !(platform as unknown as { appsInProgress: Set<string> }).appsInProgress.has('site')
    );

    expect(current('site')?.path).toBe(serving);
    expect(await fs.readdir(releasesOf('site'))).toEqual([path.basename(serving)]);
  }, 20000);

  it('opting out goes back to in-place and removes the releases', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createApp('site', OPT_IN);
    await deploy('site', appPath);
    const startSpy = jest.spyOn(fakeRuntime, 'start');

    await fs.writeFile(path.join(appPath, 'drop.yaml'), 'type: static\n');
    await redeploy('site', appPath, '<h1>site v2</h1>');

    expect(lastStartCwd(startSpy)).toBe(appPath);
    expect(current('site')).toBeUndefined();
    expect(previous('site')).toBeUndefined();
    expect(await fs.readdir(releasesOf('site')).catch(() => [])).toEqual([]);
  }, 20000);

  it('leaves an app that never opted in exactly as before', async () => {
    platform = makePlatform();
    await platform.start();
    const startSpy = jest.spyOn(fakeRuntime, 'start');
    const appPath = await createApp('plain');

    await deploy('plain', appPath);
    await redeploy('plain', appPath, '<h1>plain v2</h1>');

    expect(lastStartCwd(startSpy)).toBe(appPath);
    expect(current('plain')).toBeUndefined();
    expect(await exists(releasesOf('plain'))).toBe(false);
  }, 20000);

  it('ignores a recorded release that is not under the app\'s releases root', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createApp('site', OPT_IN);
    await deploy('site', appPath);
    // Forged record: a path outside data/releases/site must never become cwd.
    await getAppConfigService().updateSystemConfig('site', {
      currentRelease: { id: 'x', path: path.join(tempDir, 'elsewhere'), createdAt: new Date().toISOString() },
    });
    const startSpy = jest.spyOn(fakeRuntime, 'start');

    await platform.restartApp('site');

    expect(lastStartCwd(startSpy)).toBe(appPath);
  }, 20000);

  it('removes the releases when the app is deleted', async () => {
    platform = makePlatform();
    await platform.start();
    const appPath = await createApp('site', OPT_IN);
    await deploy('site', appPath);

    await platform.purgeAppArtifacts('site', { keepData: true });

    expect(await exists(releasesOf('site'))).toBe(false);
  }, 20000);
});
