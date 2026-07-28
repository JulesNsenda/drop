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

  it('clears client-supplied identity headers on the way in', () => {
    // Otherwise a client simply asserts who it is.
    const lines = flatten(generateRouteBlock(route({ mcpAuth: GUARD })).directives);

    expect(lines).toContain('request_header -X-Drop-User-Id');
    expect(lines).toContain('request_header -X-Drop-Username');
  });

  it('wraps the guard body in `route` so Caddy cannot re-order it', () => {
    // THE load-bearing structural assertion, and the one whose absence made
    // every other ordering test in this file vacuous.
    //
    // Caddy sorts the children of a `handle` by its own directive-order table;
    // only `route` preserves written order. `forward_auth` sorts BEFORE
    // `request_header`, so written as a bare list the strips ran AFTER the auth
    // sub-request — deleting the identity headers `copy_headers` had just set
    // (the tenant saw no identity at all) and forwarding the client's own
    // X-Drop-* to DROP's verify endpoint. Proven against Caddy 2.11.4.
    //
    // Emission order in this tree therefore says nothing on its own; the
    // `route` wrapper is what makes it mean anything.
    const top = generateRouteBlock(route({ mcpAuth: GUARD })).directives;
    const guard = top.find(d => d.name === 'handle' && d.args?.[0]?.startsWith('/mcp'));

    expect(guard?.block).toHaveLength(1);
    expect(guard?.block?.[0].name).toBe('route');

    const inner = (guard?.block?.[0] as { block?: { name: string }[] }).block ?? [];
    const order = inner.map(d => d.name);
    expect(order.indexOf('request_header')).toBeLessThan(order.indexOf('forward_auth'));
    expect(order.indexOf('forward_auth')).toBeLessThan(order.indexOf('reverse_proxy'));
  });

  it('matches the FULL path for a path-prefixed (monorepo child) route', () => {
    // The site address for a same-origin child is `group.host/api*`, and the
    // matcher is evaluated against the whole request path. A bare `/mcp*` could
    // never match there — the real endpoint is `/api/mcp` — so every request
    // fell through to the unguarded catch-all while the dashboard reported the
    // endpoint as protected. A guard that silently does not apply is worse than
    // no guard.
    const top = generateRouteBlock(
      route({ pathPrefix: '/api', mcpAuth: GUARD })
    ).directives;
    const guard = top.find(d => d.name === 'handle' && d.args?.[0]?.includes('/mcp'));

    expect(guard?.args?.[0]).toBe('/api/mcp*');
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
