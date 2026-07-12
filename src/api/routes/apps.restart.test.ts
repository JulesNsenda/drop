/**
 * POST /apps/:name/start and POST /apps/:name/restart — platform-ops wiring.
 *
 * Locks in docs/plans/2026-07-08-restart-env-reinjection.md's route contract:
 * both endpoints delegate to PlatformOps.restartApp (start-on-stopped and
 * restart are the same operation), 503 when ops are unwired (no fallback to
 * the old stale-env runtime.start/restart path — that was the bug), 409 on
 * AppInProgressError, 500 passthrough on any other failure, and the mutating
 * role guard (item 5) keeps readonly tokens out.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { setPlatformOps, resetPlatformOps, AppInProgressError, PlatformOps } from '../platform-ops';
import * as activity from '../../managers/activity';
import type { AppProcessInfo } from '../../managers/runtime';
import { ErrorCodes } from '../types';

const RUNNING_PROCESS: AppProcessInfo = {
  name: 'test-app',
  status: 'running',
  runtime: 'pm2',
  pid: 54321,
  port: 4001,
  memory: 2048,
  cpu: 0.5,
  uptime: 1000,
  restarts: 1,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  restartedAt: new Date('2026-01-01T00:00:05Z'),
};

function makeOps(overrides?: Partial<PlatformOps>): PlatformOps {
  return {
    restartApp: jest.fn().mockResolvedValue(RUNNING_PROCESS),
    isAppInProgress: jest.fn().mockReturnValue(false),
    removeGroup: jest.fn().mockResolvedValue({ removed: [] }),
    ...overrides,
  };
}

describe('POST /apps/:name/start and /apps/:name/restart (platform ops)', () => {
  let tempDir: string;
  let server: ApiServer;
  let hono: ReturnType<ApiServer['getApp']>;
  let ownerToken: string;
  let ownerId: string;
  let logSpy: jest.SpyInstance;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-restart-route-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    logSpy = jest.spyOn(activity, 'tryLogActivity').mockResolvedValue();

    resetStateManager();
    resetAuth();
    resetPlatformOps();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    server = new ApiServer({
      port: 3094,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    hono = server.getApp();

    const owner = await createUser('owner', 'password123', 'user');
    ownerId = owner.id;
    ownerToken = await getTestToken('owner', 'password123');

    const sm = getStateManager();
    await sm.registerApp('test-app', path.join(tempDir, 'test-app'));
    await sm.updateApp('test-app', { userId: ownerId });
  });

  afterEach(async () => {
    resetPlatformOps();
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  afterAll(() => {
    resetPlatformOps();
  });

  describe('unwired platform ops', () => {
    it('503s on restart when ops are unwired', async () => {
      const res = await hono.request('/api/v1/apps/test-app/restart', {
        method: 'POST',
        headers: authHeader(ownerToken),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(ErrorCodes.SERVICE_UNAVAILABLE);
    });

    it('503s on start when ops are unwired', async () => {
      const res = await hono.request('/api/v1/apps/test-app/start', {
        method: 'POST',
        headers: authHeader(ownerToken),
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(ErrorCodes.SERVICE_UNAVAILABLE);
    });
  });

  describe('busy (AppInProgressError)', () => {
    it('409s on restart when the app has an operation in flight', async () => {
      setPlatformOps(makeOps({ restartApp: jest.fn().mockRejectedValue(new AppInProgressError('test-app')) }));

      const res = await hono.request('/api/v1/apps/test-app/restart', {
        method: 'POST',
        headers: authHeader(ownerToken),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(ErrorCodes.CONFLICT);
    });

    it('409s on start when the app has an operation in flight', async () => {
      setPlatformOps(makeOps({ restartApp: jest.fn().mockRejectedValue(new AppInProgressError('test-app')) }));

      const res = await hono.request('/api/v1/apps/test-app/start', {
        method: 'POST',
        headers: authHeader(ownerToken),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(ErrorCodes.CONFLICT);
    });
  });

  describe('happy path', () => {
    it('restarts the app, returns the status, and logs a restart activity', async () => {
      const ops = makeOps();
      setPlatformOps(ops);

      const res = await hono.request('/api/v1/apps/test-app/restart', {
        method: 'POST',
        headers: authHeader(ownerToken),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { status: AppProcessInfo } };
      expect(body.data.status).toMatchObject({ pid: RUNNING_PROCESS.pid, port: RUNNING_PROCESS.port });
      expect(ops.restartApp).toHaveBeenCalledWith('test-app');

      const entry = logSpy.mock.calls.find((call) => call[0].action === 'restart')?.[0];
      expect(entry).toMatchObject({ action: 'restart', appName: 'test-app', userId: ownerId });
    });

    it('starts the app, returns the status, and logs a start activity', async () => {
      const ops = makeOps();
      setPlatformOps(ops);

      const res = await hono.request('/api/v1/apps/test-app/start', {
        method: 'POST',
        headers: authHeader(ownerToken),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { status: AppProcessInfo } };
      expect(body.data.status).toMatchObject({ pid: RUNNING_PROCESS.pid, port: RUNNING_PROCESS.port });
      expect(ops.restartApp).toHaveBeenCalledWith('test-app');

      const entry = logSpy.mock.calls.find((call) => call[0].action === 'start')?.[0];
      expect(entry).toMatchObject({ action: 'start', appName: 'test-app', userId: ownerId });
    });
  });

  describe('generic failure', () => {
    it('500s on restart when ops throw a non-AppInProgressError error', async () => {
      setPlatformOps(makeOps({ restartApp: jest.fn().mockRejectedValue(new Error('boom')) }));

      const res = await hono.request('/api/v1/apps/test-app/restart', {
        method: 'POST',
        headers: authHeader(ownerToken),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe(ErrorCodes.INTERNAL_ERROR);
      expect(body.error.message).toBe('boom');
    });

    it('500s on start when ops throw a non-AppInProgressError error', async () => {
      setPlatformOps(makeOps({ restartApp: jest.fn().mockRejectedValue(new Error('boom')) }));

      const res = await hono.request('/api/v1/apps/test-app/start', {
        method: 'POST',
        headers: authHeader(ownerToken),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe(ErrorCodes.INTERNAL_ERROR);
      expect(body.error.message).toBe('boom');
    });
  });

  describe('role guard (item 5)', () => {
    it('blocks a readonly-role token with 403', async () => {
      await createUser('viewer', 'password123', 'readonly');
      const viewerToken = await getTestToken('viewer', 'password123');
      setPlatformOps(makeOps());

      const res = await hono.request('/api/v1/apps/test-app/restart', {
        method: 'POST',
        headers: authHeader(viewerToken),
      });
      expect(res.status).toBe(403);
    });

    it('lets a user-role token through the guard', async () => {
      setPlatformOps(makeOps());

      const res = await hono.request('/api/v1/apps/test-app/restart', {
        method: 'POST',
        headers: authHeader(ownerToken),
      });
      expect(res.status).toBe(200);
    });
  });
});
