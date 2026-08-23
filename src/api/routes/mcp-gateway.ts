/**
 * MCP gateway verification endpoint (Step 11, PR 2).
 *
 * Caddy's `forward_auth` calls this before proxying a request to a tenant app's
 * MCP endpoint: 2xx means "let it through", anything else is returned to the
 * client and the tenant never sees the request.
 *
 * DELIBERATELY NOT behind `authMiddleware`. It authenticates the presented
 * bearer itself, against ONE app's audience, and must never accept a session
 * JWT, an API key, or a DROP-scoped OAuth token — all of which `authMiddleware`
 * would happily admit. `verifyAppMcpAccessToken` rejects every other token
 * class on `token_use` before it looks at anything else.
 *
 * THE APP NAME COMES FROM THE QUERY STRING, and that is the point (SEC-2): the
 * Caddy route block bakes `?app=<name>` in as a literal when the config is
 * GENERATED, so it is DROP-authored. Deriving it from `Host` or
 * `X-Forwarded-Host` would let a client claim to be any app it liked while
 * presenting its own valid token.
 */

import { Hono, type Context } from 'hono';
import { isValidAppName } from '../middleware/validate';
import { getStateManager } from '../../managers/app/state-manager';
import { getAppConfigService } from '../../managers/app/app-config';
import { getAppMcpResourceUrl } from '../oauth/app-resources';
import { canAccess } from '../access';
import { verifyAppMcpAccessToken } from '../middleware/auth';
import { computeAppUrl } from '../../utils/app-url';

const mcpGateway = new Hono();

/** One opaque refusal. Which of the reasons applied is not the caller's business. */
function deny(c: Context): Response {
  return c.json(
    { error: 'invalid_token' },
    401,
    {
      // Points a client at discovery so it can start the OAuth flow, matching
      // what DROP's own /mcp gate returns on a bare 401.
      'WWW-Authenticate': 'Bearer error="invalid_token"',
    }
  );
}

mcpGateway.get('/verify', async (c) => {
  // Every step inside one try: this endpoint's contract is 204 or 401, and a
  // 500 is neither. Two throws were reachable — a `customDomain` that WHATWG
  // URL rejects, and a username carrying CR/LF that `setHeader` refuses — each
  // turning a refusal into a distinguishable server error on an
  // unauthenticated surface, and into a 5xx from the auth server under
  // forward_auth.
  try {
    const appName = c.req.query('app') ?? '';
    if (!isValidAppName(appName)) return deny(c);

    // The app must currently advertise a DROP-guarded MCP endpoint. A stale
    // Caddy block for an app that stopped being one — or was deleted and its
    // name re-registered by someone else — must not keep authorizing traffic.
    const config = getAppConfigService().getConfig(appName);
    // `source: 'declared'` AND `auth: 'drop'`: DROP only vouches for an
    // endpoint whose owner asked it to. An inferred label must never put a
    // login gate in front of someone's app.
    if (config?.mcp?.source !== 'declared' || config.mcp.auth !== 'drop') return deny(c);

    const app = getStateManager().getApp(appName);
    if (!app) return deny(c);

    const base = computeAppUrl(app);
    if (!base) return deny(c);

    const header = c.req.header('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return deny(c);

    const expectedAudience = getAppMcpResourceUrl(base, config.mcp.path);
    const identity = await verifyAppMcpAccessToken(token, expectedAudience, appName);
    if (!identity) return deny(c);

    // Authorization, not just authentication. A valid token proves WHICH DROP
    // user is calling; it does not by itself mean that user may use this app.
    // Re-checked live at every request so a revoked owner, a transferred app,
    // or an app deleted and re-registered by someone else stops admitting the
    // old grant immediately — the token's own claims cannot express any of that.
    if (!canAccess({ userId: identity.userId, role: identity.role, username: identity.username, authMethod: 'jwt' }, app)) {
      return deny(c);
    }

    // 204 authorizes the proxy. The identity headers let the tenant app know
    // WHO is calling without ever seeing DROP's bearer token — the generated
    // Caddy block strips Authorization on the hop to the tenant and copies
    // these across instead (PR 2b).
    c.header('X-Drop-User-Id', identity.userId);
    c.header('X-Drop-Username', identity.username);
    return c.body(null, 204);
  } catch {
    return deny(c);
  }
});

export default mcpGateway;
