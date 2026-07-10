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

  const isLocalPeer = peerIp === '127.0.0.1' || peerIp === '::1' || peerIp === 'unknown';

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

/** Reset all rate limit stores (for testing) */
export function resetRateLimits(): void {
  stores.clear();
}
