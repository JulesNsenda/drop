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
import { INVITE_COOKIE_NAME } from '../app-access/names';

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
  describe('the invite hop (wave 3b)', () => {
    const PLATFORM = 'https://dashboard.example.com';

    const mintInvite = () =>
      getAppGuestManager().mintInviteToken({
        appName: APP,
        guestId: guest.id,
        email: guest.email,
        createdBy: ownerId,
      });

    const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      t.hono.request(`/api/v1/app-access/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });

    /** `Response.json()` is `unknown` under this tsconfig; every body here is DROP's envelope. */
    const bodyOf = async (res: Response) =>
      (await res.json()) as { data?: Record<string, string>; error?: { message: string } };

    const setCookies = (res: Response) => res.headers.getSetCookie?.() ?? [];
    const inviteCookieFrom = (res: Response): string => {
      const raw = setCookies(res).find(v => v.startsWith(`${INVITE_COOKIE_NAME}=`));
      expect(raw).toBeDefined();
      return (raw as string).split(';')[0];
    };

    describe('GET /invite/:id — the mail link', () => {
      it('redirects to the guest page carrying the id, with no fragment of its own', async () => {
        const invite = await mintInvite();
        const res = await t.hono.request(`/api/v1/app-access/invite/${invite.id}`);

        expect(res.status).toBe(302);
        const location = new URL(res.headers.get('location') as string);
        expect(location.origin).toBe(PLATFORM);
        expect(location.pathname).toBe('/dashboard/app-invite');
        expect(location.searchParams.get('id')).toBe(invite.id);
        // C0 Q1: a Location with its OWN fragment overrides the client's, which
        // is where the secret lives. This hop must never grow one.
        expect(location.hash).toBe('');
      });

      it('answers IDENTICALLY for an invented id — it is not an existence oracle', async () => {
        const invite = await mintInvite();
        const real = await t.hono.request(`/api/v1/app-access/invite/${invite.id}`);
        const fake = await t.hono.request(
          '/api/v1/app-access/invite/00000000-0000-0000-0000-000000000000'
        );

        expect(fake.status).toBe(real.status);
        expect(new URL(fake.headers.get('location') as string).pathname).toBe(
          new URL(real.headers.get('location') as string).pathname
        );
      });

      it('refuses an id that is not shaped like one we mint', async () => {
        const res = await t.hono.request('/api/v1/app-access/invite/..%2F..%2Fetc');
        expect(res.status).toBe(400);
      });
    });

    describe('POST /invite-redeem — spending it', () => {
      it('sets the invite cookie on the PLATFORM origin and returns the app URL', async () => {
        const invite = await mintInvite();
        const res = await postJson('invite-redeem', { id: invite.id, secret: invite.secret });

        expect(res.status).toBe(200);
        expect((await bodyOf(res)).data?.appUrl).toBe(origin);

        const cookie = setCookies(res).find(v => v.startsWith(`${INVITE_COOKIE_NAME}=`)) as string;
        expect(cookie).toBeDefined();
        expect(cookie).toContain('Secure');
        expect(cookie).toContain('HttpOnly');
        expect(cookie).toContain('Path=/');
        // Lax, NOT Strict, and this is pinned because Strict silently breaks
        // the chain: the next hop that must carry this cookie is a top-level
        // GET arriving from the TENANT origin, which Strict drops.
        expect(cookie).toContain('SameSite=Lax');
      });

      it('is SINGLE-USE', async () => {
        const invite = await mintInvite();
        await postJson('invite-redeem', { id: invite.id, secret: invite.secret });
        const second = await postJson('invite-redeem', { id: invite.id, secret: invite.secret });

        expect(second.status).toBe(403);
        expect(setCookies(second).some(v => v.startsWith(`${INVITE_COOKIE_NAME}=`))).toBe(false);
      });

      it('answers a wrong secret exactly as it answers an unknown id', async () => {
        const invite = await mintInvite();
        const wrongSecret = await postJson('invite-redeem', { id: invite.id, secret: 'nope' });
        const unknownId = await postJson('invite-redeem', { id: 'no-such-id', secret: 'nope' });

        expect(wrongSecret.status).toBe(unknownId.status);
        expect((await bodyOf(wrongSecret)).error?.message).toBe(
          (await bodyOf(unknownId)).error?.message
        );
      });

      it('refuses when the grant was revoked, and the invite stays SPENT', async () => {
        const invite = await mintInvite();
        await setGuests([]);

        const refused = await postJson('invite-redeem', { id: invite.id, secret: invite.secret });
        expect(refused.status).toBe(403);

        // Restoring the grant must not resurrect a spent invite.
        await setGuests([guest.id]);
        const retry = await postJson('invite-redeem', { id: invite.id, secret: invite.secret });
        expect(retry.status).toBe(403);
      });

      it('refuses a DISABLED guest', async () => {
        const invite = await mintInvite();
        await getAppGuestManager().disableGuest(guest.id, ownerId);

        const res = await postJson('invite-redeem', { id: invite.id, secret: invite.secret });
        expect(res.status).toBe(403);
      });
    });

    describe('authorize — the page hint', () => {
      it('sends a visitor with no invite cookie to the account-holder page', async () => {
        const res = await t.hono.request(
          `/api/v1/app-access/authorize?app=${APP}&flow=f1&return=%2F`
        );
        expect(new URL(res.headers.get('location') as string).pathname).toBe(
          '/dashboard/app-access'
        );
      });

      it('sends a visitor holding an invite cookie to the guest page', async () => {
        const invite = await mintInvite();
        const redeemed = await postJson('invite-redeem', {
          id: invite.id,
          secret: invite.secret,
        });
        const res = await t.hono.request(
          `/api/v1/app-access/authorize?app=${APP}&flow=f1&return=%2F`,
          { headers: { cookie: inviteCookieFrom(redeemed) } }
        );

        const location = new URL(res.headers.get('location') as string);
        expect(location.pathname).toBe('/dashboard/app-invite');
        expect(location.searchParams.get('flow')).toBe('f1');
        expect(location.hash).toBe('');
      });

      it('treats the cookie as a HINT — presence alone, never a verified claim', async () => {
        // Garbage routes to the guest page too, and that is deliberate: the
        // page corrects a wrong hint, and `guest-code` re-verifies server-side.
        // The alternative — verifying here — would make `/authorize` the place
        // bearer-vs-invite precedence gets decided, and this hop cannot see a
        // bearer at all.
        const res = await t.hono.request(
          `/api/v1/app-access/authorize?app=${APP}&flow=f1&return=%2F`,
          { headers: { cookie: `${INVITE_COOKIE_NAME}=not-a-real-token` } }
        );
        expect(new URL(res.headers.get('location') as string).pathname).toBe(
          '/dashboard/app-invite'
        );
      });
    });

    describe('POST /guest-code', () => {
      const redeemedCookie = async () => {
        const invite = await mintInvite();
        return inviteCookieFrom(
          await postJson('invite-redeem', { id: invite.id, secret: invite.secret })
        );
      };

      const startFlow = async (): Promise<string> => {
        const res = await verify({ 'x-forwarded-uri': '/' });
        const cookie = (res.headers.getSetCookie?.() ?? []).find(v =>
          v.startsWith(`${flowCookieName(APP)}=`)
        ) as string;
        return cookie.split('=')[1].split(';')[0];
      };

      it('mints a code pointing at the app exchange', async () => {
        const cookie = await redeemedCookie();
        const flow = await startFlow();

        const res = await postJson('guest-code', { app: APP, flow, return: '/' }, { cookie });

        expect(res.status).toBe(200);
        const redirectTo = new URL((await bodyOf(res)).data?.redirectTo as string);
        expect(redirectTo.origin).toBe(origin);
        expect(redirectTo.pathname).toBe('/.drop-session/exchange');
        expect(redirectTo.searchParams.get('code')).toBeTruthy();
      });

      it('refuses with no invite cookie at all', async () => {
        const flow = await startFlow();
        const res = await postJson('guest-code', { app: APP, flow, return: '/' });
        expect(res.status).toBe(403);
      });

      it('refuses when the invite names a DIFFERENT app than the request', async () => {
        // The app is bound INSIDE the token and compared against the body —
        // otherwise one redeemed invite would mint codes for every gated app
        // on the box.
        const other = await getAppGuestManager().resolveOrCreateGuest(
          'visitor@example.com',
          'other-app',
          ownerId
        );
        await getAppConfigService().upsertConfig('other-app', { type: 'nodejs', port: 4100 });
        await getStateManager().registerApp(
          'other-app',
          path.join(t.tempDir, 'webapps', APP),
          'nodejs'
        );
        await getStateManager().updateApp('other-app', { userId: ownerId, port: 4100 });
        await getAppConfigService().setAccessPolicy('other-app', () => ({
          mode: 'drop-users' as const,
          allow: [],
          guests: [other.id],
        }));
        const otherInvite = await getAppGuestManager().mintInviteToken({
          appName: 'other-app',
          guestId: other.id,
          email: other.email,
          createdBy: ownerId,
        });
        const cookie = inviteCookieFrom(
          await postJson('invite-redeem', { id: otherInvite.id, secret: otherInvite.secret })
        );
        const flow = await startFlow();

        const res = await postJson('guest-code', { app: APP, flow, return: '/' }, { cookie });

        expect(res.status).toBe(403);

        // And it refuses BEFORE spending the flow. That ordering is the only
        // thing the app-binding check uniquely buys — the live re-check below
        // it would refuse this too (a guest record is per-app, so a guest for
        // another app can never be live for this one), but only after burning
        // the visitor's flow id. Without this assertion the binding line is
        // invisible to the suite: mutating it away leaves every test green.
        const ownCookie = await redeemedCookie();
        const stillUsable = await postJson(
          'guest-code',
          { app: APP, flow, return: '/' },
          { cookie: ownCookie }
        );
        expect(stillUsable.status).toBe(200);
      });

      it('SPENDS the flow, so an observed flow id cannot be replayed', async () => {
        const cookie = await redeemedCookie();
        const flow = await startFlow();

        await postJson('guest-code', { app: APP, flow, return: '/' }, { cookie });
        const replay = await postJson('guest-code', { app: APP, flow, return: '/' }, { cookie });

        expect(replay.status).toBe(400);
      });

      it('refuses once the grant is revoked, even holding a valid invite cookie', async () => {
        const cookie = await redeemedCookie();
        const flow = await startFlow();
        await setGuests([]);

        const res = await postJson('guest-code', { app: APP, flow, return: '/' }, { cookie });

        expect(res.status).toBe(403);
      });
    });

    it('walks the whole chain: mail link -> redeem -> verify -> authorize -> code -> exchange', async () => {
      // The six hops of the plan's section C, end to end, in the order a real
      // browser makes them. This is the closest a test gets to the runtime
      // walk, and it is here because the chain's failure mode is that every
      // hop works alone.
      const invite = await mintInvite();

      // 1. The mail link, on the platform origin.
      const landing = await t.hono.request(`/api/v1/app-access/invite/${invite.id}`);
      expect(new URL(landing.headers.get('location') as string).pathname).toBe(
        '/dashboard/app-invite'
      );

      // 2-3. The gesture: the page POSTs id + the fragment secret.
      const redeemed = await postJson('invite-redeem', {
        id: invite.id,
        secret: invite.secret,
      });
      expect(redeemed.status).toBe(200);
      const inviteCookie = inviteCookieFrom(redeemed);
      expect((await bodyOf(redeemed)).data?.appUrl).toBe(origin);

      // 4. The browser walks to the app; Caddy's forward_auth hits verify,
      //    which plants the flow cookie on the TENANT origin and bounces back.
      const verified = await verify({ 'x-forwarded-uri': '/reports' });
      expect(verified.status).toBe(302);
      const flowCookie = (verified.headers.getSetCookie?.() ?? []).find(v =>
        v.startsWith(`${flowCookieName(APP)}=`)
      ) as string;
      const flow = flowCookie.split('=')[1].split(';')[0];

      // ...to authorize, which now sees the invite cookie and picks the guest page.
      const authorized = await t.hono.request(
        (verified.headers.get('location') as string).replace(PLATFORM, ''),
        { headers: { cookie: inviteCookie } }
      );
      const consent = new URL(authorized.headers.get('location') as string);
      expect(consent.pathname).toBe('/dashboard/app-invite');
      expect(consent.searchParams.get('app')).toBe(APP);
      expect(consent.searchParams.get('return')).toBe('/reports');

      // 5. The guest page POSTs app + flow with the invite cookie.
      const coded = await postJson(
        'guest-code',
        {
          app: consent.searchParams.get('app'),
          flow: consent.searchParams.get('flow'),
          return: consent.searchParams.get('return'),
        },
        { cookie: inviteCookie }
      );
      expect(coded.status).toBe(200);
      const redirectTo = new URL((await bodyOf(coded)).data?.redirectTo as string);

      // 6. The exchange, on the tenant origin, behind the flow cookie.
      const exchanged = await t.hono.request(
        `/api/v1/app-access/${APP}/exchange${redirectTo.search}`,
        { headers: { cookie: `${flowCookieName(APP)}=${flow}` } }
      );
      expect(exchanged.status).toBe(302);
      expect(exchanged.headers.get('location')).toBe('/reports');
      const session = (exchanged.headers.getSetCookie?.() ?? []).find(v =>
        v.startsWith(`${sessionCookieName(APP)}=`)
      ) as string;
      expect(session).toBeDefined();

      // And the session that came out of it opens the app.
      const opened = await verify({ cookie: session.split(';')[0] });
      expect(opened.status).toBe(204);
      expect(opened.headers.get('x-drop-guest-id')).toBe(guest.id);
    });
  });
});
