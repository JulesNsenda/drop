/**
 * The forward_auth guard for a DROP-protected MCP endpoint (Step 11, PR 2b).
 *
 * This block is where SEC-2 lives. Two properties matter more than the rest:
 * DROP's own credentials must not reach the tenant, and the app identity in the
 * verify URI must be a literal DROP wrote — never anything a client can set.
 */

import { generateRouteBlock } from './caddy-generator';
import type { RouteConfig } from './router.types';

function route(over: Partial<RouteConfig> = {}): RouteConfig {
  return {
    appName: 'alpha',
    hostname: 'alpha.example.test',
    upstream: 'localhost:3004',
    ssl: false,
    redirectHttps: false,
    ...over,
  };
}

const GUARD = { path: '/mcp', appName: 'alpha', verifyUpstream: 'localhost:3000' };

/** Flatten a directive tree to `name arg arg` lines, for order-sensitive checks. */
function flatten(directives: { name: string; args?: string[]; block?: unknown[] }[]): string[] {
  const out: string[] = [];
  for (const d of directives) {
    out.push([d.name, ...(d.args ?? [])].join(' '));
    if (d.block) out.push(...flatten(d.block as typeof directives));
  }
  return out;
}

describe('MCP forward_auth guard', () => {
  it('is absent unless the route asks for it', () => {
    const lines = flatten(generateRouteBlock(route()).directives);

    expect(lines.some(l => l.startsWith('forward_auth'))).toBe(false);
    // The ordinary case must stay a bare reverse_proxy — wrapping every app in
    // a `handle` would be a silent behaviour change for the whole fleet.
    expect(lines).toContain('reverse_proxy localhost:3004');
    expect(lines.some(l => l === 'handle')).toBe(false);
  });

  it('STRIPS Authorization and X-Api-Key on the hop to the tenant', () => {
    // forward_auth only authorizes; the original request is then proxied on.
    // Without this a malicious tenant harvests DROP-issued bearer tokens from
    // its own inbound traffic, and there is no access-token revocation.
    const lines = flatten(generateRouteBlock(route({ mcpAuth: GUARD })).directives);

    expect(lines).toContain('header_up -Authorization');
    expect(lines).toContain('header_up -X-Api-Key');
  });

  it('bakes the app name into the verify URI as a literal', () => {
    const lines = flatten(generateRouteBlock(route({ mcpAuth: GUARD })).directives);

    expect(lines).toContain('uri /api/v1/mcp-gateway/verify?app=alpha');
    // Nothing in the block may reference a request-time host value.
    expect(lines.some(l => l.includes('{host}') || l.includes('X-Forwarded-Host}'))).toBe(false);
  });

  it('clears client-supplied identity and forwarding headers on the way in', () => {
    // Otherwise a client asserts who it is, or pre-sets what the verify
    // endpoint and the tenant observe.
    const lines = flatten(generateRouteBlock(route({ mcpAuth: GUARD })).directives);

    expect(lines).toContain('request_header -X-Drop-User-Id');
    expect(lines).toContain('request_header -X-Drop-Username');
    expect(lines).toContain('request_header -X-Forwarded-Host');
  });

  it('copies the AUTHENTICATED identity from the verify response', () => {
    const lines = flatten(generateRouteBlock(route({ mcpAuth: GUARD })).directives);

    expect(lines).toContain('copy_headers X-Drop-User-Id X-Drop-Username');
  });

  it('puts the guarded handle BEFORE the catch-all proxy', () => {
    // Caddy evaluates handles in order. A catch-all first would serve the MCP
    // path unguarded, and the whole block would be decoration.
    const top = generateRouteBlock(route({ mcpAuth: GUARD })).directives;
    const guardIndex = top.findIndex(d => d.name === 'handle' && d.args?.[0] === '/mcp*');
    const catchAllIndex = top.findIndex(d => d.name === 'handle' && !d.args);

    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(catchAllIndex).toBeGreaterThan(guardIndex);
  });

  it('still serves non-MCP paths to the app', () => {
    const top = generateRouteBlock(route({ mcpAuth: GUARD })).directives;
    const catchAll = top.find(d => d.name === 'handle' && !d.args);

    expect(flatten((catchAll?.block ?? []) as never)).toContain('reverse_proxy localhost:3004');
  });

  it('honours a non-default MCP path', () => {
    const lines = flatten(
      generateRouteBlock(route({ mcpAuth: { ...GUARD, path: '/tools' } })).directives
    );

    expect(lines).toContain('handle /tools*');
    expect(lines).not.toContain('handle /mcp*');
  });
});
