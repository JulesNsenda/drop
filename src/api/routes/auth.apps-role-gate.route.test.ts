/**
 * Role gating on destructive /apps verbs (DROP-075).
 *
 * DELETE/PUT on an app fell through to the `readonly` guard and relied on
 * `canAccess` alone — inert for API keys only because a key's userId was its
 * own id and therefore owned nothing. Resolving a key to its owner arms them,
 * so the tier is now stated explicitly and method-scoped.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, createApiKey, resetAuth } from '../middleware/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';

describe('destructive /apps verbs reject a readonly token', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let bobId: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-owner-apps-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetStateManager();
    resetAuth();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    server = new ApiServer({
      port: 3097,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    const bob = await createUser('bob', 'password123', 'user');
    bobId = bob.id;
  });

  afterEach(async () => {
    // Same teardown discipline as apps.authz.test.ts: stop the server (its
    // listener is an open handle that otherwise hangs the run), flush the
    // debounced state save before rm, and retry rm — a lagging credentials
    // write can otherwise land mid-delete and lose the race.
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetAuth();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  beforeEach(async () => {
    await getStateManager().registerApp('bobapp', path.join(tempDir, 'bobapp'), 'nodejs');
    await getStateManager().updateApp('bobapp', { userId: bobId });
  });

  it('refuses DELETE /apps/:name with a readonly key', async () => {
    const { key } = await createApiKey('bob-ro', 'readonly', undefined, undefined, bobId);

    const res = await app.request('/api/v1/apps/bobapp', {
      method: 'DELETE',
      headers: { 'X-API-Key': key },
    });

    // 403 from the role gate — NOT 200/404 via canAccess, which used to be
    // the only check and passed once a key resolved to its owner.
    expect(res.status).toBe(403);
    expect(getStateManager().getApp('bobapp')).toBeDefined();
  });

  it('refuses PUT /apps/:name with a readonly key', async () => {
    const { key } = await createApiKey('bob-ro2', 'readonly', undefined, undefined, bobId);

    const res = await app.request('/api/v1/apps/bobapp', {
      method: 'PUT',
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customDomain: 'evil.example.com' }),
    });

    expect(res.status).toBe(403);
  });

  it('still allows GET /apps/:name with a readonly key', async () => {
    // The gate is method-scoped: read access at `readonly` is the point of
    // the tier and must not regress.
    const { key } = await createApiKey('bob-ro3', 'readonly', undefined, undefined, bobId);

    const res = await app.request('/api/v1/apps/bobapp', {
      headers: { 'X-API-Key': key },
    });

    expect(res.status).toBe(200);
  });
});
