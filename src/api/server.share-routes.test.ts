/**
 * DROP-153 owner-sharing routes get their OWN rate-limit bucket AND their own
 * explicit role floor, registered on BOTH path forms - mirroring
 * `server.services-rate-limit.test.ts`'s precedent for the same
 * '/apps/wildcard/services' shape, and confirming the plan's measured claim
 * (Approach item 5, `server.ts:315-324`) the other way round: the two-segment
 * `/apps/wildcard/share` form alone would leave
 * `DELETE /apps/:name/share/:userId` with neither a dedicated bucket nor an
 * explicit role floor.
 *
 * Every assertion here is about middleware behaviour (rate-limit
 * headers/429, auth 401/403) that fires BEFORE Hono resolves a handler, so it
 * holds whether the routes are a real handler or a 404. Uses the real, nested
 * `ApiServer` (built via
 * `v1.route('/apps', appsRoutes)`) rather than a flat test app - this repo's
 * own note (server.ts:465-472, and the plan's Approach item 5) is that Hono
 * guard matching on a flat app gives the opposite answer to how it is
 * actually mounted.
 */

import { createUser } from './middleware/auth';
import { getTestToken } from './__testutils__/auth';
import { createTestApiServer, teardownTestApiServer, type TestApiServer } from './__testutils__/api-server';
import { getStateManager } from '../managers/app/state-manager';
import * as path from 'path';

describe('dedicated /apps/*/share* rate-limit bucket and role floor (DROP-153)', () => {
  let t: TestApiServer;
  let ownerToken: string;
  let readonlyToken: string;
  let adminToken: string;
  let ownerId: string;

  // A fixed, loopback-trusted peer so the limiter's per-IP key is stable
  // across every request in this file (matches server.services-rate-limit.test.ts).
  const fromLoopback = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
  const authHeader = (token: string) => ({
    Authorization: `Bearer ${token}`,
    'x-forwarded-for': '10.10.10.10',
  });

  beforeEach(async () => {
    t = await createTestApiServer({ port: 3102, tempPrefix: 'drop-share-ratelimit-' });

    const owner = await createUser('share-owner', 'password123', 'user');
    ownerId = owner.id;
    ownerToken = await getTestToken('share-owner', 'password123');

    await createUser('share-readonly', 'password123', 'readonly');
    readonlyToken = await getTestToken('share-readonly', 'password123');

    await createUser('share-admin', 'password123', 'admin');
    adminToken = await getTestToken('share-admin', 'password123');

    const sm = getStateManager();
    await sm.registerApp('test-app', path.join(t.tempDir, 'test-app'));
    await sm.updateApp('test-app', { userId: ownerId });
  });

  afterEach(async () => {
    await teardownTestApiServer(t);
  });

  describe('DELETE /apps/:name/share/:userId', () => {
    it('429s the dedicated share bucket once its own cap (20/min) is exceeded', async () => {
      for (let i = 0; i < 20; i++) {
        const res = await t.hono.request(
          '/api/v1/apps/test-app/share/some-user-id',
          { method: 'DELETE', headers: authHeader(ownerToken) },
          fromLoopback
        );
        expect(res.status).not.toBe(429);
      }

      const blocked = await t.hono.request(
        '/api/v1/apps/test-app/share/some-user-id',
        { method: 'DELETE', headers: authHeader(ownerToken) },
        fromLoopback
      );
      expect(blocked.status).toBe(429);
    });

    it('rejects an unauthenticated caller with 401 (role floor is registered)', async () => {
      const res = await t.hono.request(
        '/api/v1/apps/test-app/share/some-user-id',
        { method: 'DELETE' },
        fromLoopback
      );
      expect(res.status).toBe(401);
    });

    it('rejects a readonly-role token with 403 (floor is user, not readonly)', async () => {
      const res = await t.hono.request(
        '/api/v1/apps/test-app/share/some-user-id',
        { method: 'DELETE', headers: authHeader(readonlyToken) },
        fromLoopback
      );
      expect(res.status).toBe(403);
    });
  });

  describe('GET/POST /apps/:name/share', () => {
    // Measured on this tree's Hono (4.13.3), against the named-param
    // registration in server.ts (`/apps/:name/share` + `/apps/:name/share/:userId`):
    // a two-segment path matches ONLY the two-segment pattern - `:userId`
    // requires a fourth segment that isn't there, so unlike the wildcard pair
    // this used to be, there is no double count. Same nominal 20/min budget
    // as the DELETE form below.
    it('429s the dedicated share bucket at its nominal cap (20/min), same as the DELETE form', async () => {
      for (let i = 0; i < 20; i++) {
        const res = await t.hono.request(
          '/api/v1/apps/test-app/share',
          { method: 'GET', headers: authHeader(ownerToken) },
          fromLoopback
        );
        expect(res.status).not.toBe(429);
      }

      const blocked = await t.hono.request(
        '/api/v1/apps/test-app/share',
        { method: 'GET', headers: authHeader(ownerToken) },
        fromLoopback
      );
      expect(blocked.status).toBe(429);
    });

    it('rejects an unauthenticated caller with 401 (role floor is registered)', async () => {
      const res = await t.hono.request('/api/v1/apps/test-app/share', { method: 'POST' }, fromLoopback);
      expect(res.status).toBe(401);
    });

    it('rejects a readonly-role token with 403 (floor is user, not readonly)', async () => {
      const res = await t.hono.request(
        '/api/v1/apps/test-app/share',
        { method: 'POST', headers: authHeader(readonlyToken) },
        fromLoopback
      );
      expect(res.status).toBe(403);
    });
  });

  it('does NOT 429 GET /apps/:name/access once the share bucket alone is exhausted (separate bucket, DROP-151-style)', async () => {
    // Drain the SHARE bucket only.
    for (let i = 0; i < 21; i++) {
      await t.hono.request(
        '/api/v1/apps/test-app/share',
        { method: 'GET', headers: authHeader(ownerToken) },
        fromLoopback
      );
    }

    // Same client, same IP, immediately after - /apps/*/access uses the
    // SEPARATE `services` bucket, so this must not be 429 even though the
    // share bucket above is already exhausted.
    const res = await t.hono.request(
      '/api/v1/apps/test-app/access',
      { method: 'GET', headers: authHeader(adminToken) },
      fromLoopback
    );
    expect(res.status).not.toBe(429);
  });

  it('/apps/:name/access is unaffected by this slice and still requires admin', async () => {
    // Owner (role 'user') is not admin - still refused.
    const ownerRes = await t.hono.request(
      '/api/v1/apps/test-app/access',
      { method: 'GET', headers: authHeader(ownerToken) },
      fromLoopback
    );
    expect(ownerRes.status).toBe(403);

    // Admin gets past the role floor (whatever the handler itself then does).
    const adminRes = await t.hono.request(
      '/api/v1/apps/test-app/access',
      { method: 'GET', headers: authHeader(adminToken) },
      fromLoopback
    );
    expect(adminRes.status).not.toBe(403);
    expect(adminRes.status).not.toBe(401);
  });
});

// A separate top-level describe, deliberately NOT nested inside the one
// above: nesting it would inherit that describe's outer beforeEach/afterEach
// (which create/teardown their own `t` against the same AppStateManager
// singleton), and the two teardowns racing on that singleton is exactly what
// produced a spurious "StateManager config required on first call" failure
// during development of this suite.
describe('dedicated /apps/*/share* rate-limit bucket - auth disabled (DROP-153)', () => {
  let noAuth: TestApiServer;
  const fromLoopback = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

  beforeEach(async () => {
    noAuth = await createTestApiServer({
      port: 3103,
      tempPrefix: 'drop-share-ratelimit-noauth-',
      config: { enableAuth: false },
    });
    const sm = getStateManager();
    await sm.registerApp('test-app', path.join(noAuth.tempDir, 'test-app'));
  });

  afterEach(async () => {
    await teardownTestApiServer(noAuth);
  });

  it('still registers the share bucket unconditionally with auth disabled', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await noAuth.hono.request(
        '/api/v1/apps/test-app/share/some-user-id',
        { method: 'DELETE' },
        fromLoopback
      );
      expect(res.status).not.toBe(429);
    }

    const blocked = await noAuth.hono.request(
      '/api/v1/apps/test-app/share/some-user-id',
      { method: 'DELETE' },
      fromLoopback
    );
    expect(blocked.status).toBe(429);
  });
});
