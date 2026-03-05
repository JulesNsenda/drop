/**
 * Security Headers Middleware
 *
 * Adds standard security headers to all API responses.
 */

import { Context, Next } from 'hono';

export function securityHeadersMiddleware() {
  return async (c: Context, next: Next): Promise<Response | void> => {
    await next();

    // Prevent MIME-type sniffing
    c.header('X-Content-Type-Options', 'nosniff');

    // Prevent clickjacking
    c.header('X-Frame-Options', 'DENY');

    // XSS protection (legacy browsers)
    c.header('X-XSS-Protection', '1; mode=block');

    // Referrer policy
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');

    // Permissions policy - restrict browser features
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

    // Remove server identification
    c.header('X-Powered-By', '');
  };
}
