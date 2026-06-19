/**
 * Authorization regression tests for /secrets/* routes.
 *
 * Covers: owner access, IDOR prevention, admin bypass, folder-dropped apps,
 * invalid name validation, and the reserved-key denylist.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { getSecretManager, resetSecretManager } from '../../managers/secret';

describe('secrets route authorization', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let aliceToken: string;
  let bobToken: string;
  let adminToken: string;
  let aliceId: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-secrets-authz-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetStateManager();
    resetSecretManager();
    resetAuth();

    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    const sm = getSecretManager({ storePath: path.join(tempDir, 'secrets.json'), masterKey: 'test-key' });
    await sm.initialize();

    server = new ApiServer({
      port: 3098,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    const alice = await createUser('alice', 'password123', 'user');
    await createUser('bob', 'password123', 'user');
    await createUser('sysadmin', 'password123', 'admin');
    aliceId = alice.id;
    aliceToken = await getTestToken('alice', 'password123');
    bobToken = await getTestToken('bob', 'password123');
    adminToken = await getTestToken('sysadmin', 'password123');

    const stateManager = getStateManager();
    await stateManager.registerApp('alice-app', path.join(tempDir, 'alice-app'));
    await stateManager.updateApp('alice-app', { userId: aliceId });

    // folder-dropped app: no userId
    await stateManager.registerApp('legacy-app', path.join(tempDir, 'legacy-app'));
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetSecretManager();
    resetAuth();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // --- owner access ---

  it('owner can list their own app secrets (GET)', async () => {
    const res = await app.request('/api/v1/secrets/alice-app', { headers: bearer(aliceToken) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: { keys: string[] } };
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data.keys)).toBe(true);
  });

  it('owner can set a secret (PUT)', async () => {
    const res = await app.request('/api/v1/secrets/alice-app', {
      method: 'PUT',
      headers: { ...bearer(aliceToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'MY_TOKEN', value: 'secret123' }),
    });
    expect(res.status).toBe(200);
  });

  it('owner can delete a specific secret (DELETE /:name/:key)', async () => {
    await getSecretManager().set('alice-app', 'MY_TOKEN', 'val');
    const res = await app.request('/api/v1/secrets/alice-app/MY_TOKEN', {
      method: 'DELETE',
      headers: bearer(aliceToken),
    });
    expect(res.status).toBe(200);
  });

  // --- IDOR prevention ---

  it("non-owner user gets 404 on GET (IDOR)", async () => {
    const res = await app.request('/api/v1/secrets/alice-app', { headers: bearer(bobToken) });
    expect(res.status).toBe(404);
  });

  it("non-owner user gets 404 on PUT (IDOR)", async () => {
    const res = await app.request('/api/v1/secrets/alice-app', {
      method: 'PUT',
      headers: { ...bearer(bobToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'EVIL_KEY', value: 'evil' }),
    });
    expect(res.status).toBe(404);
  });

  it("non-owner user gets 404 on DELETE (IDOR)", async () => {
    const res = await app.request('/api/v1/secrets/alice-app/SOME_KEY', {
      method: 'DELETE',
      headers: bearer(bobToken),
    });
    expect(res.status).toBe(404);
  });

  // --- admin bypass ---

  it('admin can manage any app secrets', async () => {
    const get = await app.request('/api/v1/secrets/alice-app', { headers: bearer(adminToken) });
    expect(get.status).toBe(200);

    const put = await app.request('/api/v1/secrets/alice-app', {
      method: 'PUT',
      headers: { ...bearer(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'ADMIN_KEY', value: 'val' }),
    });
    expect(put.status).toBe(200);
  });

  // --- folder-dropped / legacy apps ---

  it('non-admin gets 404 for folder-dropped app with no userId', async () => {
    const res = await app.request('/api/v1/secrets/legacy-app', { headers: bearer(aliceToken) });
    expect(res.status).toBe(404);
  });

  it('admin can manage folder-dropped app secrets', async () => {
    const res = await app.request('/api/v1/secrets/legacy-app', { headers: bearer(adminToken) });
    expect(res.status).toBe(200);
  });

  // --- input validation ---

  it('returns 400 for _-prefixed (internal) app name', async () => {
    const res = await app.request('/api/v1/secrets/__drop_git_tokens', { headers: bearer(aliceToken) });
    expect(res.status).toBe(400);
  });

  it('returns 400 when setting a reserved platform key (DATABASE_URL)', async () => {
    const res = await app.request('/api/v1/secrets/alice-app', {
      method: 'PUT',
      headers: { ...bearer(aliceToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'DATABASE_URL', value: 'postgres://evil/db' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when setting a reserved platform key (PORT)', async () => {
    const res = await app.request('/api/v1/secrets/alice-app', {
      method: 'PUT',
      headers: { ...bearer(aliceToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'PORT', value: '9999' }),
    });
    expect(res.status).toBe(400);
  });
});
