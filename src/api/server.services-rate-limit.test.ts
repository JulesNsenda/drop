/**
 * The apps/:name/services/:id routes get their OWN rate-limit bucket
 * (DROP-151 Phase 3), distinct from the db/:name one — see server.ts's
 * comment on the registration and rate-limit.ts's
 * `servicesRateLimitMiddleware`. Before this change both paths shared the
 * same named store, so a detach burst against one client would 429 the
 * database panel for that same client mid-incident — exactly the failure the
 * db bucket's own comment says it exists to prevent. This is a real,
 * route-level 429 assertion, not a middleware unit test — see
 * rate-limit.test.ts for those.
 *
 * Follows the standalone-ApiServer harness used throughout src/api/routes
 * (e.g. apps.services.routes.test.ts, db.routes.test.ts) — no real platform
 * is booted.
 */

import { createUser } from './middleware/auth';
import { getTestToken } from './__testutils__/auth';
import { createTestApiServer, teardownTestApiServer, type TestApiServer } from './__testutils__/api-server';
import { makePlatformOpsStub } from './__testutils__/platform-ops';
import { getStateManager } from '../managers/app/state-manager';
import { setPlatformOps } from './platform-ops';
import * as path from 'path';

describe('dedicated /apps/*/services/* rate-limit bucket (DROP-151 Phase 3)', () => {
  let t: TestApiServer;
  let ownerToken: string;
  let ownerId: string;

  // A fixed, loopback-trusted peer so the limiter's per-IP key is stable
  // across every request in this file (matches rate-limit.test.ts's own
  // pattern for driving the getClientIp XFF-trust path deterministically).
  const fromLoopback = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
  const authHeader = (token: string) => ({
    Authorization: `Bearer ${token}`,
    'x-forwarded-for': '10.10.10.10',
  });

  beforeEach(async () => {
    t = await createTestApiServer({ port: 3101, tempPrefix: 'drop-services-ratelimit-' });

    const owner = await createUser('services-owner', 'password123', 'user');
    ownerId = owner.id;
    ownerToken = await getTestToken('services-owner', 'password123');

    const sm = getStateManager();
    await sm.registerApp('test-app', path.join(t.tempDir, 'test-app'));
    await sm.updateApp('test-app', { userId: ownerId });

    setPlatformOps(makePlatformOpsStub());
  });

  afterEach(async () => {
    await teardownTestApiServer(t);
  });

  it('429s the services bucket once its own cap (20/min) is exceeded', async () => {
    for (let i = 0; i < 20; i++) {
      const res = await t.hono.request(
        '/api/v1/apps/test-app/services/postgres',
        { method: 'DELETE', headers: authHeader(ownerToken) },
        fromLoopback
      );
      expect(res.status).not.toBe(429);
    }

    const blocked = await t.hono.request(
      '/api/v1/apps/test-app/services/postgres',
      { method: 'DELETE', headers: authHeader(ownerToken) },
      fromLoopback
    );
    expect(blocked.status).toBe(429);
  });

  it('does NOT 429 GET /db/:name once the services bucket alone is exhausted (the bug this bucket split fixes)', async () => {
    // Drain the SERVICES bucket only.
    for (let i = 0; i < 21; i++) {
      await t.hono.request(
        '/api/v1/apps/test-app/services/postgres',
        { method: 'DELETE', headers: authHeader(ownerToken) },
        fromLoopback
      );
    }

    // Same client, same IP, immediately after — the /db/* bucket is a
    // SEPARATE counter, so this must not be 429 even though the services
    // bucket above is already exhausted. (No DB provisioner is wired in this
    // standalone harness, so the exact status is 404/503 depending on the
    // real db-inspector's fallback — the only thing under test here is that
    // it is NOT rate-limited.)
    const res = await t.hono.request(
      '/api/v1/db/test-app',
      { headers: authHeader(ownerToken) },
      fromLoopback
    );
    expect(res.status).not.toBe(429);
  });
});
