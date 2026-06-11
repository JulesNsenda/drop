/**
 * Outbound URL safety checks (SSRF mitigation).
 *
 * Used for operator-supplied outbound URLs (e.g. webhook targets). This is a
 * literal-address block — it rejects loopback/private/link-local IP literals
 * and localhost, and requires http(s). It deliberately does NOT resolve DNS,
 * so it does not defend against DNS-rebinding; for a self-hosted tool where
 * the configurer is the operator, that is an accepted, documented trade-off.
 */

const PRIVATE_IPV4_PATTERNS: RegExp[] = [
  /^10\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

function isPrivateIpv4(host: string): boolean {
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
  return PRIVATE_IPV4_PATTERNS.some((re) => re.test(host));
}

function isPrivateIpv6(host: string): boolean {
  // URL hostnames keep IPv6 in brackets; strip them.
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;

  // IPv4-mapped IPv6, dotted form: ::ffff:127.0.0.1
  const dotted = h.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return isPrivateIpv4(dotted[1]) || dotted[1].startsWith('127.');

  // IPv4-mapped IPv6, hex form (Node normalizes ::ffff:127.0.0.1 → ::ffff:7f00:1)
  const hex = h.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    const v4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    return isPrivateIpv4(v4) || v4.startsWith('127.');
  }

  return false;
}

/** True if the URL is a well-formed http(s) URL that does not target a local/private address. */
export function isSafeOutboundUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (isPrivateIpv4(host)) return false;
  if (host.includes(':') && isPrivateIpv6(host)) return false;

  return true;
}
