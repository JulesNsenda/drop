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
  /**
   * DROP's own public base URL (`getPublicUrl()`), or undefined when none is
   * configured.
   *
   * The gate's very first hop redirects the visitor here to authenticate. With
   * no public URL there is nowhere to send them, so the guard would be emitted
   * in front of an app that then answers nothing to anyone — bricked, not
   * merely ungated. It also decides whether the platform's own host is in
   * `reservedHosts()` at all: that set is derived from this value, so without
   * it the login host is not reserved and a tenant can claim it.
   */
  publicUrl?: string;
  /**
   * How many hostnames the app is routed on.
   *
   * The session cookie is `__Host-`-prefixed and therefore host-only, while
   * routes are emitted per hostname — so a session minted on one hostname does
   * not exist on another, and `computeAppUrl` can name only one origin to
   * redirect back to. A visitor arriving on any other hostname would loop
   * through the login forever, silently teleported off the address they asked
   * for. Refusing is the smaller, honest slice; per-hostname origins can come
   * later.
   */
  hostnameCount?: number;
  /**
   * Whether DROP's own API port is usable. `forward_auth 127.0.0.1:NaN` fails
   * to parse the WHOLE Caddyfile, so every site on the box loses its config at
   * the next Caddy start. Slice 0's inline `apiPortUsable` check covered the
   * MCP guard only.
   */
  apiPortUsable?: boolean;
  /**
   * Whether the app's name is safe to interpolate into a Caddyfile literal.
   * Folder-dropped names are validated only weakly, while the API's strict
   * pattern applies to API-created apps — so a name carrying a space or a
   * brace produces an unparseable directive and Caddy rejects the entire
   * config. The gate adds two more interpolation sites, so it checks.
   */
  appNameSafe?: boolean;
}

/** A machine-readable reason a gate cannot be enforced. */
export type AccessGateBlocker =
  | 'isolation-not-docker'
  | 'auth-disabled'
  | 'no-https'
  | 'tenant-network-shared'
  | 'monorepo-group-child'
  | 'monorepo-group-container'
  | 'no-public-url'
  | 'multi-hostname'
  | 'api-port-unusable'
  | 'invalid-app-name';

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
  'no-public-url':
    'this platform has no public URL configured, so there is nowhere to send a visitor to sign ' +
    'in — a gate here would make the app unreachable rather than protected, and the login host ' +
    'would not be reserved against tenants claiming it',
  'multi-hostname':
    'the app is routed on more than one hostname: the session cookie is host-only, so a visitor ' +
    'arriving on any hostname but the primary one would be redirected to the primary and loop ' +
    'forever on the address they actually asked for',
  'api-port-unusable':
    'DROP\'s API port is not usable, and a guard pointing at it would produce a Caddyfile that ' +
    'fails to parse — taking every site on this box down with it, not just this app',
  'invalid-app-name':
    'the app name cannot be safely written into a Caddy directive, and an unparseable directive ' +
    'rejects the entire configuration for every site on this box',
};

/**
 * Whether this build can actually ENFORCE an access gate.
 *
 * TRUE as of Slice 1b: the `forward_auth` emitter, the verify endpoint and the
 * code exchange all exist, so an app whose verdict is `enforceable` and whose
 * configuration Caddy ACCEPTED really is gated.
 *
 * It stays a constant rather than being deleted because it is what every
 * affirmative signal is gated on — `enforced` on the policy route,
 * `accessGateUnapplied` on the app's state. While it was `false` those all
 * reported "recorded, not enforced", which was the truth for that build. If a
 * future change ever removes the emitter, flipping this back is what keeps the
 * API honest instead of leaving it claiming a control that is gone.
 */
export const ACCESS_GATE_ENFORCEMENT_AVAILABLE = true;

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
  // Each of these four is a way for a gate to be emitted in front of an app it
  // then makes UNREACHABLE, rather than merely unprotected — the failure mode
  // the whole assessment exists to keep out, arrived at from four directions
  // that Slice 0 had no input for.
  if (!ctx.publicUrl) blockers.push('no-public-url');
  if ((ctx.hostnameCount ?? 1) > 1) blockers.push('multi-hostname');
  if (ctx.apiPortUsable === false) blockers.push('api-port-unusable');
  if (ctx.appNameSafe === false) blockers.push('invalid-app-name');

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

/** How far an emitted configuration got toward Caddy actually running it. */
export type ReloadOutcome = 'ok' | 'failed' | 'skipped';

/**
 * Whether an app's access gate is ACTUALLY in force right now.
 *
 * Three independent conditions, and it is a named function rather than an
 * inline `&&` chain because the inline version was untestable: with
 * `ACCESS_GATE_ENFORCEMENT_AVAILABLE` false, every combination of the other
 * two collapses to the same answer, so a test driving the platform could not
 * tell a correct reload check from a missing one. Mutating the reload term
 * left the suite green. Here all combinations are reachable.
 *
 *  - the box CAN enforce a gate (`assessAccessGate`);
 *  - this build HAS an emitter at all;
 *  - and Caddy ACCEPTED the configuration carrying it. A rejected `/load`
 *    returns false rather than throwing, so without this term the platform
 *    recorded "applied" for a config Caddy refused, leaving the previous
 *    ungated block live. `skipped` is not success either — the boot path
 *    batches reloads, so nothing has reached Caddy at that point.
 */
export function isGateApplied(opts: {
  enforceable: boolean;
  enforcementAvailable: boolean;
  reloadOutcome: ReloadOutcome;
}): boolean {
  return opts.enforceable && opts.enforcementAvailable && opts.reloadOutcome === 'ok';
}

/** The refusal message for a route or a log line, from a verdict. */
export function describeAccessGateRefusal(appName: string, verdict: AccessGateVerdict): string {
  return (
    `A browser access gate cannot be enforced for '${appName}': ` +
    verdict.reasons.map((r, i) => `(${i + 1}) ${r}`).join('; ')
  );
}
