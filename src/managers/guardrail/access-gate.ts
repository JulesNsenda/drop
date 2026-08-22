/**
 * Whether DROP can actually ENFORCE a browser access gate on an app
 * (DROP-152), and the structured refusal when it cannot.
 *
 * The gate lives in Caddy, so it protects exactly what Caddy is the only way
 * in to. Several ordinary platform configurations break that premise, and a
 * governance control that silently does not hold is worse than no control at
 * all — the dashboard would report the app as gated either way.
 *
 * ONE assessment, read from three places, each of which refuses differently:
 *
 *  1. The route that sets a policy — refuses the write outright.
 *  2. Route emission (`handleConfigureRoute`) — refuses to emit the guard and
 *     flags the app, so an app asked to be protected and not protected is
 *     never silent.
 *  3. The boot sweep — reports every persisted policy that cannot be enforced.
 *
 * Deliberately NOT `assertStartupConstraints`. That runs before the config
 * layer even loads (so it cannot see any app's policy) and it THROWS TO EXIT
 * THE PROCESS — one tenant declaring a gate on an unsuitable box would refuse
 * to boot the whole fleet, a self-service denial of service of exactly the
 * shape `principal-quota.ts` exists to avoid. These refusals are returned, per
 * app, and never abort anything.
 */

/**
 * Everything the verdict depends on. Passed in rather than read from
 * singletons so the rule itself is a pure function — the three callers each
 * resolve their own inputs, and the boot sweep can assess an app that is not
 * running.
 */
export interface AccessGateContext {
  /** `config.isolation`. */
  isolation: 'none' | 'docker';
  /** `config.enableApiAuth` — whether DROP has a principal to gate on at all. */
  authEnabled: boolean;
  /**
   * Whether every hostname this app is routed on is served over HTTPS.
   *
   * A hard prerequisite, not hardening: the session cookie the gate mints is
   * `Secure`, so on a plaintext host the browser silently DROPS it and the
   * user loops through the login forever with no error recorded anywhere.
   */
  httpsEffective: boolean;
  /**
   * Whether tenant containers can reach each other directly on `drop-net`
   * (`getTenantNetworkIsolation()`). `'shared'` is the failing value; docker
   * isolation is not sufficient on its own when it holds.
   */
  networkIsolation: 'unknown' | 'isolated' | 'shared';
  /**
   * `AppConfig.group` — set for a monorepo child. Group children share ONE
   * hostname, and the unit of Caddy enforcement is a site block keyed on
   * host+prefix, so a gate on one child is not a gate on the group.
   */
  group?: string;
}

/** A machine-readable reason a gate cannot be enforced. */
export type AccessGateBlocker =
  | 'isolation-not-docker'
  | 'auth-disabled'
  | 'no-https'
  | 'tenant-network-shared'
  | 'monorepo-group-child';

export interface AccessGateVerdict {
  enforceable: boolean;
  blockers: AccessGateBlocker[];
  /** One human-readable sentence per blocker, in the same order. */
  reasons: string[];
}

const BLOCKER_REASONS: Record<AccessGateBlocker, string> = {
  'isolation-not-docker':
    'the platform is not running in docker isolation, so each app binds its own port on the host ' +
    'and is reachable at host:port without passing through Caddy at all',
  'auth-disabled':
    'API authentication is disabled, so there is no principal to gate on',
  'no-https':
    'the app is not served over HTTPS, and the gate\'s session cookie is Secure — a browser would ' +
    'drop it and the user would loop through the login endlessly',
  'tenant-network-shared':
    'inter-container communication is enabled on drop-net (the network predates the ICC-disabled ' +
    'setting and could not be recreated while containers were attached), so any tenant container ' +
    'can reach this app directly, bypassing Caddy',
  'monorepo-group-child':
    'the app is a monorepo group child: group children share one hostname, so a gate on one child ' +
    'leaves its siblings open on the same origin — gate the group, not a single child',
};

/**
 * The verdict. Every blocker is reported, not just the first: an operator
 * fixing one at a time otherwise discovers the next only on the next attempt.
 */
export function assessAccessGate(ctx: AccessGateContext): AccessGateVerdict {
  const blockers: AccessGateBlocker[] = [];

  if (ctx.isolation !== 'docker') blockers.push('isolation-not-docker');
  if (!ctx.authEnabled) blockers.push('auth-disabled');
  if (!ctx.httpsEffective) blockers.push('no-https');
  // Only an explicit 'shared' refuses. 'unknown' means ensureNetwork() has not
  // run in this process yet — the normal state before the first container
  // starts — and refusing on it would refuse every correctly configured box
  // during its whole boot window.
  if (ctx.networkIsolation === 'shared') blockers.push('tenant-network-shared');
  if (ctx.group) blockers.push('monorepo-group-child');

  return {
    enforceable: blockers.length === 0,
    blockers,
    reasons: blockers.map((b) => BLOCKER_REASONS[b]),
  };
}

/**
 * The hostnames an app is actually routed on: its explicit `domains:` when it
 * has any, otherwise the computed `<name>.<suffix>` default.
 *
 * Shared by the route and the boot sweep so neither re-derives it. The route
 * emission path passes its own already-filtered list instead — by that point
 * reserved and cross-tenant-claimed hostnames have been dropped, and the
 * verdict must be about what is really being emitted.
 */
export function resolveGateHostnames(
  appName: string,
  domains: string[] | undefined,
  domainSuffix: string
): string[] {
  if (domains && domains.length > 0) return domains;
  return [`${appName}.${domainSuffix || 'localhost'}`];
}

/**
 * Whether EVERY hostname the app is routed on is served over HTTPS.
 *
 * Per hostname, not per app: each `domains:` entry gets its own Caddy route,
 * so a user authenticated on one domain is not authenticated on another, and
 * one plaintext entry is enough to break the Secure cookie the gate depends
 * on. An empty list is `false` — nothing is routed, so nothing is gated, and
 * reporting that as a pass would be vacuous.
 */
export function resolveHttpsEffective(
  hostnames: string[],
  opts: { enableHttps: boolean; tlsDisabled?: boolean; isLocalhost: (hostname: string) => boolean }
): boolean {
  return (
    hostnames.length > 0 &&
    hostnames.every((h) => opts.enableHttps && !opts.isLocalhost(h) && !opts.tlsDisabled)
  );
}

/** The refusal message for a route or a log line, from a verdict. */
export function describeAccessGateRefusal(appName: string, verdict: AccessGateVerdict): string {
  return (
    `A browser access gate cannot be enforced for '${appName}': ` +
    verdict.reasons.map((r, i) => `(${i + 1}) ${r}`).join('; ')
  );
}
