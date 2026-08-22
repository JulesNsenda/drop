/**
 * Shared authorization helpers used across route files: ownership/access
 * checks for app-scoped routes, plus the interactive-session-only guard for
 * routes that must never be reachable with an API key or OAuth token.
 */

import { AuthContext } from './middleware/auth';
import { AppState } from '../managers/app/state-manager';
import { scopesAllow, AgentVerb } from './agent-scopes';
import type { AppAccessPolicy } from '../managers/app/app-config';

/**
 * Whether the current request may access an app: owns it, is an admin, or
 * auth is disabled platform-wide. Used by every app-scoped route so a user
 * cannot read or mutate another tenant's app, logs, or secrets (IDOR).
 */
export function canAccess(auth: AuthContext | undefined, app: Pick<AppState, 'userId'>): boolean {
  if (!auth) return true; // No auth enabled
  if (auth.role === 'admin') return true;
  return app.userId === auth.userId;
}

/**
 * Ownership check for the boundaries that accept AGENT tokens.
 *
 * A SIBLING of `canAccess`, deliberately not a widening of it. Three reasons:
 *
 *  - `canAccess` has no app NAME in its signature — it takes
 *    `Pick<AppState,'userId'>`, and `deploys.ts` passes a synthetic `{userId}`
 *    with no name at all. A scope grammar keyed on names cannot live there.
 *  - `canAccess` has 27 non-test call sites. Widening it would put an agent
 *    token in front of every one of them, including routes that were never
 *    meant to accept one.
 *  - Leaving it untouched keeps the existing `*.authz.test.ts` files a valid
 *    regression net for the behaviour they were written to pin.
 *
 * So this is called ONLY at the few boundaries that opt in.
 *
 * A rank-0 agent token is admitted purely on an exact scope match. Everyone
 * else falls through to the ordinary ownership rule, unchanged.
 */
export function canAccessScoped(
  auth: AuthContext | undefined,
  app: Pick<AppState, 'userId'>,
  appName: string,
  verb: AgentVerb
): boolean {
  // A scope-only principal has NO role standing, so it can never satisfy
  // canAccess below. Its entire authority is the exact scope match — and it
  // must ALSO own the app, so a scope that outlived a transfer grants nothing.
  //
  // `kind === 'agent'` is checked HERE as well as at the MCP gate, so both
  // halves of the SEC-5 pair live at the authorization boundary rather than
  // relying on admission having been strict. Containment would otherwise rest
  // on facts outside this file — that GRANTABLE_API_SCOPES stays a closed
  // allowlist, and that no scoped boundary is ever mounted behind a role-less
  // gate. Either could change without anyone touching this line.
  if (auth?.role === 'none') {
    return (
      auth.kind === 'agent' && scopesAllow(auth.scopes, appName, verb) && canAccess(auth, app)
    );
  }
  return canAccess(auth, app);
}

/**
 * Guard for self-service ACCOUNT routes — the ones that act on the caller's own
 * credentials rather than on a resource.
 *
 * Resolving `AuthContext.userId` to a key's `ownerUserId` means a key now acts
 * AS its owner. For app/resource routes that is the point. For these routes it
 * is not: an API key is a credential handed to a CI job or a deployed app, and
 * it must not be able to change, disable or re-enrol the human's own login
 * factors — a leaked low-privilege key would otherwise convert into full
 * account takeover. Each of these routes also compares a caller-supplied secret
 * (password, TOTP code) and reports the mismatch, so without this guard they
 * are online guessing oracles against the owner reachable with any key.
 *
 * Before ownership resolution these were accidentally inert: a key's id is
 * never in `credentials.users`, so every lookup missed. The containment was a
 * side effect of the bug, so it has to be restated as a decision.
 *
 * Fails CLOSED when auth is disabled. There is no principal at all in that
 * mode (`authMiddleware` calls `next()` without setting a context), so
 * `authMethod` cannot be evaluated and `userId` is `undefined` — the routes
 * previously threw a TypeError into a 400 body. A single-operator box has no
 * account to service here anyway.
 *
 * Also used to close the read paths of the database panel (DROP-120): on an
 * auth-disabled box `canAccess(undefined, app)` returns `true`, so without
 * this guard those GETs would be anonymous, network-reachable disclosure of
 * every app's schema; and it closes the DROP-075 gap (an API key's role is
 * never clamped to its owner's) for those routes too.
 */
export function interactiveSessionOnly(
  requester: AuthContext | undefined,
  action: string
): { ok: true; requester: AuthContext } | { ok: false; message: string } {
  if (!requester) {
    return { ok: false, message: `${action} is unavailable when authentication is disabled.` };
  }
  if (requester.authMethod !== 'jwt') {
    return {
      ok: false,
      message: `${action} requires an interactive session. API keys and OAuth tokens cannot be used.`,
    };
  }
  return { ok: true, requester };
}

/**
 * Whether the current request may OPEN an app in a browser — the ACCESS
 * question, as distinct from the management question `canAccess` answers
 * (DROP-152).
 *
 * A SIBLING of `canAccess`, deliberately not a widening of it, for the same
 * reason `canAccessScoped` is: `canAccess` has 34 non-test call sites, all of
 * them management boundaries, and the existing `*.authz.test.ts` files are a
 * valid regression net only while its behaviour is untouched.
 *
 * It does NOT inherit `canAccess`'s `if (!auth) return true`. That posture is
 * defensible for a single-operator box's management API, where the operator IS
 * the only principal; it is indefensible for a gate whose entire product claim
 * is "only these people can open this app". With no auth context there is no
 * identity to compare, so the answer is no. `interactiveSessionOnly` had to
 * restate exactly this, having found that copying `canAccess`'s posture was
 * wrong there too — this is the third boundary where it would have been.
 *
 * The route that SETS a policy refuses outright when auth is disabled, so this
 * fail-closed branch should be unreachable in a correctly configured platform.
 * It is not the enforcement point of that refusal — it is what makes a
 * misconfiguration deny rather than admit.
 *
 * `policy` is REQUIRED, and that is a deliberate type-level invariant rather
 * than a convenience. This is reached only through the `forward_auth` on a
 * gated app's Caddy block, so at that point "no policy" never means "not
 * gated" — it means the config lookup MISSED on an app Caddy has already said
 * is gated (service not initialized, a name that no longer resolves, a
 * `deleteConfig` racing the request). An optional parameter that answered
 * `true` for `undefined` would turn every one of those into an open door.
 * The caller resolves the policy and refuses when it cannot, exactly as
 * `mcp-gateway.ts` re-asserts `source: 'declared' && auth: 'drop'` live rather
 * than trusting that Caddy would not have routed it otherwise.
 */
export function canOpen(
  auth: AuthContext | undefined,
  app: Pick<AppState, 'userId'>,
  policy: AppAccessPolicy
): boolean {
  if (!auth) return false; // Fails CLOSED — see above.

  // A BROWSER SESSION, or nothing. `interactiveSessionOnly` exists in this
  // file because "a role alone does not distinguish an agent token from a
  // session", and the same is true here for a harder reason: `forward_auth`
  // proxies the ORIGINAL request to the verify hop, so a tenant-controlled
  // `Authorization` / `X-Api-Key` header arrives with it unless stripped by
  // name in the generated Caddy block. Without this clause an admin-role API
  // key opens every gated app, and the scoped `DROP_API_KEY` DROP itself
  // injects into a tenant app — which resolves to its owner's user id —
  // satisfies the owner clause of a gate that owner set.
  //
  // `authMethod === 'jwt'` is the fail-closed choice, not a prediction: the
  // session the gate mints is a jose-signed token and surfaces as `jwt`. If a
  // later change gives it a distinct method, this refuses until someone
  // widens it deliberately, which is the direction an authorization check
  // should fail in.
  if (auth.authMethod !== 'jwt' || auth.role === 'none' || auth.kind === 'agent') return false;

  if (auth.role === 'admin') return true;
  // `userId` is a required `string` on the type and NOT always one at runtime:
  // the `DROP_API_KEY` and `cli-local` principals are ownerless, and a
  // monorepo group child has no `AppState.userId` at all. Two `undefined`s
  // must not compare equal into an admission. The clause above already
  // excludes those principals; this stays because the reason it was written
  // is a fact about the data, not about the credential class.
  if (auth.userId !== undefined && app.userId === auth.userId) return true;
  return auth.userId !== undefined && policy.allow.includes(auth.userId);
}
