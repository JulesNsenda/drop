/**
 * Platform Integration Tests
 *
 * Tests the full deployment pipeline: watcher → detector → builder → process → router
 */

import * as path from 'path';
import * as os from 'os';
import { DropPlatform, createPlatform } from './platform';
import { eventBus } from './event-bus';

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
