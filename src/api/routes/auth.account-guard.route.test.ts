/**
 * Route-level guards that must accompany API-key ownership resolution (DROP-075).
 *
 * Making a key act as its `ownerUserId` removes an accidental containment: a
 * key used to own nothing, so under-gated destructive routes were inert for it.
 * These two were armed by that change and are now gated explicitly.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, createApiKey, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';

describe('DELETE /auth/account guards', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let bobId: string;
  let bobToken: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-owner-acct-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetStateManager();
    resetAuth();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    server = new ApiServer({
      port: 3096,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    const bob = await createUser('bob', 'password123', 'user');
    bobId = bob.id;
    bobToken = await getTestToken('bob', 'password123');
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

  describe('DELETE /auth/account', () => {
    it('refuses an API key — deletion needs an interactive session', async () => {
      // The route requires no role, so before this guard ANY key issued to a CI
      // job or a deployed app could delete its owner's account outright.
      const { key } = await createApiKey('bob-ci', 'user', undefined, undefined, bobId);

      const res = await app.request('/api/v1/auth/account', {
        method: 'DELETE',
        headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'password123' }),
      });

      expect(res.status).toBe(403);

      // And the account still exists.
      const me = await app.request('/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${bobToken}` },
      });
      expect(me.status).toBe(200);
    });

    it('refuses a readonly key just the same', async () => {
      const { key } = await createApiKey('bob-ro', 'readonly', undefined, undefined, bobId);

      const res = await app.request('/api/v1/auth/account', {
        method: 'DELETE',
        headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'password123' }),
      });

      expect(res.status).toBe(403);
    });

    it('requires the current password on the session path', async () => {
      const res = await app.request('/api/v1/auth/account', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });

    it('rejects a wrong password', async () => {
      const res = await app.request('/api/v1/auth/account', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-password' }),
      });

      expect(res.status).toBe(401);
    });

    it('deletes the account with a session and the correct password', async () => {
      const res = await app.request('/api/v1/auth/account', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${bobToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'password123' }),
      });

      expect(res.status).toBe(200);
    });
  });
});
