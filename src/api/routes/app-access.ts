/**
 * The browser access gate's four endpoints (DROP-152).
 *
 * DELIBERATELY NOT behind `authMiddleware`, for the same reason
 * `mcp-gateway.ts` is not: these authenticate their own credential classes.
 * `authMiddleware` would happily admit a session JWT, an API key or a
 * DROP-scoped OAuth token at `verify` — none of which is a browser session for
 * this app. `POST /code` is the one exception and mounts its own guard in
 * `server.ts`, exactly as `/oauth/approve` does.
 *
 * ## The flow, and why it has four hops rather than two
 *
 * DROP sets no cookies on its own host: the dashboard session is a bearer JWT
 * in `localStorage`. So a 302 into an `/authorize` endpoint arrives with NO
 * credential of any kind, and cannot mint anything. The existing OAuth flow
 * already solves this — `/oauth/authorize` never authenticates, it bounces to
 * a dashboard SPA route which reads `localStorage` and POSTs with a bearer —
 * and this follows it exactly.
 *
 *   verify (tenant host, via forward_auth)
 *     → 302 + a flow cookie on the TENANT origin
 *   authorize (platform host)  → 302 to the dashboard SPA
 *   POST /code (platform host, bearer)  → a single-use code
 *   exchange (tenant host, ungated)     → the session cookie
 *
 * ## Two refusals that are NOT redirects
 *
 * A gate whose every negative answer is "go and sign in" is an infinite loop
 * for anyone who is signed in and simply not allowed. So the negative outcomes
 * are split, and the split is the control:
 *
 *   - no session / expired / unparseable  → 302 to sign in
 *   - a VALID session that `canOpenSession` refuses → terminal 403
 *   - a guard with no policy behind it    → terminal 403
 *
 * Measured against Caddy 2.11.4: `forward_auth` copies a non-2xx response to
 * the client with body and headers intact, so a 403 here really does reach the
 * browser and really does stop the loop.
 */

import { Hono, type Context } from 'hono';
import { success, error, ErrorCodes } from '../types';
import { isValidAppName } from '../middleware/validate';
import { getStateManager } from '../../managers/app/state-manager';
import { getAppConfigServiceOrNull } from '../../managers/app/app-config';
import { getPublicUrl, isAccessGateEnabled } from '../runtime-config';
import { canOpen, canOpenSession, canOpenGuestSession } from '../access';
import { AuthContext, getUserById } from '../middleware/auth';
import {
  mintAppSessionToken,
  verifyAppSessionToken,
  SESSION_TTL_SECONDS,
} from '../app-access/session-token';
import {
  mintFlowId,
  consumeFlowId,
  mintAppAccessCode,
  consumeAppAccessCode,
} from '../app-access/flow-code';
import { validateReturnPath } from '../app-access/return-path';
import { sessionCookieName, flowCookieName, EXCHANGE_PATH } from '../app-access/names';
import {
  mintAppGuestSessionToken,
  verifyAppGuestSessionToken,
} from '../app-access/session-token';
import { getAppGuestById, getAppGuestManager } from '../../managers/app-guest';
import { getAccessLog, type AccessLogEntry } from '../../managers/access-log/access-log';
import { computeAppUrl } from '../../utils/app-url';

const appAccess = new Hono();

/** How long a visitor has to complete the sign-in round trip. */
const FLOW_COOKIE_TTL_SECONDS = 300;

/** The dashboard route that reads `localStorage` and POSTs for a code. */
const CONSENT_PATH = '/dashboard/app-access';

export { sessionCookieName, flowCookieName } from '../app-access/names';

/**
 * Read one cookie from the raw header.
 *
 * Written by hand rather than pulled from a library because of a measured
 * quirk: Caddy's `header_up Cookie "<name>={http.request.cookie.<name>}"`
 * narrowing forwards the PLACEHOLDER TEXT LITERALLY when the cookie is absent.
 * So a value can arrive that is syntactically a cookie and semantically
 * nonsense, and "present" must not be mistaken for "valid". Anything
 * containing `{` is treated as absent.
 */
function readCookie(c: Context, name: string): string | undefined {
  const header = c.req.header('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    if (!value || value.includes('{')) return undefined;
    return value;
  }
  return undefined;
}

/**
 * The origin this app is served on — the audience its session is bound to.
 *
 * Deterministic precisely because `assessAccessGate` refuses to gate an app
 * routed on more than one hostname: there is exactly one, so this and the
 * hostname baked into the Caddy block cannot disagree.
 *
 * Forced to `https` via `computeAppUrl`'s own `forceHttps` option:
 * `computeAppUrl` is the dashboard's URL-DISPLAY helper and by default
 * honours the tenant's own `tls: {disabled: true}` — which for a gated app
 * would put a single-use code on the wire in cleartext, and mint an audience
 * the visitor's browser can never reach over the transport the `Secure` cookie
 * requires. Route emission already ignores that flag for a gated app; so does
 * this.
 */
function appOrigin(appName: string): string | undefined {
  const app = getStateManager().getApp(appName);
  if (!app) return undefined;
  return computeAppUrl(app, { forceHttps: true });
}

/** The policy, or null when this app is not gated. */
function gatePolicy(appName: string) {
  return getAppConfigServiceOrNull()?.getConfig(appName)?.access ?? null;
}

/**
 * Record a decision, and NEVER let recording change it.
 *
 * `AccessLogService.record` is already fire-and-forget, but `getAccessLog()`
 * THROWS when the singleton has not been initialised — and on this path a
 * throw lands in the verify handler's catch, which denies. That would turn an
 * uninitialised log into a total outage for every gated app on the box. The
 * evidence trail is worth less than the thing it is evidence of.
 */
function recordAccess(entry: AccessLogEntry): void {
  try {
    getAccessLog().record(entry);
  } catch {
    // Deliberately silent: see above.
  }
}

function noStore(c: Context): void {
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
}

/** A terminal refusal the visitor can read and act on. Never a redirect. */
function forbidden(c: Context, appName: string, detail: string): Response {
  noStore(c);
  c.header('Content-Type', 'text/html; charset=utf-8');
  // Escaped: the app name reaches here from a Caddy-authored literal, but this
  // renders on the tenant's own origin and costs nothing to be certain about.
  const safeName = appName.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
  return c.body(
    `<!doctype html><meta charset="utf-8"><title>Access denied</title>` +
      `<h1>You do not have access to ${safeName}</h1>` +
      `<p>${detail}</p>` +
      `<p>Signing in again will not change this — ask the person who owns this application.</p>`,
    403
  );
}

/**
 * Is this guest still admissible RIGHT NOW — record live, policy live?
 *
 * `canOpenGuestSession` answers the POLICY half and deliberately does not read
 * the guest record (see its own doc: bindings at the authorization boundary,
 * record state at the verifier). So this exists only where there is NO
 * verifier between the credential and the session — the exchange, where the
 * credential is a single-use code rather than a guest token.
 */
function guestRecordLive(guestId: string, appName: string): boolean {
  const guest = getAppGuestById(guestId);
  if (!guest) return false;
  if (guest.appName !== appName) return false;
  return guest.disabled !== true;
}

/**
 * The membership RE-CHECK the exchange makes before minting a session.
 *
 * A code is minted at `POST /code` (or its guest sibling) and spent one
 * navigation later. In between the grant can be revoked — an owner removing
 * someone, an admin clearing the policy, a guest disabled. Without this the
 * revoked visitor still walks away with a session valid for the full TTL, so
 * revocation would take up to eight hours to mean anything for anyone who
 * happened to be mid-flow. The code being single-use does not help: it is a
 * credential minted BEFORE the decision it carries was last true.
 *
 * Fails CLOSED on a missing app or policy, for the same reason `canOpen` takes
 * a REQUIRED policy: this hop is reached only for an app that was gated when
 * the code was minted, so "no policy now" is a lookup that MISSED or a gate
 * removed mid-flow. Neither is a reason to mint.
 */
function codeStillAdmissible(
  record:
    | { kind: 'user'; userId: string; username: string }
    | { kind: 'guest'; guestId: string; email: string },
  appName: string
): boolean {
  const app = getStateManager().getApp(appName);
  const policy = gatePolicy(appName);
  if (!app || !policy) return false;

  if (record.kind === 'guest') {
    if (!guestRecordLive(record.guestId, appName)) return false;
    return canOpenGuestSession(
      { guestId: record.guestId, email: record.email, appName },
      policy,
      appName
    );
  }

  // The user arm reads the role LIVE from the credentials file, exactly as
  // `verifyAppSessionToken` does — the code carries no role and must not.
  const user = getUserById(record.userId);
  if (!user || user.enabled === false) return false;
  return canOpenSession(
    { userId: user.id, username: user.username, appName, role: user.role },
    app,
    policy,
    appName
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. verify — Caddy's forward_auth target, on the TENANT's hostname
// ─────────────────────────────────────────────────────────────────────────────
appAccess.get('/:app/verify', async c => {
  // Every path inside one try. This endpoint's contract is 204 / 302 / 403, and
  // a 500 is none of them — under forward_auth it becomes a 5xx from the auth
  // server, which Caddy copies to the visitor.
  const appName = c.req.param('app');
  try {
    if (!isValidAppName(appName)) return forbidden(c, appName, 'Unknown application.');

    // DROP-153 kill switch. Checked before the policy lookup and before any
    // identity work, so a disabled gate does no per-request credential
    // handling at all. ADMITS rather than refuses: the guard is emitted by
    // DROP, but a Caddy block emitted before the operator flipped this flag
    // off can still be loaded, and without this check turning the switch off
    // would leave that stale guard refusing traffic while the API and
    // dashboard report the app as ungated — an operator told the control is
    // off while users stay locked out. That inversion is the exact thing
    // access-gate.ts exists to prevent, and it lands in the one window
    // someone reaches for a kill switch: incident response. See
    // isAccessGateEnabled()'s own doc comment for why it fails closed
    // (ENFORCING) rather than admitting when nothing has wired the flag.
    if (!isAccessGateEnabled()) {
      // Logged ONLY for an app that exists — see the identical guard on the
      // policy-lookup branch below. This endpoint is unauthenticated and
      // reachable directly on the platform host, and the log's byte cap is
      // per app per day, so a caller rotating invented names would get a
      // fresh budget for each one and append without bound. `admit` is never
      // suppressed by that cap either, which makes the unbounded case worse
      // here, not better.
      if (getStateManager().getApp(appName)) {
        recordAccess({ appName, decision: 'admit', reason: 'gate-disabled' });
      }
      noStore(c);
      return c.body(null, 204);
    }

    // The guard is emitted by DROP, but the POLICY is read live — a stale Caddy
    // block for an app whose gate was removed must not keep refusing traffic
    // forever, and it must not silently admit either. This is its own state.
    const policy = gatePolicy(appName);
    const app = getStateManager().getApp(appName);
    if (!app || !policy) {
      // Logged ONLY for an app that exists. This endpoint is unauthenticated
      // and reachable directly on the platform host, and the log's byte cap is
      // per app per day — so a caller rotating invented names would get a
      // fresh budget for each one and append without bound.
      if (app) recordAccess({ appName, decision: 'refuse', reason: 'gate-without-policy' });
      return forbidden(
        c,
        appName,
        'This application is behind a sign-in gate that is no longer configured.'
      );
    }

    const origin = appOrigin(appName);
    if (!origin) {
      recordAccess({ appName, decision: 'refuse', reason: 'no-origin' });
      return forbidden(c, appName, 'This application has no routable address.');
    }

    // ONE cookie name, TWO credential classes. The exchange writes whichever
    // class the code record named into `sessionCookieName(appName)`, so this
    // hop cannot know which it is holding without trying both.
    //
    // The order is free, and that is a property worth stating rather than a
    // coincidence to rely on: each verifier checks `token_use` FIRST (see
    // `session-token.ts`'s module doc), so a guest token can never satisfy the
    // user verifier and a user token can never satisfy the guest one. The user
    // class is tried first only because it is the common case.
    const token = readCookie(c, sessionCookieName(appName));
    const identity = token ? await verifyAppSessionToken(token, origin, appName) : null;
    const guest =
      !identity && token ? await verifyAppGuestSessionToken(token, origin, appName) : null;

    // A guest token that FAILS its verifier — expired, revoked, disabled, or
    // minted for another app — is indistinguishable here from no cookie at
    // all, and falls through to the redirect below. That is a deliberate
    // choice with a real cost, so it is written down rather than left to be
    // rediscovered.
    //
    // Giving those cases the terminal 403 they deserve would mean reading the
    // token's `token_use` claim WITHOUT verifying its signature, purely to
    // decide the message. A tenant can set cookies on its own origin, so that
    // would hand a hostile tenant a way to force a terminal refusal for every
    // visitor to their own gated app — including account holders, whose
    // recovery path is the redirect this would replace. The gate is
    // GOVERNANCE: an admin may have gated an app precisely because they do
    // not trust the tenant, and the tenant must not be able to break the way
    // back in.
    //
    // The cost is a revoked guest being sent to a sign-in page they have no
    // account for. The owner re-sending an invite is the recovery path, which
    // is the same answer the plan gives for a missed invite.

    if (guest) {
      if (canOpenGuestSession(guest, policy, appName)) {
        // No `userId`/`username` on the log row: a guest id in a field named
        // for a DROP user is the cross-class confusion the fourth credential
        // class exists to prevent, one layer below the boundary that prevents
        // it. `reason` carries the fact instead, until the estate view grows a
        // guest column of its own (plan: estate rendering follows in a fixup).
        recordAccess({ appName, decision: 'admit', reason: 'guest' });
        // The guest store's own equivalent of `recordAppOpened`, and the
        // reason `recordAppOpened` is NOT called here: that summary is keyed
        // on a user id and has no guest column yet.
        try {
          getAppGuestManager().touchLastSeen(guest.guestId);
        } catch {
          // Best-effort, exactly like the log above: a summary nobody has read
          // yet must never delay or fail the authorization it describes.
        }
        // A DISTINCT header name, and NO `X-Drop-Session-User-Id` /
        // `-Username` at all.
        //
        // What this buys, precisely: an app whose Caddy block was emitted
        // before DROP-155 copies neither name, so a guest arrives at that
        // tenant with NO identity rather than one indistinguishable from a
        // DROP user's. That is fail-closed on ABSENCE.
        //
        // It is NOT the same as unspoofable. `forward_auth` proxies the
        // ORIGINAL request to the tenant, and an already-emitted block neither
        // strips this name from the client's request nor re-adds it via
        // `copy_headers` — so a client can set `X-Drop-Guest-Id` itself and
        // the tenant will see the client's value, exactly as is true of
        // `X-Drop-Session-User-Id` today. This header becomes trustworthy only
        // once the fleet is re-emitted with a strip list AND `copy_headers`;
        // until then it is a convenience, and the tenant must not treat it as
        // authentication.
        c.header('X-Drop-Guest-Id', guest.guestId);
        noStore(c);
        return c.body(null, 204);
      }
      // A valid guest session whose grant is gone. Terminal, for the same
      // reason the user arm is — and for a harder one: a guest has no account
      // to sign in with, so a redirect here is a loop with no exit at all.
      recordAccess({ appName, decision: 'refuse', reason: 'guest-not-permitted' });
      return forbidden(c, appName, 'Your invitation to this application is no longer valid.');
    }

    if (identity) {
      if (canOpenSession(identity, app, policy, appName)) {
        recordAccess({
          appName,
          decision: 'admit',
          userId: identity.userId,
          username: identity.username,
        });
        // The estate view's "who has opened it". Fire-and-forget for the same
        // reason the log is: this runs once per HTTP request, and a summary
        // nobody has read yet must never delay or fail the authorization it
        // describes.
        // Deferred, so even a throw from the SINGLETON ACCESSOR cannot reach the
        // handler's catch and turn a summary nobody has read yet into a denial.
        // Calling `getStateManager()` synchronously here would have been
        // outside the promise chain — the exact shape `recordAccess` above
        // exists to avoid.
        void Promise.resolve()
          .then(() => getStateManager().recordAppOpened(appName, identity.userId, identity.username))
          .catch(() => undefined);
        // The tenant learns WHO is calling without ever seeing DROP's cookie —
        // the generated block strips it on the hop to them.
        c.header('X-Drop-Session-User-Id', identity.userId);
        c.header('X-Drop-Session-Username', identity.username);
        noStore(c);
        return c.body(null, 204);
      }
      // Authenticated and refused. Terminal — see this module's header.
      recordAccess({
        appName,
        decision: 'refuse',
        userId: identity.userId,
        username: identity.username,
        reason: 'not-permitted',
      });
      return forbidden(c, appName, 'Your account is not on this application’s access list.');
    }

    // No usable session.
    //
    // The app's MCP endpoint answers 401, never a redirect.
    //
    // An MCP client presents an app-audienced bearer and holds no cookie, so a
    // 302 to a login page is something it cannot follow and cannot interpret,
    // where a 401 is exactly what starts its OAuth flow. The gate answers for
    // browsers; the app's own MCP guard — which nests INSIDE this one — answers
    // for machines, and both still run. Resolving this by hoisting `/mcp*`
    // outside the gate is the sibling shape measured against Caddy 2.11.4 as
    // the worst case: there a bearer-only request reaches the tenant with no
    // browser session at all.
    //
    // Keyed on the forwarded PATH, not on the presence of a bearer: the guard
    // strips `Authorization` and `X-Api-Key` before this hop precisely so a
    // tenant-controlled credential cannot reach DROP's verify endpoint, so a
    // header check here would be dead code that reads as a control.
    // `X-Forwarded-Uri` is set by Caddy on this path, not by the client.
    const mcpPath = getAppConfigServiceOrNull()?.getConfig(appName)?.mcp?.path;
    const forwardedUri = c.req.header('x-forwarded-uri') ?? '';
    if (mcpPath && forwardedUri.split('?')[0].startsWith(mcpPath)) {
      recordAccess({ appName, decision: 'refuse', reason: 'no-session-mcp' });
      noStore(c);
      c.header('WWW-Authenticate', 'Bearer error="invalid_token"');
      return c.json(
        error(ErrorCodes.UNAUTHORIZED, 'This endpoint requires a token, not a browser sign-in'),
        401
      );
    }

    // Only a top-level navigation can survive a redirect — a POST would be
    // silently converted to a GET and its body dropped, and an XHR would fail
    // cross-origin with no CORS headers. Measured: Caddy sets
    // `X-Forwarded-Method`.
    const method = (c.req.header('x-forwarded-method') ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      recordAccess({ appName, decision: 'refuse', reason: 'no-session-non-get' });
      noStore(c);
      return c.json(error(ErrorCodes.UNAUTHORIZED, 'Your session has expired'), 401);
    }

    const platform = getPublicUrl();
    if (!platform) {
      // `assessAccessGate` refuses to emit a guard without one, so this is a
      // configuration that changed under a live gate.
      recordAccess({ appName, decision: 'refuse', reason: 'no-public-url' });
      return forbidden(c, appName, 'This platform has no sign-in address configured.');
    }

    // The flow id binds the code that comes back to THIS browser. Without it an
    // attacker can mint a code for their own account and navigate a victim to
    // the exchange, after which the victim browses as the attacker.
    const flowId = mintFlowId();
    const returnPath = validateReturnPath(c.req.header('x-forwarded-uri')) ?? '/';
    const target = new URL(`${platform}/api/v1/app-access/authorize`);
    target.searchParams.set('app', appName);
    target.searchParams.set('flow', flowId);
    target.searchParams.set('return', returnPath);

    noStore(c);
    // `__Host-` requires Secure + Path=/ + no Domain. Measured: forward_auth
    // copies Set-Cookie from a non-2xx response, which is what makes setting a
    // cookie on the tenant origin from here possible at all.
    c.header(
      'Set-Cookie',
      `${flowCookieName(appName)}=${flowId}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${FLOW_COOKIE_TTL_SECONDS}`
    );
    recordAccess({ appName, decision: 'refuse', reason: 'no-session' });
    return c.redirect(target.toString(), 302);
  } catch {
    return forbidden(c, appName, 'Sign-in is temporarily unavailable.');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. authorize — on the PLATFORM host. Bounces to the SPA; authenticates nothing.
// ─────────────────────────────────────────────────────────────────────────────
appAccess.get('/authorize', c => {
  const appName = c.req.query('app') ?? '';
  const flow = c.req.query('flow') ?? '';
  const returnPath = validateReturnPath(c.req.query('return')) ?? '/';

  noStore(c);
  if (!isValidAppName(appName) || !flow) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Invalid sign-in request'), 400);
  }

  // Everything here is client-supplied — there is no forward_auth and so no
  // generation-time literal at this hop. `return` has been validated to a
  // relative path, `app` to the name grammar, and the destination below is
  // DROP's own dashboard on DROP's own host, so nothing client-controlled
  // reaches a Location as an origin.
  const platform = getPublicUrl();
  if (!platform) {
    // `new URL('/dashboard/...')` throws without an origin, and a 500 on a
    // sign-in hop the visitor was just redirected to is the one thing this
    // endpoint must not do.
    return c.json(error(ErrorCodes.SERVICE_UNAVAILABLE, 'Sign-in is not configured'), 503);
  }

  const target = new URL(`${platform}${CONSENT_PATH}`);
  target.searchParams.set('app', appName);
  target.searchParams.set('flow', flow);
  target.searchParams.set('return', returnPath);
  return c.redirect(target.toString(), 302);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. POST /code — the SPA calls this WITH a bearer. Mounted behind a role guard.
// ─────────────────────────────────────────────────────────────────────────────
appAccess.post('/code', async c => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const body = (await c.req.json().catch(() => ({}))) as {
    app?: unknown;
    flow?: unknown;
    return?: unknown;
  };
  const appName = typeof body.app === 'string' ? body.app : '';
  const flowId = typeof body.flow === 'string' ? body.flow : '';
  const returnPath = validateReturnPath(typeof body.return === 'string' ? body.return : undefined);

  noStore(c);
  if (!isValidAppName(appName) || !flowId) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Invalid sign-in request'), 400);
  }

  const app = getStateManager().getApp(appName);
  const policy = gatePolicy(appName);
  if (!app || !policy) return c.json(error(ErrorCodes.NOT_FOUND, 'This application is not gated'), 404);

  // The flow must have been STARTED by a verify hop, and it is spent here.
  // Otherwise an observed flow id — and it transits two logged URLs for 300s —
  // would let anyone mint a code bound to a victim's browser.
  if (!consumeFlowId(flowId)) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'This sign-in has expired'), 400);
  }

  // The SAME predicate the verify hop uses. If these two ever disagree the
  // visitor loops between them forever, so the refusal is made HERE, where DROP
  // controls the page, rather than being discovered one hop later.
  if (!canOpen(auth, app, policy)) {
    return c.json(error(ErrorCodes.UNAUTHORIZED, 'Not permitted to open this application'), 403);
  }
  const user = auth?.userId ? getUserById(auth.userId) : null;
  if (!user) return c.json(error(ErrorCodes.UNAUTHORIZED, 'Not permitted to open this application'), 403);

  const origin = appOrigin(appName);
  if (!origin) return c.json(error(ErrorCodes.CONFLICT, 'This application has no routable address'), 409);

  const code = mintAppAccessCode({
    kind: 'user',
    userId: user.id,
    username: user.username,
    appName,
    flowId,
    returnPath: returnPath ?? '/',
  });

  // The SPA navigates the browser here. The origin is DROP-derived, never
  // echoed from the request.
  // EXCHANGE_PATH, not a second copy of the literal: the Caddy matcher is
  // built from the same constant, and a drift between them would 404 the hop
  // that ends every sign-in.
  return c.json(
    success({ redirectTo: `${origin}${EXCHANGE_PATH}?code=${encodeURIComponent(code)}` })
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. exchange — on the TENANT's hostname, and NEVER behind the gate
// ─────────────────────────────────────────────────────────────────────────────
appAccess.get('/:app/exchange', async c => {
  const appName = c.req.param('app');
  try {
    if (!isValidAppName(appName)) return forbidden(c, appName, 'Unknown application.');

    const code = c.req.query('code') ?? '';
    // The browser's half of the flow binding. An attacker can supply a code;
    // they cannot supply a cookie for the victim's origin.
    const flowId = readCookie(c, flowCookieName(appName));
    const record = consumeAppAccessCode(code, flowId);
    if (!record || record.appName !== appName) {
      return forbidden(
        c,
        appName,
        'This sign-in link is no longer valid. Reload the page to start again.'
      );
    }

    // Membership, re-checked at the LAST moment before a session exists — see
    // `codeStillAdmissible`. Deliberately AFTER `consumeAppAccessCode`, so a
    // code whose grant was revoked mid-flow is still SPENT rather than left
    // replayable for the rest of its (short) life.
    if (!codeStillAdmissible(record, appName)) {
      recordAccess({
        appName,
        decision: 'refuse',
        reason: record.kind === 'guest' ? 'guest-revoked-mid-flow' : 'revoked-mid-flow',
        ...(record.kind === 'user' ? { userId: record.userId, username: record.username } : {}),
      });
      return forbidden(
        c,
        appName,
        'Your access to this application was removed. Ask the person who owns it.'
      );
    }

    const origin = appOrigin(appName);
    if (!origin) return forbidden(c, appName, 'This application has no routable address.');

    // Minted fresh on every exchange, so a value the tenant planted before the
    // visitor's first sign-in is replaced rather than adopted.
    // Branch on the record's own discriminant rather than sniffing a field:
    // a guest id must never reach `mintAppSessionToken`'s userId slot, which
    // is the cross-class confusion the separate guest token class exists to
    // prevent. An added third identity kind fails to compile here.
    const token =
      record.kind === 'guest'
        ? await mintAppGuestSessionToken(record.guestId, record.email, appName, origin)
        : await mintAppSessionToken(record.userId, record.username, appName, origin);

    noStore(c);
    // TWO headers, appended — never one folded value. RFC 6265 forbids folding
    // and no browser splits it, so a joined pair would have delivered a
    // `Max-Age` that parses as garbage (dropping the 8h TTL to a
    // browser-session cookie) and would never have cleared the flow cookie at
    // all — making this function's own replay claim false.
    c.header(
      'Set-Cookie',
      `${sessionCookieName(appName)}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
      { append: true }
    );
    // The flow is spent. Clearing it means a replayed exchange URL has nothing
    // to match against.
    c.header(
      'Set-Cookie',
      `${flowCookieName(appName)}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
      { append: true }
    );
    // From the RECORD, never from the query — a `return` riding the redirect
    // chain is attacker-mutable between hops.
    return c.redirect(record.returnPath, 302);
  } catch {
    return forbidden(c, appName, 'Sign-in is temporarily unavailable.');
  }
});

export default appAccess;
