/**
 * DTO contract tests for GET /api/v1/apps and GET /api/v1/apps/:name.
 *
 * Pins the response shape for the runtime-supplied fields (pid, memory, cpu,
 * restarts) so a future runtime swap can't silently leak PM2 internals or drop
 * fields non-admin callers expect.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, authenticateUser } from '../middleware/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import * as runtimeModule from '../../managers/runtime';
import type { AppRuntime, AppProcessInfo } from '../../managers/runtime';

const KNOWN_PROCESS: AppProcessInfo = {
  name: 'test-app',
  status: 'running',
  runtime: 'pm2',
  pid: 12345,
  port: 4000,
  memory: 104857600, // 100 MiB in bytes
  cpu: 1.5,
  uptime: 60000,
  restarts: 2,
  createdAt: new Date('2024-01-01T00:00:00Z'),
  restartedAt: null,
};

function makeMockRuntime(overrides?: Partial<AppRuntime>): AppRuntime {
  return {
    type: 'pm2',
    start: jest.fn(),
    stop: jest.fn(),
    restart: jest.fn(),
    delete: jest.fn(),
    getStatus: jest.fn().mockResolvedValue(KNOWN_PROCESS),
    getAllStatus: jest.fn().mockResolvedValue([KNOWN_PROCESS]),
    getLogs: jest.fn().mockResolvedValue(''),
    streamLogs: jest.fn().mockResolvedValue(() => undefined),
    getLogPaths: jest.fn().mockResolvedValue({}),
    disconnect: jest.fn(),
    ...overrides,
  } as AppRuntime;
}

describe('GET /api/v1/apps/:name DTO contract', () => {
  let tempDir: string;
  let server: ApiServer;
  let hono: ReturnType<ApiServer['getApp']>;
  let adminToken: string;
  let userId: string;
  let userToken: string;
  let mockRuntime: AppRuntime;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-contract-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetStateManager();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    mockRuntime = makeMockRuntime();
    jest.spyOn(runtimeModule, 'getAppRuntime').mockReturnValue(mockRuntime);

    server = new ApiServer({
      port: 3097,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    hono = server.getApp();

    await createUser('admin-user', 'password123', 'admin');
    const user = await createUser('regular-user', 'password123', 'user');
    userId = user.id;
    adminToken = (await authenticateUser('admin-user', 'password123'))!;
    userToken = (await authenticateUser('regular-user', 'password123'))!;

    const sm = getStateManager();
    await sm.registerApp('test-app', path.join(tempDir, 'test-app'));
    await sm.setAppStatus('test-app', 'running');
    await sm.updateApp('test-app', { userId });
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('status is the DROP enum value, not a PM2 native string', async () => {
    const res = await hono.request('/api/v1/apps/test-app', { headers: authHeader(adminToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.status).toBe('running');
    expect(body.data.status).not.toBe('online');
  });

  it('exposes pid, memory, cpu, restarts to admin', async () => {
    const res = await hono.request('/api/v1/apps/test-app', { headers: authHeader(adminToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.pid).toBe(12345);
    expect(body.data.memory).toBe(104857600);
    expect(body.data.cpu).toBe(1.5);
    expect(body.data.restarts).toBe(2);
  });

  it('hides pid/memory/cpu from non-admin but keeps restarts', async () => {
    const res = await hono.request('/api/v1/apps/test-app', { headers: authHeader(userToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.pid).toBeUndefined();
    expect(body.data.memory).toBeUndefined();
    expect(body.data.cpu).toBeUndefined();
    expect(body.data.restarts).toBe(2);
  });

  it('returns static DTO without runtime fields when getStatus returns null', async () => {
    (mockRuntime.getStatus as jest.Mock).mockResolvedValueOnce(null);
    const res = await hono.request('/api/v1/apps/test-app', { headers: authHeader(adminToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.name).toBe('test-app');
    expect(body.data.memory).toBeUndefined();
    expect(body.data.cpu).toBeUndefined();
    expect(body.data.restarts).toBeUndefined();
  });

  it('returns static DTO when runtime throws', async () => {
    (mockRuntime.getStatus as jest.Mock).mockRejectedValueOnce(new Error('PM2 not running'));
    const res = await hono.request('/api/v1/apps/test-app', { headers: authHeader(adminToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data.name).toBe('test-app');
    expect(body.data.memory).toBeUndefined();
  });
});

describe('GET /api/v1/apps list DTO contract', () => {
  let tempDir: string;
  let server: ApiServer;
  let hono: ReturnType<ApiServer['getApp']>;
  let adminToken: string;
  let userToken: string;
  let userId: string;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-contract-list-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetStateManager();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    jest.spyOn(runtimeModule, 'getAppRuntime').mockReturnValue(makeMockRuntime());

    server = new ApiServer({
      port: 3096,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    hono = server.getApp();

    const user = await createUser('user-list', 'password123', 'user');
    await createUser('admin-list', 'password123', 'admin');
    userId = user.id;
    userToken = (await authenticateUser('user-list', 'password123'))!;
    adminToken = (await authenticateUser('admin-list', 'password123'))!;

    const sm = getStateManager();
    await sm.registerApp('my-app', path.join(tempDir, 'my-app'));
    await sm.updateApp('my-app', { userId });
    await sm.registerApp('other-app', path.join(tempDir, 'other-app'));
    // other-app has no userId — only admin can see it
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('non-admin only sees their own apps', async () => {
    const res = await hono.request('/api/v1/apps', { headers: authHeader(userToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    const names = body.data.map((a) => a.name);
    expect(names).toContain('my-app');
    expect(names).not.toContain('other-app');
  });

  it('admin sees all apps', async () => {
    const res = await hono.request('/api/v1/apps', { headers: authHeader(adminToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    const names = body.data.map((a) => a.name);
    expect(names).toContain('my-app');
    expect(names).toContain('other-app');
  });

  it('list items omit path for non-admin', async () => {
    const res = await hono.request('/api/v1/apps', { headers: authHeader(userToken) });
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    const myApp = body.data.find((a) => a.name === 'my-app');
    expect(myApp).toBeDefined();
    expect(myApp!.path).toBeUndefined();
  });

  it('list items include path for admin', async () => {
    const res = await hono.request('/api/v1/apps', { headers: authHeader(adminToken) });
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    const myApp = body.data.find((a) => a.name === 'my-app');
    expect(myApp).toBeDefined();
    expect(typeof myApp!.path).toBe('string');
  });
});
