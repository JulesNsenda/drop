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

import { Hono, type Context } from 'hono';
import { success, error, ErrorCodes } from '../types';
import { ValidationError } from '../middleware/error';
import { getPublicUrl } from '../runtime-config';
import { getMcpResourceUrl, canonicalizeUrl } from '../oauth/metadata';
import { verifyPkceS256 } from '../oauth/pkce';
import { mintAuthorizationCode, consumeAuthorizationCode } from '../oauth/authorization-code';
import {
  isAuthEnabled,
  getOAuthClientId,
  getOrCreateOAuthClientId,
  mintOAuthAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  getUserById,
  type AuthContext,
  type User,
} from '../middleware/auth';

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

  const mcpResource = getMcpResourceUrl(publicUrl);
  if (resource) {
    let canonicalResource: string;
    try {
      canonicalResource = canonicalizeUrl(resource);
    } catch {
      return redirectWithError('invalid_target');
    }
    if (canonicalResource !== mcpResource) {
      return redirectWithError('invalid_target');
    }
  }

  const consentUrl = new URL(`${publicUrl}/dashboard/oauth-consent`);
  consentUrl.searchParams.set('client_id', clientId);
  consentUrl.searchParams.set('redirect_uri', redirectUri);
  consentUrl.searchParams.set('state', state);
  consentUrl.searchParams.set('code_challenge', codeChallenge);
  consentUrl.searchParams.set('code_challenge_method', codeChallengeMethod);
  if (scope) consentUrl.searchParams.set('scope', scope);
  // Resolved resource: the incoming one (already confirmed to canonicalize
  // to the same value) or, if absent, the server's own MCP resource URL.
  consentUrl.searchParams.set('resource', mcpResource);

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

  const mcpResource = getMcpResourceUrl(publicUrl);
  if (resource !== undefined) {
    let canonicalResource: string;
    try {
      canonicalResource = canonicalizeUrl(resource);
    } catch {
      return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Invalid resource.'), 400);
    }
    if (canonicalResource !== mcpResource) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, "resource does not match this server's MCP endpoint."),
        400
      );
    }
  }

  const code = mintAuthorizationCode({
    userId: auth.userId,
    clientId,
    redirectUri,
    codeChallenge,
    resource: mcpResource,
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

    const accessToken = await mintOAuthAccessToken(user, record.resource);
    const refreshToken = await issueRefreshToken(user.id, record.clientId);

    c.header('Cache-Control', 'no-store');
    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 900,
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

    const accessToken = await mintOAuthAccessToken(user, getMcpResourceUrl(publicUrl));

    c.header('Cache-Control', 'no-store');
    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 900,
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
