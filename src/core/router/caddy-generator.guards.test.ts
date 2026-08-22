/**
 * The structural invariant every DROP guard in a route block depends on
 * (DROP-152).
 *
 * `caddy-generator.mcp-auth.test.ts` pins what the MCP guard emits. This pins
 * the property that must hold for ANY guard, present or future: when a block
 * carries a guard, the catch-all `reverse_proxy` is wrapped in its own
 * `handle` and there is no bare `reverse_proxy` left at block top level.
 *
 * Asserted structurally rather than once per guard, because the failure it
 * catches is the one nobody writes a test for: a second guard added without
 * widening the wrapping condition. Measured against Caddy 2.11.4, a
 * PATH-SCOPED guard beside a bare `reverse_proxy` lets everything outside the
 * matcher reach the tenant unguarded, while the dashboard reports the app as
 * protected. (A match-all guard beside a bare directive does hold — `handle`
 * sorts first and is terminal — but a dead bare directive in a
 * security-relevant block is a trap either way.)
 */

import { generateRouteBlock, routeMatcherPrefix } from './caddy-generator';
import { RouteConfig, CaddyDirective } from './router.types';

const baseRoute: RouteConfig = {
  appName: 'myapp',
  hostname: 'myapp.example.com',
  upstream: 'localhost:4000',
  ssl: true,
  redirectHttps: true,
};

const mcpAuth = {
  path: '/mcp',
  appName: 'myapp',
  verifyUpstream: '127.0.0.1:3000',
};

/** Every guard combination the generator can currently be handed. */
const GUARDED_ROUTES: Array<[string, RouteConfig]> = [
  ['mcpAuth', { ...baseRoute, mcpAuth }],
  ['mcpAuth on a path-prefixed group child', { ...baseRoute, pathPrefix: '/api*', mcpAuth }],
  ['mcpAuth with custom headers and a static path', {
    ...baseRoute,
    mcpAuth,
    headers: { 'X-Frame-Options': 'SAMEORIGIN' },
    staticPath: '/srv/myapp',
  }],
];

const topLevel = (directives: CaddyDirective[], name: string) =>
  directives.filter(d => d.name === name);

describe('route block guard structure', () => {
  it.each(GUARDED_ROUTES)(
    'leaves no bare reverse_proxy at top level when guarded (%s)',
    (_label, route) => {
      const block = generateRouteBlock(route);

      expect(topLevel(block.directives, 'reverse_proxy')).toHaveLength(0);

      // ...and the catch-all is still THERE, wrapped — a guard that removed it
      // would also satisfy the assertion above while breaking every request.
      const handles = topLevel(block.directives, 'handle');
      const catchAll = handles.find(h => !h.args || h.args.length === 0);
      expect(catchAll?.block?.some(d => d.name === 'reverse_proxy')).toBe(true);
    }
  );

  it('emits every guard BEFORE the catch-all handle', () => {
    // Caddy evaluates `handle` blocks in written order; a catch-all emitted
    // first would serve every guarded path unguarded.
    const block = generateRouteBlock({ ...baseRoute, mcpAuth });
    const handles = topLevel(block.directives, 'handle');
    const catchAllIndex = handles.findIndex(h => !h.args || h.args.length === 0);
    expect(catchAllIndex).toBe(handles.length - 1);
    expect(catchAllIndex).toBeGreaterThan(0);
  });

  it('leaves an UNGUARDED block with a bare reverse_proxy and no handle wrapper', () => {
    // The other half of the invariant: the wrapping must not appear when no
    // guard exists, or every existing app's Caddyfile changes shape.
    const block = generateRouteBlock(baseRoute);
    expect(topLevel(block.directives, 'reverse_proxy')).toHaveLength(1);
    expect(topLevel(block.directives, 'handle')).toHaveLength(0);
  });
});

describe('routeMatcherPrefix', () => {
  it('is empty for a route with no path prefix', () => {
    expect(routeMatcherPrefix(baseRoute)).toBe('');
  });

  it('strips the Caddy wildcard so a guard matcher can be appended', () => {
    // `group.host/api*` + `/mcp` must produce `/api/mcp*`, not `/api*/mcp*`.
    expect(routeMatcherPrefix({ ...baseRoute, pathPrefix: '/api*' })).toBe('/api');
  });

  it('strips a trailing slash', () => {
    expect(routeMatcherPrefix({ ...baseRoute, pathPrefix: '/api/' })).toBe('/api');
  });

  it('is what the MCP guard matcher is actually built from', () => {
    const block = generateRouteBlock({ ...baseRoute, pathPrefix: '/api*', mcpAuth });
    const guard = topLevel(block.directives, 'handle').find(h => h.args && h.args.length > 0);
    expect(guard?.args?.[0]).toBe('/api/mcp*');
  });
});
