/**
 * The claude.ai MCP connector policy gate (DROP-131).
 *
 * Lives in its own module for one structural reason: it is consumed from BOTH
 * `routes/oauth.ts` (the mint paths) and `middleware/auth.ts` (the verify and
 * refresh-rotation paths), and `routes/oauth.ts` already imports heavily from
 * `middleware/auth.ts`. Putting the helper in either of those files makes the
 * pair cyclic. A cycle that happens to work — because every call site reads
 * the binding at request time rather than at module-evaluation time — is a
 * latent trap for whoever next moves an import to the top level, so the
 * dependency is broken here instead of relied upon. This module imports only
 * the settings manager, so nothing can import its way back into it.
 *
 * (It is deliberately NOT in `access.ts`: that module holds pure predicates
 * over an AuthContext and an app record, and imports no runtime managers.)
 */

import { getSettingsManager } from '../managers/settings/settings-manager';

/**
 * Whether `role` may use claude.ai MCP connectors on this installation —
 * the multi-user-connectors admin toggle (`userConnectorsEnabled`).
 *
 * `admin` is never gated by its own switch: an admin who flips the toggle OFF
 * must not be able to lock themselves out of the connector they would need in
 * order to flip it back. Every other role defers to the operator setting, read
 * PER CALL — never cached in a module-scope const or in `ApiRuntimeConfig` —
 * so the admin UI's toggle takes effect without a restart.
 *
 * The `role === 'admin'` string comparison is the SAFE direction for a role
 * check (unlike the `roleHierarchy[role] ?? 0` lookup DROP-130 flagged): an
 * unrecognized or malformed role fails this equality and falls through to the
 * setting, i.e. the MORE restrictive branch.
 *
 * Note the failure mode this inherits from `getUserConnectorsEnabled()`: a
 * settings file that exists but does not parse reads as `false`, so a corrupt
 * store disables non-admin connectors platform-wide rather than silently
 * re-enabling them. That is deliberate — see `settings-manager.ts`.
 *
 * Enforced at five sites, cross-referenced here so a sixth grant path's author
 * sees the invariant:
 *   1. `POST /oauth/approve`                      (routes/oauth.ts)
 *   2. `/token`, `grant_type=authorization_code`  (routes/oauth.ts)
 *   3. `rotateRefreshToken`, PRE-SPLICE           (middleware/auth.ts)
 *   4. `verifyOAuthAccessToken`                   (middleware/auth.ts)
 *   5. `verifyAppMcpAccessToken`                  (middleware/auth.ts)
 *
 * Sites 4 and 5 are what collapse the enforcement window to zero with no new
 * durable store: both already re-read the user record on every call for
 * revocation, so the toggle bites immediately rather than after an access
 * token's 15-minute TTL. Site 3's placement is load-bearing — see its own
 * comment.
 */
export function mayUseConnectors(role: string | undefined): boolean {
  if (role === 'admin') return true;
  return getSettingsManager().getUserConnectorsEnabled();
}
