/**
 * Process Manager Tests
 */

// Create mock functions first
const mockStart = jest.fn().mockResolvedValue([{ name: 'test-app', pm_id: 1, pid: 12345 }]);
const mockStop = jest.fn().mockResolvedValue(undefined);
const mockRestart = jest.fn().mockResolvedValue(undefined);
const mockReload = jest.fn().mockResolvedValue(undefined);
const mockDeleteProcess = jest.fn().mockResolvedValue(undefined);
const mockList = jest.fn().mockResolvedValue([]);
const mockDescribe = jest.fn().mockResolvedValue([]);
const mockFlush = jest.fn().mockResolvedValue(undefined);
const mockGetProcessStatus = jest.fn();
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockDisconnect = jest.fn();
const mockToProcessStatus = jest.fn().mockImplementation((desc) => ({
  name: desc.name || 'unknown',
  status: desc.pm2_env?.status || 'stopped',
  pid: desc.pid || null,
  pmId: desc.pm_id ?? null,
  instances: desc.pm2_env?.instances || 1,
  memory: desc.monit?.memory || 0,
  cpu: desc.monit?.cpu || 0,
  uptime: 10000,
  restarts: desc.pm2_env?.restart_time || 0,
  execMode: desc.pm2_env?.exec_mode === 'cluster_mode' ? 'cluster' : 'fork',
  watching: desc.pm2_env?.watch || false,
  createdAt: null,
  restartedAt: null,
}));

// Mock pm2Client module
jest.mock('./pm2-client', () => ({
  connect: mockConnect,
  disconnect: mockDisconnect,
  isConnectedToPM2: jest.fn().mockReturnValue(true),
  start: mockStart,
  stop: mockStop,
  restart: mockRestart,
  reload: mockReload,
  deleteProcess: mockDeleteProcess,
  list: mockList,
  describe: mockDescribe,
  flush: mockFlush,
  getProcessStatus: mockGetProcessStatus,
  toProcessStatus: mockToProcessStatus,
}));

// Mock event bus
jest.mock('../../core/event-bus', () => ({
  eventBus: {
    publish: jest.fn(),
    subscribe: jest.fn().mockReturnValue(() => {}),
  },
}));

import {
  ProcessManager,
  createProcessManager,
  getProcessManager,
  resetProcessManager,
} from './process-manager';
import { ProcessConfig, ProcessStatus } from './process-manager.types';
import { eventBus } from '../../core/event-bus';

// Helper to create a ProcessStatus
function createStatus(overrides: Partial<ProcessStatus> = {}): ProcessStatus {
  return {
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
    ...overrides,
  };
}

describe('ProcessManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetProcessManager();
    // Default mock: process doesn't exist initially
    mockGetProcessStatus.mockResolvedValue(null);
  });

  describe('constructor', () => {
    it('should create with default config', () => {
      const manager = new ProcessManager();
      const config = manager.getConfig();

      expect(config.defaultKillTimeout).toBe(5000);
      expect(config.defaultMaxRestarts).toBe(10);
      expect(config.defaultRestartDelay).toBe(1000);
    });

    it('should accept custom config', () => {
      const manager = new ProcessManager({
        defaultKillTimeout: 10000,
        defaultMaxRestarts: 5,
      });
      const config = manager.getConfig();

      expect(config.defaultKillTimeout).toBe(10000);
      expect(config.defaultMaxRestarts).toBe(5);
    });
  });

  describe('start', () => {
    it('should start a process when not running', async () => {
      // First call: process doesn't exist, subsequent: process is online
      mockGetProcessStatus
        .mockResolvedValueOnce(null)
        .mockResolvedValue(createStatus());

      const manager = new ProcessManager();
      const config: ProcessConfig = {
        name: 'test-app',
        script: 'index.js',
        cwd: '/app',
      };

      const status = await manager.start(config);

      expect(status.name).toBe('test-app');
      expect(status.status).toBe('online');
      expect(mockStart).toHaveBeenCalled();
    });

    it('should emit starting and started events', async () => {
      mockGetProcessStatus
        .mockResolvedValueOnce(null)
        .mockResolvedValue(createStatus());

      const manager = new ProcessManager();
      const config: ProcessConfig = {
        name: 'test-app',
        script: 'index.js',
        cwd: '/app',
        port: 3000,
      };

      await manager.start(config);

      expect(eventBus.publish).toHaveBeenCalledWith('app:starting', {
        appId: 'test-app',
        name: 'test-app',
      });
      expect(eventBus.publish).toHaveBeenCalledWith('app:started', expect.objectContaining({
        appId: 'test-app',
        name: 'test-app',
        port: 3000,
      }));
    });

    it('should configure cluster mode', async () => {
      mockGetProcessStatus
        .mockResolvedValueOnce(null)
        .mockResolvedValue(createStatus({ execMode: 'cluster', instances: 4 }));

      const manager = new ProcessManager();
      const config: ProcessConfig = {
        name: 'test-app',
        script: 'index.js',
        cwd: '/app',
        instances: 4,
        execMode: 'cluster',
      };

      await manager.start(config);

      expect(mockStart).toHaveBeenCalledWith(
        expect.objectContaining({
          instances: 4,
          exec_mode: 'cluster',
        })
      );
    });

    it('should return existing status if already online', async () => {
      mockGetProcessStatus.mockResolvedValue(createStatus());

      const manager = new ProcessManager();
      const config: ProcessConfig = {
        name: 'test-app',
        script: 'index.js',
        cwd: '/app',
      };

      const status = await manager.start(config);

      expect(status.status).toBe('online');
      expect(mockStart).not.toHaveBeenCalled();
    });
  });

  describe('stop', () => {
    it('should stop a process', async () => {
      mockGetProcessStatus
        .mockResolvedValueOnce(createStatus())
        .mockResolvedValue(createStatus({ status: 'stopped', pid: null }));

      const manager = new ProcessManager();

      await manager.stop('test-app');

      expect(mockStop).toHaveBeenCalledWith('test-app');
    });

    it('should emit stopping and stopped events', async () => {
      mockGetProcessStatus
        .mockResolvedValueOnce(createStatus())
        .mockResolvedValue(createStatus({ status: 'stopped', pid: null }));

      const manager = new ProcessManager();

      await manager.stop('test-app');

      expect(eventBus.publish).toHaveBeenCalledWith('app:stopping', {
        appId: 'test-app',
        name: 'test-app',
      });
      expect(eventBus.publish).toHaveBeenCalledWith('app:stopped', {
        appId: 'test-app',
        name: 'test-app',
      });
    });

    it('should do nothing if process does not exist', async () => {
      mockGetProcessStatus.mockResolvedValue(null);

      const manager = new ProcessManager();

      await manager.stop('non-existent');

      expect(mockStop).not.toHaveBeenCalled();
    });
  });

  describe('restart', () => {
    it('should restart a process', async () => {
      mockGetProcessStatus.mockResolvedValue(createStatus());

      const manager = new ProcessManager();

      const status = await manager.restart('test-app');

      expect(mockRestart).toHaveBeenCalledWith('test-app');
      expect(status.name).toBe('test-app');
    });

    it('should throw if process not found', async () => {
      mockGetProcessStatus.mockResolvedValueOnce(null);

      const manager = new ProcessManager();

      await expect(manager.restart('non-existent')).rejects.toThrow('Process not found');
    });
  });

  describe('reload', () => {
    it('should reload a process', async () => {
      mockGetProcessStatus.mockResolvedValue(createStatus());

      const manager = new ProcessManager();

      const status = await manager.reload('test-app');

      expect(mockReload).toHaveBeenCalledWith('test-app');
      expect(status.name).toBe('test-app');
    });

    it('should throw if process not found', async () => {
      mockGetProcessStatus.mockResolvedValueOnce(null);

      const manager = new ProcessManager();

      await expect(manager.reload('non-existent')).rejects.toThrow('Process not found');
    });
  });

  describe('getStatus', () => {
    it('should return process status', async () => {
      mockGetProcessStatus.mockResolvedValue(createStatus());

      const manager = new ProcessManager();

      const status = await manager.getStatus('test-app');

      expect(status).not.toBeNull();
      expect(status?.name).toBe('test-app');
      expect(status?.status).toBe('online');
    });

    it('should return null for non-existent process', async () => {
      mockGetProcessStatus.mockResolvedValueOnce(null);

      const manager = new ProcessManager();

      const status = await manager.getStatus('non-existent');

      expect(status).toBeNull();
    });
  });

  describe('getAllStatus', () => {
    it('should return all process statuses', async () => {
      mockList.mockResolvedValueOnce([
        { name: 'app1', pm_id: 1, pid: 111, monit: {}, pm2_env: { status: 'online' } },
        { name: 'app2', pm_id: 2, pid: 222, monit: {}, pm2_env: { status: 'stopped' } },
      ]);

      const manager = new ProcessManager();

      const statuses = await manager.getAllStatus();

      expect(statuses).toHaveLength(2);
      expect(mockToProcessStatus).toHaveBeenCalledTimes(2);
    });
  });

  describe('delete', () => {
    it('should delete a process', async () => {
      const manager = new ProcessManager();

      await manager.delete('test-app');

      expect(mockDeleteProcess).toHaveBeenCalledWith('test-app');
    });
  });

  describe('flushLogs', () => {
    it('should flush logs for a specific process', async () => {
      const manager = new ProcessManager();

      await manager.flushLogs('test-app');

      expect(mockFlush).toHaveBeenCalledWith('test-app');
    });

    it('should flush all logs when no name provided', async () => {
      const manager = new ProcessManager();

      await manager.flushLogs();

      expect(mockFlush).toHaveBeenCalledWith(undefined);
    });
  });

  describe('factory functions', () => {
    it('createProcessManager should create new instance', () => {
      const manager1 = createProcessManager();
      const manager2 = createProcessManager();

      expect(manager1).not.toBe(manager2);
    });

    it('getProcessManager should return singleton', () => {
      const manager1 = getProcessManager();
      const manager2 = getProcessManager();

      expect(manager1).toBe(manager2);
    });

    it('resetProcessManager should clear singleton', () => {
      const manager1 = getProcessManager();
      resetProcessManager();
      const manager2 = getProcessManager();

      expect(manager1).not.toBe(manager2);
    });
  });
});

describe('ProcessConfig conversion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetProcessManager();
    mockGetProcessStatus
      .mockResolvedValueOnce(null)
      .mockResolvedValue(createStatus());
  });

  it('should convert basic config to PM2 options', async () => {
    const manager = new ProcessManager();
    const config: ProcessConfig = {
      name: 'test-app',
      script: 'server.js',
      cwd: '/app',
    };

    await manager.start(config);

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'test-app',
        script: 'server.js',
        cwd: '/app',
        kill_timeout: 5000,
        max_restarts: 10,
        restart_delay: 1000,
      })
    );
  });

  it('should convert port to environment variable', async () => {
    const manager = new ProcessManager();
    const config: ProcessConfig = {
      name: 'test-app',
      script: 'index.js',
      cwd: '/app',
      port: 8080,
    };

    await manager.start(config);

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          PORT: '8080',
        }),
      })
    );
  });

  it('should convert all config options', async () => {
    const manager = new ProcessManager();
    const config: ProcessConfig = {
      name: 'full-app',
      script: 'index.js',
      cwd: '/app',
      instances: 4,
      execMode: 'cluster',
      maxMemoryRestart: '512M',
      env: { NODE_ENV: 'production' },
      autorestart: true,
      killTimeout: 10000,
      nodeArgs: ['--max-old-space-size=4096'],
      args: ['--port', '3000'],
      interpreter: 'node',
      watch: true,
      ignoreWatch: ['node_modules'],
      maxRestarts: 5,
      restartDelay: 2000,
      port: 3000,
    };

    await manager.start(config);

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'full-app',
        script: 'index.js',
        cwd: '/app',
        instances: 4,
        exec_mode: 'cluster',
        max_memory_restart: '512M',
        autorestart: true,
        kill_timeout: 10000,
        node_args: ['--max-old-space-size=4096'],
        args: ['--port', '3000'],
        interpreter: 'node',
        watch: true,
        ignore_watch: ['node_modules'],
        max_restarts: 5,
        restart_delay: 2000,
      })
    );
  });
});
