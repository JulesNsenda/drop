/**
 * SEC-3 — what a tenant container may reach on the control plane.
 *
 * DROP's API binds `0.0.0.0` so that apps holding control-plane capabilities
 * can call it at `drop-host:<apiPort>` (a Docker `ExtraHosts` entry mapped to
 * drop-net's gateway). That reachability is not selective: it is the bridge
 * gateway on the host's INPUT path, so `enable_icc=false` and DOCKER-USER
 * FORWARD rules do not touch it, and EVERY container on drop-net can therefore
 * open a socket to the control plane — including apps that were granted no
 * capabilities at all and hold no key.
 *
 * The Tier B plan recorded this as "bind ApiServer to 127.0.0.1 and/or an
 * iptables rule blocking drop-net→:3000", with the standing tension that one
 * app (the waitlist) legitimately calls the admin API from inside a container.
 * A bind is all-or-nothing per interface, so on its own it cannot express
 * "this app yes, the rest no".
 *
 * This module is the allow-listed path that makes the bind decision possible,
 * and it is deliberately a small one. It does NOT re-implement authentication:
 * everything past it is still behind `authMiddleware` and capability scoping.
 * What it removes is REACHABILITY of the surfaces a tenant app has no business
 * touching — the credential-guessing endpoints and the browser-facing
 * authorization flows — so those are answerable only from the host and from
 * Caddy, which is where their callers actually live.
 *
 * `DROP_API_HOST=127.0.0.1` remains the stronger setting, and is correct for
 * any operator with no capability-holding apps. This gate is what an operator
 * who cannot take that option gets instead.
 */

import { Context, Next } from 'hono';
import { DROP_NET_SUBNET } from '../../managers/runtime/container-config';

/**
 * Paths a tenant container is refused, matched against the request path.
 *
 * A DENYLIST rather than an allowlist, and that is a considered choice: the
 * control-plane capability surface is meant to grow (`GRANTABLE_API_SCOPES`
 * holds one scope today and is written to take more), and an allowlist would
 * silently break the next capability someone grants — a failure that shows up
 * as a working app in development and a 403 in production. A denylist fails the
 * other way: a new capability route works, and a new credential surface has to
 * be added here. That is a real gap, which is why this is defence in depth
 * behind auth rather than the boundary itself.
 *
 * Each entry is a surface whose callers are browsers, operators or external
 * agents — never tenant code running on this box:
 *
 * - `/auth/login`, `/auth/signup`, `/auth/password`, `/auth/mfa/*` — credential
 *   guessing. A container gets its own rate-limit bucket (the limiter keys on
 *   the peer address, and each container has a distinct one), so the external
 *   throttle is weakest exactly here.
 * - `/auth/api-keys`, `/auth/agent-tokens` — credential MINTING. An app that
 *   could mint its own key would escape the capability scoping that is the
 *   entire point of `DROP_API_KEY`.
 * - `/oauth/*` — the authorization server. Its client is a browser completing
 *   a PKCE flow.
 * - `/app-access/*` — the access gate's hops. Its client is a visitor's
 *   browser, arriving through Caddy.
 * - `/mcp` — the hosted MCP server, for external coding agents.
 * - `/dashboard`, `/` — the admin SPA.
 *
 * `POST /auth/users` is deliberately NOT here: it is the one route a
 * `users:create` capability holder exists to call, and blocking it would break
 * the app this exemption was written for.
 */
const CONTAINER_DENIED_PATHS: RegExp[] = [
  /^\/api\/v1\/auth\/(login|signup|password|logout)$/,
  /^\/api\/v1\/auth\/mfa(\/|$)/,
  /^\/api\/v1\/auth\/(api-keys|agent-tokens)(\/|$)/,
  /^\/api\/v1\/oauth(\/|$)/,
  /^\/api\/v1\/app-access(\/|$)/,
  /^\/api\/v1\/mcp(\/|$)/,
  /^\/dashboard(\/|$)/,
];

/**
 * The socket peer address, normalised. Distinct from `getClientIp` in
 * `rate-limit.ts`, which deliberately prefers the `X-Forwarded-For` entry Caddy
 * appended: here the PEER is the whole question, and a forwarded header is
 * exactly the thing a container would forge to look like it came from Caddy.
 */
function peerAddress(c: Context): string | null {
  const incoming = (c.env as unknown as Record<string, unknown>)?.incoming as
    | { socket?: { remoteAddress?: string } }
    | undefined;
  const raw = incoming?.socket?.remoteAddress;
  return raw ? raw.replace(/^::ffff:/i, '') : null;
}

/** Parse `a.b.c.d/len` into a numeric base and mask. Returns null if unparseable. */
function parseCidr(cidr: string): { base: number; mask: number } | null {
  const [addr, lenRaw] = cidr.split('/');
  const len = Number(lenRaw);
  if (!addr || !Number.isInteger(len) || len < 0 || len > 32) return null;
  const base = ipv4ToInt(addr);
  if (base === null) return null;
  // `<<` on 32 is a no-op in JS (the shift count is taken mod 32), so /0 has to
  // be special-cased or it would produce a mask of 0xffffffff and match nothing.
  const mask = len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

function ipv4ToInt(addr: string): number | null {
  const parts = addr.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

/**
 * Whether an address sits inside DROP's container bridge.
 *
 * IPv6 peers answer `false`: drop-net is an IPv4 bridge, so an IPv6 peer is
 * loopback or a host interface, never a tenant container. Failing OPEN here is
 * correct precisely because this gate is defence in depth — a false positive
 * would break legitimate host traffic, which is the larger harm when the
 * authentication behind it is unchanged either way.
 */
export function isContainerPeer(addr: string | null, subnet = DROP_NET_SUBNET): boolean {
  if (!addr) return false;
  const cidr = parseCidr(subnet);
  const value = ipv4ToInt(addr);
  if (!cidr || value === null) return false;
  return ((value & cidr.mask) >>> 0) === cidr.base;
}

/** Whether this path is one a tenant container is refused. */
export function isDeniedForContainers(reqPath: string): boolean {
  return reqPath === '/' || CONTAINER_DENIED_PATHS.some(re => re.test(reqPath));
}

/**
 * Refuse credential and browser-facing surfaces to callers on drop-net.
 *
 * Mounted only under docker isolation — under `none` there is no bridge, and
 * every address the check could match would be an operator's own network.
 */
export function containerOriginGate() {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (!isContainerPeer(peerAddress(c))) return next();
    if (!isDeniedForContainers(c.req.path)) return next();

    // 404, not 403: a 403 confirms the endpoint is there, which is the
    // existence oracle the rest of the platform avoids (see the dotfile rule in
    // nginx-conf.ts for the same reasoning). From inside a container this
    // surface should simply not appear to exist.
    return c.json(
      { success: false, error: { code: 'NOT_FOUND', message: 'Not found' } },
      404
    );
  };
}
