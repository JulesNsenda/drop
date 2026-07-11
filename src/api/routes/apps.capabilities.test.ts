/**
 * PUT /apps/:name/capabilities — admin-conferred grant of the app's
 * DROP_API_KEY capability scopes (scoped-provisioning-token, PR2 §4).
 *
 * The admin-only gate (authMiddleware('admin')) is wired in server.ts by a
 * separate slice and isn't exercised here — these tests drive the handler
 * itself against a seeded app (state + config) with an authenticated caller,
 * covering: valid grant persists + restarts, unknown scope is rejected and
 * neither persisted nor restarted, empty array clears the grant, an unknown
 * app 404s, and AppInProgressError from the restart maps to 409.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { getAppConfigService, resetAppConfigService } from '../../managers/app/app-config';
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
    ...overrides,
  };
}

describe('PUT /apps/:name/capabilities', () => {
  let tempDir: string;
  let server: ApiServer;
  let hono: ReturnType<ApiServer['getApp']>;
  let adminToken: string;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-capabilities-route-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(activity, 'tryLogActivity').mockResolvedValue();

    resetStateManager();
    resetAuth();
    resetPlatformOps();
    resetAppConfigService();

    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    getAppConfigService({
      configDir: path.join(tempDir, 'appconf', 'webapps'),
      webappsDir: path.join(tempDir, 'webapps'),
    });
    await getAppConfigService().initialize();

    server = new ApiServer({
      port: 3095,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    hono = server.getApp();

    await createUser('root', 'password123', 'admin');
    adminToken = await getTestToken('root', 'password123');

    const sm = getStateManager();
    await sm.registerApp('test-app', path.join(tempDir, 'test-app'));
    // Seed a persisted config so updateConfig() has an existing record to
    // update (an app with state but no config is the "no config yet" 404 case).
    await getAppConfigService().upsertConfig('test-app', { type: 'nodejs' });
  });

  afterEach(async () => {
    resetPlatformOps();
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetAppConfigService();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  afterAll(() => {
    resetPlatformOps();
  });

  const putCapabilities = (scopes: unknown) =>
    hono.request('/api/v1/apps/test-app/capabilities', {
      method: 'PUT',
      headers: authHeader(adminToken),
      body: JSON.stringify({ scopes }),
    });

  it('grants a valid scope: persists to config and restarts the app', async () => {
    const ops = makeOps();
    setPlatformOps(ops);

    const res = await putCapabilities(['users:create']);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { grantedApiScopes: string[] } };
    expect(body.data.grantedApiScopes).toEqual(['users:create']);

    expect(getAppConfigService().getConfig('test-app')?.grantedApiScopes).toEqual(['users:create']);
    expect(ops.restartApp).toHaveBeenCalledWith('test-app');
  });

  it('rejects an unknown scope with 400 and does not persist or restart', async () => {
    const ops = makeOps();
    setPlatformOps(ops);

    const res = await putCapabilities(['delete:everything']);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);

    expect(getAppConfigService().getConfig('test-app')?.grantedApiScopes).toBeUndefined();
    expect(ops.restartApp).not.toHaveBeenCalled();
  });

  it('clears the grant with an empty array', async () => {
    const ops = makeOps();
    setPlatformOps(ops);

    // First grant, then clear.
    await putCapabilities(['users:create']);
    const res = await putCapabilities([]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { grantedApiScopes: string[] } };
    expect(body.data.grantedApiScopes).toEqual([]);

    expect(getAppConfigService().getConfig('test-app')?.grantedApiScopes).toEqual([]);
    expect(ops.restartApp).toHaveBeenCalledTimes(2);
  });

  it('404s for an unknown app', async () => {
    setPlatformOps(makeOps());

    const res = await hono.request('/api/v1/apps/does-not-exist/capabilities', {
      method: 'PUT',
      headers: authHeader(adminToken),
      body: JSON.stringify({ scopes: ['users:create'] }),
    });
    expect(res.status).toBe(404);
  });

  it('409s when the app has a restart in flight (AppInProgressError)', async () => {
    setPlatformOps(
      makeOps({ restartApp: jest.fn().mockRejectedValue(new AppInProgressError('test-app')) })
    );

    const res = await putCapabilities(['users:create']);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe(ErrorCodes.CONFLICT);

    // Persist still happens before the restart attempt (config is source of
    // truth); only the re-injection failed.
    expect(getAppConfigService().getConfig('test-app')?.grantedApiScopes).toEqual(['users:create']);
  });
});
