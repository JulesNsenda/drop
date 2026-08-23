/**
 * GET/POST/DELETE /apps/:name/share — owner-initiated app sharing (DROP-153).
 *
 * What this suite pins:
 *
 *  - the owner (not just an admin) can grant, list and revoke access;
 *  - a non-owner gets 404, never 403 (no existence oracle);
 *  - only a BROWSER SESSION may use these routes — an API key or an agent
 *    token is refused even when it resolves to the app's own owner;
 *  - the `appSharingEnabled` platform toggle refuses all four routes when off;
 *  - the enforceability 409 applies to POST only — revoke/clear always work;
 *  - `{ gateApp: true }` is required to create a policy where none exists;
 *  - provenance (`grantedBy`) is respected both ways: an owner can only see
 *    and revoke their OWN grants, and can only clear an all-owner policy;
 *  - owner/admin/suspended targets are refused, and a re-grant at exactly the
 *    cap is idempotent rather than tripping it;
 *  - the route is re-emitted on create or on `accessGateUnapplied`, never on
 *    an ordinary grant/revoke to an already-applied gate;
 *  - a malformed app name is rejected before any handler runs.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createUser, createApiKey, suspendUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager } from '../../managers/app/state-manager';
import { getActivityLog } from '../../managers/activity';
import { setPlatformOps, getPlatformOps, resetPlatformOps, PlatformOps } from '../platform-ops';
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
import { getSettingsManager, resetSettingsManager } from '../../managers/settings/settings-manager';
import type { AccessGateVerdict, AccessGateBlocker } from '../../managers/guardrail/access-gate';
import { MAX_USER_ID_LENGTH } from './access-limits';
import * as atomicWrite from '../../utils/atomic-write';

const ENFORCEABLE: AccessGateVerdict = {
  enforceable: true,
  blockers: [],
  reasons: [],
  featureEnabled: true,
};
const refused = (...blockers: AccessGateBlocker[]): AccessGateVerdict => ({
  enforceable: false,
  blockers,
  reasons: blockers.map(b => `because ${b}`),
  featureEnabled: true,
});
// The platform's own switch, as opposed to a box-level misconfiguration —
// the two must read differently to an owner (Gate 2 fix #8).
const featureDisabled: AccessGateVerdict = {
  enforceable: false,
  blockers: ['feature-disabled'],
  reasons: ['because feature-disabled'],
  featureEnabled: false,
};

describe('/apps/:name/share (DROP-153 owner sharing)', () => {
  let t: TestApiServer;
  let adminToken: string;
  let ownerToken: string;
  let ownerId: string;
  let outsiderToken: string;
  let targetUsername: string;
  let targetId: string;
  let adminId: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  const get = (name: string, headers: Record<string, string>) =>
    t.hono.request(`/api/v1/apps/${name}/share`, { headers });

  const post = (name: string, headers: Record<string, string>, body: unknown) =>
    t.hono.request(`/api/v1/apps/${name}/share`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const del = (name: string, headers: Record<string, string>) =>
    t.hono.request(`/api/v1/apps/${name}/share`, { method: 'DELETE', headers });

  const delOne = (name: string, userId: string, headers: Record<string, string>) =>
    t.hono.request(`/api/v1/apps/${name}/share/${userId}`, { method: 'DELETE', headers });

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
    resetSettingsManager();

    t = await createTestApiServer({
      port: 3143,
      tempPrefix: 'drop-share-route-',
      activityLog: true,
    });

    await fs.mkdir(path.join(t.tempDir, 'appconf'), { recursive: true });
    await fs.mkdir(path.join(t.tempDir, 'webapps', 'myapp'), { recursive: true });
    getAppConfigService({
      configDir: path.join(t.tempDir, 'appconf'),
      webappsDir: path.join(t.tempDir, 'webapps'),
    });
    await getAppConfigService().upsertConfig('myapp', { type: 'nodejs', port: 4000 });

    // Baked TRUE by default — feature-off is driven by an explicit override
    // in the one test that needs it.
    getSettingsManager({ settingsFilePath: path.join(t.tempDir, 'settings.json') });
    await getSettingsManager().setAppSharingEnabled(true);

    const admin = await createUser('gov', 'password123', 'admin');
    adminId = admin.id;
    adminToken = await getTestToken('gov', 'password123');
    const owner = await createUser('owner', 'password123', 'user');
    ownerId = owner.id;
    ownerToken = await getTestToken('owner', 'password123');
    await createUser('outsider', 'password123', 'user');
    outsiderToken = await getTestToken('outsider', 'password123');
    const target = await createUser('alice', 'password123', 'user');
    targetId = target.id;
    targetUsername = 'alice';

    const sm = getStateManager();
    await sm.registerApp('myapp', path.join(t.tempDir, 'webapps', 'myapp'), 'nodejs');
    await sm.updateApp('myapp', { userId: ownerId, port: 4000 });

    wireOps();
  });

  afterEach(async () => {
    resetAppConfigService();
    resetSettingsManager();
    // Tolerate the temp-dir removal failing, matching auth.app-mcp-token.test.ts.
    // `teardownTestApiServer` already retries (5 × 100ms), which is enough when
    // this file runs alone — but the cap test below writes 200 credential
    // records, and under a full-suite run those atomic writes can still have a
    // handle open on Windows when the rmdir lands, failing the whole suite with
    // ENOTEMPTY on a directory the OS reaps anyway. The cleanup carries no
    // assertion value; swallowing it here keeps a real failure legible instead
    // of drowning it in a teardown race.
    await teardownTestApiServer(t, { activityLog: true }).catch(() => undefined);
  });

  describe('POST (grant)', () => {
    it('lets the owner grant one person, with gateApp:true creating the policy', async () => {
      const res = await post('myapp', bearer(ownerToken), {
        username: targetUsername,
        gateApp: true,
      });
      expect(res.status).toBe(200);
      const cfg = getAppConfigService().getConfig('myapp') as AppConfig;
      expect(cfg.access?.allow).toEqual([targetId]);
      expect(cfg.access?.grantedBy).toEqual({ [targetId]: ownerId });
      const { entries } = getActivityLog().getEntries(10);
      expect(
        entries.some(e => e.action === 'access-share-granted' && e.appName === 'myapp')
      ).toBe(true);
    });

    it('lets an admin grant too', async () => {
      const res = await post('myapp', bearer(adminToken), {
        username: targetUsername,
        gateApp: true,
      });
      expect(res.status).toBe(200);
      const cfg = getAppConfigService().getConfig('myapp') as AppConfig;
      expect(cfg.access?.grantedBy).toEqual({ [targetId]: adminId });
    });

    it('refuses a non-owner with 404, not 403 — no existence oracle', async () => {
      const res = await post('myapp', bearer(outsiderToken), {
        username: targetUsername,
        gateApp: true,
      });
      expect(res.status).toBe(404);
    });

    it('refuses an API key even when it resolves to the owner', async () => {
      const key = await createApiKey('owner-key', 'user', undefined, undefined, ownerId);
      const res = await post('myapp', { 'X-API-Key': key.key }, {
        username: targetUsername,
        gateApp: true,
      });
      expect(res.status).toBe(403);
    });

    it('refuses an agent token even when it resolves to the owner', async () => {
      const key = await createApiKey('owner-agent', 'user', undefined, undefined, ownerId, {
        kind: 'agent',
      });
      const res = await post('myapp', { 'X-API-Key': key.key }, {
        username: targetUsername,
        gateApp: true,
      });
      expect(res.status).toBe(403);
    });

    it('refuses when owner-initiated sharing is disabled', async () => {
      await getSettingsManager().setAppSharingEnabled(false);
      const res = await post('myapp', bearer(ownerToken), {
        username: targetUsername,
        gateApp: true,
      });
      expect(res.status).toBe(403);
    });

    it('409s when the box cannot enforce a gate', async () => {
      wireOps({}, refused('isolation-not-docker'));
      const res = await post('myapp', bearer(ownerToken), {
        username: targetUsername,
        gateApp: true,
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { details: { blockers: string[] } } };
      // Blocker codes only — never the operator-prose `reasons` (owner-reachable route).
      expect(body.error.details.blockers).toEqual(['isolation-not-docker']);
      expect(JSON.stringify(body)).not.toContain('because isolation-not-docker');
    });

    it('requires gateApp:true to create a policy where none exists', async () => {
      const res = await post('myapp', bearer(ownerToken), { username: targetUsername });
      expect(res.status).toBe(409);
      expect(getAppConfigService().getConfig('myapp')?.access).toBeUndefined();
    });

    it('does not require gateApp on a SECOND grant to an already-gated app', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      const bob = await createUser('bob', 'password123', 'user');
      const res = await post('myapp', bearer(ownerToken), { username: 'bob' });
      expect(res.status).toBe(200);
      expect(getAppConfigService().getConfig('myapp')?.access?.allow).toEqual(
        expect.arrayContaining([targetId, bob.id])
      );
    });

    it('refuses the app owner as a target', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      const res = await post('myapp', bearer(ownerToken), { username: 'owner' });
      expect(res.status).toBe(400);
    });

    it('refuses an admin as a target', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      const res = await post('myapp', bearer(ownerToken), { username: 'gov' });
      expect(res.status).toBe(400);
    });

    it('refuses a suspended target', async () => {
      await suspendUser(targetId);
      const res = await post('myapp', bearer(ownerToken), {
        username: targetUsername,
        gateApp: true,
      });
      expect(res.status).toBe(400);
    });

    it('is idempotent: a re-grant returns 200 without erroring, even at the cap', async () => {
      // Fill the allow-list to exactly the cap, then re-grant an entry already
      // on it — the idempotent short-circuit must win BEFORE the cap check.
      //
      // Exactly ONE of the 200 entries is a real account: the one being
      // re-granted, which is the only id any code path here resolves (the
      // grant re-resolves its TARGET inside the write closure; the cap only
      // counts array length, and carryForwardGrantedBy does not validate).
      // The other 199 are synthetic filler. An earlier version created 200
      // real users — 200 password hashes and credential writes — which passed
      // alone at ~19s and then blew even a 30s timeout under a full-suite run.
      // The filler was never the behaviour under test, so making it real only
      // bought flakiness.
      const existing = await createUser('capholder', 'password123', 'user');
      const filler = Array.from({ length: 199 }, (_, i) => `synthetic-${i}`);
      const allow = [existing.id, ...filler];
      await getAppConfigService().setAccessPolicy('myapp', () => ({
        mode: 'drop-users' as const,
        allow,
        grantedBy: Object.fromEntries(allow.map(id => [id, ownerId])),
      }));

      const res = await post('myapp', bearer(ownerToken), { username: 'capholder' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { message: string } };
      // Uniform wording (Gate 2 fix #4) — see the dedicated oracle test below
      // for why this must not read differently from a fresh grant.
      expect(body.data.message).toBe(`'capholder' has access to 'myapp'.`);

      // A genuinely NEW grant at 200 entries trips the cap.
      const res2 = await post('myapp', bearer(ownerToken), { username: targetUsername });
      expect(res2.status).toBe(409);
    });

    it('returns the SAME success message for a fresh grant and a re-grant (no membership oracle)', async () => {
      const res1 = await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      const body1 = (await res1.json()) as { data: { message: string } };
      const res2 = await post('myapp', bearer(ownerToken), { username: targetUsername });
      const body2 = (await res2.json()) as { data: { message: string } };
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(body1.data.message).toBe(body2.data.message);
      expect(body1.data.message).toBe(`'${targetUsername}' has access to 'myapp'.`);
    });

    it('does not rewrite the config on a refused/no-op grant (Gate 2 fix #6, NO_CHANGE)', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      const before = getAppConfigService().getConfig('myapp');
      // Already-granted — a no-op that must not touch the stored config.
      // `saveConfig` (app-config.ts) replaces the map entry with a NEW
      // object on every real write, so object identity is the discriminator
      // between "a write ran" and "the NO_CHANGE sentinel skipped it".
      const res = await post('myapp', bearer(ownerToken), { username: targetUsername });
      expect(res.status).toBe(200);
      expect(getAppConfigService().getConfig('myapp')).toBe(before);
    });

    it("never echoes an admin-authored entry back in the success response (Gate 2 fix #4)", async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      const govTarget = await createUser('gov-target', 'password123', 'user');
      await getAppConfigService().setAccessPolicy('myapp', existing => ({
        mode: 'drop-users' as const,
        allow: [...(existing.access?.allow ?? []), govTarget.id],
        grantedBy: existing.access?.grantedBy, // govTarget.id absent — admin-authored
      }));
      await createUser('carol2', 'password123', 'user');
      const res = await post('myapp', bearer(ownerToken), { username: 'carol2' });
      const body = await res.json();
      expect(JSON.stringify(body)).not.toContain(govTarget.id);
      expect(JSON.stringify(body)).not.toContain('gov-target');
    });

    it('refuses all four ineligible-target reasons with one generic message — no account-existence/role/suspension oracle (Gate 2 fix #3)', async () => {
      await suspendUser(targetId);
      const cases = ['nobody-at-all', 'owner', 'gov', targetUsername];
      const shapes: string[] = [];
      for (const username of cases) {
        const res = await post('myapp', bearer(ownerToken), { username, gateApp: true });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { message: string; code: string } };
        expect(body.error.message).toBe(`'${username}' cannot be granted access to 'myapp'.`);
        shapes.push(JSON.stringify({ code: body.error.code, keys: Object.keys(body.error).sort() }));
      }
      // Same shape (code + keys) across every reason — none of them is
      // distinguishable from the response alone.
      expect(new Set(shapes).size).toBe(1);
    });

    it('names the platform feature switch as the cause, distinct from a misconfiguration (Gate 2 fix #8)', async () => {
      wireOps({}, featureDisabled);
      const res = await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toMatch(/administrator must enable it/);
    });

    it('names a misconfiguration distinctly from the feature switch (Gate 2 fix #8)', async () => {
      wireOps({}, refused('isolation-not-docker'));
      const res = await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).not.toMatch(/administrator must enable it/);
    });

    it('names the admin/owner split in the cap refusal instead of an impossible "remove someone" (Gate 2 fix #11)', async () => {
      // THREE shapes, deliberately, not two — the count must catch both an
      // entry with no `grantedBy` value at all (legacy/full-`/access`
      // admin-authored) AND one an admin granted VIA THIS ROUTE
      // (`grantedBy[id] = adminId`, a real value, just not the owner's own).
      // Fix #11's first draft counted only the former — exactly the
      // "has some grantedBy value" conflation fix #1 exists to kill,
      // reappearing in the cap message.
      const legacyAdminAuthored = Array.from({ length: 75 }, (_, i) => `legacy-admin-${i}`);
      const adminViaShare = Array.from({ length: 75 }, (_, i) => `admin-via-share-${i}`);
      const ownerGranted = Array.from({ length: 50 }, (_, i) => `owner-filler-${i}`);
      const allow = [...legacyAdminAuthored, ...adminViaShare, ...ownerGranted];
      await getAppConfigService().setAccessPolicy('myapp', () => ({
        mode: 'drop-users' as const,
        allow,
        // legacy-admin-* ids absent from grantedBy entirely; admin-via-share-*
        // ids present but attributed to the admin, not the owner.
        grantedBy: {
          ...Object.fromEntries(adminViaShare.map(id => [id, adminId])),
          ...Object.fromEntries(ownerGranted.map(id => [id, ownerId])),
        },
      }));

      const res = await post('myapp', bearer(ownerToken), { username: targetUsername });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string } };
      // Both shapes count — 150, not 75.
      expect(body.error.message).toContain('150');
      expect(body.error.message).toContain('administrator');
    });

    it('resolves the not-gated-yet confirmation against write-time state, not a pre-write snapshot (Gate 2 fix #2)', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      expect(getAppConfigService().getConfig('myapp')?.access).toBeDefined();

      // Simulate an admin's DELETE /access landing between this request's
      // precondition checks and the write actually executing: the clear
      // runs FIRST, then the owner's real updater runs against whatever the
      // clear left behind.
      const svc = getAppConfigService();
      const real = svc.setAccessPolicy.bind(svc);
      const spy = jest
        .spyOn(svc, 'setAccessPolicy')
        .mockImplementation(async (name: unknown, arg: unknown) => {
          // The clear, in the updater form `setAccessPolicy` now takes.
          await real(name as string, () => undefined);
          return real(name as string, arg as never);
        });

      await createUser('bob3', 'password123', 'user');
      const res = await post('myapp', bearer(ownerToken), { username: 'bob3' });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain('gateApp');
      // The admin's clear WINS — no policy resurrected without the owner
      // having acknowledged it, even though the request-time snapshot said
      // the app was already gated.
      expect(getAppConfigService().getConfig('myapp')?.access).toBeUndefined();

      spy.mockRestore();
    });

    it("audits an admin's grant through /share distinctly from an owner's own (Gate 2 fix #10)", async () => {
      await post('myapp', bearer(adminToken), { username: targetUsername, gateApp: true });
      const { entries } = getActivityLog().getEntries(10);
      const entry = entries.find(e => e.action === 'access-share-granted' && e.appName === 'myapp');
      expect(entry?.detail).toContain('admin-granted');
    });

    it("does not tag an owner's own grant as admin-granted", async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      const { entries } = getActivityLog().getEntries(10);
      const entry = entries.find(e => e.action === 'access-share-granted' && e.appName === 'myapp');
      expect(entry?.detail).toBe(targetUsername);
    });

    it("409s with 'still being deployed' before the app has a config file", async () => {
      await getStateManager().registerApp('pending-app', path.join(t.tempDir, 'webapps', 'pending-app'));
      await getStateManager().updateApp('pending-app', { userId: ownerId });
      const res = await post('pending-app', bearer(ownerToken), {
        username: targetUsername,
        gateApp: true,
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain('still being deployed');
    });

    it('re-emits the route on first grant (creation)', async () => {
      const reconfigureRoute = jest.fn().mockResolvedValue(undefined);
      wireOps({ reconfigureRoute });
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      expect(reconfigureRoute).toHaveBeenCalledWith('myapp');
    });

    it('does NOT re-emit on an ordinary grant to an already-applied gate', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      await getStateManager().setAccessGateUnapplied('myapp', false);
      const reconfigureRoute = jest.fn().mockResolvedValue(undefined);
      wireOps({ reconfigureRoute });

      await createUser('carol', 'password123', 'user');
      await post('myapp', bearer(ownerToken), { username: 'carol' });
      expect(reconfigureRoute).not.toHaveBeenCalled();
    });

    it('DOES re-emit when the platform recorded the last apply as unapplied', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      await getStateManager().setAccessGateUnapplied('myapp', true);
      const reconfigureRoute = jest.fn().mockResolvedValue(undefined);
      wireOps({ reconfigureRoute });

      await createUser('dave', 'password123', 'user');
      await post('myapp', bearer(ownerToken), { username: 'dave' });
      expect(reconfigureRoute).toHaveBeenCalledWith('myapp');
    });

    it('rejects a malformed app name before any handler runs', async () => {
      const res = await post('..%2fetc', bearer(ownerToken), {
        username: targetUsername,
        gateApp: true,
      });
      expect(res.status).toBe(400);
    });

    it('409s when a deploy is already in progress for this app', async () => {
      wireOps({ isAppInProgress: jest.fn().mockReturnValue(true) });
      const res = await post('myapp', bearer(ownerToken), {
        username: targetUsername,
        gateApp: true,
      });
      expect(res.status).toBe(409);
      expect(getAppConfigService().getConfig('myapp')?.access).toBeUndefined();
    });

    it('rejects a missing username', async () => {
      const res = await post('myapp', bearer(ownerToken), { gateApp: true });
      expect(res.status).toBe(400);
    });

    it('rejects an empty username', async () => {
      const res = await post('myapp', bearer(ownerToken), { username: '', gateApp: true });
      expect(res.status).toBe(400);
    });

    it('rejects a username over the max length', async () => {
      const res = await post('myapp', bearer(ownerToken), {
        username: 'a'.repeat(MAX_USER_ID_LENGTH + 1),
        gateApp: true,
      });
      expect(res.status).toBe(400);
    });

    it('surfaces applyError in the response when the re-emission on creation fails, without refusing the grant', async () => {
      wireOps({ reconfigureRoute: jest.fn().mockRejectedValue(new Error('caddy validation failed')) });
      const res = await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { applyError?: string } };
      expect(body.data.applyError).toBe('caddy validation failed');
      // The grant itself still landed — a failed re-emission is reported, not rolled back.
      expect(getAppConfigService().getConfig('myapp')?.access?.allow).toEqual([targetId]);
    });

    it('falls back to a generic applyError message when the re-emission rejects with a non-Error value', async () => {
      wireOps({ reconfigureRoute: jest.fn().mockRejectedValue('not-an-error-instance') });
      const res = await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { applyError?: string } };
      expect(body.data.applyError).toBe('Failed to re-emit the route');
    });

    it(
      're-checks eligibility INSIDE the write closure — a target that was eligible at the ' +
        'precheck but becomes ineligible before the write executes is still refused (SEC-7 TOCTOU)',
      async () => {
        // Establish an already-gated app so the second grant below does not
        // hit the separate `needs-confirmation` branch first.
        await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
        const bob = await createUser('toctou-bob', 'password123', 'user');

        // The route's precheck (`grantIneligibleReason(getUser(username), ...)`,
        // synchronous, before `setAccessPolicy` is even called) sees bob as
        // eligible. This intercepts the write itself — the earliest point a
        // concurrent suspension could land — and suspends bob right before the
        // real updater runs, simulating exactly the race the write-closure
        // re-check exists to close.
        const svc = getAppConfigService();
        const real = svc.setAccessPolicy.bind(svc);
        const spy = jest
          .spyOn(svc, 'setAccessPolicy')
          .mockImplementation(async (name: unknown, arg: unknown) => {
            await suspendUser(bob.id);
            return real(name as string, arg as never);
          });

        const res = await post('myapp', bearer(ownerToken), { username: 'toctou-bob' });
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { message: string } };
        expect(body.error.message).toBe(`'toctou-bob' cannot be granted access to 'myapp'.`);
        expect(getAppConfigService().getConfig('myapp')?.access?.allow).not.toContain(bob.id);

        spy.mockRestore();
      }
    );

    it('returns 503 when platform operations are unavailable', async () => {
      resetPlatformOps();
      expect(getPlatformOps()).toBeNull();
      const res = await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      expect(res.status).toBe(503);
      wireOps(); // restore for anything that runs after this test in the same file
    });

    it(
      'never writes to disk on ANY refusal arm across all three write routes (Gate 2 fix #6, ' +
        'NO_CHANGE) — a spy reused across needs-confirmation, ineligible, already-granted, ' +
        'cap-exceeded, non-owner-authored revoke and mixed-authorship clear',
      async () => {
        const writeSpy = jest.spyOn(atomicWrite, 'writeFileAtomic');
        writeSpy.mockClear();

        // needs-confirmation: no gateApp on an app with no policy yet.
        await post('myapp', bearer(ownerToken), { username: targetUsername });
        expect(writeSpy).not.toHaveBeenCalled();

        // ineligible: a suspended target.
        await suspendUser(targetId);
        await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
        expect(writeSpy).not.toHaveBeenCalled();

        // One real write to seed a policy for the remaining arms.
        await createUser('writecheck-bob', 'password123', 'user');
        await post('myapp', bearer(ownerToken), { username: 'writecheck-bob', gateApp: true });
        expect(writeSpy).toHaveBeenCalledTimes(1);
        writeSpy.mockClear();

        // already-granted: idempotent re-grant.
        await post('myapp', bearer(ownerToken), { username: 'writecheck-bob' });
        expect(writeSpy).not.toHaveBeenCalled();

        // cap-exceeded: seed a full allow-list directly (cheap — bypasses 200 real POSTs).
        const filler = Array.from({ length: 200 }, (_, i) => `filler-${i}`);
        await getAppConfigService().setAccessPolicy('myapp', () => ({
          mode: 'drop-users' as const,
          allow: filler,
          grantedBy: Object.fromEntries(filler.map(id => [id, ownerId])),
        }));
        writeSpy.mockClear();
        await createUser('writecheck-newperson', 'password123', 'user');
        await post('myapp', bearer(ownerToken), { username: 'writecheck-newperson' });
        expect(writeSpy).not.toHaveBeenCalled();

        // non-owner-authored revoke: an admin-authored entry.
        await getAppConfigService().setAccessPolicy('myapp', existing => ({
          mode: 'drop-users' as const,
          allow: [...(existing.access?.allow ?? []), 'admin-entry-id'],
          grantedBy: existing.access?.grantedBy,
        }));
        writeSpy.mockClear();
        await delOne('myapp', 'admin-entry-id', bearer(ownerToken));
        expect(writeSpy).not.toHaveBeenCalled();

        // mixed-authorship clear: the policy above still carries admin-entry-id.
        await del('myapp', bearer(ownerToken));
        expect(writeSpy).not.toHaveBeenCalled();

        writeSpy.mockRestore();
      }
    );
  });

  describe('DELETE /:userId (revoke)', () => {
    it('lets the owner revoke an entry they granted', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      const res = await delOne('myapp', targetId, bearer(ownerToken));
      expect(res.status).toBe(200);
      expect(getAppConfigService().getConfig('myapp')?.access?.allow).toEqual([]);
      const { entries } = getActivityLog().getEntries(10);
      expect(
        entries.some(e => e.action === 'access-share-revoked' && e.appName === 'myapp')
      ).toBe(true);
    });

    it('leaves an ADMIN-authored entry unrevoked for the owner (200, not a distinct 403 — Gate 2 fix #4)', async () => {
      // Simulate a legacy/admin grant: present in `allow`, absent from `grantedBy`.
      await getAppConfigService().setAccessPolicy('myapp', () => ({
        mode: 'drop-users' as const,
        allow: [targetId],
      }));
      const res = await delOne('myapp', targetId, bearer(ownerToken));
      expect(res.status).toBe(200);
      // Unrevoked — still on the list.
      expect(getAppConfigService().getConfig('myapp')?.access?.allow).toEqual([targetId]);
    });

    it('gives the owner the SAME 200 body for an admin-authored entry as a genuinely absent one (no membership oracle — Gate 2 fix #4)', async () => {
      // Present, admin-authored via /share this time (not merely absent from
      // grantedBy) — the exact shape the clear-all parity fix (#1) also
      // covers below.
      await getAppConfigService().setAccessPolicy('myapp', () => ({
        mode: 'drop-users' as const,
        allow: [targetId],
        grantedBy: { [targetId]: adminId },
      }));
      const resNotMine = await delOne('myapp', targetId, bearer(ownerToken));
      const resAbsent = await delOne('myapp', 'some-id-never-granted', bearer(ownerToken));

      expect(resNotMine.status).toBe(200);
      expect(resAbsent.status).toBe(200);
      const bodyNotMine = await resNotMine.json();
      const bodyAbsent = await resAbsent.json();
      // Same shape once the differing id is normalized out.
      expect(JSON.stringify(bodyNotMine).split(targetId).join('<id>')).toBe(
        JSON.stringify(bodyAbsent).split('some-id-never-granted').join('<id>')
      );
      // Unrevoked — still on the list.
      expect(getAppConfigService().getConfig('myapp')?.access?.allow).toEqual([targetId]);
    });

    it("audits an admin's revoke of a non-owner-authored entry distinctly (Gate 2 fix #10)", async () => {
      await getAppConfigService().setAccessPolicy('myapp', () => ({
        mode: 'drop-users' as const,
        allow: [targetId],
      }));
      const res = await delOne('myapp', targetId, bearer(adminToken));
      expect(res.status).toBe(200);
      const { entries } = getActivityLog().getEntries(10);
      const entry = entries.find(e => e.action === 'access-share-revoked' && e.appName === 'myapp');
      expect(entry?.detail).toContain('admin-revoked');
    });

    it('lets an admin revoke any entry, owner-authored or not', async () => {
      await getAppConfigService().setAccessPolicy('myapp', () => ({
        mode: 'drop-users' as const,
        allow: [targetId],
      }));
      const res = await delOne('myapp', targetId, bearer(adminToken));
      expect(res.status).toBe(200);
      expect(getAppConfigService().getConfig('myapp')?.access?.allow).toEqual([]);
    });

    it('does NOT 409 when the box cannot enforce a gate — revoke always proceeds', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      wireOps({}, refused('isolation-not-docker'));

      const res = await delOne('myapp', targetId, bearer(ownerToken));
      expect(res.status).toBe(200);
    });

    it('is a no-op (200) rather than a 409 for an app with no config at all', async () => {
      await getStateManager().registerApp('pending-app', path.join(t.tempDir, 'webapps', 'pending-app'));
      await getStateManager().updateApp('pending-app', { userId: ownerId });
      const res = await delOne('pending-app', targetId, bearer(ownerToken));
      expect(res.status).toBe(200);
    });

    it('refuses when owner-initiated sharing is disabled', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      await getSettingsManager().setAppSharingEnabled(false);
      const res = await delOne('myapp', targetId, bearer(ownerToken));
      expect(res.status).toBe(403);
    });

    it('does NOT re-emit on an ordinary revoke from an already-applied gate', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      await getStateManager().setAccessGateUnapplied('myapp', false);
      const reconfigureRoute = jest.fn().mockResolvedValue(undefined);
      wireOps({ reconfigureRoute });

      await delOne('myapp', targetId, bearer(ownerToken));
      expect(reconfigureRoute).not.toHaveBeenCalled();
    });

    it('DOES re-emit a revoke when the platform recorded the last apply as unapplied', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      await getStateManager().setAccessGateUnapplied('myapp', true);
      const reconfigureRoute = jest.fn().mockResolvedValue(undefined);
      wireOps({ reconfigureRoute });

      await delOne('myapp', targetId, bearer(ownerToken));
      expect(reconfigureRoute).toHaveBeenCalledWith('myapp');
    });

    it('409s when a deploy is already in progress for this app', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      wireOps({ isAppInProgress: jest.fn().mockReturnValue(true) });
      const res = await delOne('myapp', targetId, bearer(ownerToken));
      expect(res.status).toBe(409);
      // Unrevoked — the conflict refused the write before it ran.
      expect(getAppConfigService().getConfig('myapp')?.access?.allow).toEqual([targetId]);
    });

    it('rejects a userId over the max length', async () => {
      const res = await delOne('myapp', 'x'.repeat(MAX_USER_ID_LENGTH + 1), bearer(ownerToken));
      expect(res.status).toBe(400);
    });

    it('surfaces applyError when the unapplied-retry re-emission itself fails', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      await getStateManager().setAccessGateUnapplied('myapp', true);
      wireOps({ reconfigureRoute: jest.fn().mockRejectedValue(new Error('still refuses to load')) });

      const res = await delOne('myapp', targetId, bearer(ownerToken));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { applyError?: string; revoked: boolean } };
      expect(body.data.revoked).toBe(true);
      expect(body.data.applyError).toBe('still refuses to load');
    });
  });

  describe('DELETE /share (clear)', () => {
    it('lets the owner clear an all-owner policy', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      const res = await del('myapp', bearer(ownerToken));
      expect(res.status).toBe(200);
      expect(getAppConfigService().getConfig('myapp')?.access).toBeUndefined();
      const { entries } = getActivityLog().getEntries(10);
      expect(
        entries.some(e => e.action === 'access-share-cleared' && e.appName === 'myapp')
      ).toBe(true);
    });

    it('refuses to clear a policy with any admin-authored entry', async () => {
      await getAppConfigService().setAccessPolicy('myapp', existing => ({
        mode: 'drop-users' as const,
        allow: [targetId],
        // No grantedBy entry for targetId — admin-authored.
        grantedBy: existing.access?.grantedBy,
      }));
      const res = await del('myapp', bearer(ownerToken));
      expect(res.status).toBe(409);
      expect(getAppConfigService().getConfig('myapp')?.access).toBeDefined();
    });

    it('does NOT 409 on enforceability — clear always proceeds', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      wireOps({}, refused('isolation-not-docker'));

      const res = await del('myapp', bearer(ownerToken));
      expect(res.status).toBe(200);
    });

    it('always re-emits on a real clear (transition to no policy)', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      await getStateManager().setAccessGateUnapplied('myapp', false);
      const reconfigureRoute = jest.fn().mockResolvedValue(undefined);
      wireOps({ reconfigureRoute });

      await del('myapp', bearer(ownerToken));
      expect(reconfigureRoute).toHaveBeenCalledWith('myapp');
    });

    it('refuses an entry admin-granted VIA /share the same way DELETE /:userId does (Gate 2 fix #1 parity)', async () => {
      // Present in `allow` AND `grantedBy` — an admin's own POST /share
      // grant, not the legacy absent-`grantedBy` shape above. The old
      // `grantedBy[id] !== undefined` check treated this as owner-authored
      // and let clear-all destroy it while DELETE /:userId correctly
      // refused it — the exact parity gap Gate 2 found.
      await getAppConfigService().setAccessPolicy('myapp', () => ({
        mode: 'drop-users' as const,
        allow: [targetId],
        grantedBy: { [targetId]: adminId },
      }));

      const resOne = await delOne('myapp', targetId, bearer(ownerToken));
      expect(resOne.status).toBe(200); // uniform no-op — see fix #4
      expect(getAppConfigService().getConfig('myapp')?.access?.allow).toEqual([targetId]); // unrevoked

      const resAll = await del('myapp', bearer(ownerToken));
      expect(resAll.status).toBe(409);
      expect(getAppConfigService().getConfig('myapp')?.access).toBeDefined(); // NOT wiped
    });

    it('lets an admin clear a policy of entries THEY granted via /share themselves', async () => {
      await post('myapp', bearer(adminToken), { username: targetUsername, gateApp: true });
      const res = await del('myapp', bearer(adminToken));
      expect(res.status).toBe(200);
      expect(getAppConfigService().getConfig('myapp')?.access).toBeUndefined();
    });

    it("audits an admin's clear of admin-granted entries distinctly (Gate 2 fix #10)", async () => {
      await post('myapp', bearer(adminToken), { username: targetUsername, gateApp: true });
      await del('myapp', bearer(adminToken));
      const { entries } = getActivityLog().getEntries(10);
      const entry = entries.find(e => e.action === 'access-share-cleared' && e.appName === 'myapp');
      expect(entry?.detail).toContain('admin');
    });

    it('409s when a deploy is already in progress for this app', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      wireOps({ isAppInProgress: jest.fn().mockReturnValue(true) });
      const res = await del('myapp', bearer(ownerToken));
      expect(res.status).toBe(409);
      expect(getAppConfigService().getConfig('myapp')?.access).toBeDefined();
    });

    it('is a no-op (200), not a distinct refusal, when the app has a config but no policy at all', async () => {
      // Distinct from the mixed-authorship 409 above: this app has never had
      // an access policy at all, not merely one with an admin-authored entry.
      const res = await del('myapp', bearer(ownerToken));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { cleared: boolean; message: string } };
      expect(body.data.cleared).toBe(false);
      expect(body.data.message).toBe(`'myapp' has no access policy to clear`);
    });

    it('is a no-op (200) with the SAME "nothing to clear" shape as revoke, for an app with no config file at all', async () => {
      // A config-less app (registered in state, never reached app:detected) —
      // setAccessPolicy's create:false returns null, hitting the OTHER
      // "nothing to do" branch (distinct from the one above, which has a
      // config but no `access` field).
      await getStateManager().registerApp('pending-app', path.join(t.tempDir, 'webapps', 'pending-app'));
      await getStateManager().updateApp('pending-app', { userId: ownerId });
      const res = await del('pending-app', bearer(ownerToken));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { cleared: boolean; message: string } };
      expect(body.data.cleared).toBe(false);
      expect(body.data.message).toBe(`Nothing to clear for 'pending-app'`);
    });

    it('surfaces applyError when the clear re-emission itself fails', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      wireOps({ reconfigureRoute: jest.fn().mockRejectedValue(new Error('caddy is down')) });

      const res = await del('myapp', bearer(ownerToken));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { cleared: boolean; applyError?: string } };
      expect(body.data.cleared).toBe(true);
      expect(body.data.applyError).toBe('caddy is down');
      // The clear itself still landed — a failed re-emission is reported, not rolled back.
      expect(getAppConfigService().getConfig('myapp')?.access).toBeUndefined();
    });
  });

  describe('GET (owner view)', () => {
    it("shows the caller's own grants but only a COUNT of admin-authored ones", async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      // An admin-authored entry the owner must not see the identity of.
      const gov = await createUser('bob2', 'password123', 'user');
      await getAppConfigService().setAccessPolicy('myapp', existing => ({
        mode: 'drop-users' as const,
        allow: [...(existing.access?.allow ?? []), gov.id],
        grantedBy: existing.access?.grantedBy, // gov.id absent — admin-authored
      }));

      const res = await get('myapp', bearer(ownerToken));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: {
          ownGrants: { userId: string; username?: string }[];
          othersGrantedCount: number;
          gateApplied: boolean | null;
          blockers: string[];
        };
      };
      expect(body.data.ownGrants).toEqual([{ userId: targetId, username: targetUsername }]);
      expect(body.data.othersGrantedCount).toBe(1);
      // No id/username of the admin-authored entry anywhere in the payload.
      expect(JSON.stringify(body)).not.toContain(gov.id);
      expect(JSON.stringify(body)).not.toContain('bob2');
    });

    it('reports gateApplied from the platform state, and blockers not reasons', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      await getStateManager().setAccessGateUnapplied('myapp', true);
      wireOps({}, refused('isolation-not-docker'));

      const res = await get('myapp', bearer(ownerToken));
      const body = (await res.json()) as {
        data: { gateApplied: boolean | null; blockers: string[] };
      };
      expect(body.data.gateApplied).toBe(false);
      expect(body.data.blockers).toEqual(['isolation-not-docker']);
      expect(JSON.stringify(body)).not.toContain('because isolation-not-docker');
    });

    it('refuses a non-owner with 404', async () => {
      const res = await get('myapp', bearer(outsiderToken));
      expect(res.status).toBe(404);
    });

    it('refuses an API key', async () => {
      const key = await createApiKey('owner-key', 'user', undefined, undefined, ownerId);
      const res = await get('myapp', { 'X-API-Key': key.key });
      expect(res.status).toBe(403);
    });

    it('reports policyPresent and a truthful enforced flag, not merely policy presence (Gate 2 fix #5)', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      const res = await get('myapp', bearer(ownerToken));
      const body = (await res.json()) as {
        data: { policyPresent: boolean; enforced: boolean; gated?: unknown };
      };
      expect(body.data.policyPresent).toBe(true);
      expect(body.data.enforced).toBe(true);
      expect(body.data.gated).toBeUndefined();
    });

    it('reports enforced:false when the box cannot enforce, even with a policy present', async () => {
      await post('myapp', bearer(ownerToken), { username: targetUsername, gateApp: true });
      wireOps({}, refused('isolation-not-docker'));
      const res = await get('myapp', bearer(ownerToken));
      const body = (await res.json()) as { data: { policyPresent: boolean; enforced: boolean } };
      expect(body.data.policyPresent).toBe(true);
      expect(body.data.enforced).toBe(false);
    });

    it('does not check isAppInProgress — a read must not race-refuse (Gate 2 fix #7)', async () => {
      wireOps({ isAppInProgress: jest.fn().mockReturnValue(true) });
      const res = await get('myapp', bearer(ownerToken));
      expect(res.status).toBe(200);
    });
  });

  describe('on an auth-disabled box', () => {
    // `server.ts` registers the role floor only inside
    // `if (enableAuth && isAuthEnabled())`, so with auth off no middleware
    // covers these paths and the handlers' own `requireAuthForAccessRoutes`
    // check is the only thing standing between an anonymous caller and a
    // real DROP user id.
    beforeEach(() => {
      resetAuth();
    });

    it('refuses GET', async () => {
      const res = await t.hono.request('/api/v1/apps/myapp/share');
      expect(res.status).toBe(401);
    });

    it('refuses POST', async () => {
      const res = await t.hono.request('/api/v1/apps/myapp/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'alice', gateApp: true }),
      });
      expect(res.status).toBe(401);
    });

    it('refuses DELETE', async () => {
      const res = await t.hono.request('/api/v1/apps/myapp/share', { method: 'DELETE' });
      expect(res.status).toBe(401);
    });
  });
});
