/**
 * GET/PUT/DELETE /apps/:name/access — the access-gate policy route (DROP-152).
 *
 * The first of the three refusal points. What this suite pins:
 *
 *  - the route REFUSES rather than persisting a policy the platform cannot
 *    enforce, and says which premises failed;
 *  - it is ADMIN-only, and it refuses on an auth-disabled box *in the handler*
 *    — the role middleware is registered only inside
 *    `if (enableAuth && isAuthEnabled())`, so without the handler check these
 *    paths are anonymous;
 *  - no affirmative signal is a lie: this build emits no guard, so every
 *    response reports `enforced: false`;
 *  - a successful write actually re-emits the Caddy route, and a FAILED
 *    re-emission is reported without an error status that would contradict
 *    what was persisted;
 *  - DELETE is deliberately NOT gated on enforceability.
 *
 * The verdict itself comes through `PlatformOps` and is stubbed here. That is
 * the point of the seam: the input resolution lives on the platform and is
 * covered by `platform.access-gate.test.ts`, so this suite tests the route's
 * behaviour given a verdict rather than re-deriving one from env vars.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createUser, resetAuth } from '../middleware/auth';
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
import type { AccessGateVerdict, AccessGateBlocker } from '../../managers/guardrail/access-gate';

const ENFORCEABLE: AccessGateVerdict = { enforceable: true, blockers: [], reasons: [] };
const refused = (...blockers: AccessGateBlocker[]): AccessGateVerdict => ({
  enforceable: false,
  blockers,
  reasons: blockers.map(b => `because ${b}`),
});

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

  /** Wire ops with a given verdict; everything else takes the shared defaults. */
  const wireOps = (overrides?: Partial<PlatformOps>, verdict: AccessGateVerdict = ENFORCEABLE) =>
    setPlatformOps(
      makePlatformOpsStub({
        assessAccessGate: jest.fn().mockResolvedValue(verdict),
        ...overrides,
      })
    );

  beforeEach(async () => {
    resetAppConfigService();

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

    wireOps();
  });

  afterEach(async () => {
    resetAppConfigService();
    await teardownTestApiServer(t, { activityLog: true });
  });

  describe('PUT', () => {
    it('persists the policy and re-emits the route', async () => {
      const reconfigureRoute = jest.fn().mockResolvedValue(undefined);
      wireOps({ reconfigureRoute });

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

    it('reports the gate as ENFORCED once the emitter exists', async () => {
      // The `enforced` field is the API's claim about traffic, distinct from
      // `enforceable` (a claim about the box). It was false for the whole of
      // Slice 1a because nothing emitted a guard; it is true now.
      const res = await put('myapp', adminToken, { allow: [outsiderId] });
      const body = (await res.json()) as {
        data: { enforced: boolean; message: string; notEnforcedReason?: string };
      };
      expect(body.data.enforced).toBe(true);
      expect(body.data.message).toContain('Access gate set');
      expect(body.data.notEnforcedReason).toBeUndefined();
    });

    it('records an activity entry on success', async () => {
      await put('myapp', adminToken, { allow: [outsiderId] });
      const { entries } = getActivityLog().getEntries(10);
      expect(entries.some(e => e.action === 'access-gate-set' && e.appName === 'myapp')).toBe(true);
    });

    it('refuses with the blockers the platform reported, and persists nothing', async () => {
      wireOps({}, refused('isolation-not-docker', 'no-https'));

      const res = await put('myapp', adminToken, { allow: [outsiderId] });
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: { message: string; details: { blockers: string[] } };
      };
      expect(body.error.details.blockers).toEqual(['isolation-not-docker', 'no-https']);
      // A refusal that still persisted the policy would leave the app reported
      // as gated.
      expect(getAppConfigService().getConfig('myapp')?.access).toBeUndefined();
    });

    it('refuses BEFORE validating the allow-list', async () => {
      // Reversed, an auth-disabled box answers "Unknown user id(s)" —
      // getUserById returns null for everything when there are no credentials
      // — and the operator is told their ids are wrong when the platform simply
      // has no principals. The structured refusal must win.
      wireOps({}, refused('auth-disabled'));

      const res = await put('myapp', adminToken, { allow: ['definitely-not-a-user'] });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { details: { blockers: string[] } } };
      expect(body.error.details.blockers).toContain('auth-disabled');
    });

    it('rejects an unknown user id rather than accumulating dead entries', async () => {
      const res = await put('myapp', adminToken, { allow: ['no-such-user'] });
      expect(res.status).toBe(400);
      expect(getAppConfigService().getConfig('myapp')?.access).toBeUndefined();
    });

    it('rejects duplicates, oversized lists, over-long ids and non-strings', async () => {
      expect((await put('myapp', adminToken, { allow: [outsiderId, outsiderId] })).status).toBe(400);
      expect((await put('myapp', adminToken, { allow: [42] })).status).toBe(400);
      expect((await put('myapp', adminToken, { allow: 'user-1' })).status).toBe(400);
      expect((await put('myapp', adminToken, { allow: ['x'.repeat(129)] })).status).toBe(400);
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
      const res = await put('myapp', ownerToken, { allow: [ownerId] });
      expect(res.status).toBe(403);
      expect(getAppConfigService().getConfig('myapp')?.access).toBeUndefined();
    });

    it('404s for an unknown app', async () => {
      expect((await put('ghost', adminToken, { allow: [] })).status).toBe(404);
    });

    it('409s BEFORE writing when a deploy is in flight', async () => {
      wireOps({ isAppInProgress: jest.fn().mockReturnValue(true) });

      const res = await put('myapp', adminToken, { allow: [outsiderId] });
      expect(res.status).toBe(409);
      // The pre-check is what keeps the response and the store consistent: a
      // 409 raised only by the later re-emission would already have persisted.
      expect(getAppConfigService().getConfig('myapp')?.access).toBeUndefined();
    });

    it('reports a FAILED re-emission without contradicting what was stored', async () => {
      wireOps({
        reconfigureRoute: jest.fn().mockRejectedValue(new AppInProgressError('myapp')),
      });

      const res = await put('myapp', adminToken, { allow: [outsiderId] });
      // The policy IS on disk, so an error status would describe the opposite
      // of the stored state.
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { enforced: boolean; applyError?: string } };
      expect(body.data.enforced).toBe(false);
      expect(body.data.applyError).toBeDefined();
      expect(getAppConfigService().getConfig('myapp')?.access).toBeDefined();
    });
  });

  describe('DELETE', () => {
    it('removes the gate and re-emits the route', async () => {
      await put('myapp', adminToken, { allow: [outsiderId] });
      const reconfigureRoute = jest.fn().mockResolvedValue(undefined);
      wireOps({ reconfigureRoute });

      const res = await del('myapp', adminToken);
      expect(res.status).toBe(200);
      expect(getAppConfigService().getConfig('myapp')?.access).toBeUndefined();
      expect(reconfigureRoute).toHaveBeenCalledWith('myapp');
    });

    it('still removes the gate on a box that can no longer enforce it', async () => {
      await put('myapp', adminToken, { allow: [outsiderId] });
      // The premise breaks after the fact — an operator must not be stranded
      // with a policy the platform itself reports as not applied.
      wireOps({}, refused('isolation-not-docker'));

      expect((await del('myapp', adminToken)).status).toBe(200);
      expect(getAppConfigService().getConfig('myapp')?.access).toBeUndefined();
    });

    it('409s BEFORE removing when a deploy is in flight', async () => {
      await put('myapp', adminToken, { allow: [outsiderId] });
      wireOps({ isAppInProgress: jest.fn().mockReturnValue(true) });

      expect((await del('myapp', adminToken)).status).toBe(409);
      // A 409 after the removal would tell the operator the gate is still in
      // place when it is not — the worst direction for this particular lie.
      expect(getAppConfigService().getConfig('myapp')?.access).toBeDefined();
    });

    it('is ADMIN-only', async () => {
      await put('myapp', adminToken, { allow: [outsiderId] });
      expect((await del('myapp', ownerToken)).status).toBe(403);
      expect(getAppConfigService().getConfig('myapp')?.access).toBeDefined();
    });
  });

  describe('GET', () => {
    it('separates "enforced" from "enforceable" from "applied"', async () => {
      // Three different questions, and the estate view needs all three:
      //   enforceable — could this BOX enforce a gate?
      //   enforced    — is this build's API claiming this app is gated?
      //   gateApplied — did the platform's last emission actually reach Caddy?
      // A box can be capable and the emission still have failed.
      await put('myapp', adminToken, { allow: [outsiderId] });
      await getStateManager().setAccessGateUnapplied('myapp', true);

      const res = await get('myapp', adminToken);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          access: { allow: string[] };
          enforced: boolean;
          enforceable: boolean;
          gateApplied: boolean | null;
        };
      };
      expect(body.data.access.allow).toEqual([outsiderId]);
      expect(body.data.enforceable).toBe(true);
      expect(body.data.enforced).toBe(true);
      // ...but the platform's own record says the guard is NOT in Caddy, which
      // is exactly the disagreement this field exists to surface.
      expect(body.data.gateApplied).toBe(false);
    });

    it('reports the blockers when the box cannot enforce a gate', async () => {
      wireOps({}, refused('isolation-not-docker'));
      const res = await get('myapp', adminToken);
      const body = (await res.json()) as { data: { enforceable: boolean; blockers: string[] } };
      expect(body.data.enforceable).toBe(false);
      expect(body.data.blockers).toContain('isolation-not-docker');
    });

    it('reports null for an ungated app', async () => {
      const res = await get('myapp', adminToken);
      const body = (await res.json()) as { data: { access: null; enforced: boolean } };
      expect(body.data.access).toBeNull();
      expect(body.data.enforced).toBe(false);
    });

    it('is ADMIN-only', async () => {
      expect((await get('myapp', ownerToken)).status).toBe(403);
    });
  });

  describe('on an auth-disabled box', () => {
    // `server.ts` registers the admin guard only inside
    // `if (enableAuth && isAuthEnabled())`, so with auth off NO middleware
    // covers these paths and the handlers are the only thing left. Without
    // their own check, GET is anonymous disclosure of a set of real DROP user
    // ids and DELETE is anonymous removal of a governance policy.
    beforeEach(() => {
      resetAuth();
    });

    it('refuses GET', async () => {
      const res = await t.hono.request('/api/v1/apps/myapp/access');
      expect(res.status).toBe(401);
    });

    it('refuses DELETE', async () => {
      const res = await t.hono.request('/api/v1/apps/myapp/access', { method: 'DELETE' });
      expect(res.status).toBe(401);
    });

    it('refuses PUT', async () => {
      const res = await t.hono.request('/api/v1/apps/myapp/access', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow: [] }),
      });
      expect(res.status).toBe(401);
    });
  });
});
