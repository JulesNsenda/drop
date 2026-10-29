/**
 * Password-gated self-service routes, seen by a PASSWORDLESS (SSO-only) account.
 *
 * Such an account has no password to present, so PUT /auth/password, DELETE
 * /auth/account and the MFA enrolment routes answer with an explicit refusal
 * instead of the misleading "Current password is incorrect". Also: an admin
 * cannot promote one to admin through PUT /auth/users/:id (a 400, not a 500),
 * and /auth/me reports the marker.
 *
 * Own file: one route-test describe block per file (see
 * auth.credential-guards.route.test.ts).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, completeExternalIdentityLogin, suspendUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { resetRateLimits } from '../middleware/rate-limit';

const ISS = 'https://accounts.google.com';
const MESSAGE = 'This account signs in with an external identity and has no password';

describe('password-gated routes for a passwordless account', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let ssoId: string;
  let ssoToken: string;
  let adminToken: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-passwordless-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetStateManager();
    resetAuth();
    resetRateLimits();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    server = new ApiServer({
      port: 3096,
      enableAuth: true,
      allowSignup: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    await createUser({ username: 'root', role: 'admin', credential: { password: 'password123' } });
    adminToken = await getTestToken('root', 'password123');
    const sso = await createUser({
      username: 'sso-user',
      role: 'user',
      email: 'sso@example.com',
      credential: { externalIdentity: { issuer: ISS, subject: 'sub-1' } },
    });
    ssoId = sso.id;
    const login = await completeExternalIdentityLogin(ISS, 'sub-1');
    if (login.status !== 'ok') throw new Error('expected a session');
    ssoToken = login.token;
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

  const call = (method: string, url: string, token: string, body: unknown = {}) =>
    app.request(`/api/v1${url}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const expectRefusal = async (res: Response) => {
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe(MESSAGE);
  };

  it('PUT /auth/password', async () => {
    await expectRefusal(
      await call('PUT', '/auth/password', ssoToken, { currentPassword: 'x', newPassword: 'longenough1' })
    );
  });

  it('DELETE /auth/account', async () => {
    await expectRefusal(await call('DELETE', '/auth/account', ssoToken, { password: 'x' }));
  });

  it('POST /auth/mfa/setup', async () => {
    await expectRefusal(await call('POST', '/auth/mfa/setup', ssoToken));
  });

  it('POST /auth/mfa/enable', async () => {
    await expectRefusal(
      await call('POST', '/auth/mfa/enable', ssoToken, { password: 'x', secret: 'S', code: '123456' })
    );
  });

  it('a password account still gets the ordinary wrong-password answer', async () => {
    const res = await call('PUT', '/auth/password', adminToken, {
      currentPassword: 'wrong-password',
      newPassword: 'longenough1',
    });
    expect(res.status).toBe(401);
  });

  it('PUT /auth/users/:id refuses promoting a passwordless account to admin with a 400', async () => {
    const res = await call('PUT', `/auth/users/${ssoId}`, adminToken, { role: 'admin' });
    expect(res.status).toBe(400);
    const ok = await call('PUT', `/auth/users/${ssoId}`, adminToken, { role: 'readonly' });
    expect(ok.status).toBe(200);
  });

  it('re-enabling a passwordless account with only stale identities warns the admin, both ways', async () => {
    await suspendUser(ssoId);
    const viaAdmin = await call('POST', `/admin/users/${ssoId}/unsuspend`, adminToken);
    expect(viaAdmin.status).toBe(200);
    const adminBody = (await viaAdmin.json()) as { data?: { warning?: string } };
    expect(adminBody.data?.warning).toMatch(/no working login method/);

    await suspendUser(ssoId);
    const viaPut = await call('PUT', `/auth/users/${ssoId}`, adminToken, { enabled: true });
    const putBody = (await viaPut.json()) as { data?: { warning?: string } };
    expect(putBody.data?.warning).toMatch(/no working login method/);
  });

  it('no warning when the account still has a working login method', async () => {
    const res = await call('PUT', `/auth/users/${ssoId}`, adminToken, { enabled: true });
    const body = (await res.json()) as { data?: { warning?: string } };
    expect(body.data?.warning).toBeUndefined();
  });

  it('signup refuses an address an identity account holds, with the generic refusal; a fresh one works', async () => {
    const signup = (email: string, username: string) =>
      app.request('/api/v1/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password: 'longenough1' }),
      });
    const held = await signup('Sso@Example.com', 'newcomer');
    expect(held.status).toBe(500);
    expect(((await held.json()) as { error?: { message?: string } }).error?.message).toBe('Registration failed');
    expect((await signup('fresh@example.com', 'newcomer')).status).toBe(201);
  });

  it('GET /auth/me reports passwordless', async () => {
    const res = await app.request('/api/v1/auth/me', { headers: { Authorization: `Bearer ${ssoToken}` } });
    const body = (await res.json()) as { data?: { passwordless?: boolean } };
    expect(body.data?.passwordless).toBe(true);
  });
});
