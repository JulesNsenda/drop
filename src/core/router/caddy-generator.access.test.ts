/**
 * What the generator emits for a GATED route (DROP-152).
 *
 * Three properties here are load-bearing, and each one was a defect the critic
 * panel found in the design before it was written:
 *
 *  1. **The exchange handle is a sibling, emitted FIRST, and is never gated.**
 *     Nested inside the gate it would require the very cookie it exists to
 *     obtain, and the visitor would loop until the browser's redirect cap,
 *     burning a single-use code per lap.
 *  2. **The MCP handle nests INSIDE the gate**, so a guarded MCP endpoint on a
 *     gated app needs both credentials. As siblings the two guards silently
 *     diverge — measured against Caddy 2.11.4, `/mcp` answers 401 instead of
 *     redirecting and a bearer-only request reaches the tenant with no browser
 *     session at all.
 *  3. **Exactly one `reverse_proxy` reaches the tenant, and it is inside the
 *     gate.** This is the replacement for Slice 0's `guards.length > 0`
 *     invariant, which stops meaning anything once there is no top-level
 *     catch-all left to wrap.
 *
 * Everything asserted here was also verified against a real Caddy 2.11.4 —
 * see the plan's spike section — but these run in CI, where no binary exists.
 */

import { generateRouteBlock } from './caddy-generator';
import { RouteConfig, CaddyDirective } from './router.types';

const accessAuth = {
  appName: 'myapp',
  origin: 'https://myapp.dropkit.sh',
  verifyUpstream: '127.0.0.1:3000',
  cookieName: '__Host-drop-session-myapp',
};
const mcpAuth = { path: '/mcp', appName: 'myapp', verifyUpstream: '127.0.0.1:3000' };

const base: RouteConfig = {
  appName: 'myapp-myapp-dropkit-sh',
  owner: 'myapp',
  hostname: 'myapp.dropkit.sh',
  upstream: 'localhost:4000',
  ssl: true,
  redirectHttps: true,
};

const top = (ds: CaddyDirective[], name: string) => ds.filter(d => d.name === name);
const handles = (ds: CaddyDirective[]) => top(ds, 'handle');
/** Every `reverse_proxy` anywhere in the tree, with its depth. */
function proxies(ds: CaddyDirective[], depth = 0): Array<{ d: CaddyDirective; depth: number }> {
  const out: Array<{ d: CaddyDirective; depth: number }> = [];
  for (const d of ds) {
    if (d.name === 'reverse_proxy') out.push({ d, depth });
    if (d.block) out.push(...proxies(d.block as CaddyDirective[], depth + 1));
  }
  return out;
}

describe('gated route block', () => {
  it('emits the exchange handle FIRST, as a sibling of the gate', () => {
    const { directives } = generateRouteBlock({ ...base, accessAuth });
    const hs = handles(directives);
    expect(hs).toHaveLength(2);

    const [exchange, gate] = hs;
    expect(exchange.args?.[0]).toBe('/.drop-session/exchange');
    expect(gate.args).toBeUndefined(); // the match-all gate

    // The thing that would loop forever if it were wrong.
    const exchangeText = JSON.stringify(exchange);
    expect(exchangeText).not.toContain('forward_auth');
  });

  it('sends the exchange to DROP, never to the tenant', () => {
    const { directives } = generateRouteBlock({ ...base, accessAuth });
    const exchange = handles(directives)[0];
    expect(exchange.block?.some(d => (d as CaddyDirective).name === 'reverse_proxy'
      && (d as CaddyDirective).args?.[0] === '127.0.0.1:3000')).toBe(true);
  });

  it('rewrites to a FIXED literal target with the app name in the PATH', () => {
    // Never `{path}`: `handle` does not strip the matched prefix, so the
    // composed target would carry client-controlled input into a DROP API
    // path. The app name goes in the path segment, where a client cannot
    // append a second one.
    const { directives } = generateRouteBlock({ ...base, accessAuth });
    const rewrite = handles(directives)[0].block?.find(
      d => (d as CaddyDirective).name === 'rewrite'
    ) as CaddyDirective;
    expect(rewrite.args?.[1]).toBe('/api/v1/app-access/myapp/exchange?{query}');
    expect(rewrite.args?.[1]).not.toContain('{path}');
  });

  it('re-asserts X-Frame-Options DENY and no-store on the exchange', () => {
    // The site-level header block sets SAMEORIGIN on every response, and the
    // tenant is exactly who this endpoint must not be framed by. Measured: an
    // inner handle's header beats the site-level one.
    const { directives } = generateRouteBlock({
      ...base,
      accessAuth,
      headers: { 'X-Frame-Options': 'SAMEORIGIN' },
    });
    const text = JSON.stringify(handles(directives)[0]);
    expect(text).toContain('DENY');
    expect(text).toContain('no-store');
  });

  it('strips client-forged identity headers BEFORE forward_auth', () => {
    // Caddy sorts forward_auth ahead of request_header, so a bare list would
    // run the strips AFTER the sub-request and delete what copy_headers set.
    // `route` is what preserves written order.
    const { directives } = generateRouteBlock({ ...base, accessAuth });
    const inner = (handles(directives)[1].block?.[0] as CaddyDirective).block as CaddyDirective[];
    expect((handles(directives)[1].block?.[0] as CaddyDirective).name).toBe('route');

    const names = inner.map(d => d.name);
    expect(names.indexOf('request_header')).toBeLessThan(names.indexOf('forward_auth'));
    expect(JSON.stringify(inner.slice(0, 2))).toContain('-X-Drop-Session-User-Id');
  });

  it('STRIPS AND COPIES every identity name the verify hop can emit', () => {
    // The invariant, asserted as an invariant rather than as a list of names
    // someone remembered to extend.
    //
    // A name that is EMITTED but not STRIPPED is client-assertable: a
    // `forward_auth` proxies the original request, so whatever the client sent
    // reaches the tenant. A name that is STRIPPED but not COPIED is simply
    // absent. Both halves, or the header is not an identity.
    //
    // `X-Drop-Guest-Id` shipped emitted-but-unstripped in DROP-155 wave 3a,
    // behind a comment claiming parity with the two session names — which were
    // already stripped AND copied. Nothing here could see the gap, because
    // every assertion named one header at a time.
    const { directives } = generateRouteBlock({ ...base, accessAuth });
    const route = (handles(directives)[1].block?.[0] as CaddyDirective);
    const inner = route.block as CaddyDirective[];
    const fa = inner.find(d => d.name === 'forward_auth') as CaddyDirective;
    const copy = fa.block?.find(d => (d as CaddyDirective).name === 'copy_headers') as CaddyDirective;

    const stripped = new Set(
      inner
        .filter(d => d.name === 'request_header' && String(d.args?.[0] ?? '').startsWith('-'))
        .map(d => String(d.args?.[0] ?? '').slice(1))
    );
    const copied = new Set((copy.args ?? []).map(String));

    // The set `app-access.ts`'s verify hop can put on a 204. Kept here rather
    // than imported so a rename has to be made deliberately in both places.
    const EMITTED = ['X-Drop-Session-User-Id', 'X-Drop-Session-Username', 'X-Drop-Guest-Id'];
    for (const name of EMITTED) {
      expect(stripped.has(name)).toBe(true);
      expect(copied.has(name)).toBe(true);
    }
    // And nothing is copied that is not also stripped — the direction that
    // would re-add a value the client was allowed to supply.
    for (const name of copied) {
      expect(stripped.has(name)).toBe(true);
    }
  });

  it('uses its OWN header names, not the MCP guard\'s', () => {
    // The MCP handle nests inside and strips-then-re-copies X-Drop-User-*.
    // Sharing the names would delete the browser identity on /mcp*.
    const { directives } = generateRouteBlock({ ...base, accessAuth });
    const gate = JSON.stringify(handles(directives)[1]);
    expect(gate).toContain('X-Drop-Session-User-Id');
    expect(gate).not.toContain('"-X-Drop-User-Id"');
  });

  it('strips DROP credentials on BOTH hops', () => {
    const { directives } = generateRouteBlock({ ...base, accessAuth });
    const gate = handles(directives)[1];
    const route = gate.block?.[0] as CaddyDirective;
    const fa = route.block?.find(d => (d as CaddyDirective).name === 'forward_auth') as CaddyDirective;

    // To the verify hop: forward_auth proxies the ORIGINAL request.
    expect(JSON.stringify(fa.block)).toContain('-Authorization');
    expect(JSON.stringify(fa.block)).toContain('-X-Api-Key');
    // ...narrowed to DROP's own cookie, so tenant cookies never reach DROP.
    expect(JSON.stringify(fa.block)).toContain('{http.request.cookie.__Host-drop-session-myapp}');

    // To the tenant: measured — without these the tenant receives the
    // visitor's session cookie and replays it as them.
    const tenantProxy = proxies([gate]).find(p => p.d.args?.[0] === 'localhost:4000');
    const text = JSON.stringify(tenantProxy?.d);
    expect(text).toContain('-Authorization');
    expect(text).toContain('-X-Api-Key');
    // An anchored REPLACEMENT, not `-Cookie` — deleting the whole header would
    // break every gated tenant's own sessions.
    expect(text).toContain('__Host-drop-session-myapp=[^;]*');
  });

  it('nests the MCP handle INSIDE the gate when both are set', () => {
    const { directives } = generateRouteBlock({ ...base, accessAuth, mcpAuth });
    // Not a sibling at top level.
    expect(handles(directives)).toHaveLength(2);

    const route = handles(directives)[1].block?.[0] as CaddyDirective;
    const mcp = route.block?.find(
      d => (d as CaddyDirective).name === 'handle' && (d as CaddyDirective).args?.[0] === '/mcp*'
    );
    expect(mcp).toBeDefined();
  });

  it('lets exactly ONE reverse_proxy reach the tenant, inside the gate', () => {
    // The replacement for Slice 0's guards.length invariant.
    const { directives } = generateRouteBlock({ ...base, accessAuth, mcpAuth });
    const tenant = proxies(directives).filter(p => p.d.args?.[0] === 'localhost:4000');

    // One for the catch-all, one for the MCP path — both inside the gate.
    expect(tenant.length).toBe(2);
    expect(tenant.every(p => p.depth >= 3)).toBe(true);
    // Nothing at block top level can serve the tenant.
    expect(top(directives, 'reverse_proxy')).toHaveLength(0);
  });

  it('folds the route prefix into the exchange matcher', () => {
    // Latent today — a group child cannot be gated — but a bare
    // `/.drop-session/exchange` on a `group.host/api*` block could never match,
    // and the gate would 302 to an unreachable exchange forever.
    const { directives } = generateRouteBlock({ ...base, pathPrefix: '/api*', accessAuth });
    expect(handles(directives)[0].args?.[0]).toBe('/api/.drop-session/exchange');
  });

  it('changes NOTHING when accessAuth is absent', () => {
    // The whole blast-radius argument. caddy-generator.golden.test.ts pins the
    // exact bytes; this pins the shape.
    const { directives } = generateRouteBlock({ ...base, mcpAuth });
    expect(JSON.stringify(directives)).not.toContain('app-access');
    expect(JSON.stringify(directives)).not.toContain('drop-session');
  });
});
