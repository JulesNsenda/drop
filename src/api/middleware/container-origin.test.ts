/**
 * SEC-3 — what a tenant container may reach on the control plane (DROP-160).
 *
 * The reachability this closes is easy to under-estimate, so state it plainly:
 * `drop-host` maps to drop-net's GATEWAY, which is a host interface reached on
 * the container's own same-subnet default route. That is the host INPUT path,
 * so `enable_icc=false` and DOCKER-USER FORWARD rules never see it — every
 * container on the bridge could open a socket to `:3000`, including apps
 * granted no capabilities and holding no key.
 *
 * These tests supply a socket peer via `app.request()`'s third argument, which
 * is the only way the peer check is reachable at all — the same reason
 * `rate-limit.client-ip.test.ts` exists separately from `rate-limit.test.ts`.
 */

import { Hono } from 'hono';
import {
  containerOriginGate,
  isContainerPeer,
  isDeniedForContainers,
} from './container-origin';

/** What @hono/node-server puts on `c.env`. */
const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

function buildApp() {
  const app = new Hono();
  app.use('*', containerOriginGate());
  app.all('*', c => c.json({ reached: true }));
  return app;
}

const from = (path: string, remoteAddress: string, method = 'GET') =>
  buildApp().request(path, { method }, peer(remoteAddress));

describe('isContainerPeer', () => {
  it('recognises an address inside the drop-net subnet', () => {
    expect(isContainerPeer('10.83.0.7', '10.83.0.0/24')).toBe(true);
    expect(isContainerPeer('10.83.0.1', '10.83.0.0/24')).toBe(true);
  });

  it('does not claim an address outside it', () => {
    expect(isContainerPeer('10.84.0.7', '10.83.0.0/24')).toBe(false);
    expect(isContainerPeer('127.0.0.1', '10.83.0.0/24')).toBe(false);
    expect(isContainerPeer('192.168.1.5', '10.83.0.0/24')).toBe(false);
  });

  it('handles an IPv6-mapped IPv4 peer, which is what Node reports on a dual-stack listener', () => {
    // `peerAddress` strips the prefix before this is called; the check itself
    // must still refuse the un-normalised form rather than matching it loosely.
    expect(isContainerPeer('::ffff:10.83.0.7', '10.83.0.0/24')).toBe(false);
    expect(isContainerPeer('10.83.0.7', '10.83.0.0/24')).toBe(true);
  });

  it('answers false for a genuine IPv6 peer rather than guessing', () => {
    // drop-net is an IPv4 bridge, so an IPv6 peer is loopback or a host
    // interface — never a container. Failing OPEN is correct for a gate that
    // is defence in depth: a false positive breaks legitimate host traffic,
    // which is the larger harm when the auth behind it is unchanged either way.
    expect(isContainerPeer('::1', '10.83.0.0/24')).toBe(false);
    expect(isContainerPeer('fd00::1', '10.83.0.0/24')).toBe(false);
  });

  it('answers false when the peer address is unavailable', () => {
    expect(isContainerPeer(null, '10.83.0.0/24')).toBe(false);
  });

  it('does not treat a /24 as a /16', () => {
    // A mask built with `0xffffffff << (32 - len)` is easy to get wrong by one
    // octet, and the wrong direction here silently exempts the whole 10.83/16.
    expect(isContainerPeer('10.83.1.7', '10.83.0.0/24')).toBe(false);
    expect(isContainerPeer('10.83.1.7', '10.83.0.0/16')).toBe(true);
  });

  it('handles a /0 subnet without inverting into matching nothing', () => {
    // `<<` takes its shift count mod 32 in JS, so `0xffffffff << 32` is a
    // no-op and a naive /0 produces a full mask — matching nothing instead of
    // everything.
    expect(isContainerPeer('8.8.8.8', '0.0.0.0/0')).toBe(true);
  });

  it('refuses a malformed subnet or address instead of matching loosely', () => {
    expect(isContainerPeer('10.83.0.7', 'not-a-cidr')).toBe(false);
    expect(isContainerPeer('999.1.1.1', '10.83.0.0/24')).toBe(false);
    expect(isContainerPeer('10.83.0', '10.83.0.0/24')).toBe(false);
  });
});

describe('the surfaces a container is refused', () => {
  it.each([
    ['/api/v1/auth/login', 'credential guessing'],
    ['/api/v1/auth/signup', 'credential guessing'],
    ['/api/v1/auth/password', 'credential guessing'],
    ['/api/v1/auth/mfa/verify', 'credential guessing'],
    ['/api/v1/auth/api-keys', 'credential minting'],
    ['/api/v1/auth/agent-tokens', 'credential minting'],
    ['/api/v1/oauth/authorize', 'a browser PKCE flow'],
    ['/api/v1/app-access/demo/verify', "a visitor's browser, via Caddy"],
    ['/api/v1/mcp', 'external coding agents'],
    ['/dashboard', 'the admin SPA'],
    ['/', 'the admin SPA'],
  ])('refuses %s from a container (%s)', async (reqPath) => {
    expect(isDeniedForContainers(reqPath)).toBe(true);

    const res = await from(reqPath, '10.83.0.7');

    // 404, not 403: a 403 confirms the endpoint exists, which is the existence
    // oracle the rest of the platform avoids. From inside a container this
    // surface should simply not appear to be there.
    expect(res.status).toBe(404);
  });

  it('still allows POST /auth/users — the one route a capability holder exists to call', async () => {
    // `GRANTABLE_API_SCOPES` is `['users:create']`, and this is the route it
    // grants. Blocking it would break the waitlist app that the whole SEC-3
    // exemption was written for, so it is the single most important negative
    // case in this file.
    expect(isDeniedForContainers('/api/v1/auth/users')).toBe(false);

    const res = await from('/api/v1/auth/users', '10.83.0.7', 'POST');

    expect(res.status).toBe(200);
  });

  it('leaves the ordinary API surface reachable, since auth and scoping still gate it', async () => {
    // This gate removes REACHABILITY of surfaces a tenant app has no business
    // touching. It is not an authentication layer and must not behave like one
    // — everything here is still behind authMiddleware and capability scoping.
    for (const p of ['/api/v1/apps', '/api/v1/health', '/api/v1/deploys']) {
      expect((await from(p, '10.83.0.7')).status).toBe(200);
    }
  });

  it('does not refuse the same paths from the host', async () => {
    // Caddy and the CLI are the real callers of every denied path, and both
    // arrive over loopback. If this were wrong, the dashboard and login would
    // 404 for everyone.
    for (const p of ['/api/v1/auth/login', '/dashboard', '/api/v1/mcp', '/']) {
      expect((await from(p, '127.0.0.1')).status).toBe(200);
    }
  });

  it('does not refuse a request with no socket peer at all', async () => {
    // `app.request()` with no env is how most of the suite calls in, and a gate
    // that failed closed there would break every other test in the API suite
    // for reasons that had nothing to do with what they were testing.
    const res = await buildApp().request('/api/v1/auth/login');

    expect(res.status).toBe(200);
  });

  it('cannot be talked out of the refusal with a forged X-Forwarded-For', async () => {
    // The peer is the whole question here, which is why this reads the socket
    // rather than reusing rate-limit.ts's getClientIp — that one deliberately
    // PREFERS the forwarded entry, and a container would forge exactly that to
    // look like it arrived through Caddy.
    const res = await buildApp().request(
      '/api/v1/auth/login',
      { headers: { 'x-forwarded-for': '127.0.0.1' } },
      peer('10.83.0.7')
    );

    expect(res.status).toBe(404);
  });
});
