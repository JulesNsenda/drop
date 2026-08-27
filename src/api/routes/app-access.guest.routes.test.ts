/**
 * The gate, seen by a GUEST (DROP-155 wave 3a).
 *
 * Three properties, none of which is "the happy path works":
 *
 *  - a guest is admitted by `policy.guests` and NOTHING else, and reaches the
 *    tenant under a DISTINCT header name with no user identity at all;
 *  - a guest whose grant is gone gets a TERMINAL refusal, never a redirect.
 *    The loop argument is stronger here than for an account holder: a guest
 *    has no account to sign in with, so "go and sign in" is an exit that does
 *    not exist;
 *  - the exchange re-checks membership before minting, because a single-use
 *    code is a credential minted BEFORE the decision it carries was last true.
 *
 * Plus the one C0 measured that nothing pinned: every `Location` in the chain
 * must be fragment-free. A hop that emits a `Location` with its own fragment
 * silently destroys the invite secret riding in the client's — no error, no
 * log, and the guest simply lands somewhere useless.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createUser } from '../middleware/auth';
import { getStateManager } from '../../managers/app/state-manager';
import { setPublicUrl, setApiRuntimeConfig } from '../runtime-config';
import {
  createTestApiServer,
  teardownTestApiServer,
  type TestApiServer,
} from '../__testutils__/api-server';
import { getAppConfigService, resetAppConfigService } from '../../managers/app/app-config';
import { getAccessLog, resetAccessLog } from '../../managers/access-log/access-log';
import { mintAppSessionToken, mintAppGuestSessionToken } from '../app-access/session-token';
import { mintAppAccessCode, __resetAppAccessCodes } from '../app-access/flow-code';
import { getAppGuestManager, resetAppGuests, type GuestRecord } from '../../managers/app-guest';
import { sessionCookieName, flowCookieName } from './app-access';

const APP = 'myapp';

describe('/app-access — the guest arm (DROP-155)', () => {
  let t: TestApiServer;
  let ownerId: string;
  let allowedId: string;
  let origin: string;
  let guest: GuestRecord;

  const verify = (headers: Record<string, string> = {}) =>
    t.hono.request(`/api/v1/app-access/${APP}/verify`, { headers });

  const setGuests = (guestIds: string[], allow: string[] = []) =>
    getAppConfigService().setAccessPolicy(APP, () => ({
      mode: 'drop-users' as const,
      allow,
      guests: guestIds,
      guestGrantedBy: Object.fromEntries(guestIds.map(id => [id, ownerId])),
    }));

  beforeEach(async () => {
    resetAppConfigService();
    resetAccessLog();
    resetAppGuests();
    __resetAppAccessCodes();
    setPublicUrl('https://dashboard.example.com');

    t = await createTestApiServer({
      port: 3167,
      tempPrefix: 'drop-app-access-guest-',
      config: { domainSuffix: 'example.com', enableHttps: true },
    });
    getAccessLog(path.join(t.tempDir, 'logs'));

    await fs.mkdir(path.join(t.tempDir, 'appconf'), { recursive: true });
    await fs.mkdir(path.join(t.tempDir, 'webapps', APP), { recursive: true });
    getAppConfigService({
      configDir: path.join(t.tempDir, 'appconf'),
      webappsDir: path.join(t.tempDir, 'webapps'),
    });
    await getAppConfigService().upsertConfig(APP, { type: 'nodejs', port: 4000 });

    getAppGuestManager({
      guestsFilePath: path.join(t.tempDir, 'app-guests.json'),
      invitesFilePath: path.join(t.tempDir, 'app-guest-invites.json'),
    });
    await getAppGuestManager().load();

    const owner = await createUser('owner', 'password123', 'user');
    ownerId = owner.id;
    const allowed = await createUser('allowed', 'password123', 'user');
    allowedId = allowed.id;

    const sm = getStateManager();
    await sm.registerApp(APP, path.join(t.tempDir, 'webapps', APP), 'nodejs');
    await sm.updateApp(APP, { userId: ownerId, port: 4000 });

    guest = await getAppGuestManager().resolveOrCreateGuest('visitor@example.com', APP, ownerId);
    await setGuests([guest.id]);
    origin = `https://${APP}.example.com`;
  });

  afterEach(async () => {
    setPublicUrl(undefined);
    setApiRuntimeConfig({ accessGateEnabled: true });
    resetAppConfigService();
    resetAccessLog();
    resetAppGuests();
    await teardownTestApiServer(t);
  });

  const guestCookie = async (over: { guestId?: string; app?: string } = {}) => {
    const token = await mintAppGuestSessionToken(
      over.guestId ?? guest.id,
      guest.email,
      over.app ?? APP,
      origin
    );
    return { cookie: `${sessionCookieName(APP)}=${token}` };
  };

  describe('verify', () => {
    it('admits a guest on the guests list, under a DISTINCT header and with NO user identity', async () => {
      const res = await verify(await guestCookie());

      expect(res.status).toBe(204);
      expect(res.headers.get('x-drop-guest-id')).toBe(guest.id);
      // The section-D property: a stale Caddy block copies neither of these, so
      // a guest must never be handed an identity a tenant reads as a user's.
      expect(res.headers.get('x-drop-session-user-id')).toBeNull();
      expect(res.headers.get('x-drop-session-username')).toBeNull();
    });

    it('refuses TERMINALLY when the grant is gone — a guest has no sign-in to be sent to', async () => {
      const cookie = await guestCookie();
      await setGuests([]);

      const res = await verify(cookie);

      expect(res.status).toBe(403);
      expect(res.headers.get('location')).toBeNull();
    });

    it('refuses a guest session minted for a DIFFERENT app', async () => {
      const other = await getAppGuestManager().resolveOrCreateGuest(
        'visitor@example.com',
        'other-app',
        ownerId
      );
      // On the guests list of THIS app, but the session names another one.
      await setGuests([guest.id, other.id]);

      const res = await verify(await guestCookie({ guestId: other.id, app: 'other-app' }));

      // 302, not 403, and the distinction is the point: the VERIFIER rejects
      // this before `canOpenGuestSession` is ever reached (it binds the token's
      // `app` claim and the record's own `appName`), so what this hop sees is
      // "no usable session for this app" — which is exactly what a first-time
      // visitor looks like. The evaluator's own binding check is defence in
      // depth behind this, pinned separately in access.canopen-guest.test.ts.
      expect(res.status).toBe(302);
      expect(res.headers.get('x-drop-guest-id')).toBeNull();
    });

    it('does not admit a DISABLED guest — the record is re-read on every request', async () => {
      const cookie = await guestCookie();
      await getAppGuestManager().disableGuest(guest.id, ownerId);

      const res = await verify(cookie);

      // Also a 302, and this one is a DELIBERATE choice with a cost — see the
      // handler's own comment. `/verify` cannot tell a failed guest token from
      // no token at all without reading an UNVERIFIED `token_use` claim, and
      // trusting one would hand a hostile tenant (who can set cookies on their
      // own origin) a way to force a terminal refusal for every visitor by
      // planting a guest-shaped cookie. The cost is that a revoked guest is
      // sent to a sign-in page they cannot use; the alternative is a tenant
      // able to break the gate's recovery path for account holders too.
      expect(res.status).toBe(302);
      expect(res.headers.get('x-drop-guest-id')).toBeNull();
    });

    it('is NOT satisfied by a guest id sitting in the allow list', async () => {
      await setGuests([], [guest.id]);

      const res = await verify(await guestCookie());

      expect(res.status).toBe(403);
    });

    it('leaves the ACCOUNT-HOLDER arm untouched', async () => {
      // The regression net for adding a second verifier on the same cookie:
      // both classes check `token_use` first, so neither can satisfy the
      // other's verifier and the try-order is free.
      await setGuests([guest.id], [allowedId]);
      const token = await mintAppSessionToken(allowedId, 'allowed', APP, origin);

      const res = await verify({ cookie: `${sessionCookieName(APP)}=${token}` });

      expect(res.status).toBe(204);
      expect(res.headers.get('x-drop-session-user-id')).toBe(allowedId);
      expect(res.headers.get('x-drop-guest-id')).toBeNull();
    });
  });

  describe('exchange — the membership re-check', () => {
    const exchange = (code: string, flow: string) =>
      t.hono.request(`/api/v1/app-access/${APP}/exchange?code=${encodeURIComponent(code)}`, {
        headers: { cookie: `${flowCookieName(APP)}=${flow}` },
      });

    const guestCode = (flow: string) =>
      mintAppAccessCode({
        kind: 'guest',
        guestId: guest.id,
        email: guest.email,
        appName: APP,
        flowId: flow,
        returnPath: '/',
      });

    const hasSessionCookie = (res: Response) =>
      (res.headers.getSetCookie?.() ?? []).some(v => v.startsWith(`${sessionCookieName(APP)}=`));

    it('mints a guest session for a live grant', async () => {
      const res = await exchange(guestCode('flow-1'), 'flow-1');

      expect(res.status).toBe(302);
      expect(hasSessionCookie(res)).toBe(true);
    });

    it('refuses a code whose grant was revoked between mint and spend', async () => {
      const code = guestCode('flow-2');
      await setGuests([]);

      const res = await exchange(code, 'flow-2');

      expect(res.status).toBe(403);
      expect(hasSessionCookie(res)).toBe(false);
    });

    it('SPENDS the code it refuses, so a revoked code is not left replayable', async () => {
      // The re-check runs AFTER `consumeAppAccessCode` on purpose. If it ran
      // before, a refused code would survive for the rest of its life and land
      // the moment the grant came back.
      const code = guestCode('flow-3');
      await setGuests([]);
      await exchange(code, 'flow-3');

      await setGuests([guest.id]);
      const replay = await exchange(code, 'flow-3');

      expect(replay.status).toBe(403);
      expect(hasSessionCookie(replay)).toBe(false);
    });

    it('refuses a code for a DISABLED guest', async () => {
      const code = guestCode('flow-4');
      await getAppGuestManager().disableGuest(guest.id, ownerId);

      const res = await exchange(code, 'flow-4');

      expect(res.status).toBe(403);
    });

    it('re-checks the ACCOUNT-HOLDER arm too', async () => {
      const code = mintAppAccessCode({
        kind: 'user',
        userId: allowedId,
        username: 'allowed',
        appName: APP,
        flowId: 'flow-5',
        returnPath: '/',
      });
      await getAppConfigService().setAccessPolicy(APP, () => ({
        mode: 'drop-users' as const,
        allow: [],
      }));

      const res = await exchange(code, 'flow-5');

      expect(res.status).toBe(403);
    });
  });

  describe('every Location in the chain is fragment-free (C0 Q1)', () => {
    /**
     * C0 measured that a `Location` carrying its OWN fragment OVERRIDES the
     * client's. The invite secret rides in the client's fragment, so a single
     * hop growing a fragment destroys it silently — no error, no log. Nothing
     * pinned this before; the spike said to add it, and this is it.
     */
    const expectNoFragment = (res: Response) => {
      const location = res.headers.get('location');
      expect(location).not.toBeNull();
      expect(location).not.toContain('#');
      expect(new URL(location as string, origin).hash).toBe('');
    };

    it('verify → authorize', async () => {
      expectNoFragment(await verify({ 'x-forwarded-uri': '/reports' }));
    });

    it('authorize → the dashboard page', async () => {
      const res = await t.hono.request(
        `/api/v1/app-access/authorize?app=${APP}&flow=abc&return=%2Freports`
      );
      expectNoFragment(res);
    });

    it('exchange → the app', async () => {
      const res = await t.hono.request(
        `/api/v1/app-access/${APP}/exchange?code=${encodeURIComponent(
          mintAppAccessCode({
            kind: 'guest',
            guestId: guest.id,
            email: guest.email,
            appName: APP,
            flowId: 'flow-frag',
            returnPath: '/reports',
          })
        )}`,
        { headers: { cookie: `${flowCookieName(APP)}=flow-frag` } }
      );
      expectNoFragment(res);
    });
  });
});
