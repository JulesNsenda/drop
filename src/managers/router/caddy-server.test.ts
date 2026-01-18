/**
 * Caddy Server Tests
 */

import * as fs from 'fs/promises';
import {
  CaddyServer,
  getCaddyServer,
  resetCaddyServer,
} from './caddy-server';
import { CaddyServerConfig } from './caddy-server.types';

// Mock fs/promises
jest.mock('fs/promises');
const mockFs = fs as jest.Mocked<typeof fs>;

// Mock child_process
const mockExecSync = jest.fn();
const mockSpawn = jest.fn().mockReturnValue({
  stdout: { on: jest.fn() },
  stderr: { on: jest.fn() },
  on: jest.fn(),
  kill: jest.fn(),
  once: jest.fn((event: string, cb: () => void) => {
    if (event === 'exit') {
      setTimeout(cb, 10);
    }
  }),
});

jest.mock('child_process', () => ({
  execSync: (cmd: string, opts?: unknown) => mockExecSync(cmd, opts),
  spawn: (cmd: string, args?: string[], opts?: unknown) => mockSpawn(cmd, args, opts),
}));

// Mock fetch for admin API
global.fetch = jest.fn();
const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;

describe('CaddyServer', () => {
  const testConfig: CaddyServerConfig = {
    dropRoot: '/tmp/drop-test',
    caddyfilePath: '/tmp/drop-test/Caddyfile',
    port: 8080,
    adminPort: 2019,
    onLog: jest.fn(),
  };

  beforeEach(() => {
    // Reset mocks to clean state
    mockExecSync.mockReset();
    mockSpawn.mockReset();
    mockFetch.mockReset();
    // Reset mockFs - use mockReset on individual methods since it's a module mock
    (mockFs.access as jest.Mock).mockReset();
    (mockFs.mkdir as jest.Mock).mockReset();
    (mockFs.writeFile as jest.Mock).mockReset();
    (mockFs.readFile as jest.Mock).mockReset();

    resetCaddyServer();

    // Set default mock behaviors
    mockFs.access.mockRejectedValue(new Error('ENOENT'));
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.readFile.mockResolvedValue('# Test Caddyfile');
    mockFetch.mockResolvedValue({
      ok: true,
      text: jest.fn().mockResolvedValue(''),
    } as unknown as Response);
  });

  describe('constructor', () => {
    it('should create with provided config', () => {
      const server = new CaddyServer(testConfig);

      expect(server.getPort()).toBe(8080);
      expect(server.getAdminPort()).toBe(2019);
      expect(server.getStatus()).toBe('stopped');
    });

    it('should use default ports when not provided', () => {
      const server = new CaddyServer({
        dropRoot: '/tmp/drop-test',
        caddyfilePath: '/tmp/drop-test/Caddyfile',
      });

      expect(server.getPort()).toBe(80);
      expect(server.getAdminPort()).toBe(2019);
    });
  });

  describe('isInstalled', () => {
    it('should return true when caddy is found', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/caddy'));

      const server = new CaddyServer(testConfig);
      const result = await server.isInstalled();

      expect(result).toBe(true);
    });

    it('should return false when caddy is not found', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      const server = new CaddyServer(testConfig);
      const result = await server.isInstalled();

      expect(result).toBe(false);
    });

    it('should cache the installation check result', async () => {
      mockExecSync.mockReturnValue(Buffer.from('/usr/bin/caddy'));

      const server = new CaddyServer(testConfig);
      await server.isInstalled();
      await server.isInstalled();
      await server.isInstalled();

      // Should only call execSync once due to caching
      expect(mockExecSync).toHaveBeenCalledTimes(1);
    });
  });

  describe('getVersion', () => {
    it('should return version info when caddy is installed', async () => {
      // Use mockImplementation to handle sequential calls
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Buffer.from('/usr/bin/caddy');  // which/where
        if (callCount === 2) return 'v2.7.6 h1:abc123';  // caddy version (returns string with encoding)
        throw new Error('Unexpected call');
      });

      const server = new CaddyServer(testConfig);
      const version = await server.getVersion();

      expect(version).toEqual({
        version: 'v2.7.6',
        major: 2,
        minor: 7,
        patch: 6,
      });
    });

    it('should return null when caddy is not installed', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      const server = new CaddyServer(testConfig);
      const version = await server.getVersion();

      expect(version).toBeNull();
    });

    it('should handle version without v prefix', async () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Buffer.from('/usr/bin/caddy');
        if (callCount === 2) return '2.7.6';
        throw new Error('Unexpected call');
      });

      const server = new CaddyServer(testConfig);
      const version = await server.getVersion();

      expect(version?.major).toBe(2);
      expect(version?.minor).toBe(7);
      expect(version?.patch).toBe(6);
    });
  });

  describe('ensureReady', () => {
    it('should return true when caddy is installed and v2+', async () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Buffer.from('/usr/bin/caddy');
        if (callCount === 2) return 'v2.7.6';
        throw new Error('Unexpected call');
      });

      const server = new CaddyServer(testConfig);
      const onProgress = jest.fn();
      const result = await server.ensureReady(onProgress);

      expect(result).toBe(true);
      expect(onProgress).toHaveBeenCalledWith('Checking Caddy availability...');
      expect(onProgress).toHaveBeenCalledWith('Caddy v2.7.6 found');
    });

    it('should return false when caddy is not installed', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('command not found');
      });

      const server = new CaddyServer(testConfig);
      const onProgress = jest.fn();
      const result = await server.ensureReady(onProgress);

      expect(result).toBe(false);
      expect(server.getStatus()).toBe('unavailable');
      expect(onProgress).toHaveBeenCalledWith('Caddy not found - hostname routing disabled');
    });

    it('should return false for caddy v1', async () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Buffer.from('/usr/bin/caddy');
        if (callCount === 2) return 'v1.0.0';
        throw new Error('Unexpected call');
      });

      const server = new CaddyServer(testConfig);
      const onProgress = jest.fn();
      const result = await server.ensureReady(onProgress);

      expect(result).toBe(false);
      expect(server.getStatus()).toBe('unavailable');
    });

    it('should create initial Caddyfile if it does not exist', async () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Buffer.from('/usr/bin/caddy');
        if (callCount === 2) return 'v2.7.6';
        throw new Error('Unexpected call');
      });
      mockFs.access.mockRejectedValue(new Error('ENOENT'));

      const server = new CaddyServer(testConfig);
      const onProgress = jest.fn();
      await server.ensureReady(onProgress);

      expect(mockFs.writeFile).toHaveBeenCalledWith(
        testConfig.caddyfilePath,
        expect.stringContaining('DROP Platform Caddyfile'),
        'utf-8'
      );
      expect(onProgress).toHaveBeenCalledWith('Creating initial Caddyfile...');
    });

    it('should not create Caddyfile if it already exists', async () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Buffer.from('/usr/bin/caddy');
        if (callCount === 2) return 'v2.7.6';
        throw new Error('Unexpected call');
      });
      mockFs.access.mockResolvedValue(undefined);

      const server = new CaddyServer(testConfig);
      await server.ensureReady();

      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('getAdminUrl', () => {
    it('should return correct admin URL', () => {
      const server = new CaddyServer(testConfig);

      expect(server.getAdminUrl()).toBe('http://localhost:2019');
    });

    it('should respect custom admin port', () => {
      const server = new CaddyServer({
        ...testConfig,
        adminPort: 9000,
      });

      expect(server.getAdminUrl()).toBe('http://localhost:9000');
    });
  });

  describe('isServerRunning', () => {
    it('should return true when admin API responds with OK', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
      } as Response);

      const server = new CaddyServer(testConfig);
      const result = await server.isServerRunning();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:2019/config/',
        expect.objectContaining({ method: 'GET' })
      );
    });

    it('should return false when admin API is not responding', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const server = new CaddyServer(testConfig);
      const result = await server.isServerRunning();

      expect(result).toBe(false);
    });

    it('should return false when admin API returns non-OK', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
      } as Response);

      const server = new CaddyServer(testConfig);
      const result = await server.isServerRunning();

      expect(result).toBe(false);
    });
  });

  describe('reload', () => {
    it('should POST Caddyfile to admin API', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
      } as Response);
      mockFs.readFile.mockResolvedValue('# Test config');

      const server = new CaddyServer(testConfig);
      // Simulate running state
      (server as unknown as { status: string }).status = 'running';

      const result = await server.reload();

      expect(result).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:2019/load',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'text/caddyfile' },
          body: '# Test config',
        })
      );
    });

    it('should return false when not running', async () => {
      const server = new CaddyServer(testConfig);

      const result = await server.reload();

      expect(result).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should return false when reload fails', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        text: jest.fn().mockResolvedValue('Invalid config'),
      } as unknown as Response);
      mockFs.readFile.mockResolvedValue('# Bad config');

      const server = new CaddyServer(testConfig);
      (server as unknown as { status: string }).status = 'running';

      const result = await server.reload();

      expect(result).toBe(false);
    });

    it('should handle network errors gracefully', async () => {
      mockFetch.mockRejectedValue(new Error('Network error'));
      mockFs.readFile.mockResolvedValue('# Test config');

      const server = new CaddyServer(testConfig);
      (server as unknown as { status: string }).status = 'running';

      const result = await server.reload();

      expect(result).toBe(false);
    });
  });

  describe('start', () => {
    it('should skip start if already running', async () => {
      const server = new CaddyServer(testConfig);
      (server as unknown as { status: string }).status = 'running';

      await server.start();

      // Should not attempt to start
      expect(mockExecSync).not.toHaveBeenCalled();
    });

    it('should skip start if unavailable', async () => {
      const server = new CaddyServer(testConfig);
      (server as unknown as { status: string }).status = 'unavailable';

      await server.start();

      // Should not attempt to start
      expect(mockExecSync).not.toHaveBeenCalled();
      expect(testConfig.onLog).toHaveBeenCalledWith('Caddy not available - skipping start');
    });
  });

  describe('stop', () => {
    it('should skip stop if already stopped', async () => {
      const server = new CaddyServer(testConfig);

      await server.stop();

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should skip stop if unavailable', async () => {
      const server = new CaddyServer(testConfig);
      (server as unknown as { status: string }).status = 'unavailable';

      await server.stop();

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('singleton functions', () => {
    beforeEach(() => {
      resetCaddyServer();
    });

    it('getCaddyServer should return singleton', () => {
      const server1 = getCaddyServer(testConfig);
      const server2 = getCaddyServer();

      expect(server1).toBe(server2);
    });

    it('getCaddyServer should throw if no config on first call', () => {
      expect(() => getCaddyServer()).toThrow('CaddyServer config required on first call');
    });

    it('resetCaddyServer should clear singleton', () => {
      const server1 = getCaddyServer(testConfig);
      resetCaddyServer();
      const server2 = getCaddyServer(testConfig);

      expect(server1).not.toBe(server2);
    });
  });
});

describe('CaddyServer localhost handling', () => {
  const localhostConfig: CaddyServerConfig = {
    dropRoot: '/tmp/drop-test',
    caddyfilePath: '/tmp/drop-test/Caddyfile',
  };

  beforeEach(() => {
    mockExecSync.mockReset();
    mockSpawn.mockReset();
    mockFetch.mockReset();
    (mockFs.access as jest.Mock).mockReset();
    (mockFs.mkdir as jest.Mock).mockReset();
    (mockFs.writeFile as jest.Mock).mockReset();
    resetCaddyServer();
    mockFs.access.mockRejectedValue(new Error('ENOENT'));
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
  });

  it('should create Caddyfile with auto_https off', async () => {
    let callCount = 0;
    mockExecSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Buffer.from('/usr/bin/caddy');
      if (callCount === 2) return 'v2.7.6';
      throw new Error('Unexpected call');
    });

    const server = new CaddyServer(localhostConfig);
    await server.ensureReady();

    expect(mockFs.writeFile).toHaveBeenCalledWith(
      localhostConfig.caddyfilePath,
      expect.stringContaining('auto_https off'),
      'utf-8'
    );
  });

  it('should create Caddyfile with admin API enabled', async () => {
    let callCount = 0;
    mockExecSync.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Buffer.from('/usr/bin/caddy');
      if (callCount === 2) return 'v2.7.6';
      throw new Error('Unexpected call');
    });

    const server = new CaddyServer({
      ...localhostConfig,
      adminPort: 2019,
    });
    await server.ensureReady();

    expect(mockFs.writeFile).toHaveBeenCalledWith(
      localhostConfig.caddyfilePath,
      expect.stringContaining('admin localhost:2019'),
      'utf-8'
    );
  });
});
