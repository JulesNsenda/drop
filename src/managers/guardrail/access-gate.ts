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
   * The app's monorepo group, if any. Resolved from `AppConfig.group` for a
   * CHILD and from `AppState.group` for the container — `expandMonorepo`
   * writes the container's tag to state only, so reading the config alone made
   * the container invisible to this blocker. Group children share ONE
   * hostname, and the unit of Caddy enforcement is a site block keyed on
   * host+prefix, so a gate on one child is not a gate on the group.
   */
  group?: string;
  /**
   * Whether this app is the monorepo CONTAINER (the cloned repo folder) rather
   * than one of its services. It serves nothing itself — its children serve
   * the group host — so a policy on it is a governance record over an app
   * nobody can reach, with the origin holding the data left open.
   */
  isGroupContainer?: boolean;
}

/** A machine-readable reason a gate cannot be enforced. */
export type AccessGateBlocker =
  | 'isolation-not-docker'
  | 'auth-disabled'
  | 'no-https'
  | 'tenant-network-shared'
  | 'monorepo-group-child'
  | 'monorepo-group-container';

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
  'monorepo-group-container':
    'the app is a monorepo container, not a service: it serves nothing itself, so a gate on it ' +
    'would be a governance record over an address nobody can reach while its children stay open',
};

/**
 * Whether this build can actually ENFORCE an access gate.
 *
 * `false` until the `forward_auth` guard emitter and the verify endpoint land
 * (the next slice). Everything in this module — the rule, the three refusal
 * points, the policy store — is the enforceability half; nothing yet puts a
 * guard in front of a single request.
 *
 * It exists so that no affirmative signal is a lie in the meantime: an app
 * with a policy on this build is NOT protected, whatever the verdict says
 * about the box, and the route and the state flag both say so. Flipping this
 * to `true` alongside the emitter is the one line that turns the claims on.
 */
export const ACCESS_GATE_ENFORCEMENT_AVAILABLE = false;

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
  if (ctx.isGroupContainer) blockers.push('monorepo-group-container');
  else if (ctx.group) blockers.push('monorepo-group-child');

  return {
    enforceable: blockers.length === 0,
    blockers,
    reasons: blockers.map((b) => BLOCKER_REASONS[b]),
  };
}

/**
 * Whether EVERY hostname the app is routed on is served over HTTPS.
 *
 * Per hostname, not per app: each `domains:` entry gets its own Caddy route,
 * so a user authenticated on one is not authenticated on another, and one
 * plaintext entry is enough to break the Secure cookie the gate depends on.
 * An empty list is `false` — nothing is routed, so nothing is gated, and
 * reporting that as a pass would be vacuous.
 *
 * There is deliberately NO `tlsDisabled` input. It used to take one, read from
 * the tenant's own `drop.yaml`, which handed the governed party a one-line off
 * switch for the control governing them. A gated app's transport is not the
 * tenant's decision; the caller drops plaintext hostnames instead.
 */
export function resolveHttpsEffective(
  hostnames: string[],
  opts: { enableHttps: boolean; isLocalhost: (hostname: string) => boolean }
): boolean {
  return hostnames.length > 0 && hostnames.every((h) => opts.enableHttps && !opts.isLocalhost(h));
}

/** The refusal message for a route or a log line, from a verdict. */
export function describeAccessGateRefusal(appName: string, verdict: AccessGateVerdict): string {
  return (
    `A browser access gate cannot be enforced for '${appName}': ` +
    verdict.reasons.map((r, i) => `(${i + 1}) ${r}`).join('; ')
  );
}
