/**
 * Hot reload must not hand the platform's environment to tenant code.
 *
 * The update path stops an app and starts it again with no delete between. PM2
 * then restarts the EXISTING entry through `_startJson` with `updateEnv`, which
 * seeds the app from the platform process's own environment and does not apply
 * `filter_env`. This runs the real Pm2Runtime and ProcessManager over a faked
 * PM2 client holding a stopped entry, and resolves the environment the way PM2's
 * restart path does: platform env first, the options' env on top.
 */
const mockStart = jest.fn().mockResolvedValue([{ name: 'tenant', pm_id: 1, pid: 1 }]);
const mockDeleteProcess = jest.fn().mockResolvedValue(undefined);
const mockGetProcessStatus = jest.fn();

jest.mock('../process/pm2-client', () => ({
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn(),
  isConnectedToPM2: jest.fn().mockReturnValue(true),
  start: mockStart,
  stop: jest.fn().mockResolvedValue(undefined),
  restart: jest.fn(),
  reload: jest.fn(),
  deleteProcess: mockDeleteProcess,
  list: jest.fn().mockResolvedValue([]),
  describe: jest.fn().mockResolvedValue([]),
  flush: jest.fn(),
  getProcessStatus: mockGetProcessStatus,
  toProcessStatus: jest.fn(),
}));
jest.mock('../../core/event-bus', () => ({
  eventBus: { publish: jest.fn(), subscribe: jest.fn().mockReturnValue(() => {}) },
}));

import { Pm2Runtime } from './pm2-runtime';
import { ProcessManager } from '../process/process-manager';
import { isReservedEnvName } from '../../utils/reserved-env';

const status = (s: string) => ({
  name: 'tenant', status: s, pid: 1, pmId: 1, port: null, instances: 1, memory: 0, cpu: 0,
  uptime: 0, restarts: 0, execMode: 'fork', watching: false, createdAt: null, restartedAt: null,
});

describe('PM2 start over an existing stopped entry (hot reload)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DROP_S3_ADMIN_ACCESS_KEY_ID = 'AKIAADMIN';
    process.env.DROP_S3_ADMIN_SECRET_ACCESS_KEY = 'admin-secret';
    process.env.AWS_PROFILE = 'host-profile';
    process.env.AWS_REGION = 'eu-west-1';
    process.env.CF_API_TOKEN = 'cloudflare';
    // The entry hot reload just stopped, then the status after the start.
    mockGetProcessStatus.mockResolvedValueOnce(status('stopped')).mockResolvedValue(status('online'));
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  const spec = {
    name: 'tenant',
    script: 'index.js',
    cwd: '/apps/tenant',
    port: 3001,
    env: { DROP_DATA_DIR: '/data/tenant', AWS_REGION: 'eu-central-1', MY_SECRET: 's' },
  };

  it('deletes the stopped entry first, so PM2 takes the fresh-start path that filters', async () => {
    await new Pm2Runtime(new ProcessManager()).start(spec);

    expect(mockDeleteProcess).toHaveBeenCalledWith('tenant');
    expect(mockDeleteProcess.mock.invocationCallOrder[0]).toBeLessThan(mockStart.mock.invocationCallOrder[0]);
    expect(mockStart.mock.calls[0][0].filter_env).toEqual(['DROP_', 'AWS_', 'CF_']);
  });

  it('and even on the restart path, where no filtering happens, no reserved name holds a platform value', async () => {
    await new Pm2Runtime(new ProcessManager()).start(spec);
    const options = mockStart.mock.calls[0][0] as { env: Record<string, string> };

    // PM2's restart path: the platform's own environment, then the options' on top.
    const seen = { ...process.env, ...options.env };

    for (const [name, value] of Object.entries(seen)) {
      if (!isReservedEnvName(name)) continue;
      // Either the app was explicitly given it, or it is empty. Never the platform's.
      expect([spec.env[name as keyof typeof spec.env], '']).toContain(value);
    }
    expect(seen.DROP_S3_ADMIN_SECRET_ACCESS_KEY).toBe('');
    expect(seen.AWS_PROFILE).toBe('');
    expect(seen.CF_API_TOKEN).toBe('');
    // What the app was given survives.
    expect(seen.DROP_DATA_DIR).toBe('/data/tenant');
    expect(seen.AWS_REGION).toBe('eu-central-1');
    expect(seen.MY_SECRET).toBe('s');
  });
});
