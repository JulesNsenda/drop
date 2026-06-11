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

    // Content Security Policy. The dashboard is a same-origin Vite SPA with no
    // inline scripts; 'unsafe-inline' is needed only for runtime-injected
    // styles. Limits the blast radius of any future XSS.
    c.header(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; ')
    );

    // Remove server identification
    c.header('X-Powered-By', '');
  };
}
