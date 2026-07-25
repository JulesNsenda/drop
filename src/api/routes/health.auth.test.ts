/**
 * Auth-gating regression tests for the health routes.
 *
 * `/health/apps` and `/health/stats` anonymously enumerate every tenant's app
 * name/port/status. Once app containers can reach the control-plane API on
 * `drop-net` (docs/plans/2026-07-10-drop-api-reachability-from-containers.md,
 * §3), these two endpoints become reachable from every tenant container — so
 * they must require auth. `/health` and `/health/live` must stay anonymous
 * (liveness/readiness probes cannot require credentials).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { resetStateManager } from '../../managers/app/state-manager';

describe('health route auth gating', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let token: string;

  const authHeader = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-health-auth-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetStateManager();
    resetAuth();

    server = new ApiServer({
      port: 3098,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    const alice = await createUser('alice', 'password123', 'readonly');
    void alice;
    token = await getTestToken('alice', 'password123');
  });

  afterEach(async () => {
    if (server) await server.stop();
    resetStateManager();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('rejects GET /health/apps without credentials (401)', async () => {
    const res = await app.request('/api/v1/health/apps');
    expect(res.status).toBe(401);
  });

  it('allows GET /health/apps with a valid token', async () => {
    const res = await app.request('/api/v1/health/apps', { headers: authHeader(token) });
    expect(res.status).toBe(200);
  });

  it('rejects GET /health/stats without credentials (401)', async () => {
    const res = await app.request('/api/v1/health/stats');
    expect(res.status).toBe(401);
  });

  it('allows GET /health/stats with a valid token', async () => {
    const res = await app.request('/api/v1/health/stats', { headers: authHeader(token) });
    expect(res.status).toBe(200);
  });

  it('keeps GET /health/live public (no auth required)', async () => {
    const res = await app.request('/api/v1/health/live');
    expect(res.status).toBe(200);
  });

  it('keeps GET /health public (no auth required)', async () => {
    const res = await app.request('/api/v1/health');
    expect([200, 503]).toContain(res.status);
  });
});
