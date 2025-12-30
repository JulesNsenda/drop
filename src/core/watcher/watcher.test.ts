/**
 * Watcher Service Tests
 */

import { Debouncer } from './debouncer';
import { parsePath, isValidHostname, isConfigFile, getAppDirectory } from './path-parser';
import { createWatcherConfig } from './watcher.config';

// Mock chokidar
jest.mock('chokidar', () => ({
  watch: jest.fn().mockReturnValue({
    on: jest.fn().mockReturnThis(),
    close: jest.fn().mockResolvedValue(undefined),
    getWatched: jest.fn().mockReturnValue({}),
  }),
}));

// Mock event bus
jest.mock('../event-bus', () => ({
  eventBus: {
    publish: jest.fn(),
    subscribe: jest.fn().mockReturnValue(() => {}),
  },
}));

// Mock fs/promises
jest.mock('fs/promises', () => ({
  access: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
}));

describe('Debouncer', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should aggregate rapid changes', () => {
    const callback = jest.fn();
    const debouncer = new Debouncer(1000, callback);

    debouncer.add('change', '/path/file.txt', 'file.txt');
    debouncer.add('change', '/path/file.txt', 'file.txt');
    debouncer.add('change', '/path/file.txt', 'file.txt');

    expect(debouncer.getPendingCount()).toBe(1);

    jest.advanceTimersByTime(1000);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith([
      expect.objectContaining({
        path: '/path/file.txt',
        count: 3,
      }),
    ]);
  });

  it('should flush immediately when called', () => {
    const callback = jest.fn();
    const debouncer = new Debouncer(1000, callback);

    debouncer.add('add', '/path/file.txt', 'file.txt');

    debouncer.flush();

    expect(callback).toHaveBeenCalledTimes(1);
    expect(debouncer.getPendingCount()).toBe(0);
  });

  it('should clear pending changes without callback', () => {
    const callback = jest.fn();
    const debouncer = new Debouncer(1000, callback);

    debouncer.add('add', '/path/file.txt', 'file.txt');

    debouncer.clear();

    expect(callback).not.toHaveBeenCalled();
    expect(debouncer.getPendingCount()).toBe(0);
  });

  it('should merge add + change to add', () => {
    const callback = jest.fn();
    const debouncer = new Debouncer(1000, callback);

    debouncer.add('add', '/path/file.txt', 'file.txt');
    debouncer.add('change', '/path/file.txt', 'file.txt');

    jest.advanceTimersByTime(1000);

    expect(callback).toHaveBeenCalledWith([
      expect.objectContaining({
        type: 'add',
      }),
    ]);
  });

  it('should track if path is pending', () => {
    const debouncer = new Debouncer(1000, jest.fn());

    expect(debouncer.isPending('/path/file.txt')).toBe(false);

    debouncer.add('add', '/path/file.txt', 'file.txt');

    expect(debouncer.isPending('/path/file.txt')).toBe(true);
    expect(debouncer.isPending('/other/path.txt')).toBe(false);
  });
});

describe('PathParser', () => {
  const baseDir = '/var/drop/apps';

  describe('parsePath', () => {
    it('should parse simple app name', () => {
      const result = parsePath('/var/drop/apps/myapp/index.js', baseDir);

      expect(result.appName).toBe('myapp');
      expect(result.hostname).toBeNull();
      expect(result.port).toBeNull();
    });

    it('should parse hostname pattern', () => {
      const result = parsePath('/var/drop/apps/api.example.com/index.js', baseDir);

      expect(result.appName).toBe('api.example.com');
      expect(result.hostname).toBe('api.example.com');
      expect(result.port).toBeNull();
    });

    it('should parse hostname with port pattern', () => {
      const result = parsePath('/var/drop/apps/staging.example.com_8080/index.js', baseDir);

      expect(result.appName).toBe('staging.example.com_8080');
      expect(result.hostname).toBe('staging.example.com');
      expect(result.port).toBe(8080);
    });

    it('should handle nested paths', () => {
      const result = parsePath('/var/drop/apps/myapp/src/index.ts', baseDir);

      expect(result.appName).toBe('myapp');
      // Normalize path separators for cross-platform tests
      expect(result.relativePath.replace(/\\/g, '/')).toBe('myapp/src/index.ts');
    });

    it('should handle empty relative path', () => {
      const result = parsePath('/var/drop/apps', baseDir);

      expect(result.appName).toBe('');
      expect(result.relativePath).toBe('');
    });
  });

  describe('isValidHostname', () => {
    it('should validate correct hostnames', () => {
      expect(isValidHostname('example.com')).toBe(true);
      expect(isValidHostname('api.example.com')).toBe(true);
      expect(isValidHostname('my-app.staging.example.io')).toBe(true);
    });

    it('should reject invalid hostnames', () => {
      expect(isValidHostname('myapp')).toBe(false);
      expect(isValidHostname('localhost')).toBe(false);
      expect(isValidHostname('-invalid.com')).toBe(false);
      expect(isValidHostname('invalid-.com')).toBe(false);
      expect(isValidHostname('')).toBe(false);
    });

    it('should reject hostnames that are too long', () => {
      const longLabel = 'a'.repeat(64);
      expect(isValidHostname(`${longLabel}.com`)).toBe(false);
    });
  });

  describe('isConfigFile', () => {
    it('should recognize config files', () => {
      expect(isConfigFile('/app/drop.yaml')).toBe(true);
      expect(isConfigFile('/app/drop.yml')).toBe(true);
      expect(isConfigFile('/app/drop.json')).toBe(true);
      expect(isConfigFile('/app/package.json')).toBe(true);
      expect(isConfigFile('/app/Procfile')).toBe(true);
      expect(isConfigFile('/app/requirements.txt')).toBe(true);
    });

    it('should reject non-config files', () => {
      expect(isConfigFile('/app/index.js')).toBe(false);
      expect(isConfigFile('/app/server.ts')).toBe(false);
      expect(isConfigFile('/app/README.md')).toBe(false);
    });
  });

  describe('getAppDirectory', () => {
    it('should return app directory from file path', () => {
      const result = getAppDirectory('/var/drop/apps/myapp/src/index.ts', baseDir);
      // Normalize path separators for cross-platform tests
      expect(result?.replace(/\\/g, '/')).toBe('/var/drop/apps/myapp');
    });

    it('should return null for base directory', () => {
      expect(getAppDirectory('/var/drop/apps', baseDir)).toBeNull();
    });
  });
});

describe('WatcherConfig', () => {
  it('should create config with defaults', () => {
    const config = createWatcherConfig();

    expect(config.debounceMs).toBe(2000);
    expect(config.maxDepth).toBe(3);
    expect(config.usePolling).toBe(false);
    expect(config.ignorePatterns).toContain('**/node_modules/**');
  });

  it('should merge custom config', () => {
    const config = createWatcherConfig({
      debounceMs: 5000,
      appsDir: '/custom/path',
    });

    expect(config.debounceMs).toBe(5000);
    expect(config.appsDir).toBe('/custom/path');
    expect(config.maxDepth).toBe(3); // Default preserved
  });

  it('should merge ignore patterns', () => {
    const config = createWatcherConfig({
      ignorePatterns: ['**/custom-ignore/**'],
    });

    expect(config.ignorePatterns).toContain('**/node_modules/**');
    expect(config.ignorePatterns).toContain('**/custom-ignore/**');
  });

  it('should include default ignore patterns', () => {
    const config = createWatcherConfig();

    expect(config.ignorePatterns).toContain('**/.git/**');
    expect(config.ignorePatterns).toContain('**/__pycache__/**');
    expect(config.ignorePatterns).toContain('**/venv/**');
  });
});

describe('WatcherService', () => {
  // Import WatcherService after mocks are set up
  const chokidar = require('chokidar');
  const { WatcherService } = require('./watcher');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should create instance with config', () => {
    const service = new WatcherService({
      appsDir: '/test/apps',
      debounceMs: 1000,
    });

    const config = service.getConfig();
    expect(config.appsDir).toBe('/test/apps');
    expect(config.debounceMs).toBe(1000);
  });

  it('should start watching', async () => {
    const service = new WatcherService({
      appsDir: '/test/apps',
    });

    await service.start();

    expect(chokidar.watch).toHaveBeenCalledWith(
      '/test/apps',
      expect.objectContaining({
        persistent: true,
        ignoreInitial: false,
      })
    );

    const stats = service.getStats();
    expect(stats.state).toBe('running');
    expect(stats.startedAt).toBeInstanceOf(Date);
  });

  it('should not start twice', async () => {
    const service = new WatcherService({
      appsDir: '/test/apps',
    });

    await service.start();
    await service.start();

    expect(chokidar.watch).toHaveBeenCalledTimes(1);
  });

  it('should stop watching', async () => {
    const service = new WatcherService({
      appsDir: '/test/apps',
    });

    await service.start();
    await service.stop();

    const stats = service.getStats();
    expect(stats.state).toBe('stopped');
  });

  it('should return empty array when not started', () => {
    const service = new WatcherService({
      appsDir: '/test/apps',
    });

    expect(service.getWatchedPaths()).toEqual([]);
  });

  it('should track known apps', async () => {
    const service = new WatcherService({
      appsDir: '/test/apps',
    });

    await service.start();

    expect(service.getKnownApps()).toEqual([]);
  });
});
