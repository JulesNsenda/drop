/**
 * Hostnames a tenant may never claim.
 *
 * The cross-tenant hostname guard (`getDomainOwners`) knows about APP
 * hostnames, so one tenant cannot take another's. It knows nothing about the
 * PLATFORM's own host, which is therefore unowned — and an unowned host is an
 * available one.
 *
 * What that buys an attacker: a drop.yaml `domains: [dropkit.sh]` is accepted
 * and persisted, and a Caddy site block for DROP's own hostname is generated
 * pointing at the tenant. If it wins, that tenant serves `/api/v1/oauth/*` and
 * `/api/v1/mcp` — so a victim following an ordinary OAuth flow hands their
 * control-plane token to the tenant, which is the exact catastrophe per-app MCP
 * auth is built on top of. If it merely duplicates the platform's own block, the
 * config reload breaks for the whole box.
 *
 * Deliberately a small, closed set: the platform's own host and the wildcard
 * apex. Reserving more than DROP actually serves would refuse legitimate tenant
 * domains, and a guard that blocks real use gets removed.
 */

/** Extract a comparable hostname from a URL or bare host string. */
function toHost(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    // Bare hosts have no scheme; give them one so URL parsing is uniform.
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The reserved set for a given platform configuration.
 *
 * `publicUrl` is DROP's own base URL (the OAuth issuer); `domainSuffix` is the
 * apex apps get subdomains of. Either may be absent — an unconfigured issuer
 * reserves nothing extra rather than guessing.
 */
export function reservedHosts(publicUrl?: string, domainSuffix?: string): Set<string> {
  const hosts = new Set<string>();
  if (publicUrl) {
    const host = toHost(publicUrl);
    if (host) hosts.add(host);
  }
  if (domainSuffix) {
    const host = toHost(domainSuffix);
    // `localhost` is the unconfigured default and is not a real claim surface;
    // reserving it would refuse the local development setup.
    if (host && host !== 'localhost') hosts.add(host);
  }
  return hosts;
}

/**
 * Whether a tenant-supplied hostname is reserved by the platform.
 *
 * Compares whole hostnames, never suffixes: `dropkit.sh` is reserved while
 * `myapp.dropkit.sh` is exactly what tenants are supposed to get, and a suffix
 * test would refuse every app on the box.
 */
export function isReservedHost(
  candidate: string,
  publicUrl?: string,
  domainSuffix?: string
): boolean {
  const host = toHost(candidate);
  if (!host) return false;
  return reservedHosts(publicUrl, domainSuffix).has(host);
}
