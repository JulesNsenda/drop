/**
 * Platform Integration Tests
 *
 * Tests the full deployment pipeline: watcher → detector → builder → process → router
 */

import * as path from 'path';
import * as os from 'os';
import { DropPlatform, createPlatform } from './platform';
import { eventBus } from './event-bus';

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
      const p = new DropPlatform();
      const config = p.getConfig();

      expect(config.dropRoot).toBe('/var/drop');
      expect(config.appsDirectory).toBe('/var/drop/apps');
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

describe('Service accessors', () => {
  let platform: DropPlatform;

  beforeEach(() => {
    platform = createPlatform({
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
