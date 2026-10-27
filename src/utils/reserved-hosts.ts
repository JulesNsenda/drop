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
 * TWO rules, combined by `platformHostProblem` (the one entry point for a
 * tenant-authored name):
 *
 *  1. EXACT — the platform's public host and the wildcard apex
 *     (`isReservedHost`). Whole-host comparison only: `myapp.dropkit.sh` is
 *     exactly what tenants are supposed to get, and a suffix test would refuse
 *     every app on the box.
 *  2. SUBTREE — anything under the public URL's host (`x.dashboard.dropkit.sh`
 *     for `https://dashboard.dropkit.sh`), including a wildcard whose
 *     expansion would reach it. Such a name is same-site with the platform, and
 *     an OAuth provider that accepts subdomains of a registered callback
 *     (GitHub) delivers authorization codes meant for the platform to it. This
 *     rule is a NO-OP when the domain suffix equals the public host or sits
 *     under it: every app is then same-site with the platform anyway, so it
 *     cannot tell a tenant name from an app name (`platformHostWarning` says so
 *     once at boot).
 *
 * Deliberately a small, closed set. Reserving more than DROP actually serves
 * would refuse legitimate tenant domains, and a guard that blocks real use gets
 * removed.
 */

/**
 * Extract a comparable hostname from a URL or bare host string: lower-cased
 * (by URL parsing) with one trailing dot stripped, so `Example.COM.` and
 * `example.com` compare equal everywhere.
 */
function toHost(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    // Bare hosts have no scheme; give them one so URL parsing is uniform.
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return url.hostname.toLowerCase().replace(/\.$/, '') || undefined;
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

/** The public URL's host, or undefined when unset or `localhost`. */
function realPublicHost(publicUrl?: string): string | undefined {
  const host = publicUrl ? toHost(publicUrl) : undefined;
  return host && host !== 'localhost' ? host : undefined;
}

/**
 * Whether the SUBTREE rule is switched off: the domain suffix equals the public
 * host or sits under it. See the header.
 */
function subtreeRuleOff(publicHost: string, domainSuffix?: string): boolean {
  const suffix = domainSuffix ? toHost(domainSuffix) : undefined;
  if (!suffix || suffix === 'localhost') return false;
  return suffix === publicHost || suffix.endsWith(`.${publicHost}`);
}

/**
 * Why a tenant-authored hostname may not be routed, or undefined when it may.
 * The returned text completes "<host> is …" / "That domain is …".
 *
 * A `*.X` entry is judged by X, and also refused when its single-label
 * expansion would cover the public host (`*.dropkit.sh` for a public host of
 * `dashboard.dropkit.sh`).
 */
export function platformHostProblem(
  host: string,
  opts: { publicUrl?: string; domainSuffix?: string }
): string | undefined {
  const trimmed = host.trim();
  const wildcard = trimmed.startsWith('*.');
  const name = toHost(wildcard ? trimmed.slice(2) : trimmed);
  // Fail closed: with a platform host to protect, a name that cannot be
  // compared cannot be shown to be outside it.
  if (!name) return reservedHosts(opts.publicUrl, opts.domainSuffix).size > 0 ? 'not a valid hostname' : undefined;

  if (reservedHosts(opts.publicUrl, opts.domainSuffix).has(name)) {
    return 'reserved by the platform';
  }

  const publicHost = realPublicHost(opts.publicUrl);
  if (!publicHost || subtreeRuleOff(publicHost, opts.domainSuffix)) return undefined;

  const under = name === publicHost || name.endsWith(`.${publicHost}`);
  // `*.<parent>` covers `<label>.<parent>`: the public host is one label below.
  const covers = wildcard && publicHost.slice(publicHost.indexOf('.') + 1) === name;
  return under || covers ? "under the platform's own host" : undefined;
}

/**
 * One-line boot warning when the SUBTREE rule is off for this configuration
 * (public URL set, domain suffix equal to or under its host), else undefined.
 */
export function platformHostWarning(publicUrl?: string, domainSuffix?: string): string | undefined {
  const publicHost = realPublicHost(publicUrl);
  if (!publicHost || !subtreeRuleOff(publicHost, domainSuffix)) return undefined;
  return (
    `The domain suffix '${domainSuffix}' is the platform's public host '${publicHost}' or under it, ` +
    'so every app is same-site with the platform and names under the public host cannot be ' +
    'refused. OAuth providers that accept subdomains of a registered callback could deliver ' +
    "authorization codes to an app; give the platform its own host outside the apps' suffix. " +
    'In this topology an external OAuth provider with subdomain-matching callbacks must not ' +
    'point at the public host.'
  );
}
