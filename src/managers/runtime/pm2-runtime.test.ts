/**
 * Pm2Runtime adapter tests
 *
 * Verifies the PM2 → DROP translation layer: status mapping, start-spec
 * conversion, and that native PM2 strings never leak through the seam.
 */

import { Pm2Runtime } from './pm2-runtime';
import { getAppRuntime, resetAppRuntime } from './index';
import { ProcessManager } from '../process';
import { ProcessStatus } from '../process/process-manager.types';

function pm2Status(overrides: Partial<ProcessStatus> = {}): ProcessStatus {
  return {
    name: 'test-app',
    status: 'online',
    pid: 1234,
    pmId: 0,
    port: 3001,
    instances: 1,
    memory: 1024,
    cpu: 1.5,
    uptime: 1000,
    restarts: 2,
    execMode: 'fork',
    watching: false,
    createdAt: new Date('2026-01-01'),
    restartedAt: null,
    ...overrides,
  };
}

function mockProcessManager(): jest.Mocked<ProcessManager> {
  return {
    start: jest.fn(),
    stop: jest.fn(),
    restart: jest.fn(),
    delete: jest.fn(),
    getStatus: jest.fn(),
    getAllStatus: jest.fn(),
    getLogs: jest.fn(),
    streamLogs: jest.fn(),
    getLogPaths: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as jest.Mocked<ProcessManager>;
}

describe('Pm2Runtime', () => {
  let pm: jest.Mocked<ProcessManager>;
  let runtime: Pm2Runtime;

  beforeEach(() => {
    pm = mockProcessManager();
    runtime = new Pm2Runtime(pm);
  });

  it('reports its type as pm2', () => {
    expect(runtime.type).toBe('pm2');
  });

  describe('status mapping', () => {
    const cases: Array<[ProcessStatus['status'], string]> = [
      ['online', 'running'],
      ['launching', 'starting'],
      ['stopping', 'stopping'],
      ['stopped', 'stopped'],
      ['errored', 'errored'],
      ['one-launch-status', 'unknown'],
    ];

    it.each(cases)('maps PM2 %s to %s', async (pm2State, dropState) => {
      pm.getStatus.mockResolvedValue(pm2Status({ status: pm2State }));
      const info = await runtime.getStatus('test-app');
      expect(info?.status).toBe(dropState);
    });

    it('maps unrecognized native statuses to unknown', async () => {
      pm.getStatus.mockResolvedValue(
        pm2Status({ status: 'some-future-pm2-state' as ProcessStatus['status'] })
      );
      const info = await runtime.getStatus('test-app');
      expect(info?.status).toBe('unknown');
    });

    it('never exposes PM2 status strings', async () => {
      pm.getAllStatus.mockResolvedValue([
        pm2Status({ status: 'online' }),
        pm2Status({ name: 'other', status: 'launching' }),
      ]);
      const all = await runtime.getAllStatus();
      for (const info of all) {
        expect(['running', 'starting', 'stopping', 'stopped', 'errored', 'unknown']).toContain(
          info.status
        );
      }
    });
  });

  describe('process info shape', () => {
    it('carries the public contract fields through', async () => {
      pm.getStatus.mockResolvedValue(pm2Status());
      const info = await runtime.getStatus('test-app');
      expect(info).toEqual({
        name: 'test-app',
        status: 'running',
        runtime: 'pm2',
        pid: 1234,
        port: 3001,
        memory: 1024,
        cpu: 1.5,
        uptime: 1000,
        restarts: 2,
        createdAt: new Date('2026-01-01'),
        restartedAt: null,
      });
    });

    it('returns null when the process is unknown', async () => {
      pm.getStatus.mockResolvedValue(null);
      expect(await runtime.getStatus('ghost')).toBeNull();
    });
  });

  describe('start spec conversion', () => {
    it('maps the runtime-agnostic spec onto ProcessConfig', async () => {
      pm.start.mockResolvedValue(pm2Status());
      await runtime.start({
        name: 'test-app',
        script: 'index.js',
        cwd: '/apps/test-app',
        interpreter: 'node',
        args: ['--flag'],
        port: 3001,
        env: { FOO: 'bar' },
        autorestart: true,
        killTimeout: 5000,
        outFile: '/logs/out.log',
        errorFile: '/logs/err.log',
        limits: { memory: '256M', cpus: 0.5 },
      });

      expect(pm.start).toHaveBeenCalledWith({
        name: 'test-app',
        script: 'index.js',
        cwd: '/apps/test-app',
        interpreter: 'node',
        args: ['--flag'],
        port: 3001,
        env: { FOO: 'bar' },
        autorestart: true,
        killTimeout: 5000,
        outFile: '/logs/out.log',
        errorFile: '/logs/err.log',
        // memory degrades to PM2's restart-on-exceed; cpus has no PM2 equivalent
        maxMemoryRestart: '256M',
      });
    });
  });

  describe('delegation', () => {
    it('delegates stop/delete/logs/disconnect to the ProcessManager', async () => {
      pm.getLogs.mockResolvedValue('log line');
      pm.getLogPaths.mockResolvedValue({ out: '/o', err: '/e' });

      await runtime.stop('a');
      await runtime.delete('a');
      await runtime.getLogs('a', 10);
      await runtime.getLogPaths('a');
      runtime.disconnect();

      expect(pm.stop).toHaveBeenCalledWith('a');
      expect(pm.delete).toHaveBeenCalledWith('a');
      expect(pm.getLogs).toHaveBeenCalledWith('a', 10);
      expect(pm.getLogPaths).toHaveBeenCalledWith('a');
      expect(pm.disconnect).toHaveBeenCalled();
    });
  });
});

describe('getAppRuntime singleton', () => {
  afterEach(() => {
    resetAppRuntime();
  });

  it('returns the same instance across calls', () => {
    const a = getAppRuntime();
    const b = getAppRuntime();
    expect(a).toBe(b);
    expect(a.type).toBe('pm2');
  });

  it('resets cleanly', () => {
    const a = getAppRuntime();
    resetAppRuntime();
    const b = getAppRuntime();
    expect(a).not.toBe(b);
  });

  it('rejects the docker runtime until PRD-029 lands', () => {
    expect(() => getAppRuntime('docker')).toThrow(/not available/);
  });

  it('refuses a silent runtime switch', () => {
    getAppRuntime('pm2');
    expect(() => getAppRuntime('docker')).toThrow(/already initialized/);
  });
});
