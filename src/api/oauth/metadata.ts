/**
 * OAuth 2.1 discovery metadata for the hosted MCP endpoint (PRD-041).
 *
 * Pure functions only — no I/O, no Hono. `publicUrl` is supplied by the
 * caller (see `getPublicUrl()` in `../runtime-config`, which fails closed
 * when unconfigured); this module never reads the environment itself.
 */

const DEFAULT_PORT_BY_PROTOCOL: Record<string, string> = {
  'https:': '443',
  'http:': '80',
};

/**
 * Canonicalizes a URL per the RFC 8707 / RFC 9728 conventions used for OAuth
 * issuer and resource identifiers: lowercase scheme + host, drop a default
 * port (:443 for https, :80 for http), strip any fragment/query, and strip a
 * trailing slash. The path (if any) is otherwise preserved as-is.
 */
export function canonicalizeUrl(u: string): string {
  const url = new URL(u);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  if (url.port && DEFAULT_PORT_BY_PROTOCOL[url.protocol] === url.port) {
    url.port = '';
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/$/, '');
}

/**
 * Canonical resource identifier (RFC 8707) for the MCP endpoint:
 * `<publicUrl>/api/v1/mcp`, canonicalized. `publicUrl` is canonicalized first
 * so a trailing slash on the input doesn't produce a double slash here.
 */
export function getMcpResourceUrl(publicUrl: string): string {
  const issuer = canonicalizeUrl(publicUrl);
  return canonicalizeUrl(`${issuer}/api/v1/mcp`);
}

/**
 * RFC 9728 OAuth Protected Resource Metadata document for the MCP endpoint,
 * served at `/.well-known/oauth-protected-resource` (and the resource-scoped
 * `/mcp` path — mounted by the route layer, not here).
 */
export function buildProtectedResourceMetadata(publicUrl: string): object {
  return {
    resource: getMcpResourceUrl(publicUrl),
    authorization_servers: [canonicalizeUrl(publicUrl)],
  };
}

/**
 * RFC 8414 OAuth Authorization Server Metadata document, served at
 * `/.well-known/oauth-authorization-server`. Deliberately omits
 * `registration_endpoint` — dynamic client registration was cut from scope
 * (see docs/plans/2026-07-10-mcp-oauth.md); DROP mints a single static
 * `client_id` via an admin endpoint instead.
 */
export function buildAuthServerMetadata(publicUrl: string): object {
  const issuer = canonicalizeUrl(publicUrl);
  return {
    issuer,
    authorization_endpoint: `${issuer}/api/v1/oauth/authorize`,
    token_endpoint: `${issuer}/api/v1/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['offline_access'],
  };
}
