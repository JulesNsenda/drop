/**
 * Rate Limiting Middleware
 *
 * Sliding window rate limiter using in-memory storage.
 */

import { Context, Next } from 'hono';
import { error, ErrorCodes } from '../types';

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitConfig {
  /** Max requests per window */
  maxRequests: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxRequests: 100,
  windowMs: 60_000, // 1 minute
};

const AUTH_CONFIG: RateLimitConfig = {
  maxRequests: 10,
  windowMs: 60_000, // 1 minute - stricter for auth endpoints
};

const UPLOAD_CONFIG: RateLimitConfig = {
  maxRequests: 10,
  windowMs: 60_000, // 1 minute - stricter for the upload-deploy endpoint (PRD-039)
};

const MCP_CONFIG: RateLimitConfig = {
  maxRequests: 60,
  windowMs: 60_000, // 1 minute - dedicated bucket for the hosted MCP endpoint (PRD-040)
};

const OAUTH_CONFIG: RateLimitConfig = {
  // Raised from 30 for DROP-131 (multi-user connectors). This bucket is keyed
  // per client IP, and claude.ai's server-to-server /token refreshes all
  // arrive from a small set of Anthropic egress IPs sharing ONE counter — so
  // the ceiling is shared across every connected user, not per user. At ~30
  // users refreshing every 15 minutes, plus consent bursts and the dashboard's
  // new GET /oauth/connector-info, 30/min starts 429ing refreshes, and a 429
  // on /token reads to claude.ai as a dead connector.
  //
  // Deliberately NOT re-keyed on client_id+grant_type (the first draft of the
  // plan said to): there is exactly one static client_id on this platform, so
  // that keying would collapse the whole installation into two buckets and let
  // any single user starve everyone else — the global-cap anti-pattern
  // principal-quota.ts exists to avoid. Per-user fairness on refreshes, if it
  // is ever wanted, belongs in that layer, not in the IP limiter.
  maxRequests: 120,
  windowMs: 60_000, // 1 minute - dedicated bucket for the OAuth 2.1 endpoints (PRD-041)
};

const DB_CONFIG: RateLimitConfig = {
  maxRequests: 20,
  windowMs: 60_000, // 1 minute - dedicated bucket for the database panel (DROP-120). The
  // general bucket is 100/min per IP shared across every endpoint, so a burst
  // of on-demand refreshes against the panel (overview + tables, no polling —
  // see the plan) would otherwise 429 the operator out of the rest of the API
  // mid-incident.
};

// In-memory stores per limiter instance
const stores = new Map<string, Map<string, RateLimitEntry>>();

/**
 * Extract the real client IP.
 *
 * Uses the TCP socket peer address as the authoritative source.
 * XFF is only trusted when the socket peer is loopback (i.e. the request
 * came from the local Caddy reverse proxy), preventing clients from spoofing
 * their own rate-limit bucket by forging the X-Forwarded-For header.
 */
function getClientIp(c: Context): string {
  // @hono/node-server exposes the raw IncomingMessage on c.env.incoming
  const incoming = (c.env as unknown as Record<string, unknown>)?.incoming as
    | { socket?: { remoteAddress?: string } }
    | undefined;
  const socketIp = incoming?.socket?.remoteAddress;

  // Normalise IPv6-mapped IPv4 (e.g. "::ffff:127.0.0.1" → "127.0.0.1")
  const peerIp = socketIp?.replace(/^::ffff:/i, '') ?? 'unknown';

  // Fail closed: only a genuine loopback peer is trusted (Caddy runs on the
  // same host). An unresolved socket ('unknown') must NOT be treated the
  // same way — trusting it would make X-Forwarded-For client-controlled
  // whenever the peer address happens to be unavailable, bypassing every
  // limiter. Falling through to `return peerIp` below instead buckets every
  // such request under the single literal key 'unknown', so a missing peer
  // address throttles harder than a normal client, never softer.
  const isLocalPeer = peerIp === '127.0.0.1' || peerIp === '::1';

  if (isLocalPeer) {
    // Trust XFF only from a local reverse proxy (Caddy runs on the same host).
    const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (xff) return xff;
  }

  return peerIp;
}

function cleanup(store: Map<string, RateLimitEntry>): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now >= entry.resetAt) {
      store.delete(key);
    }
  }
}

function createRateLimiter(name: string, config: RateLimitConfig) {
  if (!stores.has(name)) {
    stores.set(name, new Map());
  }
  const store = stores.get(name)!;

  // Periodic cleanup every 5 minutes
  const cleanupInterval = setInterval(() => cleanup(store), 300_000);
  cleanupInterval.unref();

  return async (c: Context, next: Next): Promise<Response | void> => {
    const ip = getClientIp(c);
    const now = Date.now();

    let entry = store.get(ip);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + config.windowMs };
      store.set(ip, entry);
    }

    entry.count++;

    // Set rate limit headers
    const remaining = Math.max(0, config.maxRequests - entry.count);
    c.header('X-RateLimit-Limit', String(config.maxRequests));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > config.maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json(
        error(ErrorCodes.RATE_LIMITED, 'Too many requests. Please try again later.'),
        429 as any
      );
    }

    return next();
  };
}

/** General rate limiter for API endpoints */
export function rateLimitMiddleware(config?: Partial<RateLimitConfig>) {
  return createRateLimiter('general', { ...DEFAULT_CONFIG, ...config });
}

/** Strict rate limiter for auth endpoints (login, token refresh) */
export function authRateLimitMiddleware(config?: Partial<RateLimitConfig>) {
  return createRateLimiter('auth', { ...AUTH_CONFIG, ...config });
}

/** Strict rate limiter for the upload-deploy endpoint (large-body abuse, PRD-039) */
export function uploadRateLimitMiddleware(config?: Partial<RateLimitConfig>) {
  return createRateLimiter('upload', { ...UPLOAD_CONFIG, ...config });
}

/** Dedicated rate limiter for the hosted MCP endpoint (PRD-040) */
export function mcpRateLimitMiddleware(config?: Partial<RateLimitConfig>) {
  return createRateLimiter('mcp', { ...MCP_CONFIG, ...config });
}

/** Dedicated rate limiter for the OAuth 2.1 endpoints (PRD-041) */
export function oauthRateLimitMiddleware(config?: Partial<RateLimitConfig>) {
  return createRateLimiter('oauth', { ...OAUTH_CONFIG, ...config });
}

/** Dedicated rate limiter for the database panel (DROP-120) */
/**
 * The access gate's verify hop.
 *
 * Sized for PAGE-LOAD FAN-OUT, not for a credential surface: `forward_auth`
 * fires once per HTTP request to a gated app, so a single SPA page load is
 * routinely 30-80 hits from one visitor. The general 100/min bucket would make
 * an ordinary browsing session fail intermittently — and because a non-2xx
 * from this hop is copied to the browser by Caddy, a 429 here is a broken page
 * rather than a refusal the app can handle.
 *
 * It is deliberately generous. What bounds abuse here is that the endpoint is
 * cheap (a signature check and two in-memory reads) and that a refused visitor
 * gets a terminal 403 rather than an endless redirect loop — not this number.
 */
export function accessVerifyRateLimitMiddleware() {
  return createRateLimiter('access-verify', { maxRequests: 600, windowMs: 60_000 });
}

export function dbRateLimitMiddleware(config?: Partial<RateLimitConfig>) {
  return createRateLimiter('db', { ...DB_CONFIG, ...config });
}

/**
 * Dedicated rate limiter for backing-service attach/detach (DROP-151 Phase 3).
 * Same numbers as DB_CONFIG on purpose — attach/detach and the database panel
 * are the same shared-Postgres-instance cost, so there is no reason to size
 * this bucket differently. What has to differ is the STORE: this bucket is
 * deliberately its OWN `createRateLimiter` instance rather than a share of
 * the /db/* one, so a detach burst (or a client hammering a refusal) can't
 * 429 the database panel for the same client mid-incident — the exact
 * failure the /db/* bucket's own comment says it exists to prevent. An
 * operator tuning /db/* should NOT assume this bucket follows — bump both
 * explicitly if the two ever need to move together.
 */
export function servicesRateLimitMiddleware(config?: Partial<RateLimitConfig>) {
  return createRateLimiter('services', { ...DB_CONFIG, ...config });
}

/** Reset all rate limit stores (for testing) */
export function resetRateLimits(): void {
  stores.clear();
}
