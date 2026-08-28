/**
 * Shared limits and guards for the DROP-152/153 access-gate route surface —
 * admin `/apps/:name/access` (apps.ts) and owner `/apps/:name/share`
 * (apps.share.ts).
 *
 * A leaf module, deliberately: `apps.ts` mounts `apps.share.ts` via
 * `apps.route(...)` (so `apps.use('/:name/*', validateAppName())` covers the
 * share routes too), which means `apps.ts` imports `apps.share.ts`. If
 * `apps.share.ts` imported these three symbols back from `apps.ts` instead of
 * from here, that would close a require cycle under CommonJS — one that
 * survives only while every shared symbol happens to be read inside a
 * handler body (never at module scope), and whose first module-level read
 * (e.g. `MAX_ACCESS_ALLOW_ENTRIES` in a top-level `const`) would silently
 * resolve to `undefined` instead of throwing. Both route files import from
 * here instead; `describeAccessGateRefusal` comes from
 * `guardrail/access-gate.ts` directly, as `apps.ts` already does.
 */

import { isAuthEnabled } from '../middleware/auth';

/**
 * Cap on an access-gate allow-list (DROP-152), now also the DROP-153 product
 * ceiling on how many people an app can be shared with.
 *
 * A bound, not incidental: every id is validated against the credential
 * store on write, so a large list is a large number of lookups on a request
 * a `user`-role owner now controls, not just an admin. A governance
 * allow-list that genuinely needs more than this is a group, and groups are
 * the next slice.
 */
export const MAX_ACCESS_ALLOW_ENTRIES = 200;

/**
 * The same number, under the name that describes what DROP-155 made it bound.
 *
 * `MAX_ACCESS_ALLOW_ENTRIES` still means exactly what it says at its ONE
 * remaining `allow`-only call site: the admin `PUT /apps/:name/access` route
 * validating the length of an `allow` array in a request body.
 *
 * `/apps/:name/share` bounds something else now — `allow.length +
 * guests.length`, one cap on PEOPLE WITH ACCESS, because two independent caps
 * would let an owner admit twice as many by alternating between the lists.
 * Reading `MAX_ACCESS_ALLOW_ENTRIES` there invited the next person raising the
 * user allow-list to raise the guest ceiling without noticing, and left
 * `access-limits.ts` describing a bound it no longer only holds.
 *
 * An alias rather than a rename: renaming would have made the `apps.ts` use
 * site wrong instead, which is not an improvement.
 */
export const MAX_ADMITTED_PRINCIPALS = MAX_ACCESS_ALLOW_ENTRIES;

/**
 * Per-entry cap. Ids are UUIDs; the bound exists so an unvalidated string
 * cannot be echoed into the refusal message, the error log and a persisted
 * YAML file at body-size scale.
 */
export const MAX_USER_ID_LENGTH = 128;

/**
 * Guard shared by every `/access` and `/share` handler.
 *
 * The admin role floor for `/access` (and the `user` floor for `/share`) is
 * applied in `server.ts`, but that registration lives inside
 * `if (this.config.enableAuth && isAuthEnabled())` — so on an auth-disabled
 * box no middleware is registered for these paths at all and these handlers
 * are the only thing standing between an anonymous caller and an app's
 * allow-list (a set of real DROP user ids) or, on a DELETE, removal of a
 * governance policy. This is the `interactiveSessionOnly` posture, restated
 * for the same reason it had to be restated there.
 */
export function requireAuthForAccessRoutes(): string | null {
  if (!isAuthEnabled()) {
    return 'Access-gate policy is unavailable when authentication is disabled.';
  }
  return null;
}
