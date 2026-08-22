/**
 * GET/PUT/DELETE /apps/:name/access — the access-gate policy route (DROP-152).
 *
 * The first of the three refusal points. What this suite is really pinning:
 *
 *  - the route REFUSES rather than persisting a policy the platform cannot
 *    enforce, and says which premises failed;
 *  - it is ADMIN-only, so an owner cannot widen an allow-list set over their
 *    own app;
 *  - allow-list ids are validated against the credential store at write time;
 *  - a successful write actually re-emits the Caddy route — without that the
 *    policy is written and nothing running changes, which is fail-OPEN in the
 *    direction the control is sold on;
 *  - DELETE is deliberately NOT gated on enforceability: an operator must
 *    always be able to remove a control.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createUser } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager } from '../../managers/app/state-manager';
import { getActivityLog } from '../../managers/activity';
import { setPlatformOps, AppInProgressError, PlatformOps } from '../platform-ops';
import { makePlatformOpsStub } from '../__testutils__/platform-ops';
import {
  createTestApiServer,
  teardownTestApiServer,
  type TestApiServer,
} from '../__testutils__/api-server';
import {
  getAppConfigService,
  resetAppConfigService,
  type AppConfig,
} from '../../managers/app/app-config';
import { resetContainerManager } from '../../managers/runtime/container-manager';

describe('/apps/:name/access (DROP-152 access gate)', () => {
  let t: TestApiServer;
  let adminToken: string;
  let ownerToken: string;
  let ownerId: string;
  let outsiderId: string;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  const put = (name: string, token: string, body: unknown) =>
    t.hono.request(`/api/v1/apps/${name}/access`, {
      method: 'PUT',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const del = (name: string, token: string) =>
    t.hono.request(`/api/v1/apps/${name}/access`, {
      method: 'DELETE',
      headers: authHeader(token),
    });

  const get = (name: string, token: string) =>
    t.hono.request(`/api/v1/apps/${name}/access`, { headers: authHeader(token) });

  /** The one platform shape where a gate IS enforceable. */
  const enforceable = () => {
    process.env.DROP_ISOLATION = 'docker';
    process.env.DROP_ENABLE_HTTPS = 'true';
    process.env.DROP_DOMAIN_SUFFIX = 'example.com';
  };

  beforeEach(async () => {
    resetAppConfigService();
    resetContainerManager();
    delete process.env.DROP_ISOLATION;
    delete process.env.DROP_ENABLE_HTTPS;
    delete process.env.DROP_DOMAIN_SUFFIX;

    t = await createTestApiServer({
      port: 3142,
      tempPrefix: 'drop-access-gate-route-',
      activityLog: true,
    });

    await fs.mkdir(path.join(t.tempDir, 'appconf'), { recursive: true });
    await fs.mkdir(path.join(t.tempDir, 'webapps', 'myapp'), { recursive: true });
    getAppConfigService({
      configDir: path.join(t.tempDir, 'appconf'),
      webappsDir: path.join(t.tempDir, 'webapps'),
    });
    await getAppConfigService().upsertConfig('myapp', { type: 'nodejs', port: 4000 });

    await createUser('gov', 'password123', 'admin');
    adminToken = await getTestToken('gov', 'password123');
    const owner = await createUser('owner', 'password123', 'user');
    ownerId = owner.id;
    ownerToken = await getTestToken('owner', 'password123');
    const outsider = await createUser('reviewer', 'password123', 'user');
    outsiderId = outsider.id;

    const sm = getStateManager();
    await sm.registerApp('myapp', path.join(t.tempDir, 'webapps', 'myapp'), 'nodejs');
    await sm.updateApp('myapp', { userId: ownerId, port: 4000 });

    setPlatformOps(makePlatformOpsStub());
    enforceable();
  });

  afterEach(async () => {
    delete process.env.DROP_ISOLATION;
    delete process.env.DROP_ENABLE_HTTPS;
    delete process.env.DROP_DOMAIN_SUFFIX;
    resetAppConfigService();
    resetContainerManager();
    await teardownTestApiServer(t, { activityLog: true });
  });

  describe('PUT', () => {
    it('persists the policy and re-emits the route', async () => {
      const reconfigureRoute = jest.fn().mockResolvedValue(undefined);
      setPlatformOps(makePlatformOpsStub({ reconfigureRoute }));

      const res = await put('myapp', adminToken, { allow: [outsiderId] });
      expect(res.status).toBe(200);

      const body = (await res.json()) as { data: { access: AppConfig['access'] } };
      expect(body.data.access).toEqual({ mode: 'drop-users', allow: [outsiderId] });
      expect(getAppConfigService().getConfig('myapp')?.access).toEqual({
        mode: 'drop-users',
        allow: [outsiderId],
      });
      // Without this the Caddyfile keeps the previous, ungated block.
      expect(reconfigureRoute).toHaveBeenCalledWith('myapp');
    });

    it('records an activity entry only on success', async () => {
      await put('myapp', adminToken, { allow: [outsiderId] });
      const { entries } = getActivityLog().getEntries(10);
      expect(entries.some(e => e.action === 'access-gate-set' && e.appName === 'myapp')).toBe(true);
    });

    it('refuses outside docker isolation, naming the blocker', async () => {
      process.env.DROP_ISOLATION = 'none';

      const res = await put('myapp', adminToken, { allow: [outsiderId] });
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: { message: string; details: { blockers: string[] } };
      };
      expect(body.error.details.blockers).toContain('isolation-not-docker');
      // And nothing was written — a refusal that still persisted the policy
      // would leave the app reported as gated.
      expect(getAppConfigService().getConfig('myapp')?.access).toBeUndefined();
    });

    it('refuses without HTTPS', async () => {
      process.env.DROP_ENABLE_HTTPS = 'false';

      const res = await put('myapp', adminToken, { allow: [outsiderId] });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { details: { blockers: string[] } } };
      expect(body.error.details.blockers).toContain('no-https');
    });

    it('refuses a monorepo group child', async () => {
      await getAppConfigService().updateConfig('myapp', { group: 'ezsign' });

      const res = await put('myapp', adminToken, { allow: [outsiderId] });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { details: { blockers: string[] } } };
      expect(body.error.details.blockers).toContain('monorepo-group-child');
    });

    it('rejects an unknown user id rather than accumulating dead entries', async () => {
      const res = await put('myapp', adminToken, { allow: ['no-such-user'] });
      expect(res.status).toBe(400);
      expect(getAppConfigService().getConfig('myapp')?.access).toBeUndefined();
    });

    it('rejects duplicates, oversized lists and non-string entries', async () => {
      expect((await put('myapp', adminToken, { allow: [outsiderId, outsiderId] })).status).toBe(400);
      expect((await put('myapp', adminToken, { allow: [42] })).status).toBe(400);
      expect((await put('myapp', adminToken, { allow: 'user-1' })).status).toBe(400);
      expect(
        (await put('myapp', adminToken, { allow: Array.from({ length: 201 }, (_, i) => `u${i}`) }))
          .status
      ).toBe(400);
    });

    it('accepts an empty allow-list — owner and admins only', async () => {
      const res = await put('myapp', adminToken, { allow: [] });
      expect(res.status).toBe(200);
      expect(getAppConfigService().getConfig('myapp')?.access).toEqual({
        mode: 'drop-users',
        allow: [],
      });
    });

    it('is ADMIN-only: the app OWNER cannot set or widen the gate', async () => {
      // A governance control the governed party can rewrite is not a control.
      const res = await put('myapp', ownerToken, { allow: [ownerId] });
      expect(res.status).toBe(403);
      expect(getAppConfigService().getConfig('myapp')?.access).toBeUndefined();
    });

    it('404s for an unknown app', async () => {
      expect((await put('ghost', adminToken, { allow: [] })).status).toBe(404);
    });

    it('409s when a deploy is in flight', async () => {
      setPlatformOps(
        makePlatformOpsStub({
          reconfigureRoute: jest.fn().mockRejectedValue(new AppInProgressError('myapp')),
        }) as PlatformOps
      );
      const res = await put('myapp', adminToken, { allow: [outsiderId] });
      expect(res.status).toBe(409);
    });
  });

  describe('DELETE', () => {
    it('removes the gate and re-emits the route', async () => {
      await put('myapp', adminToken, { allow: [outsiderId] });
      const reconfigureRoute = jest.fn().mockResolvedValue(undefined);
      setPlatformOps(makePlatformOpsStub({ reconfigureRoute }));

      const res = await del('myapp', adminToken);
      expect(res.status).toBe(200);
      expect(getAppConfigService().getConfig('myapp')?.access).toBeUndefined();
      expect(reconfigureRoute).toHaveBeenCalledWith('myapp');
    });

    it('still removes the gate on a box that can no longer enforce it', async () => {
      await put('myapp', adminToken, { allow: [outsiderId] });
      // The premise breaks after the fact — an operator must not be stranded
      // with a policy the platform itself reports as not applied.
      process.env.DROP_ISOLATION = 'none';

      expect((await del('myapp', adminToken)).status).toBe(200);
      expect(getAppConfigService().getConfig('myapp')?.access).toBeUndefined();
    });

    it('is ADMIN-only', async () => {
      await put('myapp', adminToken, { allow: [outsiderId] });
      expect((await del('myapp', ownerToken)).status).toBe(403);
      expect(getAppConfigService().getConfig('myapp')?.access).toBeDefined();
    });
  });

  describe('GET', () => {
    it('reports the policy alongside the live enforceability verdict', async () => {
      await put('myapp', adminToken, { allow: [outsiderId] });
      process.env.DROP_ISOLATION = 'none';

      const res = await get('myapp', adminToken);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { access: { allow: string[] }; enforceable: boolean; blockers: string[] };
      };
      expect(body.data.access.allow).toEqual([outsiderId]);
      // The dashboard must be able to say "gate NOT applied" rather than
      // implying protection from the persisted policy alone.
      expect(body.data.enforceable).toBe(false);
      expect(body.data.blockers).toContain('isolation-not-docker');
    });

    it('reports null for an ungated app', async () => {
      const res = await get('myapp', adminToken);
      const body = (await res.json()) as { data: { access: null } };
      expect(body.data.access).toBeNull();
    });

    it('is ADMIN-only', async () => {
      expect((await get('myapp', ownerToken)).status).toBe(403);
    });
  });
});
