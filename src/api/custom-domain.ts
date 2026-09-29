/**
 * Custom domains for the API and MCP surfaces (#302): set one, learn the DNS
 * record to create, and verify it — at which point, and not before, the
 * platform routes it and Caddy obtains its certificate. The rules and the DNS
 * reduction live in managers/domain/custom-domain.ts; routing in platform.ts's
 * handleConfigureRoute.
 *
 * Shared by `PUT /apps/:name/domain`, the general `PUT /apps/:name`, the
 * `/domain` status + verify routes and the `custom_domain` MCP tool, so there
 * is one rule set and one activation path behind every door.
 */

import { getStateManager } from '../managers/app/state-manager';
import { getAppConfigServiceOrNull } from '../managers/app/app-config';
import { getCaddyAdminClient } from '../managers/router/caddy-api';
import {
  customDomainProblem,
  dnsInstructions,
  platformAddresses,
  checkDomainDns,
  type DnsRecordInstruction,
} from '../managers/domain/custom-domain';
import { getDomainSuffix, getPublicUrl } from './runtime-config';
import { getPlatformOps, AppInProgressError } from './platform-ops';
import { ValidationError } from './middleware/error';

export type CustomDomainState =
  /** No custom domain is set. */
  | 'none'
  /** Set; DNS does not point here yet. */
  | 'pending'
  /** DNS pointed here; the domain is routed. */
  | 'verified'
  /** Set, but this platform does not know its own public address, so cannot check. */
  | 'unverifiable'
  /** Set, but it can never be verified: claimed by another app, or breaks a rule. */
  | 'blocked';

export interface CustomDomainStatus {
  app: string;
  domain: string | null;
  state: CustomDomainState;
  /** Whether the platform serves this domain for the app. */
  routed: boolean;
  /** The records that point the domain here. */
  records: DnsRecordInstruction[];
  /** Null when there is nothing to check. Booleans only: resolver output is never echoed. */
  dns: { resolves: boolean; pointsHere: boolean } | null;
  /** Null until the domain is routed and Caddy reports a certificate. */
  certificate: { status: string; notAfter: string | null; issuer: string } | null;
  message: string;
}

function platformContext() {
  return { publicUrl: getPublicUrl(), domainSuffix: getDomainSuffix() };
}

/** Throws ValidationError when `domain` may not be a custom domain. */
export function assertCustomDomainAllowed(domain: string): void {
  const problem = customDomainProblem(domain, platformContext());
  if (problem) throw new ValidationError(problem);
}

/**
 * Record an app's custom domain (`undefined` or '' clears it). Validates with
 * the shared rules. A domain that was verified and routed and is now replaced
 * is unrouted straight away: the route write drops a verification that no
 * longer matches. A deploy in flight will do that write itself.
 */
export async function setCustomDomain(appName: string, domain: string | undefined): Promise<void> {
  const next = domain?.trim() || undefined;
  if (next) assertCustomDomainAllowed(next);
  await getStateManager().updateApp(appName, { customDomain: next ?? ('' as unknown as undefined) });

  const verified = getAppConfigServiceOrNull()?.getConfig(appName)?.customDomainVerified?.domain;
  if (verified && verified.toLowerCase() !== next?.toLowerCase()) {
    await reconfigure(appName);
  }
}

/**
 * The app's custom-domain status. With `verify`, a pending domain whose DNS
 * now points here, that no other app claims and that breaks no rule, is
 * recorded as verified and routed — idempotent, so a caller can poll it.
 */
export async function customDomainStatus(
  appName: string,
  opts: { verify?: boolean } = {}
): Promise<CustomDomainStatus> {
  const app = getStateManager().getApp(appName);
  const domain = app?.customDomain?.trim() || null;
  if (!domain) {
    return {
      app: appName,
      domain: null,
      state: 'none',
      routed: false,
      records: [],
      dns: null,
      certificate: null,
      message: `No custom domain is set. Set one with PUT /api/v1/apps/${appName}/domain.`,
    };
  }

  const { publicUrl, domainSuffix } = platformContext();
  const configs = getAppConfigServiceOrNull();
  const addresses = await platformAddresses(publicUrl);
  const records = dnsInstructions(appName, domain, domainSuffix, addresses);
  const base = { app: appName, domain, records };

  // A value stored before these rules existed can still break one.
  const problem = customDomainProblem(domain, { publicUrl, domainSuffix });
  const owner = configs?.getDomainOwners(domainSuffix).get(domain.toLowerCase());
  const claimedBy = owner && owner !== appName ? owner : undefined;
  if (problem || claimedBy) {
    return {
      ...base,
      state: 'blocked',
      routed: false,
      dns: null,
      certificate: null,
      message: problem ?? `${domain} is already served by another app on this platform.`,
    };
  }

  let verified =
    configs?.getConfig(appName)?.customDomainVerified?.domain.toLowerCase() === domain.toLowerCase();
  const dns = addresses.length > 0 ? await checkDomainDns(domain, addresses) : null;

  if (!verified && opts.verify && dns?.pointsHere && configs) {
    await configs.updateSystemConfig(appName, {
      customDomainVerified: { domain, verifiedAt: new Date().toISOString() },
    });
    await reconfigure(appName);
    verified = true;
  }

  if (verified) {
    const certificate = await certificateFor(domain);
    return {
      ...base,
      state: 'verified',
      routed: true,
      dns,
      certificate,
      message: certificate
        ? `${domain} is verified and routed; its certificate is ${certificate.status}.`
        : `${domain} is verified and routed; the certificate is being obtained — check again shortly.`,
    };
  }
  if (!dns) {
    return {
      ...base,
      state: 'unverifiable',
      routed: false,
      dns: null,
      certificate: null,
      message:
        'This platform does not know its own public address, so it cannot check DNS. ' +
        'An operator can set DROP_PUBLIC_IPS.',
    };
  }
  return {
    ...base,
    state: 'pending',
    routed: false,
    dns,
    certificate: null,
    message: dns.resolves
      ? `${domain} resolves, but not to this platform. Create one of the records listed, then verify again.`
      : `${domain} does not resolve yet. Create one of the records listed, then verify again.`,
  };
}

async function reconfigure(appName: string): Promise<void> {
  try {
    await getPlatformOps()?.reconfigureRoute(appName);
  } catch (err) {
    // A deploy in flight writes the route itself when it starts the app.
    if (!(err instanceof AppInProgressError)) throw err;
  }
}

async function certificateFor(domain: string): Promise<CustomDomainStatus['certificate']> {
  try {
    const client = getCaddyAdminClient();
    if (!(await client.isAvailable())) return null;
    const cert = await client.getCertificateForDomain(domain);
    return cert ? { status: cert.status, notAfter: cert.notAfter || null, issuer: cert.issuer } : null;
  } catch {
    return null;
  }
}
