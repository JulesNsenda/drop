/**
 * Bearer-presented API key tests (DROP-053).
 *
 * DROP historically accepted API keys only via the `X-API-Key` header, while
 * `Authorization: Bearer` was JWT-only — which broke hosted apps using the
 * conventional `Authorization: Bearer <api-key>` scheme. authMiddleware now
 * tries JWT first and falls back to API-key verification for a Bearer value
 * that isn't a valid JWT, so both header styles authenticate the same key
 * without changing session semantics. (`optionalAuthMiddleware` did the same
 * fallback and was covered here too, until DROP-130 LOW-9 deleted it as dead
 * code.)
 */

import { Hono } from 'hono';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  initializeAuth,
  createUser,
  createApiKey,
  authMiddleware,
  requireCapability,
  resetAuth,
  AuthContext,
} from './auth';

describe('Bearer-presented API keys', () => {
  let tempDir: string;
  let credentialsPath: string;

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-auth-bearer-test-'));
    credentialsPath = path.join(tempDir, 'credentials.json');
    resetAuth();
    await initializeAuth({ credentialsPath, enableJwt: true, enableApiKeys: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  type TestEnv = { Variables: { auth: AuthContext } };

  function buildApp(): Hono<TestEnv> {
    const app = new Hono<TestEnv>();
    app.get('/user-gate', authMiddleware('user'), (c) => {
      const auth = c.get('auth');
      return c.json({ ok: true, authMethod: auth.authMethod, role: auth.role });
    });
    app.get(
      '/capability-gate',
      authMiddleware(),
      requireCapability('users:create'),
      (c) => c.json({ ok: true })
    );
    return app;
  }

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  it('authenticates a user API key presented via Authorization: Bearer', async () => {
    const app = buildApp();
    const { key } = await createApiKey('bearer-user', 'user');

    const res = await app.request('/user-gate', { headers: bearer(key) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { authMethod: string; role: string };
    expect(body.authMethod).toBe('apikey');
    expect(body.role).toBe('user');
  });

  it('carries scopes so a scope-only key via Bearer passes requireCapability', async () => {
    const app = buildApp();
    const { key } = await createApiKey('bearer-scoped', 'none', undefined, ['users:create']);

    const res = await app.request('/capability-gate', { headers: bearer(key) });

    expect(res.status).toBe(200);
  });

  it('rejects a garbage Bearer token (neither JWT nor key) with 401', async () => {
    const app = buildApp();

    const res = await app.request('/user-gate', { headers: bearer('not-a-real-token') });

    expect(res.status).toBe(401);
  });

  it('still treats a valid session JWT via Bearer as a JWT (JWT is tried first)', async () => {
    const app = buildApp();
    await createUser('alice', 'password123', 'user');
    const { getTestToken } = await import('../__testutils__/auth');
    const token = await getTestToken('alice', 'password123');

    const res = await app.request('/user-gate', { headers: bearer(token) });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { authMethod: string };
    expect(body.authMethod).toBe('jwt');
  });

  it('still accepts the same key via the X-API-Key header (regression)', async () => {
    const app = buildApp();
    const { key } = await createApiKey('xapikey-user', 'user');

    const res = await app.request('/user-gate', { headers: { 'X-API-Key': key } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { authMethod: string };
    expect(body.authMethod).toBe('apikey');
  });

});
