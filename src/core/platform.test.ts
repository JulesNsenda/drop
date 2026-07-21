/**
 * Platform Integration Tests
 *
 * Tests the full deployment pipeline: watcher → detector → builder → process → router
 */

import * as path from 'path';
import * as os from 'os';
import * as fsPromises from 'fs/promises';
import * as yaml from 'yaml';
import { DropPlatform, createPlatform } from './platform';
import { eventBus } from './event-bus';
import { getDetector, parseDropYaml, DetectionResult } from './detector';
import * as diskUtils from '../utils/disk';
import { createApiKey, deleteApiKeysByName } from '../api/middleware/auth';

// These are pipeline/service unit tests — they never exercise the HTTP API, so
// disable it (createPlatform reads DROP_ENABLE_API when no enableApi is passed).
// Otherwise start() binds a real, fixed port (3000), which HANGS/fails the
// suite on CI whenever 3000 is contended by a parallel worker or a leaked
// process — while passing locally where 3000 is free. The API itself is covered
// by src/api/**/*.test.ts on their own explicit ports. Mirrors
// platform.integration.test.ts, which passes enableApi: false directly.
const PRIOR_DROP_ENABLE_API = process.env.DROP_ENABLE_API;
process.env.DROP_ENABLE_API = 'false';
afterAll(() => {
  if (PRIOR_DROP_ENABLE_API === undefined) delete process.env.DROP_ENABLE_API;
  else process.env.DROP_ENABLE_API = PRIOR_DROP_ENABLE_API;
});

// Disk-space queries shell out to `df`/PowerShell — mock them so platform
// tests are hermetic and don't depend on real free disk space or subprocess
// execution. Defaults to "plenty of space"; individual tests (P2-5 disk
// preflight guards) override hasEnoughDisk to simulate a low-disk condition.
jest.mock('../utils/disk', () => ({
  hasEnoughDisk: jest.fn().mockResolvedValue({ ok: true, freeMb: 999999 }),
  getMinFreeDiskMb: jest.fn().mockReturnValue(500),
}));

// Mock only the auth module's API-key helpers (createApiKey/deleteApiKeysByName)
// so buildStartSpec's provisioning-key minting (PR2) is exercisable without a
// real, initialized auth store — while keeping the rest of the module (e.g.
// authMiddleware, used transitively by the API routes platform.ts imports)
// real, since this file doesn't otherwise touch auth.
jest.mock('../api/middleware/auth', () => {
  const actual = jest.requireActual('../api/middleware/auth');
  return {
    ...actual,
    createApiKey: jest.fn().mockResolvedValue({
      key: 'drop_testkey',
      apiKey: { id: 'test-key-id', name: 'test', role: 'none', createdAt: new Date().toISOString() },
    }),
    deleteApiKeysByName: jest.fn().mockResolvedValue(undefined),
  };
});

// Mock state manager
jest.mock('../managers/app/state-manager', () => {
  const mockStateManager = {
    initialize: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    registerApp: jest.fn().mockResolvedValue({ name: 'test-app', status: 'pending' }),
    updateApp: jest.fn().mockResolvedValue({ name: 'test-app', status: 'running' }),
    setAppStatus: jest.fn().mockResolvedValue({ name: 'test-app', status: 'running' }),
    removeApp: jest.fn().mockResolvedValue(true),
    getApp: jest.fn().mockReturnValue(undefined),
    getAllApps: jest.fn().mockReturnValue([]),
    getAppsByStatus: jest.fn().mockReturnValue([]),
    getRunningApps: jest.fn().mockReturnValue([]),
    hasApp: jest.fn().mockReturnValue(false),
    getUsedPorts: jest.fn().mockReturnValue([]),
    getStats: jest.fn().mockReturnValue({ total: 0, running: 0, stopped: 0, errored: 0 }),
  };

  return {
    AppStateManager: jest.fn().mockImplementation(() => mockStateManager),
    getStateManager: jest.fn().mockReturnValue(mockStateManager),
    resetStateManager: jest.fn(),
  };
});

// Mock database module
jest.mock('../managers/database', () => {
  const mockPostgresServer = {
    getStatus: jest.fn().mockReturnValue('running'),
    getPort: jest.fn().mockReturnValue(5433),
    getConnectionString: jest.fn().mockReturnValue('postgresql://postgres@localhost:5433/postgres'),
    ensureReady: jest.fn().mockResolvedValue(undefined),
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    getPool: jest.fn().mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }), end: jest.fn() }),
    query: jest.fn().mockResolvedValue([]),
    databaseExists: jest.fn().mockResolvedValue(false),
    createDatabase: jest.fn().mockResolvedValue(undefined),
    createUser: jest.fn().mockResolvedValue(undefined),
    grantPrivileges: jest.fn().mockResolvedValue(undefined),
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
      host: 'localhost',
      port: 5433,
      database: 'drop_test_app',
      user: 'drop_test_app_user',
      password: 'test',
      connectionString: 'postgresql://drop_test_app_user:test@localhost:5433/drop_test_app',
    }),
    getAppCredentials: jest.fn().mockReturnValue(null),
    hasAppDatabase: jest.fn().mockReturnValue(false),
    listDatabases: jest.fn().mockReturnValue([]),
    deleteAppDatabase: jest.fn().mockResolvedValue(undefined),
    getEnvVars: jest.fn().mockReturnValue(null),
    // M4 group teardown (teardownApp/removeGroup) dump-then-drops via this.
    backupAndDeleteAppDatabase: jest.fn().mockResolvedValue({ dropped: true }),
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

// Mock PM2 client
jest.mock('../managers/process/pm2-client', () => ({
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn(),
  isConnectedToPM2: jest.fn().mockReturnValue(true),
  start: jest.fn().mockResolvedValue([{ name: 'test-app', pm_id: 1, pid: 12345 }]),
  stop: jest.fn().mockResolvedValue(undefined),
  restart: jest.fn().mockResolvedValue(undefined),
  reload: jest.fn().mockResolvedValue(undefined),
  deleteProcess: jest.fn().mockResolvedValue(undefined),
  list: jest.fn().mockResolvedValue([]),
  describe: jest.fn().mockResolvedValue([]),
  flush: jest.fn().mockResolvedValue(undefined),
  getProcessStatus: jest.fn().mockResolvedValue({
    name: 'test-app',
    status: 'online',
    pid: 12345,
    pmId: 1,
    instances: 1,
    memory: 52428800,
    cpu: 5,
    uptime: 10000,
    restarts: 0,
    execMode: 'fork',
    watching: false,
    createdAt: new Date(),
    restartedAt: null,
  }),
  toProcessStatus: jest.fn().mockImplementation((desc) => ({
    name: desc.name || 'unknown',
    status: desc.pm2_env?.status || 'online',
    pid: desc.pid || 12345,
    pmId: desc.pm_id ?? 1,
    instances: 1,
    memory: 52428800,
    cpu: 5,
    uptime: 10000,
    restarts: 0,
    execMode: 'fork',
    watching: false,
    createdAt: new Date(),
    restartedAt: null,
  })),
}));

// Mock fs for router
jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises');
  return {
    ...actual,
    mkdir: jest.fn().mockResolvedValue(undefined),
    writeFile: jest.fn().mockResolvedValue(undefined),
    // Cover the atomic-write path (writeFileAtomic uses open+sync+close+rename)
    // so no real files are written during platform tests.
    open: jest.fn().mockResolvedValue({
      writeFile: jest.fn().mockResolvedValue(undefined),
      sync: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    }),
    rename: jest.fn().mockResolvedValue(undefined),
    rm: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockImplementation(async (filePath: string) => {
      // Return package.json for test apps
      if (filePath.endsWith('package.json')) {
        return JSON.stringify({
          name: 'test-app',
          version: '1.0.0',
          scripts: {
            start: 'node index.js',
            build: 'echo build',
          },
        });
      }
      return actual.readFile(filePath);
    }),
    stat: jest.fn().mockImplementation(async (_filePath: string) => {
      // Mock directory stats
      return {
        isDirectory: () => true,
        isFile: () => false,
      };
    }),
    access: jest.fn().mockResolvedValue(undefined),
  };
});

describe('DropPlatform', () => {
  let platform: DropPlatform;
  let tempDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    
    tempDir = path.join(os.tmpdir(), `drop-test-${Date.now()}`);

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error', // Suppress logs during tests
      autoBuild: false, // Disable auto-build for controlled testing
      autoStart: false, // Disable auto-start for controlled testing
      caddyfilePath: path.join(tempDir, 'Caddyfile'),
    });
  });

  afterEach(async () => {
    if (platform.isActive()) {
      await platform.stop();
    }
  });

  describe('constructor', () => {
    it('should create platform with default config', () => {
      const isWindows = process.platform === 'win32';
      const expectedDropRoot = isWindows ? 'C:\\drop' : '/var/drop';
      const expectedAppsDir = isWindows ? 'C:\\drop\\data\\webapps' : '/var/drop/data/webapps';

      const p = new DropPlatform();
      const config = p.getConfig();

      expect(config.dropRoot).toBe(expectedDropRoot);
      expect(config.appsDirectory).toBe(expectedAppsDir);
      expect(config.portRangeStart).toBe(3001);
      expect(config.portRangeEnd).toBe(3999);
    });

    it('should accept custom config', () => {
      const config = platform.getConfig();

      expect(config.dropRoot).toBe(tempDir);
      expect(config.appsDirectory).toBe(path.join(tempDir, 'apps'));
      expect(config.autoBuild).toBe(false);
      expect(config.autoStart).toBe(false);
    });
  });

  // Regression guard for the docker-isolation start bugs: Docker execs the
  // container Cmd array directly with NO shell, so a multi-token start command
  // ("gunicorn --bind 0.0.0.0:$PORT app:app", "node dist/server.js") must be
  // wrapped in /bin/sh -c or runc fails with "executable file not found", and
  // $PORT never expands. These assert what buildStartSpec ACTUALLY emits under
  // docker isolation — the ContainerManager unit tests hand-craft specs and so
  // cannot catch a regression here. (fs.access is globally mocked to resolve,
  // so pathExists('.venv') is true; the python case therefore gets the venv
  // PATH prefix.)
  describe('buildStartSpec docker command shaping', () => {
    let dockerPlatform: DropPlatform;

    beforeEach(() => {
      dockerPlatform = createPlatform({
        dropRoot: tempDir,
        appsDirectory: path.join(tempDir, 'apps'),
        logLevel: 'error',
        caddyfilePath: path.join(tempDir, 'Caddyfile'),
      });
      (dockerPlatform as any).config.isolation = 'docker';
    });

    const detection = (type: string, startCommand: string): DetectionResult =>
      ({
        type,
        framework: null,
        confidence: 1,
        suggestedConfig: { startCommand },
      }) as unknown as DetectionResult;

    const build = (appName: string, det: DetectionResult) =>
      (dockerPlatform as any).buildStartSpec(
        appName,
        path.join(tempDir, appName),
        det,
        4000,
        path.join(tempDir, 'data', appName),
        {}
      );

    it('wraps a python gunicorn command in /bin/sh -c with the venv on PATH, execd', async () => {
      const spec = await build('pyapp', detection('flask', 'gunicorn --bind 0.0.0.0:$PORT app:app'));
      expect(spec.script).toBe('/bin/sh');
      expect(spec.interpreter).toBe('none');
      expect(spec.args).toEqual([
        '-c',
        'export PATH="/app/.venv/bin:$PATH"; exec gunicorn --bind 0.0.0.0:$PORT app:app',
      ]);
    });

    it('wraps a node start command in /bin/sh -c with no venv prefix, execd', async () => {
      const spec = await build('nodeapp', detection('nodejs', 'node dist/server.js'));
      expect(spec.script).toBe('/bin/sh');
      expect(spec.interpreter).toBe('none');
      expect(spec.args).toEqual(['-c', 'exec node dist/server.js']);
    });

    it('spreads the injected redisEnvVars into the start spec env', async () => {
      const spec = await (dockerPlatform as any).buildStartSpec(
        'redisapp',
        path.join(tempDir, 'redisapp'),
        detection('nodejs', 'node server.js'),
        4000,
        path.join(tempDir, 'data', 'redisapp'),
        {},
        { REDIS_URL: 'redis://:pw@drop-host:6380/3', REDIS_DB: '3' }
      );
      expect(spec.env.REDIS_URL).toBe('redis://:pw@drop-host:6380/3');
      expect(spec.env.REDIS_DB).toBe('3');
    });
  });

  // Regression guard for the static-docroot bug (DROP-059): the manifest
  // detector wins detection for any app carrying a drop.yaml (confidence 1.0)
  // but only knows an explicit `build.output` — so a Vite/CRA app typed
  // `static` in its manifest got nginx `root /app` and served its SOURCE
  // index.html (browser then loads /src/main.tsx as octet-stream). The fix
  // falls back to the build strategy's reported output dir: fresh from the
  // build:completed payload on deploy, or the persisted app config on plain
  // restarts. Values are sanitized before interpolation into nginx.conf.
  describe('buildStartSpec static docroot fallback', () => {
    let dockerPlatform: DropPlatform;

    beforeEach(() => {
      dockerPlatform = createPlatform({
        dropRoot: tempDir,
        appsDirectory: path.join(tempDir, 'apps'),
        logLevel: 'error',
        caddyfilePath: path.join(tempDir, 'Caddyfile'),
      });
      (dockerPlatform as any).config.isolation = 'docker';
    });

    const staticDetection = (outputDirectory?: string): DetectionResult =>
      ({
        type: 'static',
        framework: 'spa',
        confidence: 1,
        suggestedConfig: outputDirectory ? { outputDirectory } : {},
      }) as unknown as DetectionResult;

    const stubConfig = (config?: Record<string, unknown>) => {
      (dockerPlatform as any).appConfigService = {
        getConfig: jest.fn().mockReturnValue(config),
      };
    };

    const build = (appName: string, det: DetectionResult, buildOutputDir?: string) =>
      (dockerPlatform as any).buildStartSpec(
        appName,
        path.join(tempDir, appName),
        det,
        4000,
        path.join(tempDir, 'data', appName),
        {},
        {},
        buildOutputDir
      );

    const writtenNginxConf = (appName: string): string => {
      const confPath = path.join(tempDir, 'data', appName, 'nginx.conf');
      const calls = (fsPromises.writeFile as unknown as jest.Mock).mock.calls.filter(
        (c) => c[0] === confPath
      );
      expect(calls.length).toBeGreaterThan(0);
      return calls[calls.length - 1][1] as string;
    };

    it('serves the persisted outputDirectory when detection has none (restart path)', async () => {
      stubConfig({ outputDirectory: 'dist' });
      await build('staticapp1', staticDetection());
      expect(writtenNginxConf('staticapp1')).toContain('root /app/dist;');
    });

    it('serves the fresh build outputPath when detection and config have none (first deploy)', async () => {
      stubConfig(undefined);
      await build('staticapp2', staticDetection(), 'dist');
      expect(writtenNginxConf('staticapp2')).toContain('root /app/dist;');
    });

    it('lets an explicit manifest build.output win over build and config values', async () => {
      stubConfig({ outputDirectory: 'dist' });
      await build('staticapp3', staticDetection('out'), 'dist');
      expect(writtenNginxConf('staticapp3')).toContain('root /app/out;');
    });

    it('falls back to the app root when no output dir is known anywhere', async () => {
      stubConfig(undefined);
      await build('staticapp4', staticDetection());
      expect(writtenNginxConf('staticapp4')).toContain('root /app;');
    });

    it('collapses traversal and nginx-directive-smuggling values to the app root', async () => {
      stubConfig({ outputDirectory: '../../etc' });
      await build('staticapp5', staticDetection());
      expect(writtenNginxConf('staticapp5')).toContain('root /app;');

      stubConfig({ outputDirectory: 'dist; } server { listen 80' });
      await build('staticapp6', staticDetection());
      expect(writtenNginxConf('staticapp6')).toContain('root /app;');
    });

    it('normalizes a "./dist"-style value and treats "." as the app root', async () => {
      stubConfig({ outputDirectory: './dist/' });
      await build('staticapp7', staticDetection());
      expect(writtenNginxConf('staticapp7')).toContain('root /app/dist;');

      stubConfig({ outputDirectory: '.' });
      await build('staticapp8', staticDetection());
      expect(writtenNginxConf('staticapp8')).toContain('root /app;');
    });

    it('applies the same fallback to the non-docker static-server path', async () => {
      const pm2Platform = createPlatform({
        dropRoot: tempDir,
        appsDirectory: path.join(tempDir, 'apps'),
        logLevel: 'error',
        caddyfilePath: path.join(tempDir, 'Caddyfile'),
      });
      (pm2Platform as any).appConfigService = {
        getConfig: jest.fn().mockReturnValue({ outputDirectory: 'dist' }),
      };
      const spec = await (pm2Platform as any).buildStartSpec(
        'staticapp9',
        path.join(tempDir, 'staticapp9'),
        staticDetection(),
        4000,
        path.join(tempDir, 'data', 'staticapp9'),
        {}
      );
      expect(spec.args?.[0]).toBe(path.join(tempDir, 'staticapp9', 'dist'));
    });
  });

  // Regression guard for the `none`/PM2 start bugs: previously this branch
  // passed the raw, possibly multi-token startCommand straight through as a
  // bare `script` (PM2 infers the interpreter from the file extension), with
  // no args/interpreter — so a multi-token command (gunicorn/uvicorn
  // invocations) was treated as a single bogus executable → ENOENT, and
  // $PORT (only present in the child env, process-manager.ts) never expanded.
  // These assert buildStartSpec now mirrors the docker branch's /bin/sh -c +
  // exec shape under `none`/PM2 isolation too — while Node stays prefix-free
  // so PM2 monitors the real node PID (metrics/restart parity, not a shell).
  describe('buildStartSpec PM2 (isolation:none) command shaping', () => {
    let pm2Platform: DropPlatform;

    beforeEach(() => {
      pm2Platform = createPlatform({
        dropRoot: tempDir,
        appsDirectory: path.join(tempDir, 'apps'),
        logLevel: 'error',
        caddyfilePath: path.join(tempDir, 'Caddyfile'),
      });
      (pm2Platform as any).config.isolation = 'none';
    });

    const detection = (type: string, startCommand: string): DetectionResult =>
      ({
        type,
        framework: null,
        confidence: 1,
        suggestedConfig: { startCommand },
      }) as unknown as DetectionResult;

    const build = (appName: string, det: DetectionResult) =>
      (pm2Platform as any).buildStartSpec(
        appName,
        path.join(tempDir, appName),
        det,
        4000,
        path.join(tempDir, 'data', appName),
        {}
      );

    it('wraps a python gunicorn command in /bin/sh -c with the real appPath venv on PATH, execd', async () => {
      const appPath = path.join(tempDir, 'pyapp');
      const spec = await build('pyapp', detection('flask', 'gunicorn --bind 0.0.0.0:$PORT app:app'));
      expect(spec.script).toBe('/bin/sh');
      expect(spec.interpreter).toBe('none');
      expect(spec.args).toEqual([
        '-c',
        `export PATH="${appPath}/.venv/bin:$PATH"; exec gunicorn --bind 0.0.0.0:$PORT app:app`,
      ]);
      // Guards the old failure mode directly: no bare multi-token script/no args.
      expect(spec.args![1]).toMatch(/^export PATH=".*\.venv\/bin:\$PATH"; exec /);
      expect(spec.args![1]).toContain('$PORT');
    });

    it('wraps a node start command in /bin/sh -c with NO venv prefix, execd (PM2 PID parity)', async () => {
      const spec = await build('nodeapp', detection('nodejs', 'node dist/server.js'));
      expect(spec.script).toBe('/bin/sh');
      expect(spec.interpreter).toBe('none');
      expect(spec.args).toEqual(['-c', 'exec node dist/server.js']);
      // Guards the Node/PM2 PID-parity constraint: no export/&& prefix at all.
      expect(spec.args![1]).not.toMatch(/export |&&/);
      expect(spec.args![1]).toBe('exec node dist/server.js');
    });
  });

  // Managed-Redis platform wiring: provisionRedisEnvVars picks the app-facing
  // host (drop-host under docker isolation, loopback otherwise) and is fail-soft
  // when Redis is unavailable. The provisioner itself is unit-tested separately;
  // these cover the platform's host-selection + gating, which the unit tests
  // can't see.
  describe('provisionRedisEnvVars', () => {
    const mockProvisioner = () => ({
      isProvisioned: jest.fn().mockReturnValue(true), // short-circuits to getEnvVars
      getEnvVars: jest.fn().mockReturnValue({ REDIS_URL: 'redis://:pw@H:6380/3', REDIS_DB: '3' }),
      provisionAppRedis: jest.fn(),
    });

    const makePlatform = (isolation: string) => {
      const p = createPlatform({
        dropRoot: tempDir,
        appsDirectory: path.join(tempDir, 'apps'),
        logLevel: 'error',
        caddyfilePath: path.join(tempDir, 'Caddyfile'),
      });
      (p as any).config.isolation = isolation;
      return p;
    };

    it('returns {} when managed Redis is unavailable (no provisioner)', async () => {
      const p = makePlatform('docker');
      (p as any).redisProvisioner = null;
      expect(await (p as any).provisionRedisEnvVars('app', path.join(tempDir, 'app'))).toEqual({});
    });

    it('addresses Redis via the drop-host alias under docker isolation', async () => {
      const prov = mockProvisioner();
      const p = makePlatform('docker');
      (p as any).redisProvisioner = prov;
      const env = await (p as any).provisionRedisEnvVars('app', path.join(tempDir, 'app'));
      expect(prov.getEnvVars).toHaveBeenCalledWith('app', { host: 'drop-host' });
      expect(env.REDIS_URL).toBe('redis://:pw@H:6380/3');
    });

    it('addresses Redis via loopback when not under docker isolation', async () => {
      const prov = mockProvisioner();
      const p = makePlatform('none');
      (p as any).redisProvisioner = prov;
      await (p as any).provisionRedisEnvVars('app', path.join(tempDir, 'app'));
      expect(prov.getEnvVars).toHaveBeenCalledWith('app', { host: '127.0.0.1' });
    });
  });

  describe('start', () => {
    it('should start the platform', async () => {
      const startedHandler = jest.fn();
      eventBus.subscribe('platform:started', startedHandler);

      await platform.start();

      expect(platform.isActive()).toBe(true);
      expect(startedHandler).toHaveBeenCalled();
    });

    it('should throw if already running', async () => {
      await platform.start();

      await expect(platform.start()).rejects.toThrow('DROP platform is already running');
    });

    it('should initialize all services', async () => {
      await platform.start();

      expect(platform.getWatcher()).not.toBeNull();
      expect(platform.getDetector()).not.toBeNull();
      expect(platform.getBuilder()).not.toBeNull();
      expect(platform.getProcessManager()).not.toBeNull();
      expect(platform.getRouter()).not.toBeNull();
    });
  });

  describe('stop', () => {
    it('should stop the platform', async () => {
      await platform.start();

      const stoppedHandler = jest.fn();
      eventBus.subscribe('platform:stopped', stoppedHandler);

      await platform.stop();

      expect(platform.isActive()).toBe(false);
      expect(stoppedHandler).toHaveBeenCalled();
    });

    it('should do nothing if not running', async () => {
      await platform.stop();

      expect(platform.isActive()).toBe(false);
    });
  });

  describe('port allocation', () => {
    it('should allocate ports in sequence', () => {
      const port1 = (platform as any).allocatePort();
      const port2 = (platform as any).allocatePort();
      const port3 = (platform as any).allocatePort();

      expect(port1).toBe(3001);
      expect(port2).toBe(3002);
      expect(port3).toBe(3003);
    });

    it('should track used ports', () => {
      const port1 = (platform as any).allocatePort();

      expect((platform as any).usedPorts.has(port1)).toBe(true);
    });

    it('should release ports', () => {
      const port = (platform as any).allocatePort();

      platform.releasePort(port);

      expect((platform as any).usedPorts.has(port)).toBe(false);
    });

    it('reuses the freed interior port after an app:deleted release (P2-5)', async () => {
      // The app:deleted subscription is wired up in setupEventHandlers, which
      // only runs on start().
      await platform.start();

      const portA = (platform as any).allocatePort('a');
      const portB = (platform as any).allocatePort('b');
      const portC = (platform as any).allocatePort('c');

      expect(portA).toBe(3001);
      expect(portB).toBe(3002);
      expect(portC).toBe(3003);

      eventBus.publish('app:deleted', { appId: 'b', name: 'b' });

      expect((platform as any).usedPorts.has(portB)).toBe(false);

      // Range-scan must find the freed interior gap (3002), not just append at 3004.
      const portD = (platform as any).allocatePort('d');
      expect(portD).toBe(portB);
    });

    it('does NOT release a port on a stray app:removed event — release is keyed on app:deleted only (P2-5)', async () => {
      await platform.start();

      const portA = (platform as any).allocatePort('a');

      // app:removed fires from two producers (real teardown AND the watcher's
      // chokidar unlinkDir handler on a transient folder disappearance); it
      // must never free a port on its own.
      eventBus.publish('app:removed', { appId: 'a', name: 'a' });

      expect((platform as any).usedPorts.has(portA)).toBe(true);
    });

    it('throws when the configured port range is exhausted (P2-5)', () => {
      const { portRangeStart, portRangeEnd } = platform.getConfig();
      const totalPorts = portRangeEnd - portRangeStart + 1;

      for (let i = 0; i < totalPorts; i++) {
        (platform as any).allocatePort();
      }

      expect(() => (platform as any).allocatePort()).toThrow('No available ports in configured range');
    });

    // M4 regression coverage for bug 6 (docs/plan/python-docker-runtime-fixes.md
    // §M4) — already fixed 2026-07-07 by claiming usedPorts synchronously at
    // allocation time (reserve-by-assignment), not at successful bind. These
    // assert the old double-booking failure mode is now impossible.
    it('allocates a distinct port for every app — no two apps ever double-book (bug 6)', () => {
      const names = ['app-a', 'app-b', 'app-c', 'app-d', 'app-e'];
      const ports = names.map((n) => (platform as any).allocatePort(n));

      expect(new Set(ports).size).toBe(ports.length);
      names.forEach((n, i) => {
        expect((platform as any).usedPorts.get(ports[i])).toBe(n);
      });
    });

    it("a crash-looping app's already-assigned port is never handed to a different app (bug 6)", () => {
      // The crash-looper's port is reserved the moment allocatePort claims it
      // — no successful bind is required. A repeatedly-restarting process
      // never fires app:deleted, so the reservation must survive further
      // allocations for brand-new apps.
      const crashPort = (platform as any).allocatePort('crash-looper');
      const otherPort = (platform as any).allocatePort('other-app');
      expect(otherPort).not.toBe(crashPort);

      // Simulate the crash-looper still churning (PM2 restart-count climbing,
      // no app:deleted) while a THIRD, brand-new app is deployed.
      const newPort = (platform as any).allocatePort('new-app');

      expect(newPort).not.toBe(crashPort);
      expect(newPort).not.toBe(otherPort);
      expect((platform as any).usedPorts.get(crashPort)).toBe('crash-looper');
    });
  });

  describe('disk preflight guards (P2-5)', () => {
    let diskPlatform: DropPlatform;
    let diskTempDir: string;

    beforeEach(async () => {
      jest.clearAllMocks();
      diskTempDir = path.join(os.tmpdir(), `drop-test-${Date.now()}`);
      diskPlatform = createPlatform({
        dropRoot: diskTempDir,
        appsDirectory: path.join(diskTempDir, 'apps'),
        logLevel: 'error',
        autoBuild: true,
        autoStart: false,
        caddyfilePath: path.join(diskTempDir, 'Caddyfile'),
      });
      await diskPlatform.start();
      (diskPlatform as any).buildLogService = null; // skip build-log FS writes
    });

    afterEach(async () => {
      if (diskPlatform && diskPlatform.isActive()) {
        await diskPlatform.stop();
      }
    });

    it('aborts a fresh deploy (handleBuildApp) and marks the app errored when disk is low', async () => {
      (diskUtils.hasEnoughDisk as jest.Mock).mockResolvedValueOnce({ ok: false, freeMb: 10 });
      const sm = (diskPlatform as any).stateManager;
      jest.spyOn(diskPlatform.getDetector()!, 'detect').mockResolvedValue({
        type: 'nodejs',
        framework: null,
        suggestedConfig: {},
      } as any);
      const buildSpy = jest.spyOn(diskPlatform.getBuilder()!, 'build');

      await (diskPlatform as any).handleBuildApp(
        path.join(diskTempDir, 'apps', 'lowdiskapp'),
        'lowdiskapp',
        'nodejs'
      );

      expect(buildSpy).not.toHaveBeenCalled();
      expect(sm.setAppStatus).toHaveBeenCalledWith(
        'lowdiskapp',
        'errored',
        expect.objectContaining({ error: expect.stringContaining('Insufficient disk space') })
      );
      expect((diskPlatform as any).appsInProgress.has('lowdiskapp')).toBe(false);
    });

    it('aborts a hot-reload (handleAppUpdate) without erroring a running app when disk is low', async () => {
      (diskUtils.hasEnoughDisk as jest.Mock).mockResolvedValueOnce({ ok: false, freeMb: 10 });
      const sm = (diskPlatform as any).stateManager;
      sm.getApp.mockReturnValue({ name: 'liveapp', status: 'running', port: 3005 });
      const detectSpy = jest.spyOn(diskPlatform.getDetector()!, 'detect');
      const buildSpy = jest.spyOn(diskPlatform.getBuilder()!, 'build');

      await (diskPlatform as any).handleAppUpdate(
        'liveapp',
        path.join(diskTempDir, 'apps', 'liveapp'),
        'file change'
      );

      // Must return before touching the rebuild pipeline or the app's status —
      // a throw here would incorrectly mark a healthy running app 'errored'.
      expect(detectSpy).not.toHaveBeenCalled();
      expect(buildSpy).not.toHaveBeenCalled();
      expect(sm.setAppStatus).not.toHaveBeenCalled();
      expect((diskPlatform as any).appsInProgress.has('liveapp')).toBe(false);
    });
  });

  describe('getEventBus', () => {
    it('should return the event bus', () => {
      const bus = platform.getEventBus();

      expect(bus).toBe(eventBus);
    });
  });

  describe('handleAppDeleted route cleanup (M4: route-leak fix)', () => {
    it('removes every route the deleted app owns, alongside the existing port release', async () => {
      // The app:deleted subscription (and the real router) are wired by
      // start().
      await platform.start();

      const router = (platform as any).router;
      await router.addRoute({
        appName: 'gone-gone-localhost',
        owner: 'gone',
        hostname: 'gone.localhost',
        upstream: 'localhost:4009',
        ssl: false,
        redirectHttps: false,
      });
      expect(router.hasRoute('gone-gone-localhost')).toBe(true);

      const portA = (platform as any).allocatePort('gone');
      eventBus.publish('app:deleted', { appId: 'gone', name: 'gone' });

      // Port release is synchronous within the async handler (runs before the
      // first await), so it's observable immediately.
      expect((platform as any).usedPorts.has(portA)).toBe(false);

      // Route removal happens in a chain of awaits inside the fire-and-forget
      // async event handler (router.removeRoutesForApp -> regenerateConfig ->
      // fs.mkdir/writeFile) — flush the microtask queue before asserting.
      await new Promise((resolve) => setImmediate(resolve));

      expect(router.hasRoute('gone-gone-localhost')).toBe(false);
    });
  });
});

describe('Platform Factory', () => {
  it('createPlatform should create new instance', () => {
    const p1 = createPlatform();
    const p2 = createPlatform();

    expect(p1).not.toBe(p2);
  });

  it('should create platform with environment variables', () => {
    const originalRoot = process.env.DROP_ROOT;
    const originalApps = process.env.DROP_APPS_DIR;

    process.env.DROP_ROOT = '/custom/root';
    process.env.DROP_APPS_DIR = '/custom/apps';

    const p = new DropPlatform();
    const config = p.getConfig();

    expect(config.dropRoot).toBe('/custom/root');
    expect(config.appsDirectory).toBe('/custom/apps');

    // Restore
    if (originalRoot) process.env.DROP_ROOT = originalRoot;
    else delete process.env.DROP_ROOT;
    if (originalApps) process.env.DROP_APPS_DIR = originalApps;
    else delete process.env.DROP_APPS_DIR;
  });
});

describe('Event-driven pipeline', () => {
  let platform: DropPlatform;
  let tempDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    
    tempDir = path.join(os.tmpdir(), `drop-test-${Date.now()}`);

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      autoBuild: true,
      autoStart: true,
      caddyfilePath: path.join(tempDir, 'Caddyfile'),
    });
  });

  afterEach(async () => {
    if (platform.isActive()) {
      await platform.stop();
    }
  });

  it('should emit platform:starting on start', async () => {
    const handler = jest.fn();
    eventBus.subscribe('platform:starting', handler);

    await platform.start();

    expect(handler).toHaveBeenCalled();
    expect(handler.mock.calls[0][0]).toHaveProperty('config');
  });

  it('should emit platform:stopping on stop', async () => {
    await platform.start();

    const handler = jest.fn();
    eventBus.subscribe('platform:stopping', handler);

    await platform.stop();

    expect(handler).toHaveBeenCalled();
  });

  it('should subscribe to watcher:change events', async () => {
    await platform.start();

    // Verify subscriptions were set up
    const watcher = platform.getWatcher();
    expect(watcher).not.toBeNull();
  });

  it('should subscribe to app:detected events', async () => {
    await platform.start();

    const detector = platform.getDetector();
    expect(detector).not.toBeNull();
  });

  it('should subscribe to build:completed events', async () => {
    await platform.start();

    const builder = platform.getBuilder();
    expect(builder).not.toBeNull();
  });

  it('should subscribe to app:started events', async () => {
    await platform.start();

    const processManager = platform.getProcessManager();
    expect(processManager).not.toBeNull();
  });
});

describe('handleAppUpdate — stopped-app guard (P0-2)', () => {
  let platform: DropPlatform;
  let tempDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    tempDir = path.join(os.tmpdir(), `drop-test-${Date.now()}`);
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      autoBuild: true,
      autoStart: true,
      caddyfilePath: path.join(tempDir, 'Caddyfile'),
    });
    await platform.start();
  });

  afterEach(async () => {
    if (platform.isActive()) {
      await platform.stop();
    }
  });

  it('does not rebuild or restart an app the user has stopped', async () => {
    const stateManager = (platform as any).stateManager;
    stateManager.getApp.mockReturnValue({ name: 'stoppedapp', status: 'stopped', port: 3005 });

    const detectSpy = jest.spyOn(platform.getDetector()!, 'detect');
    const startSpy = jest.spyOn((platform as any).runtime, 'start');

    await (platform as any).handleAppUpdate(
      'stoppedapp',
      path.join(tempDir, 'apps', 'stoppedapp'),
      'file change'
    );

    // The guard must short-circuit before any rebuild or restart work.
    expect(detectSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('proceeds past the guard for a running app (detect is invoked)', async () => {
    const stateManager = (platform as any).stateManager;
    stateManager.getApp.mockReturnValue({ name: 'liveapp', status: 'running', port: 3006 });

    // detect() is the first step inside the rebuild try-block, reached only if
    // the stopped-app guard did NOT fire. Reject it so the pipeline stops right
    // there (caught internally) without doing any real build/FS work.
    const detectSpy = jest
      .spyOn(platform.getDetector()!, 'detect')
      .mockRejectedValue(new Error('stop-here'));

    await (platform as any).handleAppUpdate(
      'liveapp',
      path.join(tempDir, 'apps', 'liveapp'),
      'file change'
    );

    expect(detectSpy).toHaveBeenCalled();
  });
});

// M2 2g: an app the detector can't classify used to be left registered at
// `pending` forever (the autoBuild guard requires `payload.type !== 'unknown'`,
// so it never builds and nothing else ever writes a terminal status). Assert
// it now ends `errored` with an actionable message instead of dangling silently.
describe('handleAppDetected — unknown type ends errored (M2 2g)', () => {
  let platform: DropPlatform;
  let tempDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    tempDir = path.join(os.tmpdir(), `drop-test-${Date.now()}`);
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      autoBuild: true,
      autoStart: true,
      caddyfilePath: path.join(tempDir, 'Caddyfile'),
    });
    await platform.start();
  });

  afterEach(async () => {
    if (platform.isActive()) {
      await platform.stop();
    }
  });

  it('marks an unknown-type app errored with a clear message, not left at pending', async () => {
    const stateManager = (platform as any).stateManager;
    // getApp's mock return value persists across tests/suites (clearAllMocks
    // resets call history, not implementations) — reset explicitly so this
    // test isn't hostage to another suite's leftover override.
    stateManager.getApp.mockReturnValue(undefined);

    await (platform as any).handleAppDetected({
      name: 'mystery-app',
      path: path.join(tempDir, 'apps', 'mystery-app'),
      type: 'unknown',
      timestamp: new Date(),
    });

    expect(stateManager.setAppStatus).toHaveBeenCalledWith(
      'mystery-app',
      'errored',
      expect.objectContaining({ error: expect.stringContaining('Could not detect application type') })
    );
  });

  it('does not build an unknown-type app', async () => {
    const buildSpy = jest.spyOn(platform as any, 'handleBuildApp');
    ((platform as any).stateManager.getApp as jest.Mock).mockReturnValue(undefined);

    await (platform as any).handleAppDetected({
      name: 'mystery-app-2',
      path: path.join(tempDir, 'apps', 'mystery-app-2'),
      type: 'unknown',
      timestamp: new Date(),
    });

    expect(buildSpy).not.toHaveBeenCalled();
  });

  it('does not mark a user-stopped app errored on re-detection as unknown', async () => {
    const stateManager = (platform as any).stateManager;
    stateManager.getApp.mockReturnValue({ name: 'stopped-mystery-app', status: 'stopped' });

    await (platform as any).handleAppDetected({
      name: 'stopped-mystery-app',
      path: path.join(tempDir, 'apps', 'stopped-mystery-app'),
      type: 'unknown',
      timestamp: new Date(),
    });

    expect(stateManager.setAppStatus).not.toHaveBeenCalled();
  });

  it('still builds a known-type app (errored branch does not shadow the normal path)', async () => {
    const buildSpy = jest.spyOn(platform as any, 'handleBuildApp').mockResolvedValue(undefined);
    const stateManager = (platform as any).stateManager;
    // getApp's mock return value persists across tests (jest.clearAllMocks
    // resets call history, not implementations) — reset explicitly rather
    // than depend on a previous test's leftover 'stopped' override.
    stateManager.getApp.mockReturnValue(undefined);

    await (platform as any).handleAppDetected({
      name: 'known-app',
      path: path.join(tempDir, 'apps', 'known-app'),
      type: 'nodejs',
      timestamp: new Date(),
    });

    expect(buildSpy).toHaveBeenCalledWith(
      path.join(tempDir, 'apps', 'known-app'),
      'known-app',
      'nodejs'
    );
    expect(stateManager.setAppStatus).not.toHaveBeenCalled();
  });
});

describe('deploy strand & startup reconciler (P1-1)', () => {
  let platform: DropPlatform;
  let tempDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    tempDir = path.join(os.tmpdir(), `drop-test-${Date.now()}`);
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      autoBuild: true,
      autoStart: true,
      caddyfilePath: path.join(tempDir, 'Caddyfile'),
    });
    await platform.start();
  });

  afterEach(async () => {
    if (platform && platform.isActive()) {
      await platform.stop();
    }
  });

  it('releases the in-progress guard when the initial status write throws', async () => {
    const sm = (platform as any).stateManager;
    // Simulate the app already being mid-deploy (handleBuildApp added it).
    (platform as any).appsInProgress.add('wedged');
    // The first setAppStatus — the 'starting' write — fails, as a disk error would.
    sm.setAppStatus.mockRejectedValueOnce(new Error('disk full'));

    await (platform as any).handleStartApp('wedged');

    // finally must have released the guard, so future rebuilds aren't wedged.
    expect((platform as any).appsInProgress.has('wedged')).toBe(false);
  });

  it('reconciles a mid-deploy building app to pending on startup', async () => {
    const sm = (platform as any).stateManager;
    sm.getAllApps.mockReturnValue([
      { name: 'buildingapp', status: 'building', path: path.join(tempDir, 'apps', 'buildingapp') },
    ]);
    jest.spyOn((platform as any).runtime, 'getAllStatus').mockResolvedValue([]);

    await (platform as any).syncStateWithProcesses();

    expect(sm.setAppStatus).toHaveBeenCalledWith('buildingapp', 'pending');
  });
});

describe('app type persistence after build (P1-5 / P1-6 follow-up)', () => {
  let platform: DropPlatform;
  let tempDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    tempDir = path.join(os.tmpdir(), `drop-test-${Date.now()}`);
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      autoBuild: true,
      autoStart: false,
      caddyfilePath: path.join(tempDir, 'Caddyfile'),
    });
    await platform.start();
  });

  afterEach(async () => {
    if (platform && platform.isActive()) {
      await platform.stop();
    }
  });

  it('persists the real detected type to state after building', async () => {
    const sm = (platform as any).stateManager;
    (platform as any).buildLogService = null; // skip build-log FS writes
    jest.spyOn(platform.getDetector()!, 'detect').mockResolvedValue({
      type: 'nodejs',
      framework: null,
      suggestedConfig: {},
    } as any);
    jest.spyOn(platform.getBuilder()!, 'build').mockResolvedValue({
      success: true,
      duration: 5,
      errors: [],
    } as any);

    await (platform as any).handleBuildApp(path.join(tempDir, 'apps', 'app'), 'app', 'unknown');
    // handleBuildApp's success path hands off to handleStartApp (which owns the
    // guard release); that handoff doesn't run in isolation, so clear it here to
    // keep afterEach's stop()/drain from waiting on it.
    (platform as any).appsInProgress.clear();

    // The watcher's app:detected can't know the real type, and detect() no
    // longer republishes (P1-6), so the build path must persist it.
    expect(sm.updateApp).toHaveBeenCalledWith('app', expect.objectContaining({ type: 'nodejs' }));
  });

  it('persists a changed type on hot-reload too', async () => {
    const sm = (platform as any).stateManager;
    sm.getApp.mockReturnValue({ name: 'app', status: 'running', port: 3005 });
    (platform as any).buildLogService = null;
    jest.spyOn(platform.getDetector()!, 'detect').mockResolvedValue({
      type: 'python',
      framework: null,
      suggestedConfig: {},
    } as any);
    // Fail the build fast — the type write happens before the build runs.
    jest.spyOn(platform.getBuilder()!, 'build').mockResolvedValue({
      success: false,
      errors: [{ message: 'stub' }],
    } as any);

    await (platform as any).handleAppUpdate('app', path.join(tempDir, 'apps', 'app'), 'edit');

    expect(sm.updateApp).toHaveBeenCalledWith('app', expect.objectContaining({ type: 'python' }));
  });
});

describe('hung/failed build ends errored with the record intact (M4)', () => {
  // Regression coverage for docs/plan/python-docker-runtime-fixes.md §M4: the
  // builder's own build-timeout resolves with the same { success: false,
  // errors: [...] } shape as any other build failure — already handled by
  // handleBuildApp's else-branch (setAppStatus('errored'), never removeApp).
  // This locks in that a hung/failed build does NOT wipe the app's state out
  // from under it (the old "operator sees not found instead of errored" bug,
  // which the M4 DELETE-during-build guard also targets from the API side).
  let platform: DropPlatform;
  let tempDir: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    tempDir = path.join(os.tmpdir(), `drop-test-${Date.now()}`);
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      autoBuild: true,
      autoStart: false,
      caddyfilePath: path.join(tempDir, 'Caddyfile'),
    });
    await platform.start();
  });

  afterEach(async () => {
    if (platform && platform.isActive()) {
      await platform.stop();
    }
  });

  it('a timed-out build ends the app errored, never calls removeApp, and the record stays gettable', async () => {
    const sm = (platform as any).stateManager;
    (platform as any).buildLogService = null; // skip build-log FS writes

    // Stateful getApp/removeApp so "record intact" is a real assertion, not a
    // static mock return value: removeApp actually clears it if called.
    let record: { name: string; status: string } | undefined = { name: 'hungapp', status: 'building' };
    sm.getApp.mockImplementation((n: string) => (n === 'hungapp' ? record : undefined));
    sm.removeApp.mockImplementation(async (n: string) => {
      if (n === 'hungapp') record = undefined;
      return true;
    });

    jest.spyOn(platform.getDetector()!, 'detect').mockResolvedValue({
      type: 'python',
      framework: null,
      suggestedConfig: {},
    } as any);
    // Same shape the 10-minute builder timeout produces: success: false with
    // an error message, not a thrown exception.
    jest.spyOn(platform.getBuilder()!, 'build').mockResolvedValue({
      success: false,
      errors: [{ message: 'Build timed out after 600000ms' }],
    } as any);

    await (platform as any).handleBuildApp(path.join(tempDir, 'apps', 'hungapp'), 'hungapp', 'python');

    expect(sm.setAppStatus).toHaveBeenCalledWith(
      'hungapp',
      'errored',
      expect.objectContaining({ error: expect.stringContaining('timed out') })
    );
    expect(sm.removeApp).not.toHaveBeenCalled();
    expect(sm.getApp('hungapp')).toBeDefined();
    // The build guard is released on failure so a later retry isn't wedged.
    expect((platform as any).appsInProgress.has('hungapp')).toBe(false);
  });
});

describe('buildStartSpec — resource limits (P0-4)', () => {
  let platform: DropPlatform;
  let tempDir: string;

  const detection = {
    type: 'nodejs',
    framework: null,
    suggestedConfig: { startCommand: 'node index.js' },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = path.join(os.tmpdir(), `drop-test-${Date.now()}`);
  });

  afterEach(async () => {
    if (platform && platform.isActive()) {
      await platform.stop();
    }
  });

  it('wires configured per-app memory and cpu caps into the spec', async () => {
    platform = createPlatform({
      dropRoot: tempDir,
      logLevel: 'error',
      maxMemoryMbPerApp: 512,
      maxCpusPerApp: 0.5,
    } as any);
    await platform.start();

    const spec = await (platform as any).buildStartSpec(
      'app1',
      path.join(tempDir, 'app1'),
      detection,
      3005,
      path.join(tempDir, 'data'),
      {}
    );

    expect(spec.limits).toEqual({ memory: '512M', cpus: 0.5 });
  });

  it('omits limits by default (0 = opt-in), so runtimes keep their own defaults', async () => {
    // Default config leaves caps at 0 — no forced cap, so an existing PM2 app
    // is never newly killed and docker keeps its own 256M/0.5 container default.
    platform = createPlatform({ dropRoot: tempDir, logLevel: 'error' });
    await platform.start();

    const spec = await (platform as any).buildStartSpec(
      'app2',
      path.join(tempDir, 'app2'),
      detection,
      3006,
      path.join(tempDir, 'data'),
      {}
    );

    expect(spec.limits).toBeUndefined();
  });
});

describe('buildStartSpec — DROP_API_URL injection (PR1)', () => {
  let platform: DropPlatform;
  let tempDir: string;

  const detection = {
    type: 'nodejs',
    framework: null,
    suggestedConfig: { startCommand: 'node index.js' },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = path.join(os.tmpdir(), `drop-test-${Date.now()}`);
  });

  afterEach(async () => {
    if (platform && platform.isActive()) {
      await platform.stop();
    }
  });

  it('injects the drop-host alias URL under docker isolation', async () => {
    platform = createPlatform({ dropRoot: tempDir, logLevel: 'error', apiPort: 4111 });
    await platform.start();
    // Flip isolation post-start rather than passing isolation: 'docker' to
    // createPlatform — docker isolation triggers real `docker info`/`caddy
    // version` startup probes (assertStartupConstraints) that aren't
    // available/mocked in this hermetic suite. buildStartSpec only reads
    // this.config.isolation, so mutating it directly is sufficient here.
    (platform as any).config.isolation = 'docker';
    // The shared database mock (top of file) doesn't stub getSocketDir —
    // buildStartSpec's docker-only pgSocketDir branch calls it once
    // isolation is flipped above, so add the missing method here.
    (platform as any).postgresServer.getSocketDir = jest.fn().mockReturnValue(undefined);

    const spec = await (platform as any).buildStartSpec(
      'app-docker',
      path.join(tempDir, 'app-docker'),
      detection,
      3005,
      path.join(tempDir, 'data'),
      {}
    );

    expect(spec.env.DROP_API_URL).toBe('http://drop-host:4111');
  });

  it('injects the loopback URL when isolation is none', async () => {
    platform = createPlatform({
      dropRoot: tempDir,
      logLevel: 'error',
      apiPort: 4112,
      isolation: 'none',
    });
    await platform.start();

    const spec = await (platform as any).buildStartSpec(
      'app-none',
      path.join(tempDir, 'app-none'),
      detection,
      3006,
      path.join(tempDir, 'data'),
      {}
    );

    expect(spec.env.DROP_API_URL).toBe('http://127.0.0.1:4112');
  });

  it('does not let a tenant DROP_API_URL secret override the platform-authoritative value', async () => {
    platform = createPlatform({
      dropRoot: tempDir,
      logLevel: 'error',
      apiPort: 4113,
      isolation: 'none',
    });
    await platform.start();
    // Stub the secret manager to simulate a tenant secret literally named
    // DROP_API_URL — must not win over the platform value (R6).
    (platform as any).secretManager = {
      hasSecrets: jest.fn().mockReturnValue(true),
      getAll: jest.fn().mockReturnValue({ DROP_API_URL: 'http://evil.example:9999' }),
    };

    const spec = await (platform as any).buildStartSpec(
      'app-secret-override',
      path.join(tempDir, 'app-secret-override'),
      detection,
      3007,
      path.join(tempDir, 'data'),
      {}
    );

    expect(spec.env.DROP_API_URL).toBe('http://127.0.0.1:4113');
  });
});

describe('buildStartSpec — DROP_API_KEY provisioning grant (PR2)', () => {
  let platform: DropPlatform;
  let tempDir: string;

  const detection = {
    type: 'nodejs',
    framework: null,
    suggestedConfig: { startCommand: 'node index.js' },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = path.join(os.tmpdir(), `drop-test-${Date.now()}`);
  });

  afterEach(async () => {
    if (platform && platform.isActive()) {
      await platform.stop();
    }
  });

  it('mints a fresh, rotated provisioning key and injects DROP_API_KEY when the app has a granted scope', async () => {
    platform = createPlatform({
      dropRoot: tempDir,
      logLevel: 'error',
      apiPort: 4114,
      isolation: 'none',
    });
    await platform.start();
    (platform as any).appConfigService = {
      getConfig: jest.fn().mockReturnValue({ grantedApiScopes: ['users:create'] }),
    };

    const spec = await (platform as any).buildStartSpec(
      'app-granted',
      path.join(tempDir, 'app-granted'),
      detection,
      3008,
      path.join(tempDir, 'data'),
      {}
    );

    expect(spec.env.DROP_API_KEY).toBe('drop_testkey');
    // Rotation: any prior key for this app is deleted before minting the new one.
    expect(deleteApiKeysByName).toHaveBeenCalledWith('app:app-granted:provision');
    expect(createApiKey).toHaveBeenCalledWith(
      'app:app-granted:provision',
      'none',
      undefined,
      ['users:create']
    );
  });

  it('omits DROP_API_KEY entirely when the app has no granted scopes', async () => {
    platform = createPlatform({
      dropRoot: tempDir,
      logLevel: 'error',
      apiPort: 4115,
      isolation: 'none',
    });
    await platform.start();
    (platform as any).appConfigService = {
      getConfig: jest.fn().mockReturnValue(undefined),
    };

    const spec = await (platform as any).buildStartSpec(
      'app-ungranted',
      path.join(tempDir, 'app-ungranted'),
      detection,
      3009,
      path.join(tempDir, 'data'),
      {}
    );

    expect(spec.env.DROP_API_KEY).toBeUndefined();
    expect(createApiKey).not.toHaveBeenCalled();
    expect(deleteApiKeysByName).not.toHaveBeenCalled();
  });
});

describe('Service accessors', () => {
  let platform: DropPlatform;
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `drop-test-${Date.now()}`);
    platform = createPlatform({
      dropRoot: tempDir,
      logLevel: 'error',
    });
  });

  afterEach(async () => {
    if (platform.isActive()) {
      await platform.stop();
    }
  });

  it('should return null for services before start', () => {
    expect(platform.getWatcher()).toBeNull();
    expect(platform.getDetector()).toBeNull();
    expect(platform.getBuilder()).toBeNull();
    expect(platform.getProcessManager()).toBeNull();
    expect(platform.getRouter()).toBeNull();
  });

  it('should return services after start', async () => {
    await platform.start();

    expect(platform.getWatcher()).not.toBeNull();
    expect(platform.getDetector()).not.toBeNull();
    expect(platform.getBuilder()).not.toBeNull();
    expect(platform.getProcessManager()).not.toBeNull();
    expect(platform.getRouter()).not.toBeNull();
  });
});

describe('resolveBuildEnv / resolveDependencies (M1: build-time env + browser-reachable depends_on)', () => {
  let platform: DropPlatform;
  let tempDir: string;
  // Content returned for any path ending in a drop.yaml filename; null means
  // "no drop.yaml" (parseDropYaml sees the ENOENT thrown below as a failed
  // parse, same net effect as absent for our purposes — no config).
  let dropYamlContent: string | null;

  beforeAll(() => {
    // Override just for this suite: the shared fs/promises mock's default
    // readFile only special-cases package.json. Route anything ending in a
    // drop.yaml filename through the test-controlled `dropYamlContent`, so
    // parseDropYaml (used by both resolveBuildEnv and resolveDependencies)
    // sees real, per-test YAML instead of throwing ENOENT.
    (fsPromises.readFile as jest.Mock).mockImplementation(async (filePath: unknown) => {
      const p = String(filePath);
      if (/drop\.ya?ml$/.test(p) || /\.drop\.ya?ml$/.test(p)) {
        if (dropYamlContent === null) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return dropYamlContent;
      }
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
  });

  afterAll(() => {
    // Restore the file-level default so later-running suites (if any) aren't
    // affected — this suite is the last in the file, but keep it hygienic.
    (fsPromises.readFile as jest.Mock).mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('package.json')) {
        return JSON.stringify({
          name: 'test-app',
          version: '1.0.0',
          scripts: { start: 'node index.js', build: 'echo build' },
        });
      }
      const actual = jest.requireActual('fs/promises') as typeof fsPromises;
      return actual.readFile(filePath as never);
    });
  });

  beforeEach(() => {
    dropYamlContent = null;
    tempDir = path.join(os.tmpdir(), `drop-test-${Date.now()}-${Math.random()}`);
  });

  afterEach(async () => {
    if (platform && platform.isActive()) {
      await platform.stop();
    }
  });

  describe('resolveBuildEnv', () => {
    it('merges env -> build_env -> depends_on (later wins) and coerces scalars to strings', async () => {
      platform = createPlatform({
        dropRoot: tempDir,
        appsDirectory: path.join(tempDir, 'apps'),
        logLevel: 'error',
        domainSuffix: 'localhost',
      });
      (platform as any).appConfigService = {
        getConfig: jest.fn().mockReturnValue({ port: 4001 }),
      };

      dropYamlContent = [
        'env:',
        '  NODE_ENV: production',
        '  SHARED: from-env',
        'build_env:',
        '  VITE_API_URL: /api',
        '  VITE_PORT: 5173',
        '  VITE_DEBUG: true',
        '  SHARED: from-build-env',
        'depends_on:',
        '  - name: backend',
        '    env: SHARED',
        '    path: /api',
      ].join('\n');

      const result = await (platform as any).resolveBuildEnv(
        path.join(tempDir, 'apps', 'app'),
        'app'
      );

      expect(result.NODE_ENV).toBe('production');
      expect(result.VITE_API_URL).toBe('/api');
      expect(result.VITE_PORT).toBe('5173'); // number coerced to string
      expect(result.VITE_DEBUG).toBe('true'); // boolean coerced to string
      // depends_on beats both env and build_env for the same key.
      expect(result.SHARED).toBe('http://localhost:4001/api');
    });

    it('returns an empty object when there is no valid drop.yaml', async () => {
      platform = createPlatform({
        dropRoot: tempDir,
        appsDirectory: path.join(tempDir, 'apps'),
        logLevel: 'error',
      });
      dropYamlContent = null;

      const result = await (platform as any).resolveBuildEnv(
        path.join(tempDir, 'apps', 'app'),
        'app'
      );

      expect(result).toEqual({});
    });
  });

  describe('resolveDependencies', () => {
    it('resolves to the dependency custom domain (browser-reachable), honoring path — not localhost:port', async () => {
      platform = createPlatform({
        dropRoot: tempDir,
        appsDirectory: path.join(tempDir, 'apps'),
        logLevel: 'error',
        enableHttps: true,
        domainSuffix: 'dropkit.sh',
      });
      (platform as any).appConfigService = {
        getConfig: jest.fn().mockReturnValue({ domains: ['api.example.com'], port: 4002 }),
      };

      dropYamlContent = [
        'depends_on:',
        '  - name: api',
        '    env: API_URL',
        '    path: /v1',
      ].join('\n');

      const result = await (platform as any).resolveDependencies(
        path.join(tempDir, 'apps', 'frontend'),
        'frontend'
      );

      expect(result.API_URL).toBe('https://api.example.com/v1');
    });

    it('falls back to <dep>.<domainSuffix> when a real domain suffix is configured and the dep has no custom domain', async () => {
      platform = createPlatform({
        dropRoot: tempDir,
        appsDirectory: path.join(tempDir, 'apps'),
        logLevel: 'error',
        enableHttps: true,
        domainSuffix: 'dropkit.sh',
      });
      (platform as any).appConfigService = {
        getConfig: jest.fn().mockReturnValue({ port: 4003 }),
      };

      dropYamlContent = [
        'depends_on:',
        '  - name: backend',
        '    env: BACKEND_URL',
      ].join('\n');

      const result = await (platform as any).resolveDependencies(
        path.join(tempDir, 'apps', 'frontend'),
        'frontend'
      );

      expect(result.BACKEND_URL).toBe('https://backend.dropkit.sh');
    });

    it('falls back to http://localhost:<configPort> for pure local dev (no real domain configured)', async () => {
      platform = createPlatform({
        dropRoot: tempDir,
        appsDirectory: path.join(tempDir, 'apps'),
        logLevel: 'error',
        // domainSuffix defaults to 'localhost', enableHttps defaults to false
      });
      (platform as any).appConfigService = {
        getConfig: jest.fn().mockReturnValue({ port: 4004 }),
      };

      dropYamlContent = [
        'depends_on:',
        '  - name: backend',
        '    env: BACKEND_URL',
      ].join('\n');

      const result = await (platform as any).resolveDependencies(
        path.join(tempDir, 'apps', 'frontend'),
        'frontend'
      );

      expect(result.BACKEND_URL).toBe('http://localhost:4004');
    });

    it('warns and omits the env var when the dependency is unregistered (no config)', async () => {
      platform = createPlatform({
        dropRoot: tempDir,
        appsDirectory: path.join(tempDir, 'apps'),
        logLevel: 'error',
      });
      (platform as any).appConfigService = {
        getConfig: jest.fn().mockReturnValue(undefined),
      };
      const warnSpy = jest.spyOn((platform as any).logger, 'warn').mockImplementation(() => undefined);

      dropYamlContent = [
        'depends_on:',
        '  - name: ghost',
        '    env: GHOST_URL',
      ].join('\n');

      const result = await (platform as any).resolveDependencies(
        path.join(tempDir, 'apps', 'frontend'),
        'frontend'
      );

      expect(result).toEqual({});
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ghost'),
        'DEPS'
      );
    });

    it('resolves an empty object when depends_on is absent', async () => {
      platform = createPlatform({
        dropRoot: tempDir,
        appsDirectory: path.join(tempDir, 'apps'),
        logLevel: 'error',
      });
      dropYamlContent = 'name: frontend';

      const result = await (platform as any).resolveDependencies(
        path.join(tempDir, 'apps', 'frontend'),
        'frontend'
      );

      expect(result).toEqual({});
    });
  });
});

describe('expandMonorepo (M2: monorepo -> per-service app expansion)', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let appsDir: string;

  beforeAll(() => {
    // This suite exercises real copy-per-service materialization, real
    // generated child drop.yaml content, and real type detection against a
    // fixture on disk — override the file-level fs/promises mocks (set up
    // above for the rest of this file's hermetic unit tests) with the real
    // implementation for the duration of this suite only. `cp` is untouched
    // by the file-level mock already (falls through to the real impl via the
    // `...actual` spread), so only the explicitly-overridden functions need
    // restoring here.
    const actual = jest.requireActual('fs/promises') as typeof fsPromises;
    (fsPromises.mkdir as jest.Mock).mockImplementation(actual.mkdir);
    (fsPromises.writeFile as jest.Mock).mockImplementation(actual.writeFile);
    (fsPromises.rm as jest.Mock).mockImplementation(actual.rm);
    (fsPromises.stat as jest.Mock).mockImplementation(actual.stat);
    (fsPromises.access as jest.Mock).mockImplementation(actual.access);
    (fsPromises.readFile as jest.Mock).mockImplementation(actual.readFile);
  });

  afterAll(() => {
    // Restore this file's original mock behavior (matches the jest.mock
    // factory at the top of the file) for hygiene, even though this suite
    // happens to run last.
    (fsPromises.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.writeFile as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.rm as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.stat as jest.Mock).mockImplementation(async () => ({
      isDirectory: () => true,
      isFile: () => false,
    }));
    (fsPromises.access as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.readFile as jest.Mock).mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('package.json')) {
        return JSON.stringify({
          name: 'test-app',
          version: '1.0.0',
          scripts: { start: 'node index.js', build: 'echo build' },
        });
      }
      const realFs = jest.requireActual('fs/promises') as typeof fsPromises;
      return realFs.readFile(filePath as never);
    });
  });

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `drop-test-monorepo-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    appsDir = path.join(tempDir, 'apps');
    await fsPromises.mkdir(appsDir, { recursive: true });

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: appsDir,
      logLevel: 'error',
      autoBuild: true,
    });
    // detect() is exercised for real (backend's type isn't overridden in the
    // fixture) — wire up a real detector instance, same as production wires
    // it in initializeServices().
    (platform as any).detector = getDetector();
  });

  afterEach(async () => {
    if (platform && platform.isActive()) {
      await platform.stop();
    }
    await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  /** Writes a minimal two-service repo fixture (backend + frontend), each with a node_modules/ subtree that must be excluded from the copy. */
  async function writeFixtureRepo(repoPath: string): Promise<void> {
    const backendDir = path.join(repoPath, 'backend');
    await fsPromises.mkdir(path.join(backendDir, 'node_modules', 'some-dep'), { recursive: true });
    await fsPromises.writeFile(
      path.join(backendDir, 'node_modules', 'some-dep', 'index.js'),
      '// should be excluded from the copy'
    );
    await fsPromises.writeFile(
      path.join(backendDir, 'package.json'),
      JSON.stringify({
        name: 'backend',
        version: '1.0.0',
        scripts: { start: 'node index.js' },
      })
    );
    await fsPromises.writeFile(path.join(backendDir, 'index.js'), "console.log('backend');\n");

    const frontendDir = path.join(repoPath, 'frontend');
    await fsPromises.mkdir(path.join(frontendDir, 'node_modules', 'some-dep'), { recursive: true });
    await fsPromises.writeFile(
      path.join(frontendDir, 'node_modules', 'some-dep', 'index.js'),
      '// should be excluded from the copy'
    );
    await fsPromises.writeFile(
      path.join(frontendDir, 'package.json'),
      JSON.stringify({ name: 'frontend', version: '1.0.0' })
    );
    await fsPromises.writeFile(path.join(frontendDir, 'index.html'), '<html></html>');
  }

  it('materializes each service into its own top-level app folder with type/DB/depends_on resolved correctly', async () => {
    const repoName = 'ezsign';
    const repoPath = path.join(appsDir, repoName);
    await writeFixtureRepo(repoPath);

    const configStore = new Map<string, any>();
    (platform as any).appConfigService = {
      getConfig: jest.fn((name: string) => configStore.get(name)),
      upsertConfig: jest.fn(async (name: string, updates: any) => {
        const merged = { ...(configStore.get(name) || {}), ...updates, name };
        configStore.set(name, merged);
        return merged;
      }),
    };
    (platform as any).stateManager = {
      registerApp: jest.fn().mockResolvedValue(undefined),
      updateApp: jest.fn().mockResolvedValue(undefined),
    };
    const buildSpy = jest.fn().mockResolvedValue(undefined);
    (platform as any).handleBuildApp = buildSpy;

    const dropConfig = {
      services: {
        backend: { path: 'backend', database: 'postgres' },
        frontend: {
          path: 'frontend',
          type: 'static',
          depends_on: [{ name: 'backend', env: 'API_URL' }],
        },
      },
    };

    await (platform as any).expandMonorepo(repoPath, repoName, dropConfig);

    const backendChildPath = path.join(appsDir, `${repoName}-backend`);
    const frontendChildPath = path.join(appsDir, `${repoName}-frontend`);

    // (a) folders created, files copied, node_modules excluded
    await expect(fsPromises.stat(path.join(backendChildPath, 'index.js'))).resolves.toBeDefined();
    await expect(fsPromises.stat(path.join(frontendChildPath, 'index.html'))).resolves.toBeDefined();
    await expect(fsPromises.stat(path.join(backendChildPath, 'node_modules'))).rejects.toThrow();
    await expect(fsPromises.stat(path.join(frontendChildPath, 'node_modules'))).rejects.toThrow();

    const backendYaml = yaml.parse(
      await fsPromises.readFile(path.join(backendChildPath, 'drop.yaml'), 'utf-8')
    );
    const frontendYaml = yaml.parse(
      await fsPromises.readFile(path.join(frontendChildPath, 'drop.yaml'), 'utf-8')
    );

    // (b) each child drop.yaml has a real (non-'unknown') type
    expect(backendYaml.type).toBeTruthy();
    expect(backendYaml.type).not.toBe('unknown');
    expect(frontendYaml.type).toBe('static'); // explicit override honored, no detection needed

    // (c) frontend's depends_on is rewritten to the real sibling app name
    expect(frontendYaml.depends_on).toEqual([{ name: `${repoName}-backend`, env: 'API_URL' }]);

    // (d) only backend gets `database`
    expect(backendYaml.database).toBe('postgres');
    expect(frontendYaml.database).toBeUndefined();

    // (e) configs + state registered with the group tag
    expect(configStore.get(`${repoName}-backend`)?.group).toBe(repoName);
    expect(configStore.get(`${repoName}-frontend`)?.group).toBe(repoName);
    expect((platform as any).stateManager.registerApp).toHaveBeenCalledWith(
      `${repoName}-backend`,
      backendChildPath,
      expect.any(String)
    );
    expect((platform as any).stateManager.registerApp).toHaveBeenCalledWith(
      `${repoName}-frontend`,
      frontendChildPath,
      'static'
    );
    expect((platform as any).stateManager.updateApp).toHaveBeenCalledWith(`${repoName}-backend`, {
      group: repoName,
    });
    expect((platform as any).stateManager.updateApp).toHaveBeenCalledWith(`${repoName}-frontend`, {
      group: repoName,
    });

    // Builds were driven for both children (build itself is stubbed).
    expect(buildSpy).toHaveBeenCalledWith(backendChildPath, `${repoName}-backend`, expect.any(String));
    expect(buildSpy).toHaveBeenCalledWith(frontendChildPath, `${repoName}-frontend`, 'static');
  });

  it('(f) skips a service whose derived name collides with a pre-existing app outside the group', async () => {
    const repoName = 'ezsign';
    const repoPath = path.join(appsDir, repoName);
    await writeFixtureRepo(repoPath);

    const configStore = new Map<string, any>();
    // A standalone, non-grouped app already owns 'ezsign-backend'.
    configStore.set(`${repoName}-backend`, { name: `${repoName}-backend`, type: 'nodejs' });

    (platform as any).appConfigService = {
      getConfig: jest.fn((name: string) => configStore.get(name)),
      upsertConfig: jest.fn(async (name: string, updates: any) => {
        const merged = { ...(configStore.get(name) || {}), ...updates, name };
        configStore.set(name, merged);
        return merged;
      }),
    };
    (platform as any).stateManager = {
      registerApp: jest.fn().mockResolvedValue(undefined),
      updateApp: jest.fn().mockResolvedValue(undefined),
    };
    (platform as any).handleBuildApp = jest.fn().mockResolvedValue(undefined);
    const warnSpy = jest.spyOn((platform as any).logger, 'warn').mockImplementation(() => undefined);

    const dropConfig = {
      services: {
        backend: { path: 'backend' },
        frontend: { path: 'frontend', type: 'static' },
      },
    };

    await (platform as any).expandMonorepo(repoPath, repoName, dropConfig);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`${repoName}-backend`),
      'MONOREPO'
    );
    // The colliding service was skipped — its config is untouched (still the
    // pre-existing standalone owner, no group tag added).
    expect(configStore.get(`${repoName}-backend`)?.group).toBeUndefined();
    // The other service in the same group still proceeds normally.
    expect(configStore.get(`${repoName}-frontend`)?.group).toBe(repoName);
  });

  it('(g) writes route into the generated child drop.yaml when a service declares one (M3)', async () => {
    const repoName = 'ezsign';
    const repoPath = path.join(appsDir, repoName);
    await writeFixtureRepo(repoPath);

    const configStore = new Map<string, any>();
    (platform as any).appConfigService = {
      getConfig: jest.fn((name: string) => configStore.get(name)),
      upsertConfig: jest.fn(async (name: string, updates: any) => {
        const merged = { ...(configStore.get(name) || {}), ...updates, name };
        configStore.set(name, merged);
        return merged;
      }),
    };
    (platform as any).stateManager = {
      registerApp: jest.fn().mockResolvedValue(undefined),
      updateApp: jest.fn().mockResolvedValue(undefined),
    };
    (platform as any).handleBuildApp = jest.fn().mockResolvedValue(undefined);

    const dropConfig = {
      group: repoName,
      services: {
        backend: { path: 'backend', database: 'postgres', route: { path: '/api' } },
        frontend: { path: 'frontend', type: 'static', route: { path: '/' } },
      },
    };

    await (platform as any).expandMonorepo(repoPath, repoName, dropConfig);

    const backendChildPath = path.join(appsDir, `${repoName}-backend`);
    const frontendChildPath = path.join(appsDir, `${repoName}-frontend`);

    // Read back through the real parser (not just yaml.parse) so this also
    // proves the generated child drop.yaml is schema-valid, not just present.
    const backendResult = await parseDropYaml(backendChildPath);
    const frontendResult = await parseDropYaml(frontendChildPath);

    expect(backendResult.success).toBe(true);
    expect(backendResult.config?.route).toEqual({ path: '/api' });
    expect(frontendResult.success).toBe(true);
    expect(frontendResult.config?.route).toEqual({ path: '/' });
  });

  describe('handleConfigureRoute (M3: same-origin routing)', () => {
    it('routes a grouped app with route.path "/api" to the shared group hostname with a Caddy path prefix', async () => {
      const childName = 'ezsign-backend';
      const childPath = path.join(appsDir, childName);
      await fsPromises.mkdir(childPath, { recursive: true });
      await fsPromises.writeFile(
        path.join(childPath, 'drop.yaml'),
        'name: ezsign-backend\nroute:\n  path: /api\n'
      );

      const addRoute = jest.fn().mockResolvedValue(undefined);
      (platform as any).router = { addRoute };
      (platform as any).appConfigService = {
        getConfig: jest.fn().mockReturnValue({ group: 'ezsign' }),
        updateConfig: jest.fn(),
      };
      (platform as any).caddyServer = undefined;

      await (platform as any).handleConfigureRoute(childName, 4001);

      expect(addRoute).toHaveBeenCalledTimes(1);
      expect(addRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          hostname: 'ezsign.localhost',
          pathPrefix: '/api*',
          upstream: 'localhost:4001',
        })
      );
    });

    it('routes the frontend (route.path "/") to the shared group hostname with no path prefix', async () => {
      const childName = 'ezsign-frontend';
      const childPath = path.join(appsDir, childName);
      await fsPromises.mkdir(childPath, { recursive: true });
      await fsPromises.writeFile(
        path.join(childPath, 'drop.yaml'),
        'name: ezsign-frontend\nroute:\n  path: /\n'
      );

      const addRoute = jest.fn().mockResolvedValue(undefined);
      (platform as any).router = { addRoute };
      (platform as any).appConfigService = {
        getConfig: jest.fn().mockReturnValue({ group: 'ezsign' }),
        updateConfig: jest.fn(),
      };
      (platform as any).caddyServer = undefined;

      await (platform as any).handleConfigureRoute(childName, 4002);

      expect(addRoute).toHaveBeenCalledTimes(1);
      const call = addRoute.mock.calls[0][0];
      expect(call.hostname).toBe('ezsign.localhost');
      expect(call.pathPrefix).toBeUndefined();
      expect(call.upstream).toBe('localhost:4002');
    });

    it('routes a standalone app (no group) to its own default hostname with no path prefix', async () => {
      const appName = 'solo-app';
      // Deliberately no drop.yaml on disk for this app — parseDropYaml should
      // resolve gracefully to "not found" and default (non-group) routing
      // should apply unchanged.

      const addRoute = jest.fn().mockResolvedValue(undefined);
      (platform as any).router = { addRoute };
      (platform as any).appConfigService = {
        getConfig: jest.fn().mockReturnValue(undefined),
        updateConfig: jest.fn(),
      };
      (platform as any).caddyServer = undefined;

      await (platform as any).handleConfigureRoute(appName, 4003);

      expect(addRoute).toHaveBeenCalledTimes(1);
      const call = addRoute.mock.calls[0][0];
      expect(call.hostname).toBe('solo-app.localhost');
      expect(call.pathPrefix).toBeUndefined();
      expect(call.upstream).toBe('localhost:4003');
    });
  });
});

describe('drop.yaml build/start overrides', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let appsDir: string;

  beforeAll(() => {
    // buildStartSpec calls the real parseDropYaml (fs-backed) against a
    // drop.yaml written to a real temp dir — override the file-level
    // fs/promises mocks (set up above for the rest of this file's hermetic
    // unit tests) with the real implementation for the duration of this
    // suite only. Mirrors the expandMonorepo suite above.
    const actual = jest.requireActual('fs/promises') as typeof fsPromises;
    (fsPromises.mkdir as jest.Mock).mockImplementation(actual.mkdir);
    (fsPromises.writeFile as jest.Mock).mockImplementation(actual.writeFile);
    (fsPromises.rm as jest.Mock).mockImplementation(actual.rm);
    (fsPromises.stat as jest.Mock).mockImplementation(actual.stat);
    (fsPromises.access as jest.Mock).mockImplementation(actual.access);
    (fsPromises.readFile as jest.Mock).mockImplementation(actual.readFile);
  });

  afterAll(() => {
    // Restore this file's original mock behavior (matches the jest.mock
    // factory at the top of the file) for hygiene.
    (fsPromises.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.writeFile as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.rm as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.stat as jest.Mock).mockImplementation(async () => ({
      isDirectory: () => true,
      isFile: () => false,
    }));
    (fsPromises.access as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.readFile as jest.Mock).mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('package.json')) {
        return JSON.stringify({
          name: 'test-app',
          version: '1.0.0',
          scripts: { start: 'node index.js', build: 'echo build' },
        });
      }
      const realFs = jest.requireActual('fs/promises') as typeof fsPromises;
      return realFs.readFile(filePath as never);
    });
  });

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `drop-test-overrides-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    appsDir = path.join(tempDir, 'apps');
    await fsPromises.mkdir(appsDir, { recursive: true });

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: appsDir,
      logLevel: 'error',
    });
  });

  afterEach(async () => {
    if (platform && platform.isActive()) {
      await platform.stop();
    }
    await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  /** Minimal nodejs DetectionResult, with a configurable suggested start command. */
  function makeNodejsDetection(startCommand: string): DetectionResult {
    return {
      type: 'nodejs',
      framework: null,
      confidence: 1,
      detectedBy: 'test',
      suggestedConfig: { startCommand },
      warnings: [],
      metadata: {},
    };
  }

  describe('buildStartSpec `start:` override', () => {
    it('honors drop.yaml `start:` as an override, stripping the `node ` prefix', async () => {
      const appName = 'override-app';
      const appPath = path.join(appsDir, appName);
      await fsPromises.mkdir(appPath, { recursive: true });
      await fsPromises.writeFile(
        path.join(appPath, 'drop.yaml'),
        yaml.stringify({ name: appName, start: 'node dist/server.js' })
      );

      const detection = makeNodejsDetection('node index.js');
      const dataDir = path.join(tempDir, 'data', 'appdata', appName);

      const spec = await (platform as any).buildStartSpec(
        appName,
        appPath,
        detection,
        4100,
        dataDir,
        {}
      );

      // PM2 branch now mirrors the docker branch's /bin/sh -c + exec shape
      // (M1b) rather than passing the (node-prefix-stripped) command as a
      // bare script — the override still wins, just wrapped/execd.
      expect(spec.script).toBe('/bin/sh');
      expect(spec.interpreter).toBe('none');
      expect(spec.args).toEqual(['-c', 'exec node dist/server.js']);
    });

    it('falls back to suggestedConfig.startCommand when drop.yaml has no `start:` override', async () => {
      const appName = 'no-override-app';
      const appPath = path.join(appsDir, appName);
      await fsPromises.mkdir(appPath, { recursive: true });
      await fsPromises.writeFile(
        path.join(appPath, 'drop.yaml'),
        yaml.stringify({ name: appName })
      );

      const detection = makeNodejsDetection('node index.js');
      const dataDir = path.join(tempDir, 'data', 'appdata', appName);

      const spec = await (platform as any).buildStartSpec(
        appName,
        appPath,
        detection,
        4101,
        dataDir,
        {}
      );

      // Same PM2 /bin/sh -c + exec shape (M1b) applies to the no-override
      // fallback path too.
      expect(spec.script).toBe('/bin/sh');
      expect(spec.interpreter).toBe('none');
      expect(spec.args).toEqual(['-c', 'exec node index.js']);
    });
  });

  // M2 2b: precedence is drop.yaml `start` (top) → Procfile `web:` → detector
  // suggestion → default. This is the mechanism that lets App B's Flask
  // Procfile (`python3 app.py`) win over the python detector's gunicorn
  // default, so a missing gunicorn dependency can never be reached/break the
  // start.
  describe('buildStartSpec Procfile `web:` precedence', () => {
    it('prefers a Procfile `web:` command over the detector suggestedConfig', async () => {
      const appName = 'procfile-app';
      const appPath = path.join(appsDir, appName);
      await fsPromises.mkdir(appPath, { recursive: true });
      await fsPromises.writeFile(
        path.join(appPath, 'drop.yaml'),
        yaml.stringify({ name: appName })
      );
      await fsPromises.writeFile(path.join(appPath, 'Procfile'), 'web: python3 app.py\n');

      const detection = makeNodejsDetection('node index.js');
      const dataDir = path.join(tempDir, 'data', 'appdata', appName);

      const spec = await (platform as any).buildStartSpec(
        appName,
        appPath,
        detection,
        4102,
        dataDir,
        {}
      );

      expect(spec.script).toBe('/bin/sh');
      expect(spec.interpreter).toBe('none');
      expect(spec.args).toEqual(['-c', 'exec python3 app.py']);
    });

    it('still honors drop.yaml `start:` as an override over a Procfile `web:` command', async () => {
      const appName = 'procfile-and-override-app';
      const appPath = path.join(appsDir, appName);
      await fsPromises.mkdir(appPath, { recursive: true });
      await fsPromises.writeFile(
        path.join(appPath, 'drop.yaml'),
        yaml.stringify({ name: appName, start: 'node dist/server.js' })
      );
      await fsPromises.writeFile(path.join(appPath, 'Procfile'), 'web: python3 app.py\n');

      const detection = makeNodejsDetection('node index.js');
      const dataDir = path.join(tempDir, 'data', 'appdata', appName);

      const spec = await (platform as any).buildStartSpec(
        appName,
        appPath,
        detection,
        4103,
        dataDir,
        {}
      );

      expect(spec.script).toBe('/bin/sh');
      expect(spec.interpreter).toBe('none');
      expect(spec.args).toEqual(['-c', 'exec node dist/server.js']);
    });
  });

  describe('handleBuildApp `build:` override', () => {
    /** Minimal real nodejs fixture so the real detector resolves type 'nodejs'. */
    async function writeNodejsFixture(appPath: string): Promise<void> {
      await fsPromises.mkdir(appPath, { recursive: true });
      await fsPromises.writeFile(
        path.join(appPath, 'package.json'),
        JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { start: 'node index.js' } })
      );
      await fsPromises.writeFile(path.join(appPath, 'index.js'), "console.log('ok');\n");
    }

    it('passes the drop.yaml `build:` override through to builder.build as config.buildCommand', async () => {
      const appName = 'build-override-app';
      const appPath = path.join(appsDir, appName);
      await writeNodejsFixture(appPath);
      await fsPromises.writeFile(
        path.join(appPath, 'drop.yaml'),
        yaml.stringify({ name: appName, build: 'npm run build' })
      );

      (platform as any).detector = getDetector();
      (platform as any).stateManager = {
        setAppStatus: jest.fn().mockResolvedValue(undefined),
        updateApp: jest.fn().mockResolvedValue(undefined),
      };
      (platform as any).appConfigService = {
        updateConfig: jest.fn().mockResolvedValue(undefined),
      };
      (platform as any).buildLogService = null;
      const buildSpy = jest.fn().mockResolvedValue({ success: true, duration: 1, errors: [] });
      (platform as any).builder = { build: buildSpy };

      await (platform as any).handleBuildApp(appPath, appName, 'nodejs');

      expect(buildSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          appName,
          config: expect.objectContaining({ buildCommand: 'npm run build' }),
        })
      );
    });
  });
});

// Bug 2 fix (docs/plans/2026-07-13-ezsign-monorepo-deploy-fixes.md): a monorepo
// container (root drop.yaml has a `services:` map) is a group descriptor, not a
// buildable app. The git-deploy path registers it in state, so an app:update for
// the container must not fall through to a plain build/detect - it must be
// skipped (incidental watcher settle) or re-expanded (explicit redeploy).
describe('handleAppUpdate — monorepo container guard (Bug 2 fix)', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let appsDir: string;

  beforeAll(() => {
    // The guard calls the real, fs-backed parseDropYaml against a drop.yaml
    // written to a real temp dir — override the file-level fs/promises mocks
    // (set up above for the rest of this file's hermetic unit tests) with the
    // real implementation for the duration of this suite only. Mirrors the
    // expandMonorepo / drop.yaml build-start-overrides suites above.
    const actual = jest.requireActual('fs/promises') as typeof fsPromises;
    (fsPromises.mkdir as jest.Mock).mockImplementation(actual.mkdir);
    (fsPromises.writeFile as jest.Mock).mockImplementation(actual.writeFile);
    (fsPromises.rm as jest.Mock).mockImplementation(actual.rm);
    (fsPromises.stat as jest.Mock).mockImplementation(actual.stat);
    (fsPromises.access as jest.Mock).mockImplementation(actual.access);
    (fsPromises.readFile as jest.Mock).mockImplementation(actual.readFile);
  });

  afterAll(() => {
    // Restore this file's original mock behavior (matches the jest.mock
    // factory at the top of the file) for hygiene.
    (fsPromises.mkdir as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.writeFile as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.rm as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.stat as jest.Mock).mockImplementation(async () => ({
      isDirectory: () => true,
      isFile: () => false,
    }));
    (fsPromises.access as jest.Mock).mockResolvedValue(undefined);
    (fsPromises.readFile as jest.Mock).mockImplementation(async (filePath: string) => {
      if (filePath.endsWith('package.json')) {
        return JSON.stringify({
          name: 'test-app',
          version: '1.0.0',
          scripts: { start: 'node index.js', build: 'echo build' },
        });
      }
      const realFs = jest.requireActual('fs/promises') as typeof fsPromises;
      return realFs.readFile(filePath as never);
    });
  });

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `drop-test-monorepo-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    appsDir = path.join(tempDir, 'apps');
    await fsPromises.mkdir(appsDir, { recursive: true });

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: appsDir,
      logLevel: 'error',
      caddyfilePath: path.join(tempDir, 'Caddyfile'),
    });
    // handleAppUpdate's own early guard bails out unless these are truthy;
    // stub minimally rather than starting the whole platform (which would
    // spin up a real watcher that could race the fixture file below).
    (platform as any).runtime = {};
    (platform as any).stateManager = { getApp: jest.fn().mockReturnValue(undefined) };
    (platform as any).detector = {};
    (platform as any).builder = {};
  });

  afterEach(async () => {
    if (platform && platform.isActive()) {
      await platform.stop();
    }
    await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  /** Writes a container drop.yaml declaring a `services:` map (monorepo group descriptor). */
  async function writeContainerYaml(appPath: string): Promise<void> {
    await fsPromises.mkdir(appPath, { recursive: true });
    await fsPromises.writeFile(
      path.join(appPath, 'drop.yaml'),
      yaml.stringify({
        name: 'ezsign',
        services: {
          backend: { path: 'backend' },
          frontend: { path: 'frontend', type: 'static' },
        },
      })
    );
  }

  it('skips the container on an incidental watcher settle (bypassCooldown=false), without re-expanding', async () => {
    const appName = 'ezsign';
    const appPath = path.join(appsDir, appName);
    await writeContainerYaml(appPath);

    const expandSpy = jest.spyOn(platform as any, 'expandMonorepo').mockResolvedValue(undefined);
    const debugSpy = jest.spyOn((platform as any).logger, 'debug').mockImplementation(() => undefined);

    await (platform as any).handleAppUpdate(appName, appPath, 'file change', false);

    expect(expandSpy).not.toHaveBeenCalled();
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Skipping update for monorepo container '${appName}'`),
      'UPDATE'
    );
  });

  it('re-expands the container on an explicit redeploy (bypassCooldown=true)', async () => {
    const appName = 'ezsign';
    const appPath = path.join(appsDir, appName);
    await writeContainerYaml(appPath);

    const expandSpy = jest.spyOn(platform as any, 'expandMonorepo').mockResolvedValue(undefined);
    const infoSpy = jest.spyOn((platform as any).logger, 'info').mockImplementation(() => undefined);

    await (platform as any).handleAppUpdate(appName, appPath, 'redeploy', true);

    expect(expandSpy).toHaveBeenCalledWith(
      appPath,
      appName,
      expect.objectContaining({ services: expect.any(Object) })
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Re-expanding monorepo container '${appName}'`),
      'MONOREPO'
    );
  });
});

describe('teardownApp / removeGroup (M4: group lifecycle)', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let appsDir: string;

  beforeEach(() => {
    jest.clearAllMocks();

    tempDir = path.join(
      os.tmpdir(),
      `drop-test-teardown-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    appsDir = path.join(tempDir, 'apps');

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: appsDir,
      logLevel: 'error',
    });
  });

  afterEach(async () => {
    if (platform.isActive()) {
      await platform.stop();
    }
  });

  /** Minimal AppState-shaped object, enough for the fields teardownApp/removeGroup read. */
  function makeAppState(name: string, group?: string) {
    return {
      name,
      type: 'nodejs' as const,
      status: 'running' as const,
      path: path.join(appsDir, name),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      group,
    };
  }

  /** Wires minimal mocks for every manager teardownApp/removeGroup touches. */
  function wireMocks(overrides: {
    stateManager?: Partial<{ removeApp: jest.Mock; getApp: jest.Mock; getAllApps: jest.Mock }>;
    runtime?: Partial<{ stop: jest.Mock; delete: jest.Mock }>;
    router?: Partial<{ removeRoutesForApp: jest.Mock }>;
    dbProvisioner?: Partial<{ backupAndDeleteAppDatabase: jest.Mock }>;
    appConfigService?: Partial<{ getConfig: jest.Mock; deleteConfig: jest.Mock }>;
    secretManager?: Partial<{ deleteAll: jest.Mock }>;
  } = {}) {
    (platform as any).stateManager = {
      removeApp: jest.fn().mockResolvedValue(true),
      getApp: jest.fn().mockReturnValue(undefined),
      getAllApps: jest.fn().mockReturnValue([]),
      ...overrides.stateManager,
    };
    (platform as any).runtime = {
      stop: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      ...overrides.runtime,
    };
    (platform as any).router = {
      removeRoutesForApp: jest.fn().mockResolvedValue(undefined),
      ...overrides.router,
    };
    (platform as any).dbProvisioner = {
      backupAndDeleteAppDatabase: jest.fn().mockResolvedValue({ dropped: true }),
      ...overrides.dbProvisioner,
    };
    (platform as any).appConfigService = {
      getConfig: jest.fn().mockReturnValue(undefined),
      deleteConfig: jest.fn().mockResolvedValue(true),
      ...overrides.appConfigService,
    };
    (platform as any).secretManager = {
      deleteAll: jest.fn().mockResolvedValue(true),
      ...overrides.secretManager,
    };
  }

  describe('teardownApp', () => {
    it('stops+deletes the runtime, removes routes, drops the DB, removes state/secrets/config, and rm-s the folder', async () => {
      wireMocks({
        appConfigService: {
          getConfig: jest.fn().mockReturnValue({ path: path.join(appsDir, 'myapp') }),
          deleteConfig: jest.fn().mockResolvedValue(true),
        },
      });

      await (platform as any).teardownApp('myapp');

      expect((platform as any).runtime.stop).toHaveBeenCalledWith('myapp');
      expect((platform as any).runtime.delete).toHaveBeenCalledWith('myapp');
      expect((platform as any).router.removeRoutesForApp).toHaveBeenCalledWith('myapp');
      expect((platform as any).dbProvisioner.backupAndDeleteAppDatabase).toHaveBeenCalledWith('myapp');
      expect((platform as any).stateManager.removeApp).toHaveBeenCalledWith('myapp');
      expect((platform as any).secretManager.deleteAll).toHaveBeenCalledWith('myapp');
      expect((platform as any).appConfigService.deleteConfig).toHaveBeenCalledWith('myapp');
      expect(fsPromises.rm).toHaveBeenCalledWith(
        path.join(appsDir, 'myapp'),
        { recursive: true, force: true }
      );
    });

    it('skips the DB teardown when keepData is set', async () => {
      wireMocks();

      await (platform as any).teardownApp('myapp', { keepData: true });

      expect((platform as any).dbProvisioner.backupAndDeleteAppDatabase).not.toHaveBeenCalled();
      // The rest of teardown still runs.
      expect((platform as any).stateManager.removeApp).toHaveBeenCalledWith('myapp');
    });

    it('isolates a single failing step so the rest of teardown still runs', async () => {
      wireMocks({
        router: { removeRoutesForApp: jest.fn().mockRejectedValue(new Error('caddy boom')) },
        dbProvisioner: { backupAndDeleteAppDatabase: jest.fn().mockRejectedValue(new Error('db boom')) },
      });

      await expect((platform as any).teardownApp('myapp')).resolves.toBeUndefined();

      // Steps after the two failures still ran.
      expect((platform as any).stateManager.removeApp).toHaveBeenCalledWith('myapp');
      expect((platform as any).secretManager.deleteAll).toHaveBeenCalledWith('myapp');
      expect((platform as any).appConfigService.deleteConfig).toHaveBeenCalledWith('myapp');
      expect(fsPromises.rm).toHaveBeenCalledWith(
        path.join(appsDir, 'myapp'),
        { recursive: true, force: true }
      );
    });
  });

  describe('removeGroup', () => {
    it('tears down every child of the group and removes the group container folder', async () => {
      const children = [
        makeAppState('ezsign-backend', 'ezsign'),
        makeAppState('ezsign-frontend', 'ezsign'),
        makeAppState('standalone-app'), // no group — must be left alone
      ];
      wireMocks({
        stateManager: {
          getAllApps: jest.fn().mockReturnValue(children),
          removeApp: jest.fn().mockResolvedValue(true),
          getApp: jest.fn().mockReturnValue(undefined),
        },
      });

      const result = await platform.removeGroup('ezsign');

      expect(result.removed.slice().sort()).toEqual(['ezsign-backend', 'ezsign-frontend']);
      expect((platform as any).stateManager.removeApp).toHaveBeenCalledWith('ezsign-backend');
      expect((platform as any).stateManager.removeApp).toHaveBeenCalledWith('ezsign-frontend');
      expect((platform as any).stateManager.removeApp).not.toHaveBeenCalledWith('standalone-app');
      expect((platform as any).runtime.stop).toHaveBeenCalledWith('ezsign-backend');
      expect((platform as any).runtime.stop).toHaveBeenCalledWith('ezsign-frontend');
      expect((platform as any).router.removeRoutesForApp).toHaveBeenCalledWith('ezsign-backend');
      expect((platform as any).router.removeRoutesForApp).toHaveBeenCalledWith('ezsign-frontend');

      // The container folder (webapps/ezsign/, the root drop.yaml holder) is removed too.
      expect(fsPromises.rm).toHaveBeenCalledWith(
        path.join(appsDir, 'ezsign'),
        { recursive: true, force: true }
      );
    });

    it('isolates a per-child teardown failure so the remaining children still get removed', async () => {
      // teardownApp itself already isolates every one of ITS OWN steps (see
      // the teardownApp describe block above) — it never rejects on a normal
      // step failure. removeGroup's own try/catch around each `teardownApp`
      // call is a second, independent isolation layer (defense in depth); test
      // it directly by making teardownApp itself reject for one child.
      const children = [makeAppState('child-a', 'g'), makeAppState('child-b', 'g')];
      wireMocks({
        stateManager: {
          getAllApps: jest.fn().mockReturnValue(children),
          removeApp: jest.fn().mockResolvedValue(true),
          getApp: jest.fn().mockReturnValue(undefined),
        },
      });

      const teardownSpy = jest
        .spyOn(platform as any, 'teardownApp')
        .mockRejectedValueOnce(new Error('boom on child-a'))
        .mockResolvedValueOnce(undefined);

      const result = await platform.removeGroup('g');

      expect(teardownSpy).toHaveBeenCalledTimes(2);
      // child-a's teardown rejected — isolated, doesn't abort child-b.
      expect(result.removed).toEqual(['child-b']);
      // The container folder removal is still attempted regardless.
      expect(fsPromises.rm).toHaveBeenCalledWith(
        path.join(appsDir, 'g'),
        { recursive: true, force: true }
      );
    });

    it('returns an empty removed list when no app belongs to the group (still attempts folder cleanup)', async () => {
      wireMocks({
        stateManager: {
          getAllApps: jest.fn().mockReturnValue([]),
          removeApp: jest.fn().mockResolvedValue(true),
          getApp: jest.fn().mockReturnValue(undefined),
        },
      });

      const result = await platform.removeGroup('ghost-group');

      expect(result.removed).toEqual([]);
      expect(fsPromises.rm).toHaveBeenCalledWith(
        path.join(appsDir, 'ghost-group'),
        { recursive: true, force: true }
      );
    });
  });
});

describe('build-drain queue', () => {
  let platform: DropPlatform;
  let tempDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    tempDir = path.join(
      os.tmpdir(),
      `drop-test-build-drain-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      maxConcurrentBuilds: 1,
    });
    // handleBuildApp only needs these two to be truthy to get past its guard
    // clause — no real detect/build work happens once the cap-full branch
    // (or a stubbed drain dispatch) returns early.
    (platform as any).builder = {} as any;
    (platform as any).detector = {} as any;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('queues the app when the concurrent-build cap is full, instead of dropping it', async () => {
    (platform as any).appsInProgress.add('other'); // fills the cap (maxConcurrentBuilds: 1)
    const drainSpy = jest
      .spyOn(platform as any, 'scheduleBuildDrain')
      .mockImplementation(() => undefined);

    await (platform as any).handleBuildApp('/some/path', 'app1', 'static');

    expect((platform as any).pendingBuilds.has('app1')).toBe(true);
    expect((platform as any).pendingBuilds.get('app1')).toEqual({
      appPath: '/some/path',
      appType: 'static',
    });
    // Not started nor errored — just queued.
    expect((platform as any).appsInProgress.has('app1')).toBe(false);
    expect(drainSpy).toHaveBeenCalled();
  });

  it('drainPendingBuilds starts a queued build once a slot frees', async () => {
    (platform as any).pendingBuilds.set('app1', { appPath: '/p', appType: 'static' });
    (platform as any).handleBuildApp = jest.fn().mockResolvedValue(undefined);
    // appsInProgress is empty here — below the cap of 1.

    await (platform as any).drainPendingBuilds();

    expect((platform as any).handleBuildApp).toHaveBeenCalledWith('/p', 'app1', 'static');
    expect((platform as any).pendingBuilds.has('app1')).toBe(false);
  });

  it('drainPendingBuilds does not dispatch while the cap is still full', async () => {
    (platform as any).appsInProgress.add('other'); // cap (1) already full
    (platform as any).pendingBuilds.set('app1', { appPath: '/p', appType: 'static' });
    (platform as any).handleBuildApp = jest.fn().mockResolvedValue(undefined);

    await (platform as any).drainPendingBuilds();

    expect((platform as any).handleBuildApp).not.toHaveBeenCalled();
    // Entry stays queued for the next drain attempt.
    expect((platform as any).pendingBuilds.has('app1')).toBe(true);
  });
});

// M3 3a: handleStartApp must not declare 'running' the instant runtime.start
// resolves — it gates on awaitReadiness first. A failing gate writes 'errored'
// (never 'running') and skips the health prober / crash-loop watch entirely;
// a passing gate proceeds to 'running' and arms both. awaitReadiness itself is
// unit-tested in isolation (platform.readiness.test.ts), so here it's mocked
// directly — this test is about handleStartApp's branching on the gate's
// result, not the gate's own logic. Constructed but never start()-ed, mirroring
// the teardownApp/removeGroup harness above: the constructor does no I/O, so
// runtime/detector/stateManager can be bare mocks without the full
// module-level mock stack the rest of this file sets up for the pipeline.
describe('handleStartApp — readiness gate (M3 3a)', () => {
  let platform: DropPlatform;
  let tempDir: string;

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = path.join(
      os.tmpdir(),
      `drop-test-readiness-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
    });

    (platform as any).detector = {
      detect: jest.fn().mockResolvedValue({
        type: 'nodejs',
        framework: null,
        confidence: 1,
        suggestedConfig: {},
      }),
    };
    (platform as any).runtime = {
      type: 'pm2',
      start: jest.fn().mockResolvedValue({ pid: 4242 }),
    };
    (platform as any).stateManager = {
      setAppStatus: jest.fn().mockResolvedValue(undefined),
      getAllApps: jest.fn().mockReturnValue([]),
      getApp: jest.fn().mockReturnValue(undefined),
    };
    // buildStartSpec's own shaping is covered by the "buildStartSpec ... command
    // shaping" describes above; stub it here so this test is only about the
    // gate branch, with a healthCheckPath set so a passing gate has something
    // real to arm the prober with.
    jest.spyOn(platform as any, 'buildStartSpec').mockResolvedValue({
      name: 'gatedapp',
      script: '/bin/sh',
      args: ['-c', 'exec node index.js'],
      cwd: path.join(tempDir, 'apps', 'gatedapp'),
      port: 4000,
      env: {},
      healthCheckPath: '/health',
    });
  });

  afterEach(async () => {
    if (platform.isActive()) {
      await platform.stop();
    }
  });

  it('errors the app (not running) when the readiness gate fails, and starts neither the health prober nor the crash-loop watch', async () => {
    const sm = (platform as any).stateManager;
    (platform as any).awaitReadiness = jest.fn().mockResolvedValue({ ok: false, reason: 'boom' });
    const proberSpy = jest.spyOn(platform as any, 'startHealthProber').mockImplementation(() => undefined);
    const crashWatchSpy = jest.spyOn(platform as any, 'startCrashLoopWatch').mockImplementation(() => undefined);

    await (platform as any).handleStartApp('gatedapp');

    expect(sm.setAppStatus).toHaveBeenCalledWith(
      'gatedapp',
      'errored',
      expect.objectContaining({ error: expect.stringContaining('boom') })
    );
    expect(sm.setAppStatus).not.toHaveBeenCalledWith('gatedapp', 'running', expect.anything());
    expect(proberSpy).not.toHaveBeenCalled();
    expect(crashWatchSpy).not.toHaveBeenCalled();
  });

  it('reaches running when the readiness gate passes, and arms the health prober + crash-loop watch', async () => {
    const sm = (platform as any).stateManager;
    (platform as any).awaitReadiness = jest.fn().mockResolvedValue({ ok: true });
    const proberSpy = jest.spyOn(platform as any, 'startHealthProber').mockImplementation(() => undefined);
    const crashWatchSpy = jest.spyOn(platform as any, 'startCrashLoopWatch').mockImplementation(() => undefined);

    await (platform as any).handleStartApp('gatedapp');

    expect(sm.setAppStatus).toHaveBeenCalledWith(
      'gatedapp',
      'running',
      expect.objectContaining({ pid: 4242 })
    );
    // The prober is armed with handleStartApp's own allocated port (not
    // buildStartSpec's mocked spec.port — that field isn't the one it reads).
    expect(proberSpy).toHaveBeenCalledWith('gatedapp', expect.any(Number), '/health');
    expect(crashWatchSpy).toHaveBeenCalledWith('gatedapp');
  });
});
