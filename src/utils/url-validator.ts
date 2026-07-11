/**
 * Validates and normalizes an admin-supplied public base URL
 * (DROP_PUBLIC_URL override — see `src/api/runtime-config.ts`).
 *
 * This value becomes the OAuth issuer/resource base (PRD-041) —
 * security-adjacent, so validation is deliberately strict:
 *  - HTTPS-only, except for localhost/loopback (dev convenience).
 *  - Must be a bare origin: no path, query, or fragment, so it composes
 *    cleanly with fixed suffix paths elsewhere
 *    (e.g. `${publicUrl}/api/v1/oauth/authorize`).
 */

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export type NormalizePublicUrlResult = { ok: true; value: string } | { ok: false; reason: string };

export function normalizePublicUrl(input: string): NormalizePublicUrlResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'must be a valid URL' };
  }

  const isLocalhost = LOCALHOST_HOSTNAMES.has(url.hostname);
  const schemeOk = url.protocol === 'https:' || (url.protocol === 'http:' && isLocalhost);
  if (!schemeOk) {
    return { ok: false, reason: 'must use https://' };
  }

  if (!url.hostname) {
    return { ok: false, reason: 'must include a hostname' };
  }

  if ((url.pathname !== '' && url.pathname !== '/') || url.search !== '' || url.hash !== '') {
    return { ok: false, reason: 'must be a bare origin (no path, query, or fragment)' };
  }

  // url.origin is already a canonical "scheme://host[:port]" with no
  // trailing slash.
  return { ok: true, value: url.origin };
}
