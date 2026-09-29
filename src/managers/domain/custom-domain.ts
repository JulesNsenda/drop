/**
 * Custom domains set from the dashboard/API (#302): the rules, the DNS record
 * to create, and the check that it has been created.
 *
 * WHY VERIFICATION GATES ROUTING. `AppState.customDomain` was never routed —
 * only drop.yaml `domains` reach Caddy — so the dashboard advertised a link
 * nothing served. Routing it as soon as it is set would put a Caddy block, and
 * an ACME order, behind every value ever typed into that field, including ones
 * whose DNS never pointed here. So a custom domain is routed only once DROP has
 * seen its DNS resolve to this box; `AppConfig.customDomainVerified` records
 * that, on the SYSTEM tier because it decides routing.
 *
 * WHAT VERIFICATION PROVES. That the domain resolves to one of this platform's
 * addresses — i.e. whoever controls its DNS pointed it here. Names under the
 * platform's own domain suffix are refused outright: the wildcard record makes
 * them resolve here whether or not anyone pointed them, so for them resolving
 * proves nothing, and claiming one would squat a future app's default hostname.
 *
 * Nothing the resolver returns is echoed to a caller: results are reduced to
 * booleans against DROP's own addresses, which is all a caller needs and all
 * that is safe to hand an agent.
 */

import { Resolver } from 'dns/promises';
import * as dns from 'dns/promises';
import { isReservedHost } from '../../utils/reserved-hosts';

/** Same format rule both existing writers applied. */
export const CUSTOM_DOMAIN_RE = /^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * Why `domain` may not be an app's custom domain, or undefined when it may.
 * The ONE rule set every writer applies — `PUT /apps/:name/domain`, the
 * general `PUT /apps/:name`, and the MCP tool.
 */
export function customDomainProblem(
  domain: string,
  opts: { publicUrl?: string; domainSuffix?: string }
): string | undefined {
  if (!CUSTOM_DOMAIN_RE.test(domain)) return 'Invalid domain format';
  if (isReservedHost(domain, opts.publicUrl, opts.domainSuffix)) {
    return 'That domain is reserved by the platform';
  }
  const suffix = opts.domainSuffix?.trim().toLowerCase();
  const host = domain.toLowerCase();
  if (suffix && suffix !== 'localhost' && (host === suffix || host.endsWith(`.${suffix}`))) {
    return `Names under ${suffix} belong to the platform; every app already has its own ` +
      `<app>.${suffix} hostname. Use a domain you control.`;
  }
  return undefined;
}

/** A DNS record the domain's owner should create. */
export interface DnsRecordInstruction {
  type: 'CNAME' | 'A' | 'AAAA';
  name: string;
  value: string;
  /** When to use this record rather than the others. */
  use: string;
}

/**
 * The records that point `domain` at this box: a CNAME to the app's own
 * hostname for a subdomain (it follows the box if its address changes), and
 * A/AAAA records to the platform's addresses for an apex, where a CNAME is not
 * allowed. The CNAME is offered only when the app has a real, non-localhost
 * hostname to point at.
 */
export function dnsInstructions(
  appName: string,
  domain: string,
  domainSuffix: string | undefined,
  addresses: string[]
): DnsRecordInstruction[] {
  const records: DnsRecordInstruction[] = [];
  const suffix = domainSuffix?.trim().toLowerCase();
  if (suffix && suffix !== 'localhost') {
    records.push({
      type: 'CNAME',
      name: domain,
      value: `${appName}.${suffix}`,
      use: 'for a subdomain such as app.example.com (recommended)',
    });
  }
  for (const address of addresses) {
    records.push({
      type: address.includes(':') ? 'AAAA' : 'A',
      name: domain,
      value: address,
      use: 'for an apex domain such as example.com, where a CNAME is not allowed',
    });
  }
  return records;
}

/**
 * This platform's public addresses: `DROP_PUBLIC_IPS` (comma-separated) when
 * set — the answer for a box behind NAT, whose own hostname may resolve to an
 * address DNS records should not use — otherwise whatever the platform's own
 * public host resolves to. Empty when neither is known.
 */
export async function platformAddresses(
  publicUrl: string | undefined,
  lookup: (host: string) => Promise<string[]> = defaultLookup
): Promise<string[]> {
  const configured = (process.env.DROP_PUBLIC_IPS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (configured.length > 0) return unique(configured);
  if (!publicUrl) return [];
  let host: string;
  try {
    host = new URL(publicUrl).hostname;
  } catch {
    return [];
  }
  if (!host || host === 'localhost') return [];
  return unique(await lookup(host).catch(() => []));
}

/** What DNS says about `domain`, reduced to what a caller may be told. */
export interface DnsCheck {
  /** The domain has at least one A/AAAA record. */
  resolves: boolean;
  /** At least one of those addresses is this platform's. */
  pointsHere: boolean;
}

/**
 * Resolve `domain` (A and AAAA, following CNAMEs) and compare against
 * `addresses`. Never throws: a resolver error reads as "does not resolve".
 */
export async function checkDomainDns(
  domain: string,
  addresses: string[],
  resolve: (host: string) => Promise<string[]> = defaultResolve
): Promise<DnsCheck> {
  const found = await resolve(domain).catch(() => [] as string[]);
  const ours = new Set(addresses.map(normalizeAddress));
  return {
    resolves: found.length > 0,
    pointsHere: found.some((a) => ours.has(normalizeAddress(a))),
  };
}

async function defaultLookup(host: string): Promise<string[]> {
  const results = await dns.lookup(host, { all: true });
  return results.map((r) => r.address);
}

/** Straight to DNS rather than through /etc/hosts, so a local override cannot fake a pass. */
async function defaultResolve(host: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  const [v4, v6] = await Promise.all([
    resolver.resolve4(host).catch(() => [] as string[]),
    resolver.resolve6(host).catch(() => [] as string[]),
  ]);
  return [...v4, ...v6];
}

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(normalizeAddress))];
}
