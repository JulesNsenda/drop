/**
 * Compute an app's externally-reachable URL.
 *
 * Lives in `utils/` rather than `apps.ts` (its original home) so its real
 * callers (mcp/tools.ts, app-access.ts, mcp-gateway.ts, oauth.ts) don't have
 * to reach into a route file for a pure function, and so importing it FROM
 * `apps.ts` can't close a require cycle that would only work by accident of
 * CommonJS's late-bound exports object, breaking depending on which module
 * happened to load first.
 *
 * `apps.share.ts` does NOT call this function, deliberately — see
 * `ComputeAppUrlOptions.forceHttps` below for why.
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
   * tenant-authored downgrade would be a confidentiality problem (a session
   * audience) sets this — see `app-access.ts`'s `appOrigin` for the current
   * example. Handled HERE, once, instead of a
   * `.replace(/^http:\/\//, 'https://')` at every call site.
   *
   * NOT `apps.share.ts`'s `notifyShareGrant` — that mailed link deliberately
   * never calls `computeAppUrl` at all (forced-https or otherwise): this
   * function resolves from the app's OWN `domains`/`customDomain`, which are
   * tenant-authored, and a mail sent from the operator's DKIM/SPF-aligned
   * relay carrying an attacker-chosen domain would be a phishing primitive
   * borrowing the operator's sender reputation. `notifyShareGrant` hand-rolls
   * `${app.name}.${getDomainSuffix()}` instead — see that function's own doc
   * comment.
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
