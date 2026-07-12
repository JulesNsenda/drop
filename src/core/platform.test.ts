/**
 * Platform Integration Tests
 *
 * Tests the full deployment pipeline: watcher → detector → builder → process → router
 */

import * as path from 'path';
import * as os from 'os';
import * as fsPromises from 'fs/promises';
import { DropPlatform, createPlatform } from './platform';
import { eventBus } from './event-bus';
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
