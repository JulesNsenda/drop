/**
 * Owner-initiated app sharing (DROP-153).
 *
 * `/apps/:name/access` (apps.ts) is admin-only: the person who deployed an
 * app has no way to grant anyone else access to it. These four routes let
 * the OWNER do that themselves, within limits that keep the admin-authored
 * governance list (DROP-152) intact and untouchable by the party it governs.
 *
 * Mounted onto `apps` (apps.ts) via `apps.route('/', shareRoutes)` rather
 * than a second `v1.route('/apps', …)` in server.ts — that would bypass
 * `apps.use('/:name/*', validateAppName())`, the defense-in-depth check that
 * stops a malformed name reaching path/YAML construction below.
 *
 * Every route shares five refusals, applied in the same order, factored into
 * `resolveShareRequest` below (Gate 2 finding: this preamble used to be
 * copy-pasted ~35 lines per handler, in an order only a prose comment
 * enforced):
 *
 *  1. `requireAuthForAccessRoutes()` — on an auth-disabled box no role
 *     middleware is registered for these paths at all (server.ts wires it
 *     only inside `if (enableAuth && isAuthEnabled())`), so this handler
 *     check is the only thing standing between an anonymous caller and a
 *     real DROP user id.
 *  2. `interactiveSessionOnly` — a BROWSER SESSION, or nothing. DROP injects
 *     a scoped `DROP_API_KEY` into every tenant container that resolves to
 *     the app's OWNER; without this, a deployed app could grant (or revoke)
 *     access to itself.
 *  3. `canAccess` — non-owner (and non-admin) is a 404, matching every other
 *     app-scoped route in apps.ts. No existence oracle for a stranger.
 *  4. The `appSharingEnabled` platform toggle, read LIVE via
 *     `getSettingsManager()` on every request — never a `runtime-config`
 *     snapshot, which would reintroduce the restart-to-flip-a-toggle problem
 *     that seam exists to avoid for an admin-settable value.
 *  5. `PlatformOps` availability.
 *
 * `isAppInProgress` is deliberately NOT folded into `resolveShareRequest`:
 * GET never checks it (a read must not race-refuse), so each WRITE handler
 * calls it itself, immediately after resolving — keeping that divergence
 * visible at the call site instead of hidden inside a shared function that
 * one route quietly opts out of. The POST-only enforceability 409 stays out
 * for the same reason: it is per-route policy, not a shared precondition.
 *
 * Provenance (`AppAccessPolicy.grantedBy`) is what makes an OWNER-reachable
 * write safe against the admin-authored governance list `server.ts` states
 * the rule about: `evaluateAccessPolicy` never reads it, so it cannot widen
 * or narrow who may open the app — only who may administer their own entry.
 * An id present in `allow` but absent from `grantedBy` is ADMIN-authored,
 * and every write below either respects that or refuses. Ownership of an
 * entry is decided against the REQUESTER (whoever is calling, owner or
 * admin), not against the app's owner specifically — an admin who grants
 * through this route administers that grant the same way an owner would
 * administer theirs (Gate 2 finding: the clear-all route used to check
 * "does `grantedBy` have any value at all", which let it destroy an
 * admin-authored entry that the single-entry revoke correctly refuses).
 *
 * A grant target that cannot be granted access — nonexistent, the app's own
 * owner, an admin, or suspended — is refused with ONE generic message and
 * status (`refuseGrantTarget` below), never four distinct ones. `listUsers`
 * is admin-only precisely because that data is not for a mere app owner, and
 * the four distinct messages let any owner of any app use this route as an
 * account-existence/role/suspension oracle against arbitrary usernames. The
 * specific reason is still recorded server-side (`console.warn`) for anyone
 * debugging a refusal report — never in the response.
 *
 * Re-emission (`ops.reconfigureRoute`) is deliberately NOT called on every
 * write, unlike the admin `/access` routes. The `/verify` hop
 * (`app-access.ts`) reads the policy LIVE, so an allow-list edit on an
 * already-applied gate needs no Caddy reload at all — and this route is
 * reachable by a plain `user`-role owner, so triggering the estate-wide
 * routing reload on every grant/revoke would move real blast radius to that
 * role for no benefit. Each write route re-emits only when:
 *   - the policy just transitioned PRESENCE (created out of nothing, or —
 *     clear only — cleared to nothing): the Caddy block itself has to be
 *     added or removed, and the verify hop can't paper over "does a guard
 *     exist at all"; or
 *   - `AppState.accessGateUnapplied` is already `true`: the platform's own
 *     record that the last emission never reached Caddy, so this write is
 *     the operator's only retry (`handleConfigureRoute` swallows its own
 *     failures and returns normally — CORR-3).
 *
 * Every closure below signals its outcome out of `setAccessPolicy`'s updater
 * via a mutable REF OBJECT, not a bare `let`: TS's control-flow analysis
 * does not see assignments made inside a callback, so a bare
 * `let outcome: Union = 'x'` stays narrowed to the literal `'x'` for every
 * read after the call, regardless of what the closure actually assigned (a
 * static-analysis gap, not a runtime one — the closure's mutations are real;
 * only compile-time narrowing wrongly ignores them). One idiom, file-wide,
 * so a reader never has to ask which pattern a given handler picked.
 * Deciding what to write ALSO happens entirely inside the closure — never
 * from a snapshot read before it (e.g. a pre-fetched `getConfig(name)`) —
 * because `enqueueWrite` invokes the updater at write EXECUTION time, and a
 * concurrent write for the same app between the snapshot and the execution
 * is exactly how an admin's `DELETE /access` clearing a policy got silently
 * undone by an owner's in-flight `POST /share` (Gate 2 finding).
 *
 * Every refusing updater below returns `NO_CHANGE` (`app-config.ts`), never a
 * copy of `current`/`existing.access` — that sentinel is what lets `write()`
 * detect a no-op and skip `saveConfig` entirely, so a refused grant/revoke/
 * clear does not rewrite the app's YAML or occupy its write chain.
 */

import { Hono, type Context } from 'hono';
import { success, error, ErrorCodes } from '../types';
import { NotFoundError, ValidationError } from '../middleware/error';
import { AuthContext, getUser, getUserById, type SafeUser } from '../middleware/auth';
import { canAccess, interactiveSessionOnly } from '../access';
import { getPlatformOps, type PlatformOps } from '../platform-ops';
import { getStateManager, type AppState } from '../../managers/app/state-manager';
import {
  getAppConfigService,
  getAppConfigServiceOrNull,
  NO_CHANGE,
  type AppAccessPolicy,
} from '../../managers/app/app-config';
import { getSettingsManager } from '../../managers/settings/settings-manager';
import { logActivityFor } from '../../managers/activity';
import { ACCESS_GATE_ENFORCEMENT_AVAILABLE } from '../../managers/guardrail/access-gate';
import { MAX_ACCESS_ALLOW_ENTRIES, MAX_USER_ID_LENGTH, requireAuthForAccessRoutes } from './access-limits';

const shareRoutes = new Hono();

/**
 * Whether owner-initiated sharing is enabled at all right now.
 *
 * Read live on every call — see the file header on why this is a
 * `getSettingsManager()` read rather than a `runtime-config` accessor.
 */
function sharingDisabledRefusal(): string | null {
  if (!getSettingsManager().getAppSharingEnabled()) {
    return 'Owner-initiated app sharing is disabled on this platform.';
  }
  return null;
}

/** The message used for both a genuinely nonexistent target and a stale write. */
function stillDeployingResponse(name: string) {
  return error(
    ErrorCodes.CONFLICT,
    `Application '${name}' is still being deployed — try again once it has finished.`
  );
}

/**
 * Whether a gate is actually ENFORCED for this app right now — as opposed to
 * whether the box could enforce one. A persisted policy on a build with no
 * guard emitter is a record, not a control (Gate 2 finding: the previous
 * `gated` field answered only "is there a policy?", the exact read the kill
 * switch exists to eliminate).
 *
 * A deliberate DUPLICATE of `gateEnforced` in apps.ts, not an import from
 * it: apps.ts imports THIS file (`apps.route('/', shareRoutes)`), so
 * importing the function back out of apps.ts would close a require cycle —
 * `access-limits.ts`'s own header documents why this pair of route files
 * shares constants through a leaf module instead. Both copies read the same
 * `ACCESS_GATE_ENFORCEMENT_AVAILABLE` constant from `guardrail/access-gate`,
 * so they cannot drift on the one part of the predicate that could change.
 */
function gateEnforced(verdict: { enforceable: boolean }, hasPolicy: boolean): boolean {
  return hasPolicy && verdict.enforceable && ACCESS_GATE_ENFORCEMENT_AVAILABLE;
}

/** The caller's own grants (id + username) plus a COUNT of everyone else's. */
function ownView(
  access: AppAccessPolicy | undefined,
  requesterUserId: string
): { ownGrants: { userId: string; username?: string }[]; othersGrantedCount: number } {
  const grantedBy = access?.grantedBy ?? {};
  const ownGrants: { userId: string; username?: string }[] = [];
  let othersGrantedCount = 0;
  for (const id of access?.allow ?? []) {
    if (grantedBy[id] === requesterUserId) {
      ownGrants.push({ userId: id, username: getUserById(id)?.username });
    } else {
      othersGrantedCount += 1;
    }
  }
  return { ownGrants, othersGrantedCount };
}

type GrantIneligibleReason = 'unknown-user' | 'owner' | 'admin' | 'suspended';

/** The one rule POST re-applies twice: a pre-check (fast path) and, authoritatively, inside the write closure. */
function grantIneligibleReason(
  user: SafeUser | null,
  ownerId: string | undefined
): GrantIneligibleReason | null {
  if (!user) return 'unknown-user';
  if (ownerId !== undefined && user.id === ownerId) return 'owner';
  if (user.role === 'admin') return 'admin';
  if (user.enabled === false) return 'suspended';
  return null;
}

/**
 * Refuses a grant target without disclosing WHY — see the file header on why
 * the four distinct reasons collapse to one message/status here. The reason
 * is still logged server-side, matching the posture apps.ts's own detach
 * route documents for a refusal that must not echo internals to the caller.
 */
function refuseGrantTarget(name: string, username: string, reason: GrantIneligibleReason): never {
  console.warn(`[apps.share] grant of '${username}' on '${name}' refused: ${reason}`);
  throw new ValidationError(`'${username}' cannot be granted access to '${name}'.`);
}

type ResolvedShareRequest = {
  auth: AuthContext | undefined;
  requester: AuthContext;
  name: string;
  app: AppState;
  ops: PlatformOps;
};

/**
 * Refusals 1-5 from the file header, shared by every /share handler.
 * Returns the resolved request on success, or a Response to return
 * immediately — mirroring `requireOAuthPreconditions` (oauth.ts) rather than
 * `resolveApp` (secrets.ts)'s flag-object form, because these five refusals
 * carry four different statuses/messages and a flag object would just move
 * that dispatch into every caller.
 */
async function resolveShareRequest(c: Context, action: string): Promise<ResolvedShareRequest | Response> {
  const auth = (c.get as (k: string) => AuthContext | undefined)('auth');

  const authRefusal = requireAuthForAccessRoutes();
  if (authRefusal) return c.json(error(ErrorCodes.UNAUTHORIZED, authRefusal), 401);

  const gate = interactiveSessionOnly(auth, action);
  if (!gate.ok) return c.json(error(ErrorCodes.UNAUTHORIZED, gate.message), 403);
  const requester = gate.requester;

  const name = c.req.param('name') as string;
  const app = getStateManager().getApp(name);
  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const disabledRefusal = sharingDisabledRefusal();
  if (disabledRefusal) {
    return c.json(error(ErrorCodes.UNAUTHORIZED, disabledRefusal, { reason: 'sharing_disabled' }), 403);
  }

  const ops = getPlatformOps();
  if (!ops) {
    return c.json(error(ErrorCodes.SERVICE_UNAVAILABLE, 'Platform operations unavailable'), 503);
  }

  return { auth, requester, name, app, ops };
}

// GET /apps/:name/share — the owner's own view of who has access.
//
// Deliberately narrower than admin's GET /access: it returns the CALLER's
// own grants (id + username) plus a COUNT of everyone else's, never their
// ids or usernames (SEC-1/SEC-4) — an owner reading a governance list an
// admin placed on their own app would be exactly the disclosure `grantedBy`
// exists to prevent. It also returns blocker CODES only, never `reasons`:
// those are operator prose (ICC state, a broken API port, an unparseable
// directive taking every site down) that stay behind
// `authMiddleware('admin')` today, and this route is owner-reachable.
shareRoutes.get('/:name/share', async c => {
  const resolved = await resolveShareRequest(c, 'Viewing app sharing');
  if (resolved instanceof Response) return resolved;
  const { requester, name, app, ops } = resolved;

  const access = getAppConfigServiceOrNull()?.getConfig(name)?.access;
  const { ownGrants, othersGrantedCount } = ownView(access, requester.userId);

  const verdict = await ops.assessAccessGate(name);
  const policyPresent = access !== undefined;

  return c.json(
    success({
      policyPresent,
      // What is true of traffic right now, not merely what is on disk — the
      // same distinction admin's GET /access reports, and the read the kill
      // switch exists to make truthful.
      enforced: gateEnforced(verdict, policyPresent),
      ownGrants,
      othersGrantedCount,
      // The platform's own record of whether the last route emission
      // actually installed the guard — without it, an owner whose first
      // share failed to apply has no signal, and the app reads as shared
      // while it actually serves ungated.
      gateApplied: app.accessGateUnapplied === undefined ? null : !app.accessGateUnapplied,
      enforceable: verdict.enforceable,
      blockers: verdict.blockers,
    })
  );
});

// POST /apps/:name/share — grant one person, by username.
//
// `{ username }` ONLY, never `{ email }`: `createUser` enforces no email
// uniqueness and no verification, so an email is not an identifier in this
// codebase — resolving one to an existing account would let an attacker on
// a signup-enabled box register with a colleague's address and receive
// their shares. The `{ email }` branch (guest access) is a later slice.
shareRoutes.post('/:name/share', async c => {
  const resolved = await resolveShareRequest(c, 'Sharing an app');
  if (resolved instanceof Response) return resolved;
  const { auth, requester, name, app, ops } = resolved;
  const isAdminCaller = auth?.role === 'admin';

  // Pre-check, before anything is persisted — same reason the admin PUT
  // /access route pre-checks: a deploy in flight makes the re-emission below
  // throw, and by then the policy would already be on disk.
  if (ops.isAppInProgress(name)) {
    return c.json(
      error(ErrorCodes.CONFLICT, `Application '${name}' has an operation in progress`),
      409
    );
  }

  // Enforceability, POST ONLY — matching the admin PUT /access route's own
  // pre-check. Unlike that route this one is owner-reachable, so the
  // refusal carries blocker CODES only (see the GET handler's own note on
  // why `reasons` never leaves this file for an owner-reachable route).
  const verdict = await ops.assessAccessGate(name);
  if (!verdict.enforceable) {
    // The feature switch and a genuine misconfiguration read very
    // differently to an owner: one names something an admin can flip, the
    // other is a box-level fact the owner cannot act on at all. Collapsing
    // them into one "cannot be enforced" message left both unactionable for
    // the owner and unattributed for the admin who would need to fix it.
    const message = !verdict.featureEnabled
      ? `The browser access gate feature is switched off platform-wide for '${name}' — an administrator must enable it before this app can be shared.`
      : `A browser access gate cannot be enforced for '${name}' right now.`;
    return c.json(error(ErrorCodes.CONFLICT, message, { blockers: verdict.blockers }), 409);
  }

  const body = (await c.req.json().catch(() => ({}))) as { username?: unknown; gateApp?: unknown };
  const username = body.username;
  if (
    typeof username !== 'string' ||
    username.length === 0 ||
    username.length > MAX_USER_ID_LENGTH
  ) {
    throw new ValidationError(`username is required (max ${MAX_USER_ID_LENGTH} chars)`);
  }
  const gateApp = body.gateApp === true;

  // Pre-resolved for a fast, specific refusal. RE-RESOLVED again inside the
  // write closure below — a username can be reassigned, and the id that
  // matters is whichever account holds this username at write time, not at
  // request time (SEC-7's TOCTOU half).
  const precheckReason = grantIneligibleReason(getUser(username), app.userId);
  if (precheckReason) refuseGrantTarget(name, username, precheckReason);

  type GrantOutcome = 'granted' | 'already-granted' | 'cap-exceeded' | 'ineligible' | 'needs-confirmation';
  const grant: {
    outcome: GrantOutcome;
    hadPolicyBefore: boolean;
    ineligibleReason?: GrantIneligibleReason;
    adminAuthoredCount?: number;
  } = { outcome: 'granted', hadPolicyBefore: false };

  const updatedConfig = await getAppConfigService().setAccessPolicy(name, existing => {
    const current = existing.access;
    grant.hadPolicyBefore = current !== undefined;

    // Delegation is symmetric (DROP-153 §3): creating a policy where none
    // exists is an acknowledged act, never a side effect of the first share
    // — otherwise an owner turns their live public app sign-in-only on a
    // mis-click, with only an admin able to undo it. Decided HERE, inside
    // the write closure, reading `current` at write EXECUTION time — not
    // from a snapshot taken before this call — so an admin's `DELETE
    // /access` landing between the request and this write is seen: if it
    // cleared the policy first, `current` is undefined here regardless of
    // what it was when the request arrived, and this still requires
    // `gateApp: true` rather than silently re-installing the guard the
    // admin just removed (Gate 2 finding).
    if (current === undefined && !gateApp) {
      grant.outcome = 'needs-confirmation';
      return NO_CHANGE;
    }

    const liveUser = getUser(username);
    const reason = grantIneligibleReason(liveUser, app.userId);
    if (reason) {
      grant.outcome = 'ineligible';
      grant.ineligibleReason = reason;
      return NO_CHANGE;
    }

    const allow = current?.allow ?? [];
    // Already-granted short-circuits BEFORE the cap — an idempotent re-grant
    // at exactly MAX_ACCESS_ALLOW_ENTRIES entries must still succeed.
    if (allow.includes(liveUser!.id)) {
      grant.outcome = 'already-granted';
      return NO_CHANGE;
    }
    if (allow.length >= MAX_ACCESS_ALLOW_ENTRIES) {
      grant.outcome = 'cap-exceeded';
      // Computed HERE, not from a separate read after the fact, for the
      // same snapshot reason as the `needs-confirmation` branch above.
      // `!== requester.userId`, NOT `=== undefined` — the same distinction
      // fix #1 makes for clear-all. An entry an ADMIN granted via `POST
      // /share` has a real `grantedBy` value, just not the requester's own,
      // so "does grantedBy exist" undercounts exactly the entries an owner
      // cannot remove themselves (Gate 2 finding: this is the same bug fix
      // #1 closed, reappearing here).
      const grantedByMap = current?.grantedBy ?? {};
      grant.adminAuthoredCount = allow.filter(id => grantedByMap[id] !== requester.userId).length;
      return NO_CHANGE;
    }
    return {
      mode: 'drop-users',
      allow: [...allow, liveUser!.id],
      grantedBy: { ...(current?.grantedBy ?? {}), [liveUser!.id]: requester.userId },
    };
  });

  if (!updatedConfig) {
    return c.json(stillDeployingResponse(name), 409);
  }
  if (grant.outcome === 'needs-confirmation') {
    return c.json(
      error(
        ErrorCodes.CONFLICT,
        `'${name}' is not gated yet. Sharing it will make it sign-in-only for everyone else — ` +
          `resend with { "gateApp": true } to confirm.`
      ),
      409
    );
  }
  if (grant.outcome === 'ineligible') {
    refuseGrantTarget(name, username, grant.ineligibleReason!);
  }
  if (grant.outcome === 'cap-exceeded') {
    const adminAuthoredCount = grant.adminAuthoredCount ?? 0;
    // At the cap "remove someone" is impossible advice when the list is
    // admin-heavy — the owner can neither see nor revoke those entries
    // (SEC-1). Name the split instead of a refusal the owner cannot act on.
    const advice =
      adminAuthoredCount > 0
        ? `${adminAuthoredCount} of them granted by an administrator — ask an admin to remove one, or revoke someone you granted yourself.`
        : 'remove someone before adding another.';
    return c.json(
      error(
        ErrorCodes.CONFLICT,
        `'${name}' already has ${MAX_ACCESS_ALLOW_ENTRIES} people with access — ${advice}`
      ),
      409
    );
  }

  let applyError: string | undefined;
  const justCreated = !grant.hadPolicyBefore && grant.outcome === 'granted';
  if (justCreated || app.accessGateUnapplied === true) {
    try {
      await ops.reconfigureRoute(name);
    } catch (err) {
      applyError = err instanceof Error ? err.message : 'Failed to re-emit the route';
    }
  }

  if (grant.outcome === 'granted') {
    // An admin acting through this owner-facing route is audited as such —
    // `requester.userId !== app.userId` means the freshly-stamped
    // `grantedBy` entry is NOT owner-authored, which the three dedicated
    // `access-share-*` actions would otherwise collapse into an
    // indistinguishable owner action (Gate 2 finding).
    const detail =
      isAdminCaller && requester.userId !== app.userId ? `${username} (admin-granted)` : username;
    await logActivityFor(auth, { action: 'access-share-granted', appName: name, detail });
  }

  // The caller's own view only, mirroring GET — never the whole `allow`
  // array. Echoing every id (admin-authored ones included) here would
  // reopen exactly the oracle GET's own `othersGrantedCount` design closes,
  // just on a different route (Gate 2 finding).
  const view = ownView(updatedConfig.access, requester.userId);
  return c.json(
    success({
      // Uniform regardless of whether this was a fresh grant or a re-grant
      // of an existing entry — a distinct "already has access" message let
      // an owner probe allow-list membership one username at a time.
      message: `'${username}' has access to '${name}'.`,
      ownGrants: view.ownGrants,
      othersGrantedCount: view.othersGrantedCount,
      ...(applyError ? { applyError } : {}),
    })
  );
});

// DELETE /apps/:name/share/:userId — revoke one person.
//
// Deliberately NOT gated on enforceability — an operator (here, the owner)
// must always be able to remove a control, including on a box that can no
// longer enforce it; a stale guard may still be live in Caddy.
shareRoutes.delete('/:name/share/:userId', async c => {
  const resolved = await resolveShareRequest(c, 'Revoking an app share');
  if (resolved instanceof Response) return resolved;
  const { auth, requester, name, app, ops } = resolved;
  const isAdminCaller = auth?.role === 'admin';

  if (ops.isAppInProgress(name)) {
    return c.json(
      error(ErrorCodes.CONFLICT, `Application '${name}' has an operation in progress`),
      409
    );
  }

  const targetUserId = c.req.param('userId');
  if (!targetUserId || targetUserId.length > MAX_USER_ID_LENGTH) {
    throw new ValidationError(`Invalid user id (max ${MAX_USER_ID_LENGTH} chars)`);
  }

  const revoke: { removed: boolean; grantor?: string } = { removed: false };
  const updatedConfig = await getAppConfigService().setAccessPolicy(name, existing => {
    const current = existing.access;
    if (!current || !current.allow.includes(targetUserId)) return NO_CHANGE; // nothing to do
    const grantor = current.grantedBy?.[targetUserId];
    if (!isAdminCaller && grantor !== requester.userId) {
      // Owner may revoke only an entry THEY granted. An entry absent from
      // `grantedBy` (or granted by someone else) is admin-authored
      // governance — the owner revoking it is exactly the SEC-1 hole
      // `grantedBy` exists to close. Returned as a plain no-op (same as an
      // absent target below), never a distinct refusal: a 403 here vs a 200
      // for "never had access" is itself a membership oracle against the
      // admin-authored list GET deliberately reduces to a count (Gate 2
      // finding).
      return NO_CHANGE;
    }
    revoke.removed = true;
    revoke.grantor = grantor;
    const nextGrantedBy = current.grantedBy ? { ...current.grantedBy } : undefined;
    if (nextGrantedBy) delete nextGrantedBy[targetUserId];
    return {
      ...current,
      allow: current.allow.filter(id => id !== targetUserId),
      grantedBy: nextGrantedBy,
    };
  });

  // No config at all means there was never anything to revoke — the same
  // idempotent no-op success every other DELETE route in this file gives,
  // not the POST route's "still deploying" refusal (which exists only
  // because POST needs somewhere to write TO).
  if (!updatedConfig) {
    return c.json(success({ message: `Nothing to revoke for '${name}'`, revoked: false }));
  }

  // Re-emitted only when the platform's own record says the last apply
  // never landed — an ordinary revoke on an already-applied gate needs no
  // Caddy reload (the verify hop reads the allow-list live); a revoke while
  // that apply is stuck IS the retry.
  let applyError: string | undefined;
  if (revoke.removed && app.accessGateUnapplied === true) {
    try {
      await ops.reconfigureRoute(name);
    } catch (err) {
      applyError = err instanceof Error ? err.message : 'Failed to re-emit the route';
    }
  }

  if (revoke.removed) {
    // Same admin-attribution reasoning as POST's grant log — see there.
    const detail =
      isAdminCaller && revoke.grantor !== app.userId
        ? `${targetUserId} (admin-revoked)`
        : targetUserId;
    await logActivityFor(auth, { action: 'access-share-revoked', appName: name, detail });
  }

  return c.json(
    success({
      message: revoke.removed
        ? `Access revoked for '${name}'`
        : `'${targetUserId}' did not have access to '${name}'`,
      revoked: revoke.removed,
      ...(applyError ? { applyError } : {}),
    })
  );
});

// DELETE /apps/:name/share — clear an ALL-REQUESTER-AUTHORED policy.
//
// Symmetric with the create-requires-gateApp rule above (DROP-153 §3): an
// owner who can gate their own app must also be able to un-gate it, or a
// mis-click makes an admin ticket mandatory in a feature whose whole point
// is removing that friction. Bounded to policies where EVERY entry was
// authored by the REQUESTER — the same rule DELETE /:userId enforces
// per-entry, not "does every entry merely have SOME `grantedBy` value"
// (that laxer check let an admin-authored entry, `grantedBy[id] = adminId`,
// survive a clear the single-entry revoke correctly refuses — Gate 2
// finding). A policy carrying any entry the requester did not grant
// themselves stays admin-only to clear, via DELETE /apps/:name/access,
// which is the invariant server.ts actually cares about.
shareRoutes.delete('/:name/share', async c => {
  const resolved = await resolveShareRequest(c, 'Clearing an app share policy');
  if (resolved instanceof Response) return resolved;
  const { auth, requester, name, app, ops } = resolved;
  const isAdminCaller = auth?.role === 'admin';

  if (ops.isAppInProgress(name)) {
    return c.json(
      error(ErrorCodes.CONFLICT, `Application '${name}' has an operation in progress`),
      409
    );
  }

  const clear: { cleared: boolean; refusedMixed: boolean } = { cleared: false, refusedMixed: false };
  const updatedConfig = await getAppConfigService().setAccessPolicy(name, existing => {
    const current = existing.access;
    if (!current) return NO_CHANGE; // nothing to clear
    const grantedBy = current.grantedBy ?? {};
    const allRequesterAuthored = current.allow.every(id => grantedBy[id] === requester.userId);
    if (!allRequesterAuthored) {
      clear.refusedMixed = true;
      return NO_CHANGE;
    }
    clear.cleared = true;
    return undefined;
  });

  if (!updatedConfig) {
    return c.json(success({ message: `Nothing to clear for '${name}'`, cleared: false }));
  }

  if (clear.refusedMixed) {
    return c.json(
      error(
        ErrorCodes.CONFLICT,
        `'${name}'s access policy includes entries you did not grant yourself — clear it from the ` +
          `admin access page instead.`
      ),
      409
    );
  }

  // Clearing transitions the policy from present to absent, which the Caddy
  // block itself depends on — unlike an allow-list edit, the verify hop
  // can't paper over "does a guard exist at all". Always re-emit, exactly
  // like the admin DELETE /access route.
  let applyError: string | undefined;
  if (clear.cleared) {
    try {
      await ops.reconfigureRoute(name);
    } catch (err) {
      applyError = err instanceof Error ? err.message : 'Failed to re-emit the route';
    }
    // Same admin-attribution reasoning as POST's grant log — see there. A
    // clear only ever succeeds when every entry was requester-authored, so
    // an admin requester means none of them were owner-authored.
    await logActivityFor(auth, {
      action: 'access-share-cleared',
      appName: name,
      ...(isAdminCaller && requester.userId !== app.userId
        ? { detail: 'cleared by admin (entries admin-granted via /share)' }
        : {}),
    });
  }

  return c.json(
    success({
      message: clear.cleared
        ? `Access policy cleared for '${name}'`
        : `'${name}' has no access policy to clear`,
      cleared: clear.cleared,
      ...(applyError ? { applyError } : {}),
    })
  );
});

export default shareRoutes;
