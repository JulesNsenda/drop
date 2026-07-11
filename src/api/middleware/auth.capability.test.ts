/**
 * Capability-model tests (PR2: scoped provisioning token, §1).
 *
 * Covers the auth.ts changes only:
 *  - `scopes?` propagate into AuthContext on the API-key path.
 *  - The role-hierarchy `?? 0` hardening: a `role: 'none'` scope-only key is
 *    rejected by every `authMiddleware(role)` gate (it has no role standing).
 *  - `requireCapability(cap)` admits admins and scoped keys, rejects
 *    role-only callers lacking the scope, and 401s when unauthenticated.
 *
 * Uses a tiny standalone Hono app (same pattern as rate-limit.test.ts) rather
 * than the full ApiServer, since `requireCapability` is not yet mounted on
 * any real route (that's a later slice) — this file's only job is to prove
 * the middleware's own behavior.
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

describe('capability model', () => {
  let tempDir: string;
  let credentialsPath: string;

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-auth-capability-test-'));
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
    // Role-gated route — exercises authMiddleware('readonly') alone.
    app.get('/readonly-gate', authMiddleware('readonly'), (c) => c.json({ ok: true }));
    // Capability-gated route — authMiddleware() (no required role) then requireCapability.
    app.get(
      '/capability-gate',
      authMiddleware(),
      requireCapability('users:create'),
      (c) => {
        const auth = c.get('auth');
        return c.json({ ok: true, scopes: auth.scopes ?? null, role: auth.role });
      }
    );
    // requireCapability with nothing in front — exercises its own 401 safety net.
    app.get('/capability-only', requireCapability('users:create'), (c) => c.json({ ok: true }));
    return app;
  }

  it("rejects a role:'none' scope-only API key on authMiddleware('readonly') (proves the ?? 0 fix)", async () => {
    const app = buildApp();
    const { key } = await createApiKey('scoped-key', 'none', undefined, ['users:create']);

    const res = await app.request('/readonly-gate', { headers: { 'X-API-Key': key } });

    expect(res.status).toBe(403);
  });

  it('propagates scopes into AuthContext on the API-key path', async () => {
    const app = buildApp();
    const { key } = await createApiKey('scoped-key', 'none', undefined, ['users:create']);

    const res = await app.request('/capability-gate', { headers: { 'X-API-Key': key } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { scopes: string[] | null; role: string };
    expect(body.scopes).toEqual(['users:create']);
    expect(body.role).toBe('none');
  });

  describe('requireCapability', () => {
    it('admits a scope-only key carrying the required capability', async () => {
      const app = buildApp();
      const { key } = await createApiKey('scoped-key', 'none', undefined, ['users:create']);

      const res = await app.request('/capability-gate', { headers: { 'X-API-Key': key } });

      expect(res.status).toBe(200);
    });

    it('admits an admin key even without the scope', async () => {
      const app = buildApp();
      const { key } = await createApiKey('admin-key', 'admin');

      const res = await app.request('/capability-gate', { headers: { 'X-API-Key': key } });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { role: string };
      expect(body.role).toBe('admin');
    });

    it('rejects (403) a plain user key lacking the scope', async () => {
      const app = buildApp();
      const { key } = await createApiKey('user-key', 'user');

      const res = await app.request('/capability-gate', { headers: { 'X-API-Key': key } });

      expect(res.status).toBe(403);
    });

    it('rejects (403) a plain readonly key lacking the scope', async () => {
      const app = buildApp();
      const { key } = await createApiKey('readonly-key', 'readonly');

      const res = await app.request('/capability-gate', { headers: { 'X-API-Key': key } });

      expect(res.status).toBe(403);
    });

    it('returns 401 when unauthenticated (no auth context set)', async () => {
      const app = buildApp();

      const res = await app.request('/capability-only', {});

      expect(res.status).toBe(401);
    });

    it('returns 401 via the full gate chain when no credentials are supplied', async () => {
      const app = buildApp();

      const res = await app.request('/capability-gate', {});

      expect(res.status).toBe(401);
    });
  });

  describe('createApiKey with scopes', () => {
    it('persists scopes on the ApiKey record when provided', async () => {
      const { apiKey } = await createApiKey('k', 'none', undefined, ['users:create']);
      expect(apiKey.scopes).toEqual(['users:create']);
      expect(apiKey.role).toBe('none');
    });

    it('omits scopes when not provided (existing admin/user/readonly keys unaffected)', async () => {
      const { apiKey } = await createApiKey('k2', 'user');
      expect(apiKey.scopes).toBeUndefined();
    });
  });

  describe('regression: existing role gates unaffected by the none/scope additions', () => {
    it('still admits a plain admin API key on authMiddleware("readonly")', async () => {
      const app = buildApp();
      const { key } = await createApiKey('admin-key', 'admin');

      const res = await app.request('/readonly-gate', { headers: { 'X-API-Key': key } });

      expect(res.status).toBe(200);
    });

    it('still admits a JWT session for a plain user on authMiddleware("readonly")', async () => {
      const app = buildApp();
      await createUser('alice', 'password123', 'user');
      const { getTestToken } = await import('../__testutils__/auth');
      const token = await getTestToken('alice', 'password123');

      const res = await app.request('/readonly-gate', { headers: { Authorization: `Bearer ${token}` } });

      expect(res.status).toBe(200);
    });
  });
});
