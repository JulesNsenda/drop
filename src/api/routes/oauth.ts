/**
 * OAuth 2.1 authorization-code + PKCE endpoints for the hosted MCP connector
 * (PRD-041).
 *
 * Every handler fails closed: if `DROP_PUBLIC_URL` (the OAuth issuer) is
 * unset, or platform auth isn't enabled, every route here refuses to serve
 * rather than derive an issuer from a spoofable source or run without users
 * to consent. See docs/plans/2026-07-10-mcp-oauth.md and
 * docs/plans/2026-07-11-mcp-oauth-execution.md for the design.
 *
 * `/authorize` and `/token` are deliberately NOT behind `authMiddleware` —
 * `/authorize` self-gates via the SPA session redirect and `/token`
 * authenticates via PKCE (mounting session auth on either breaks claude.ai's
 * calls). `/approve`, `/revoke`, and `/client` ARE behind `authMiddleware`,
 * mounted externally in server.ts.
 */

import { randomUUID } from 'crypto';
import { Hono, type Context } from 'hono';
import { success, error, ErrorCodes } from '../types';
import { ValidationError } from '../middleware/error';
import { getPublicUrl } from '../runtime-config';
import { getMcpResourceUrl } from '../oauth/metadata';
import { verifyPkceS256 } from '../oauth/pkce';
import { mintAuthorizationCode, consumeAuthorizationCode } from '../oauth/authorization-code';
import {
  resolveOAuthResource,
  audienceFor,
  getAppMcpResourceUrl,
  type AppMcpResource,
  type OAuthResourceTarget,
} from '../oauth/app-resources';
import { getStateManager } from '../../managers/app/state-manager';
import { getAppConfigService } from '../../managers/app/app-config';
import { computeAppUrl } from './apps';
import { canAccess } from '../access';
import {
  isAuthEnabled,
  getOAuthClientId,
  getOrCreateOAuthClientId,
  mintOAuthAccessToken,
  mintAppMcpAccessToken,
  ACCESS_TOKEN_TTL_SECONDS,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  getUserById,
  predatesInvalidationStamp,
  type AuthContext,
  type User,
} from '../middleware/auth';

/**
 * Every app that currently advertises an MCP endpoint, as resource identifiers.
 *
 * Read fresh on every call rather than cached: an app that stops being an MCP
 * server, or is deleted, must stop being a mintable audience immediately — a
 * cached allowlist would keep issuing tokens for a resource that no longer
 * exists, and app names are reusable.
 */
function listAppMcpResources(): AppMcpResource[] {
  let configs;
  try {
    configs = getAppConfigService().getAllConfigs();
  } catch {
    // Managers not initialised (isolated route tests) — no app resources, so
    // only DROP's own resource resolves. Fails closed.
    return [];
  }

  const out: AppMcpResource[] = [];
  for (const cfg of configs) {
    // PER-APP try. A single `try` around the whole loop meant one app could
    // zero the list for EVERY tenant: `computeAppUrl` interpolates
    // `app.customDomain` raw, that field is settable through PUT /apps/:name
    // without the domain-format check the dedicated route applies, and a value
    // WHATWG URL rejects (a space, a '[') throws inside canonicalizeUrl. The
    // whole feature would then fail closed platform-wide until an operator
    // found the one poisoned record. One bad app must cost only that app.
    try {
      // Only an EXPLICIT declaration registers an OAuth resource. Inference
      // exists to label an app in the UI; letting it also mint an audience
      // would enrol any app that merely depends on the MCP SDK — including an
      // MCP *client* or a test harness — without its owner asking for it.
      if (cfg.mcp?.source !== 'declared') continue;
      if (cfg.mcp.auth !== 'drop') continue;
      const app = getStateManager().getApp(cfg.name);
      if (!app) continue;
      const base = computeAppUrl(app);
      if (!base) continue;
      out.push({ appName: cfg.name, resource: getAppMcpResourceUrl(base, cfg.mcp.path) });
    } catch {
      continue;
    }
  }
  return out;
}

/** Resolve a requested resource, or null to refuse. */
function resolveRequestedResource(
  requested: string | undefined,
  publicUrl: string
): OAuthResourceTarget | null {
  return resolveOAuthResource(requested, getMcpResourceUrl(publicUrl), listAppMcpResources());
}

/**
 * Whether this user may hold a token for this target.
 *
 * Authentication is not authorization: resolving a resource proves the app
 * exists and opted in, not that the consenting user may use it. Checked at
 * mint AND at every refresh, because ownership is not expressible in a token's
 * claims — an app can be transferred, or deleted and its name re-registered by
 * a different user, while a grant for that name is still alive.
 */
function mayHoldTokenFor(target: OAuthResourceTarget, user: User): boolean {
  if (target.kind === 'drop') return true;
  try {
    const app = getStateManager().getApp(target.appName);
    if (!app) return false;
    return canAccess(
      { userId: user.id, username: user.username, role: user.role, authMethod: 'jwt' },
      app
    );
  } catch {
    return false;
  }
}

/** The only allowed redirect_uri — claude.ai's fixed MCP OAuth callback. Validated by raw string equality. */
export const CLAUDE_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

const oauth = new Hono();

/**
 * Shared fail-closed precondition gate for every OAuth handler: the issuer
 * must be configured and platform auth must be enabled. Returns the
 * resolved `publicUrl` on success, or a Response to return immediately.
 */
function requireOAuthPreconditions(c: Context): { publicUrl: string } | Response {
  const publicUrl = getPublicUrl();
  if (!publicUrl) {
    return c.json(
      error(
        ErrorCodes.SERVICE_UNAVAILABLE,
        'OAuth is not configured on this server (DROP_PUBLIC_URL unset).'
      ),
      503
    );
  }
  if (!isAuthEnabled()) {
    return c.json(
      error(ErrorCodes.BAD_REQUEST, 'OAuth requires authentication to be enabled.'),
      400
    );
  }
  return { publicUrl };
}

/** Extract a string field from a parsed x-www-form-urlencoded body (Hono types values as string | File). */
function formStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// GET /oauth/authorize — validate the request, then bounce the browser to
// the dashboard consent SPA (or an error page / error redirect).
oauth.get('/authorize', (c) => {
  const pre = requireOAuthPreconditions(c);
  if (pre instanceof Response) return pre;
  const { publicUrl } = pre;

  const clientId = c.req.query('client_id') ?? '';
  const redirectUri = c.req.query('redirect_uri') ?? '';
  const responseType = c.req.query('response_type') ?? '';
  const codeChallenge = c.req.query('code_challenge') ?? '';
  const codeChallengeMethod = c.req.query('code_challenge_method') ?? '';
  const state = c.req.query('state') ?? '';
  const resource = c.req.query('resource');
  const scope = c.req.query('scope') ?? '';

  // Phase 5 observability: the resource->aud canonicalization is the single
  // most likely live break with claude.ai — log the raw incoming values.
  console.log('[oauth] authorize probe', {
    resource,
    redirect_uri: redirectUri,
    hasChallenge: Boolean(codeChallenge),
  });

  // Open-redirector guard: an unrecognized client_id or redirect_uri NEVER
  // redirects — render a plain error response instead.
  if (clientId !== getOAuthClientId() || redirectUri !== CLAUDE_REDIRECT_URI) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, 'Invalid client_id or redirect_uri.'),
      400
    );
  }

  const redirectWithError = (errCode: string): Response => {
    const url = new URL(redirectUri);
    url.searchParams.set('error', errCode);
    if (state) url.searchParams.set('state', state);
    return c.redirect(url.toString(), 302);
  };

  if (responseType !== 'code') {
    return redirectWithError('unsupported_response_type');
  }

  // PKCE is mandatory — no downgrade to the (unsupported) `plain` method or no PKCE at all.
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    return redirectWithError('invalid_request');
  }

  // Gate (a) of SEC-1: a requested resource must resolve to exactly ONE known
  // target — DROP's own MCP endpoint, or one app's. Anything else is refused
  // here, so a tenant-controlled subdomain can never become a registrable
  // OAuth resource just by being named on the consent screen.
  const target = resolveRequestedResource(resource || undefined, publicUrl);
  if (!target) {
    return redirectWithError('invalid_target');
  }
  const resolvedResource = audienceFor(target, getMcpResourceUrl(publicUrl));

  const consentUrl = new URL(`${publicUrl}/dashboard/oauth-consent`);
  consentUrl.searchParams.set('client_id', clientId);
  consentUrl.searchParams.set('redirect_uri', redirectUri);
  consentUrl.searchParams.set('state', state);
  consentUrl.searchParams.set('code_challenge', codeChallenge);
  consentUrl.searchParams.set('code_challenge_method', codeChallengeMethod);
  if (scope) consentUrl.searchParams.set('scope', scope);
  // The RESOLVED resource, so the consent screen states what is actually being
  // granted. For an app target that is the app's own URL, which names the app
  // to the person approving — they are consenting to one tenant app, not to
  // DROP's control plane.
  consentUrl.searchParams.set('resource', resolvedResource);
  if (target.kind === 'app') consentUrl.searchParams.set('app', target.appName);

  return c.redirect(consentUrl.toString(), 302);
});

// POST /oauth/approve — bearer-authenticated (authMiddleware('user'), mounted
// in server.ts). The SPA calls this after the operator clicks Approve.
oauth.post('/approve', async (c) => {
  const pre = requireOAuthPreconditions(c);
  if (pre instanceof Response) return pre;
  const { publicUrl } = pre;

  const auth = (c.get as (key: string) => AuthContext | undefined)('auth');
  if (!auth) {
    return c.json(error(ErrorCodes.UNAUTHORIZED, 'Authentication required.'), 401);
  }

  const body = await c.req.json<{
    client_id?: string;
    redirect_uri?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    state?: string;
    resource?: string;
  }>();

  const clientId = body.client_id ?? '';
  const redirectUri = body.redirect_uri ?? '';
  const codeChallenge = body.code_challenge ?? '';
  const codeChallengeMethod = body.code_challenge_method ?? '';
  const state = body.state ?? '';
  const resource = body.resource;

  // Defense in depth — re-validate exactly as /authorize did. userId comes
  // from the bearer session, never the body (CSRF-resistant by construction).
  if (clientId !== getOAuthClientId() || redirectUri !== CLAUDE_REDIRECT_URI) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, 'Invalid client_id or redirect_uri.'),
      400
    );
  }
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, 'PKCE code_challenge (S256) is required.'),
      400
    );
  }

  // Re-resolved here, not trusted from the body: /authorize and /approve are
  // separate requests, and the app set can change between them (an app can stop
  // advertising MCP, or be deleted and its name re-registered by someone else).
  // The code is minted for whatever resolves NOW, or not at all.
  const target = resolveRequestedResource(resource, publicUrl);
  if (!target) {
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, 'resource does not match a known MCP endpoint.'),
      400
    );
  }

  const approver = getUserById(auth.userId) as User | null;
  if (!approver || !mayHoldTokenFor(target, approver)) {
    // Indistinguishable from an unknown resource: whether an app exists and
    // who owns it is not something an unauthorized approver should learn here.
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, 'resource does not match a known MCP endpoint.'),
      400
    );
  }

  const resolvedResource = audienceFor(target, getMcpResourceUrl(publicUrl));

  const code = mintAuthorizationCode({
    userId: auth.userId,
    clientId,
    redirectUri,
    codeChallenge,
    resource: resolvedResource,
  });

  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set('code', code);
  if (state) redirectUrl.searchParams.set('state', state);

  return c.json(success({ redirect: redirectUrl.toString() }));
});

// POST /oauth/token — form-urlencoded (claude.ai sends form-encoded, not
// JSON). Responses use the plain OAuth JSON error/success shape (RFC 6749),
// NOT DROP's { success, data/error } envelope.
oauth.post('/token', async (c) => {
  const pre = requireOAuthPreconditions(c);
  if (pre instanceof Response) return pre;
  const { publicUrl } = pre;

  const body = await c.req.parseBody();
  const grantType = formStr(body['grant_type']);

  // Phase 5 observability: first-contact log for the token endpoint.
  console.log('[oauth] token', { grant_type: grantType, client_id: formStr(body['client_id']) });

  const tokenError = (code: string, description?: string) =>
    c.json(
      { error: code, ...(description ? { error_description: description } : {}) },
      400
    );

  if (grantType === 'authorization_code') {
    const code = formStr(body['code']);
    const codeVerifier = formStr(body['code_verifier']);
    const clientId = formStr(body['client_id']);
    const redirectUri = formStr(body['redirect_uri']);

    if (!code) return tokenError('invalid_grant', 'code is required');

    const record = consumeAuthorizationCode(code);
    if (!record) return tokenError('invalid_grant', 'Unknown or expired authorization code');

    if (clientId !== record.clientId || redirectUri !== record.redirectUri) {
      return tokenError('invalid_grant', 'client_id or redirect_uri mismatch');
    }
    if (!codeVerifier || !verifyPkceS256(codeVerifier, record.codeChallenge)) {
      return tokenError('invalid_grant', 'PKCE verification failed');
    }

    const user = getUserById(record.userId) as User | null;
    if (!user) return tokenError('invalid_grant', 'User no longer exists');
    // DROP-130 MEDIUM-5: this branch checked `!user` but not `enabled` — the
    // `refresh_token` branch below has checked `enabled` since DROP-075. An
    // authorization code minted before suspension could still be exchanged
    // after, and the refresh token it mints has its OWN fresh `createdAt`,
    // so every later `predatesInvalidationStamp` check on that refresh token
    // would pass forever: a pre-incident credential laundered into one that
    // outlives the incident permanently.
    if (user.enabled === false) {
      return tokenError('invalid_grant', 'Account is disabled');
    }
    // Same reasoning, for the stamp itself: a code minted BEFORE containment
    // must not be exchangeable after, even within its own 60s TTL.
    if (predatesInvalidationStamp(record.createdAt, user.credentialsInvalidBefore)) {
      return tokenError('invalid_grant', 'Authorization code predates a credential invalidation');
    }

    // One sid per GRANT, minted here at code exchange and carried through every
    // later refresh. This is the stable half of principalId: without it the
    // principal would change every 15 minutes when the access token rotates.
    const sid = randomUUID();

    // Which token CLASS this grant gets is decided by re-resolving the recorded
    // resource, so an app whose MCP endpoint has since gone away stops being a
    // mintable audience rather than silently falling back to DROP's own.
    const target = resolveRequestedResource(record.resource, publicUrl);
    if (!target) return tokenError('invalid_target', 'Resource is no longer a known MCP endpoint');
    if (!mayHoldTokenFor(target, user)) {
      return tokenError('invalid_target', 'Resource is no longer a known MCP endpoint');
    }

    const accessToken =
      target.kind === 'app'
        ? await mintAppMcpAccessToken(user, target.resource, target.appName, sid)
        : await mintOAuthAccessToken(user, record.resource, sid);
    // The grant's audience is RECORDED, so a refresh cannot re-derive a
    // different (broader) one later.
    const refreshToken = await issueRefreshToken(user.id, record.clientId, sid, record.resource);

    c.header('Cache-Control', 'no-store');
    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: 'offline_access',
    });
  }

  if (grantType === 'refresh_token') {
    const presented = formStr(body['refresh_token']);
    const clientId = formStr(body['client_id']);

    if (!presented) return tokenError('invalid_grant', 'refresh_token is required');
    if (clientId !== getOAuthClientId()) return tokenError('invalid_grant', 'client_id mismatch');

    const rotated = await rotateRefreshToken(presented);
    if (!rotated) return tokenError('invalid_grant', 'Unknown or already-used refresh token');

    const user = getUserById(rotated.userId) as User | null;
    if (!user) return tokenError('invalid_grant', 'User no longer exists');
    // Existence is not enough. verifyApiKey has rejected a disabled owner
    // since DROP-075; this path never did, so suspending a user blocked their
    // login and purged their keys while their OAuth grant kept refreshing
    // forever. Same rule, same reason.
    if (user.enabled === false) {
      return tokenError('invalid_grant', 'Account is disabled');
    }

    // The RECORDED resource, never a recomputed one. Recomputing DROP's own
    // resource here would hand a grant issued for a tenant app a token
    // audienced at DROP's control plane on its first refresh — an app-scoped
    // credential escalating to every app its user owns. A grant predating this
    // field has no recorded resource and could only ever have been DROP's own.
    const grantResource = rotated.resource ?? getMcpResourceUrl(publicUrl);
    const target = resolveRequestedResource(grantResource, publicUrl);
    if (!target) return tokenError('invalid_target', 'Resource is no longer a known MCP endpoint');
    // Re-checked on EVERY refresh, not just at consent. Otherwise a grant
    // outlives the access it was based on: delete an app, let someone else
    // register the name, and the old refresh token keeps minting valid tokens
    // against the new owner's app forever.
    if (!mayHoldTokenFor(target, user)) {
      return tokenError('invalid_target', 'Resource is no longer a known MCP endpoint');
    }

    // rotated.sid, NOT a fresh one — the grant's identity survives the refresh.
    const accessToken =
      target.kind === 'app'
        ? await mintAppMcpAccessToken(user, target.resource, target.appName, rotated.sid)
        : await mintOAuthAccessToken(user, grantResource, rotated.sid);

    c.header('Cache-Control', 'no-store');
    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: rotated.refreshToken,
      scope: 'offline_access',
    });
  }

  return tokenError('unsupported_grant_type', `Unsupported grant_type: ${grantType || '(missing)'}`);
});

// POST /oauth/client — admin-only (authMiddleware('admin'), mounted in
// server.ts). Mints (once) and returns the static client_id the operator
// pastes into claude.ai's connector settings.
oauth.post('/client', async (c) => {
  const pre = requireOAuthPreconditions(c);
  if (pre instanceof Response) return pre;
  const { publicUrl } = pre;

  const clientId = await getOrCreateOAuthClientId();
  return c.json(
    success({
      client_id: clientId,
      // DROP is a public PKCE client — there is no client secret. Surfaced
      // explicitly so the UI can tell the operator to leave that field blank.
      client_secret: null,
      redirect_uri: CLAUDE_REDIRECT_URI,
      mcp_url: getMcpResourceUrl(publicUrl),
    })
  );
});

// POST /oauth/revoke — bearer-authenticated (authMiddleware('user'), mounted
// in server.ts). Revokes a single presented refresh token.
oauth.post('/revoke', async (c) => {
  const pre = requireOAuthPreconditions(c);
  if (pre instanceof Response) return pre;

  const auth = (c.get as (key: string) => AuthContext | undefined)('auth');
  if (!auth) {
    return c.json(error(ErrorCodes.UNAUTHORIZED, 'Authentication required.'), 401);
  }

  const body = await c.req.json<{ refresh_token?: string }>();
  const refreshToken = body.refresh_token ?? '';
  if (!refreshToken) {
    throw new ValidationError('refresh_token is required');
  }

  const revoked = await revokeRefreshToken(refreshToken);
  return c.json(success({ revoked }));
});

export default oauth;
