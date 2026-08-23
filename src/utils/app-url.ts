/**
 * Compute an app's externally-reachable URL.
 *
 * Lives in `utils/` rather than `apps.ts` (its original home) because
 * DROP-154 gave it a second call site inside `apps.share.ts`, which is
 * itself mounted onto `apps.ts` (`apps.route('/', shareRoutes)`) — an import
 * of `computeAppUrl` FROM `apps.ts` closed a require cycle that only worked
 * by accident of CommonJS's late-bound exports object, and broke depending on
 * which module happened to load first. Every other caller (mcp/tools.ts,
 * app-access.ts, mcp-gateway.ts, oauth.ts) moved here too, so there is one
 * definition instead of one cycle-prone one plus a growing set of importers
 * reaching into a route file for a pure function.
 *
 * The served host is DERIVED, never read from `app.hostname` — that field is the
 * persisted `<name>.localhost` placeholder; the host an app actually serves on is
 * computed at route time and never stored (P0-6 hijack guard — see
 * `AppConfigService.getDomainOwners`). Priority: dashboard-set `customDomain` >
 * drop.yaml `domains` (persisted in app config) > default `<name>.<domainSuffix>`
 * (mirrors `platform.ts` `handleConfigureRoute`). Returns `undefined` for a
 * localhost host — there is no globally-reachable URL, so the dashboard falls back
 * to a direct host:port link derived from the viewer's own location.
 */

import { getAppConfigService } from '../managers/app/app-config';
import type { AppState } from '../managers/app/state-manager';
import { isHttpsEnabled, getDomainSuffix } from '../api/runtime-config';
import { isLocalhostDomain } from './domain-validator';

export interface ComputeAppUrlOptions {
  /**
   * Force `https` regardless of the app's own `tls: {disabled: true}` or the
   * platform's own HTTP mode. Every caller that puts the result somewhere a
   * tenant-authored downgrade would be a confidentiality problem (a mailed
   * link, a session audience) sets this — see `app-access.ts`'s `appOrigin`
   * and `apps.share.ts`'s `notifyShareGrant` for the two current examples.
   * Handled HERE, once, instead of a `.replace(/^http:\/\//, 'https://')` at
   * every call site.
   */
  forceHttps?: boolean;
}

export function computeAppUrl(app: AppState, options?: ComputeAppUrlOptions): string | undefined {
  const forceHttps = options?.forceHttps === true;
  let configDomains: string[] | undefined;
  let tlsDisabled = false;
  let publicUrl: string | undefined;
  try {
    const cfg = getAppConfigService().getConfig(app.name);
    configDomains = cfg?.domains;
    tlsDisabled = cfg?.tls?.disabled === true;
    publicUrl = cfg?.publicUrl;
  } catch {
    // Config service not initialised (e.g. isolated route tests) — use default host.
  }
  // A same-origin monorepo child is routed onto the group domain (frontend at
  // '/', backend at '/api'), never its own `<name>` subdomain — so the
  // name-based default below would be a dead link. handleConfigureRoute persists
  // the real, fully-resolved URL as publicUrl. A custom domain still wins:
  // declaring `domains` opts the child out of same-origin routing.
  if (publicUrl && !app.customDomain && !configDomains?.length) {
    return forceHttps ? publicUrl.replace(/^http:\/\//, 'https://') : publicUrl;
  }
  const domain = app.customDomain || configDomains?.[0] || `${app.name}.${getDomainSuffix()}`;
  if (isLocalhostDomain(domain)) return undefined;
  const proto = forceHttps || (isHttpsEnabled() && !tlsDisabled) ? 'https' : 'http';
  return `${proto}://${domain}`;
}
