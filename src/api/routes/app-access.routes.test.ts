/**
 * The access gate's four endpoints (DROP-152).
 *
 * The property this suite exists for is NOT "the happy path works". It is that
 * **no input produces an endless redirect**. Four critics independently found
 * that a gate whose every negative answer is "go and sign in" loops forever for
 * anyone who is signed in and simply not on the list — until the browser's
 * redirect cap, with no error surfaced anywhere and the dashboard reporting the
 * app as protected.
 *
 * So the refusals are split by kind, and each split is pinned here:
 *
 *   no session                        → 302 (go and sign in — that will help)
 *   valid session, not permitted      → 403 (signing in again will NOT help)
 *   guard present, policy gone        → 403
 *   non-GET with no session           → 401 (a 302 would drop the body)
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createUser } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager } from '../../managers/app/state-manager';
import { setPublicUrl } from '../runtime-config';
import {
  createTestApiServer,
  teardownTestApiServer,
  type TestApiServer,
} from '../__testutils__/api-server';
import { getAppConfigService, resetAppConfigService } from '../../managers/app/app-config';
import { getAccessLog, resetAccessLog } from '../../managers/access-log/access-log';
import { mintAppSessionToken, SESSION_TTL_SECONDS } from '../app-access/session-token';
import { __resetAppAccessCodes } from '../app-access/flow-code';
import { sessionCookieName, flowCookieName } from './app-access';

const APP = 'myapp';

describe('/app-access (DROP-152 the gate)', () => {
  let t: TestApiServer;
  let ownerId: string;
  let outsiderId: string;
  let outsiderToken: string;
  let allowedToken: string;
  let allowedId: string;
  let origin: string;

  const verify = (headers: Record<string, string> = {}) =>
    t.hono.request(`/api/v1/app-access/${APP}/verify`, { headers });

  beforeEach(async () => {
    resetAppConfigService();
    resetAccessLog();
    __resetAppAccessCodes();
    setPublicUrl('https://dashboard.example.com');

    t = await createTestApiServer({
      port: 3157,
      tempPrefix: 'drop-app-access-',
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

    const owner = await createUser('owner', 'password123', 'user');
    ownerId = owner.id;
    const allowed = await createUser('allowed', 'password123', 'user');
    allowedId = allowed.id;
    allowedToken = await getTestToken('allowed', 'password123');
    const outsider = await createUser('outsider', 'password123', 'user');
    outsiderId = outsider.id;
    outsiderToken = await getTestToken('outsider', 'password123');

    const sm = getStateManager();
    await sm.registerApp(APP, path.join(t.tempDir, 'webapps', APP), 'nodejs');
    await sm.updateApp(APP, { userId: ownerId, port: 4000 });

    await getAppConfigService().setAccessPolicy(APP, { mode: 'drop-users', allow: [allowedId] });
    origin = `https://${APP}.example.com`;
  });

  afterEach(async () => {
    setPublicUrl(undefined);
    resetAppConfigService();
    resetAccessLog();
    await teardownTestApiServer(t);
  });

  describe('verify — the loop-prevention contract', () => {
    it('302s a visitor with NO session, and plants the flow cookie', async () => {
      const res = await verify({ 'x-forwarded-uri': '/reports' });
      expect(res.status).toBe(302);

      const location = new URL(res.headers.get('location') as string);
      expect(location.origin).toBe('https://dashboard.example.com');
      expect(location.searchParams.get('app')).toBe(APP);
      expect(location.searchParams.get('return')).toBe('/reports');
      const flow = location.searchParams.get('flow');
      expect(flow).toBeTruthy();

      // The browser's half of the login-CSRF binding, set on the TENANT origin
      // — only possible because forward_auth copies Set-Cookie from a non-2xx.
      const cookie = res.headers.get('set-cookie') as string;
      expect(cookie).toContain(`${flowCookieName(APP)}=${flow}`);
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('HttpOnly');
      expect(res.headers.get('cache-control')).toContain('no-store');
    });

    it('403s — never 302s — a VALID session that is not permitted', async () => {
      // THE loop case. This visitor is signed in; sending them to sign in
      // again produces exactly the same outcome, forever.
      const token = await mintAppSessionToken(outsiderId, 'outsider', APP, origin);
      const res = await verify({ cookie: `${sessionCookieName(APP)}=${token}` });

      expect(res.status).toBe(403);
      expect(res.headers.get('location')).toBeNull();
      expect(await res.text()).toContain('do not have access');
    });

    it('403s when the guard outlived its policy', async () => {
      // A stale Caddy block for an app whose gate was removed. Refusing is
      // right — canOpen's contract requires a policy — but it must be terminal,
      // not a redirect, or the app is bricked in a loop rather than with an
      // explanation.
      await getAppConfigService().setAccessPolicy(APP, undefined);
      const res = await verify({ 'x-forwarded-uri': '/' });
      expect(res.status).toBe(403);
      expect(res.headers.get('location')).toBeNull();
    });

    it('204s a permitted session and hands the tenant the identity', async () => {
      const token = await mintAppSessionToken(allowedId, 'allowed', APP, origin);
      const res = await verify({ cookie: `${sessionCookieName(APP)}=${token}` });

      expect(res.status).toBe(204);
      expect(res.headers.get('x-drop-session-user-id')).toBe(allowedId);
      expect(res.headers.get('x-drop-session-username')).toBe('allowed');
    });

    it('204s the OWNER even though they are not on the allow-list', async () => {
      const token = await mintAppSessionToken(ownerId, 'owner', APP, origin);
      const res = await verify({ cookie: `${sessionCookieName(APP)}=${token}` });
      expect(res.status).toBe(204);
    });

    it('401s a non-GET with no session, rather than dropping its body', async () => {
      // A 302 on a POST is followed as a GET with the body discarded, so a
      // gated app would silently lose form submissions at every expiry.
      const res = await verify({ 'x-forwarded-method': 'POST', 'x-forwarded-uri': '/submit' });
      expect(res.status).toBe(401);
      expect(res.headers.get('location')).toBeNull();
    });

    it('treats the placeholder Caddy sends for an ABSENT cookie as no session', async () => {
      // Measured: `header_up Cookie "<n>={http.request.cookie.<n>}"` forwards
      // the literal text when the cookie is missing. "Present" must not be
      // mistaken for "valid".
      const res = await verify({
        cookie: `${sessionCookieName(APP)}={http.request.cookie.${sessionCookieName(APP)}}`,
        'x-forwarded-uri': '/',
      });
      expect(res.status).toBe(302);
    });

    it('refuses a session minted for a different app', async () => {
      const token = await mintAppSessionToken(allowedId, 'allowed', 'otherapp', origin);
      const res = await verify({ cookie: `${sessionCookieName(APP)}=${token}`, 'x-forwarded-uri': '/' });
      expect(res.status).toBe(302);
    });

    it('sanitises a hostile return path rather than echoing it', async () => {
      const res = await verify({ 'x-forwarded-uri': '//evil.example.com/x' });
      const location = new URL(res.headers.get('location') as string);
      expect(location.searchParams.get('return')).toBe('/');
    });
  });

  describe('authorize', () => {
    it('bounces to the dashboard SPA without authenticating anything', async () => {
      // It cannot authenticate: the browser arrives on a top-level navigation
      // with no cookie and no bearer.
      const res = await t.hono.request(
        `/api/v1/app-access/authorize?app=${APP}&flow=F1&return=%2Freports`
      );
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location') as string);
      expect(location.pathname).toBe('/dashboard/app-access');
      expect(location.searchParams.get('flow')).toBe('F1');
    });

    it('refuses a bad app name or a missing flow', async () => {
      expect((await t.hono.request('/api/v1/app-access/authorize?app=../x&flow=F1')).status).toBe(400);
      expect((await t.hono.request(`/api/v1/app-access/authorize?app=${APP}`)).status).toBe(400);
    });
  });

  describe('code + exchange', () => {
    /**
     * Start a real flow the way a browser does — a flow id is no longer a
     * string a caller can invent. It must have been minted by a verify hop and
     * it is spent by the first code, because an id that merely LEAKED (it
     * transits two logged URLs for 300s) would otherwise let anyone mint a
     * code bound to someone else's browser.
     */
    const startFlow = async (): Promise<string> => {
      const res = await verify({ 'x-forwarded-uri': '/reports' });
      return new URL(res.headers.get('location') as string).searchParams.get('flow') as string;
    };

    const mintCode = async (token: string, flow: string) =>
      t.hono.request('/api/v1/app-access/code', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: APP, flow, return: '/reports' }),
      });

    it('refuses a code for a visitor the gate would refuse anyway', async () => {
      // The refusal happens HERE, on DROP's own page, rather than being
      // discovered one hop later at verify — which is the other half of the
      // loop fix.
      const res = await mintCode(outsiderToken, await startFlow());
      expect(res.status).toBe(403);
    });

    it('completes the round trip for a permitted visitor', async () => {
      const flow = await startFlow();
      const res = await mintCode(allowedToken, flow);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { redirectTo: string } };
      const code = new URL(body.data.redirectTo).searchParams.get('code') as string;
      expect(body.data.redirectTo.startsWith(origin)).toBe(true);

      const ex = await t.hono.request(`/api/v1/app-access/${APP}/exchange?code=${code}`, {
        headers: { cookie: `${flowCookieName(APP)}=${flow}` },
      });
      expect(ex.status).toBe(302);
      // From the RECORD, not from any query parameter.
      expect(ex.headers.get('location')).toBe('/reports');
      // getSetCookie(), not get() + toContain. A single FOLDED header would
      // satisfy `toContain` for both names while delivering neither correctly:
      // RFC 6265 forbids folding, no browser splits it, and the joined value
      // would carry a Max-Age that parses as garbage and never clear the flow
      // cookie. The count is what discriminates.
      const cookies = ex.headers.getSetCookie();
      expect(cookies).toHaveLength(2);

      const session = cookies.find(c => c.startsWith(sessionCookieName(APP)));
      expect(session).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
      expect(session).toContain('HttpOnly');
      expect(session).toContain('Secure');

      // The spent flow is cleared, so a replayed exchange URL matches nothing.
      const cleared = cookies.find(c => c.startsWith(`${flowCookieName(APP)}=;`));
      expect(cleared).toContain('Max-Age=0');
    });

    it('REFUSES an exchange whose code belongs to another browser flow', async () => {
      // Login-CSRF: the attacker's own valid code, the victim's browser.
      // The attacker starts their OWN flow and mints a real code in it.
      const res = await mintCode(allowedToken, await startFlow());
      const code = new URL(
        ((await res.json()) as { data: { redirectTo: string } }).data.redirectTo
      ).searchParams.get('code') as string;

      const ex = await t.hono.request(`/api/v1/app-access/${APP}/exchange?code=${code}`, {
        headers: { cookie: `${flowCookieName(APP)}=VICTIM-FLOW` },
      });
      expect(ex.status).toBe(403);
      expect(ex.headers.get('set-cookie')).toBeNull();
    });

    it('REFUSES an exchange with no flow cookie at all', async () => {
      const res = await mintCode(allowedToken, await startFlow());
      const code = new URL(
        ((await res.json()) as { data: { redirectTo: string } }).data.redirectTo
      ).searchParams.get('code') as string;

      const ex = await t.hono.request(`/api/v1/app-access/${APP}/exchange?code=${code}`);
      expect(ex.status).toBe(403);
    });

    it('is single-use', async () => {
      const flow = await startFlow();
      const res = await mintCode(allowedToken, flow);
      const code = new URL(
        ((await res.json()) as { data: { redirectTo: string } }).data.redirectTo
      ).searchParams.get('code') as string;
      const headers = { cookie: `${flowCookieName(APP)}=${flow}` };

      expect((await t.hono.request(`/api/v1/app-access/${APP}/exchange?code=${code}`, { headers })).status).toBe(302);
      expect((await t.hono.request(`/api/v1/app-access/${APP}/exchange?code=${code}`, { headers })).status).toBe(403);
    });

    it('REFUSES a flow id that no verify hop ever started', async () => {
      // The defence against an OBSERVED flow id. It transits two URLs on the
      // platform host for 300s, in query strings Caddy logs — so "knows the
      // id" must not be enough to mint against it.
      const res = await mintCode(allowedToken, 'not-a-real-flow');
      expect(res.status).toBe(400);
    });

    it('spends the flow on the first code', async () => {
      const flow = await startFlow();
      expect((await mintCode(allowedToken, flow)).status).toBe(200);
      expect((await mintCode(allowedToken, flow)).status).toBe(400);
    });

    it('requires a bearer for the code hop', async () => {
      const res = await t.hono.request('/api/v1/app-access/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: APP, flow: await startFlow() }),
      });
      expect(res.status).toBe(401);
    });
  });
});
