/**
 * Shared authorization helpers used across route files: ownership/access
 * checks for app-scoped routes, plus the interactive-session-only guard for
 * routes that must never be reachable with an API key or OAuth token.
 */

import { AuthContext } from './middleware/auth';
import { AppState } from '../managers/app/state-manager';
import { scopesAllow, AgentVerb } from './agent-scopes';
import type { AppAccessPolicy } from '../managers/app/app-config';
import type { AppSessionIdentity, AppGuestIdentity } from './app-access/session-token';
import { GUEST_ID_PREFIX } from '../managers/app-guest/types';

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

  return evaluateAccessPolicy({ kind: 'account', userId: auth.userId, role: auth.role }, app, policy);
}

/**
 * The same rule, for a visitor holding a GATED APP'S OWN SESSION rather than a
 * control-plane credential.
 *
 * A separate exported function, deliberately not an overload of `canOpen`. An
 * overload resolves to one implementation signature over a union and has to
 * discriminate at runtime (`'appName' in identity`) — and the branch it would
 * pick for a session is precisely the one that skips `canOpen`'s
 * credential-class clause. `AppSessionIdentity` is structurally disjoint from
 * `AuthContext` today, but excess-property checking only fires on fresh object
 * literals, so "disjoint as declared" is not something a runtime discriminator
 * can rely on. Two entry points, one shared evaluator, no discrimination.
 *
 * `appName` is checked here as well as in the token verifier. That is defence
 * in depth of the kind `canAccessScoped` already argues for: both halves of a
 * binding belong at the authorization boundary rather than resting on
 * admission having been strict.
 */
export function canOpenSession(
  session: AppSessionIdentity,
  app: Pick<AppState, 'userId'>,
  policy: AppAccessPolicy,
  appName: string
): boolean {
  // A session minted for a different app is not a session for this one, even
  // though the signature verified — the verifier binds it too, and this is the
  // second half of that pair.
  if (session.appName !== appName) return false;
  // The same refusal `canOpen` makes on its own path. `AppSessionIdentity.role`
  // is typed as a real role, but it is read LIVE from the credentials file with
  // no runtime narrowing — and this file's own argument for two entry points is
  // that "disjoint as declared" is not something to rely on at runtime.
  if (session.role === ('none' as string)) return false;
  return evaluateAccessPolicy(
    { kind: 'account', userId: session.userId, role: session.role },
    app,
    policy
  );
}

/**
 * The THIRD entry point: a visitor holding a GUEST session (DROP-155).
 *
 * A guest is not a low-privilege account, and this is not `canOpenSession`
 * with a weaker role. `AppGuestIdentity` carries no `role` field at all, so
 * there is no value to pass into the admin/owner clauses — the guest is
 * admitted by `policy.guests` membership or not at all, and the evaluator
 * below makes that structural rather than a discipline every future policy
 * clause has to remember.
 *
 * WHAT THIS CHECKS AND WHAT IT DELIBERATELY DOES NOT
 *
 * It checks the app BINDING (the identity's own `appName` against the app
 * being opened) and POLICY membership. It does NOT re-read the guest record
 * to re-assert `disabled` / `credentialsInvalidBefore`, and that is a
 * decision rather than an oversight:
 *
 *  - `verifyAppGuestSessionToken` already re-reads the record live on every
 *    single request and refuses a disabled or invalidated guest there. That
 *    is the same posture `canOpenSession` rests on for a user, whose `role`
 *    is likewise read live by the verifier and simply trusted here.
 *  - The line this file draws is BINDINGS here, RECORD STATE at the
 *    verifier. `canAccessScoped`'s "both halves of a binding belong at the
 *    authorization boundary" argument is about bindings — scope-to-app,
 *    session-to-app — not about record liveness. Re-reading only in the
 *    guest arm would put the two arms on different footings for no gain: a
 *    second read at a slightly later instant is not more current, only
 *    differently stale.
 *
 * So the invariant a caller must hold up is exactly the one the verifier
 * already enforces: an `AppGuestIdentity` value must only ever come from
 * `verifyAppGuestSessionToken`. It is not constructible from request input
 * anywhere in this codebase, and it must not become so.
 */
export function canOpenGuestSession(
  guest: AppGuestIdentity,
  policy: AppAccessPolicy,
  appName: string
): boolean {
  // The second half of the app binding, exactly as `canOpenSession` does it:
  // the verifier binds the token's `app` claim AND the guest record's own
  // `appName`, and this is the authorization boundary re-asserting it rather
  // than trusting that admission was strict.
  if (guest.appName !== appName) return false;
  return evaluateAccessPolicy({ kind: 'guest', guestId: guest.guestId }, undefined, policy);
}

/**
 * The principal, as the shared evaluator sees it.
 *
 * A DISCRIMINATED UNION, so the admin and owner clauses are unreachable for
 * a guest BY CONSTRUCTION rather than by every clause remembering to ask.
 * The alternative shape — one principal object with an optional `role` and
 * an optional `guestId` — is what makes a future policy field ("also admit
 * anyone with role >= X") silently apply to guests too, because nothing in
 * the type stops it.
 */
type AccessPrincipal =
  | { kind: 'account'; userId: string | undefined; role: 'admin' | 'user' | 'readonly' | 'none' }
  | { kind: 'guest'; guestId: string };

/**
 * The rule all three entry points share, dispatching on the principal's own
 * discriminant.
 *
 * `app` is `undefined` for a guest and that is not a convenience: there is no
 * owner clause on the guest arm to feed it to. Typing it as optional here
 * rather than threading a synthetic `{ userId: undefined }` through keeps
 * "a guest has no ownership question" visible in the signature.
 *
 * Each arm receives only the SLICE of the policy it is allowed to read —
 * `Pick<…,'allow'>` for an account, `Pick<…,'guests'>` for a guest. That is
 * what makes "a guest cannot be admitted by an `allow` entry" a compile
 * error rather than a code-review promise, in both directions.
 */
function evaluateAccessPolicy(
  principal: AccessPrincipal,
  app: Pick<AppState, 'userId'> | undefined,
  policy: AppAccessPolicy
): boolean {
  if (principal.kind === 'guest') return guestAdmitted(principal.guestId, policy);
  return accountAdmitted(principal.userId, principal.role, app, policy);
}

/**
 * Admin, or owner, or explicitly allowed.
 *
 * `userId` is typed as a required string on both account callers and is NOT
 * always one at runtime — the `DROP_API_KEY` and `cli-local` principals are
 * ownerless and a monorepo group child has no `AppState.userId` — so two
 * `undefined`s must never compare equal into an admission.
 */
function accountAdmitted(
  userId: string | undefined,
  role: 'admin' | 'user' | 'readonly' | 'none',
  app: Pick<AppState, 'userId'> | undefined,
  policy: Pick<AppAccessPolicy, 'allow'>
): boolean {
  if (role === 'admin') return true;
  if (userId !== undefined && app?.userId === userId) return true;
  return userId !== undefined && policy.allow.includes(userId);
}

/**
 * Membership in `policy.guests`, and nothing else. No owner clause, no admin
 * clause, no `allow` — a guest holds exactly one grant, on exactly one app.
 *
 * The `guest:` prefix is re-asserted HERE, not merely relied on from the
 * store. `isValidGuestRecord` refuses to LOAD a record whose id lacks it, so
 * a real guest id always carries it; what this closes is the other
 * direction — a `guests` array that somehow came to hold a bare DROP user id
 * (a hand-edited config, a future writer that forgets to namespace) must not
 * admit anything. The namespacing guarantee in `types.ts` is only worth
 * having if the authorization boundary depends on it rather than assuming it.
 */
function guestAdmitted(guestId: string, policy: Pick<AppAccessPolicy, 'guests'>): boolean {
  if (!guestId.startsWith(GUEST_ID_PREFIX)) return false;
  return (policy.guests ?? []).includes(guestId);
}
