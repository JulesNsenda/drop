/**
 * SSRF guard utilities.
 *
 * Blocks outbound HTTP calls to private/loopback/link-local ranges so that
 * tenant-controlled URLs (webhook targets, git clone URLs, depends_on URLs)
 * cannot be used to reach internal services (metadata endpoints, LAN hosts,
 * the DROP API itself).
 */

import * as dns from 'dns/promises';
import * as net from 'net';

/**
 * True if the given IP address is in a private, loopback, link-local, or
 * cloud-metadata range that outbound tenant requests should not reach.
 */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    return (
      a === 127 ||                          // 127.0.0.0/8  loopback
      a === 10 ||                           // 10.0.0.0/8   RFC1918
      (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12 RFC1918
      (a === 192 && b === 168) ||           // 192.168.0.0/16 RFC1918
      (a === 169 && b === 254) ||           // 169.254.0.0/16 link-local
      (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10  CGNAT
      a === 0 ||                            // 0.0.0.0/8      this-network
      (a === 192 && b === 0 && parts[2] === 2) || // 192.0.2.0/24 TEST-NET
      (a === 198 && (b === 18 || b === 19))        // 198.18.0.0/15 benchmarking
    );
  }

  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();
    return (
      normalized === '::1' ||               // loopback
      normalized.startsWith('fc') ||        // fc00::/7  ULA
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80') ||      // fe80::/10 link-local
      normalized === '::' ||                // unspecified
      // IPv4-mapped IPv6: ::ffff:192.168.x.x etc — re-extract and re-check
      (normalized.startsWith('::ffff:') &&
        isBlockedIp(normalized.slice('::ffff:'.length)))
    );
  }

  return false; // unknown format — let the caller decide
}

/**
 * Resolves all A/AAAA records for `hostname` and returns true if any of them
 * land in a blocked range.  Throws if DNS resolution fails entirely.
 */
export async function hostnameResolvesToBlockedIp(hostname: string): Promise<boolean> {
  if (net.isIP(hostname)) {
    return isBlockedIp(hostname);
  }
  try {
    const records = await dns.lookup(hostname, { all: true });
    return records.some((r) => isBlockedIp(r.address));
  } catch {
    // DNS failure — treat as blocked (fail-closed)
    return true;
  }
}

/**
 * Asserts that the given URL is safe to make an outbound HTTP request to.
 * Rejects URLs that:
 *   - are not http/https
 *   - have a hostname that resolves to a blocked IP range
 *
 * Throws an `SsrfBlockedError` if the URL is blocked.
 */
export class SsrfBlockedError extends Error {
  constructor(url: string, reason: string) {
    super(`Outbound request to '${url}' blocked: ${reason}`);
    this.name = 'SsrfBlockedError';
  }
}

export async function assertSafeOutboundUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(rawUrl, 'invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(rawUrl, `protocol '${parsed.protocol}' is not allowed`);
  }

  const hostname = parsed.hostname;
  if (await hostnameResolvesToBlockedIp(hostname)) {
    throw new SsrfBlockedError(rawUrl, `hostname '${hostname}' resolves to a private/blocked address`);
  }
}
