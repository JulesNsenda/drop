/**
 * `POST /admin/mail/test` gets its OWN rate-limit bucket (DROP-154), separate
 * from the `services`/`db` buckets other admin routes share — see
 * `rate-limit.ts`'s `MAIL_CONFIG` and `server.ts`'s registration comment: a
 * burst against this route dials the operator's real SMTP relay, not just
 * CPU, so it must not share a budget with unrelated admin traffic and must
 * not let an unrelated admin burst exhaust IT either.
 *
 * Registered on a single LITERAL path, not a wildcard — mirrors
 * `server.share-routes.test.ts`'s measured-not-assumed approach, but here the
 * thing to measure is that a literal path doesn't accidentally shadow or get
 * shadowed by a sibling pattern, since `/admin/*` (the admin role floor) is
 * also registered. Uses the real, nested `ApiServer`
 * (`v1.route('/admin', adminRoutes)`) rather than a flat test app, same
 * reasoning as `server.share-routes.test.ts`.
 *
 * The handler for `POST /admin/mail/test` may or may not exist yet in
 * `admin.ts` depending on build order — irrelevant here, since every
 * assertion below is about middleware that fires BEFORE Hono resolves a
 * handler and holds whether the route is a real handler or a 404.
 */

import { createUser } from './middleware/auth';
import { getTestToken } from './__testutils__/auth';
import { createTestApiServer, teardownTestApiServer, type TestApiServer } from './__testutils__/api-server';

describe('dedicated POST /admin/mail/test rate-limit bucket (DROP-154)', () => {
  let t: TestApiServer;
  let adminToken: string;
  let userToken: string;

  // A fixed, loopback-trusted peer so the limiter's per-IP key is stable
  // across every request in this file (matches server.share-routes.test.ts).
  const fromLoopback = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
  const authHeader = (token: string) => ({
    Authorization: `Bearer ${token}`,
    'x-forwarded-for': '10.10.10.10',
  });

  beforeEach(async () => {
    t = await createTestApiServer({ port: 3104, tempPrefix: 'drop-mail-ratelimit-' });

    await createUser('mail-admin', 'password123', 'admin');
    adminToken = await getTestToken('mail-admin', 'password123');

    await createUser('mail-user', 'password123', 'user');
    userToken = await getTestToken('mail-user', 'password123');
  });

  afterEach(async () => {
    await teardownTestApiServer(t);
  });

  it('429s the dedicated mail bucket once its own cap (10/min) is exceeded', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await t.hono.request(
        '/api/v1/admin/mail/test',
        { method: 'POST', headers: authHeader(adminToken) },
        fromLoopback
      );
      expect(res.status).not.toBe(429);
    }

    const blocked = await t.hono.request(
      '/api/v1/admin/mail/test',
      { method: 'POST', headers: authHeader(adminToken) },
      fromLoopback
    );
    expect(blocked.status).toBe(429);
  });

  it('rejects an unauthenticated caller with 401 (admin role floor still applies)', async () => {
    const res = await t.hono.request('/api/v1/admin/mail/test', { method: 'POST' }, fromLoopback);
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin user-role token with 403', async () => {
    const res = await t.hono.request(
      '/api/v1/admin/mail/test',
      { method: 'POST', headers: authHeader(userToken) },
      fromLoopback
    );
    expect(res.status).toBe(403);
  });

  it('does NOT 429 GET /admin/settings once the mail bucket alone is exhausted (separate bucket)', async () => {
    // Drain the MAIL bucket only.
    for (let i = 0; i < 11; i++) {
      await t.hono.request(
        '/api/v1/admin/mail/test',
        { method: 'POST', headers: authHeader(adminToken) },
        fromLoopback
      );
    }

    // Same client, same IP, immediately after — general admin traffic runs on
    // the shared `/api/*` bucket (100/min), a separate counter, so this must
    // not be 429 even though the mail bucket above is already exhausted.
    const res = await t.hono.request(
      '/api/v1/admin/settings',
      { headers: authHeader(adminToken) },
      fromLoopback
    );
    expect(res.status).not.toBe(429);
  });

  it('does not 429 PUT /admin/settings/mail — the bucket is a literal path, not a wildcard', async () => {
    // If `/admin/mail/test` were mistakenly registered as a wildcard (e.g.
    // `/admin/mail/*` or matched loosely against `/admin/settings/mail`),
    // draining the test-send bucket would also throttle the mail SETTINGS
    // write, which shares nothing with the test-send cost this bucket exists
    // for. `admin.ts` mounts the settings write at a DIFFERENT prefix
    // (`/admin/settings/mail`, not `/admin/mail/*`), so this also confirms
    // the two never shared a store even coincidentally.
    for (let i = 0; i < 11; i++) {
      await t.hono.request(
        '/api/v1/admin/mail/test',
        { method: 'POST', headers: authHeader(adminToken) },
        fromLoopback
      );
    }

    const res = await t.hono.request(
      '/api/v1/admin/settings/mail',
      { method: 'PUT', headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' }, body: '{}' },
      fromLoopback
    );
    expect(res.status).not.toBe(429);
  });
});

describe('dedicated POST /admin/mail/test rate-limit bucket - auth disabled (DROP-154)', () => {
  let noAuth: TestApiServer;
  const fromLoopback = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

  beforeEach(async () => {
    noAuth = await createTestApiServer({
      port: 3105,
      tempPrefix: 'drop-mail-ratelimit-noauth-',
      config: { enableAuth: false },
    });
  });

  afterEach(async () => {
    await teardownTestApiServer(noAuth);
  });

  it('still registers the mail bucket unconditionally with auth disabled', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await noAuth.hono.request(
        '/api/v1/admin/mail/test',
        { method: 'POST' },
        fromLoopback
      );
      expect(res.status).not.toBe(429);
    }

    const blocked = await noAuth.hono.request(
      '/api/v1/admin/mail/test',
      { method: 'POST' },
      fromLoopback
    );
    expect(blocked.status).toBe(429);
  });
});
