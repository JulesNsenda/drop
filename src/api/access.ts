/**
 * Shared ownership/access checks for app-scoped routes.
 */

import { AuthContext } from './middleware/auth';
import { AppState } from '../managers/app/state-manager';
import { scopesAllow, AgentVerb } from './agent-scopes';

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
  if (auth?.role === 'none') {
    return scopesAllow(auth.scopes, appName, verb) && canAccess(auth, app);
  }
  return canAccess(auth, app);
}
