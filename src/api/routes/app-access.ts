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
import { getPublicUrl } from '../runtime-config';
import { canOpen, canOpenSession } from '../access';
import { AuthContext, getUserById } from '../middleware/auth';
import {
  mintAppSessionToken,
  verifyAppSessionToken,
  SESSION_TTL_SECONDS,
} from '../app-access/session-token';
import {
  mintFlowId,
  mintAppAccessCode,
  consumeAppAccessCode,
} from '../app-access/flow-code';
import { validateReturnPath } from '../app-access/return-path';
import { getAccessLog, type AccessLogEntry } from '../../managers/access-log/access-log';
import { computeAppUrl } from './apps';

const appAccess = new Hono();

/** How long a visitor has to complete the sign-in round trip. */
const FLOW_COOKIE_TTL_SECONDS = 300;

/** The dashboard route that reads `localStorage` and POSTs for a code. */
const CONSENT_PATH = '/dashboard/app-access';

export function sessionCookieName(appName: string): string {
  return `__Host-drop-session-${appName}`;
}

export function flowCookieName(appName: string): string {
  return `__Host-drop-flow-${appName}`;
}

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

/** The origin this app is served on — the audience its session is bound to. */
function appOrigin(appName: string): string | undefined {
  const app = getStateManager().getApp(appName);
  if (!app) return undefined;
  // Deterministic precisely because `assessAccessGate` refuses to gate an app
  // routed on more than one hostname: there is exactly one, so this and the
  // hostname baked into the Caddy block cannot disagree.
  return computeAppUrl(app);
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

    // The guard is emitted by DROP, but the POLICY is read live — a stale Caddy
    // block for an app whose gate was removed must not keep refusing traffic
    // forever, and it must not silently admit either. This is its own state.
    const policy = gatePolicy(appName);
    const app = getStateManager().getApp(appName);
    if (!app || !policy) {
      recordAccess({ appName, decision: 'refuse', reason: 'gate-without-policy' });
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

    const token = readCookie(c, sessionCookieName(appName));
    const identity = token
      ? await verifyAppSessionToken(token, origin, appName)
      : null;

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
        void getStateManager()
          .recordAppOpened(appName, identity.userId, identity.username)
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

    // No usable session. Only a top-level navigation can survive a redirect —
    // a POST would be silently converted to a GET and its body dropped, and an
    // XHR would fail cross-origin with no CORS headers. Measured: Caddy sets
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
  const target = new URL(`${getPublicUrl() ?? ''}${CONSENT_PATH}`);
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
    userId: user.id,
    username: user.username,
    appName,
    flowId,
    returnPath: returnPath ?? '/',
  });

  // The SPA navigates the browser here. The origin is DROP-derived, never
  // echoed from the request.
  return c.json(
    success({ redirectTo: `${origin}/.drop-session/exchange?code=${encodeURIComponent(code)}` })
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

    const origin = appOrigin(appName);
    if (!origin) return forbidden(c, appName, 'This application has no routable address.');

    // Minted fresh on every exchange, so a value the tenant planted before the
    // visitor's first sign-in is replaced rather than adopted.
    const token = await mintAppSessionToken(record.userId, record.username, appName, origin);

    noStore(c);
    c.header('Set-Cookie', [
      `${sessionCookieName(appName)}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`,
      // The flow is spent. Clearing it means a replayed exchange URL has
      // nothing to match against.
      `${flowCookieName(appName)}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    ].join(', '));
    // From the RECORD, never from the query — a `return` riding the redirect
    // chain is attacker-mutable between hops.
    return c.redirect(record.returnPath, 302);
  } catch {
    return forbidden(c, appName, 'Sign-in is temporarily unavailable.');
  }
});

export default appAccess;
