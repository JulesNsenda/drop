/**
 * Interactive-session guards on the self-service ACCOUNT-CREDENTIAL routes.
 *
 * Companion to auth.account-guard.route.test.ts, which covers DELETE
 * /auth/account. Found by adversarial review of this branch: that route got
 * the guard, but the three other routes in the same class did not, and they
 * are armed by exactly the same change.
 *
 * Resolving `AuthContext.userId` to a key's `ownerUserId` makes a key act as
 * its owner. These routes compare a caller-supplied secret against the
 * OWNER'S credentials and report the mismatch, so without a guard each is an
 * online guessing oracle reachable with ANY key — including a `readonly` one,
 * or one injected into a deployed app. A hit on PUT /auth/password is
 * outright account takeover, and keys minted without an explicit owner
 * default to the minting admin.
 *
 * Own file: a second route-test describe block in one file hangs the Jest
 * worker. One concern per file.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, createApiKey, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { resetRateLimits } from '../middleware/rate-limit';

describe('account-credential routes require an interactive session', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let bobId: string;
  let bobToken: string;
  let bobKey: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-cred-guard-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetStateManager();
    resetAuth();
    resetRateLimits();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    server = new ApiServer({
      port: 3095,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    const bob = await createUser('bob', 'password123', 'user');
    bobId = bob.id;
    bobToken = await getTestToken('bob', 'password123');
    bobKey = (await createApiKey('bob-ci', 'user', undefined, undefined, bobId)).key;
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetAuth();
    resetRateLimits();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const changePasswordAs = (headers: Record<string, string>, currentPassword: string) =>
    app.request('/api/v1/auth/password', {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword: 'attackerchosen1' }),
    });

  const canStillLogInWithOriginalPassword = async (): Promise<boolean> => {
    const res = await app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'password123' }),
    });
    return res.status === 200;
  };

  describe('PUT /auth/password', () => {
    it('refuses an API key even when the current password is CORRECT', async () => {
      const res = await changePasswordAs({ 'X-API-Key': bobKey }, 'password123');

      expect(res.status).toBe(403);
      // The takeover, not just the status: the owner's password must be intact.
      expect(await canStillLogInWithOriginalPassword()).toBe(true);
    });

    it('is indistinguishable for a right and a wrong password — the oracle is closed', async () => {
      // THE load-bearing assertion of this file. A 403-vs-401 split, or any
      // difference in body, would still let a key confirm a guess one attempt
      // at a time; closing the takeover but leaving the oracle open would be
      // a partial fix that reads as complete.
      const right = await changePasswordAs({ 'X-API-Key': bobKey }, 'password123');
      const wrong = await changePasswordAs({ 'X-API-Key': bobKey }, 'not-the-password');

      expect(right.status).toBe(wrong.status);
      expect(await right.text()).toBe(await wrong.text());
    });

    it('refuses a Bearer-presented API key too, not just X-API-Key', async () => {
      const res = await changePasswordAs({ Authorization: `Bearer ${bobKey}` }, 'password123');

      expect(res.status).toBe(403);
      expect(await canStillLogInWithOriginalPassword()).toBe(true);
    });

    it('still lets the owner change their own password from a session', async () => {
      // The guard must not have broken the legitimate path — without this,
      // rejecting everything would satisfy every assertion above.
      const res = await changePasswordAs({ Authorization: `Bearer ${bobToken}` }, 'password123');

      expect(res.status).toBe(200);
      expect(await canStillLogInWithOriginalPassword()).toBe(false);
    });
  });

  describe('MFA routes', () => {
    it('refuses an API key on POST /auth/mfa/disable', async () => {
      // disableMfa reports `invalid_code` and keeps no failed-attempt counter
      // of its own, so an unguarded key could grind a 6-digit code and strip
      // the owner's second factor.
      const res = await app.request('/api/v1/auth/mfa/disable', {
        method: 'POST',
        headers: { 'X-API-Key': bobKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: '000000' }),
      });

      expect(res.status).toBe(403);
    });

    it('refuses an API key on POST /auth/mfa/setup', async () => {
      const res = await app.request('/api/v1/auth/mfa/setup', {
        method: 'POST',
        headers: { 'X-API-Key': bobKey },
      });

      expect(res.status).toBe(403);
    });

    it('refuses an API key on POST /auth/mfa/enable', async () => {
      const res = await app.request('/api/v1/auth/mfa/enable', {
        method: 'POST',
        headers: { 'X-API-Key': bobKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'password123', secret: 'AAAA', code: '000000' }),
      });

      expect(res.status).toBe(403);
    });
  });
});
