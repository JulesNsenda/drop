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
 * `resolveShareRequest` below:
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
 * administer theirs.
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
import {
  AuthContext,
  getUser,
  getUserById,
  emailHeldByAnyUser,
  type SafeUser,
} from '../middleware/auth';
import { canAccess, interactiveSessionOnly } from '../access';
import { getPlatformOps, AppInProgressError, type PlatformOps } from '../platform-ops';
import { getStateManager, type AppState } from '../../managers/app/state-manager';
import {
  getAppConfigService,
  getAppConfigServiceOrNull,
  NO_CHANGE,
  type AppAccessPolicy,
} from '../../managers/app/app-config';
import { getSettingsManager } from '../../managers/settings/settings-manager';
import { getPublicUrl, getDomainSuffix } from '../runtime-config';
import { logActivityFor } from '../../managers/activity';
import { gateEnforced } from '../../managers/guardrail/access-gate';

import { isLocalhostDomain } from '../../utils/domain-validator';
import { MAX_ACCESS_ALLOW_ENTRIES, MAX_USER_ID_LENGTH, requireAuthForAccessRoutes } from './access-limits';
import { sendMeteredMail } from './mail-quota';
import {
  getAppGuestManager,
  normalizeEmail,
  reapGuest,
  GuestStoreCorruptError,
  InviteStoreCorruptError,
  InviteCapacityError,
  INVITE_TTL_HOURS,
} from '../../managers/app-guest';

const shareRoutes = new Hono();

/** The shared 409 for a write that lands while the app has an operation in progress. */
function inProgressResponse(c: Context, name: string) {
  return c.json(error(ErrorCodes.CONFLICT, new AppInProgressError(name).message), 409);
}

/**
 * Re-emits the route for `name`, the way every write handler below recovers
 * from a Caddy reload failure: the policy is already persisted by the time
 * this runs, so a thrown error here becomes `applyError` in the response
 * rather than a failed request — the write itself already succeeded.
 */
async function reEmit(ops: PlatformOps, name: string): Promise<string | undefined> {
  try {
    await ops.reconfigureRoute(name);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : 'Failed to re-emit the route';
  }
}

/**
 * Best-effort "you now have access" notification to a freshly-granted user
 * (DROP-154 §7/§9) — the mailer's first real consumer.
 *
 * Fires only after the grant is already persisted, and can NEVER change the
 * response the caller already committed to. The call site fires this with
 * `void`, never `await` (the `void tryLogActivity` idiom used elsewhere in
 * this codebase) — awaiting would (a) add up to the mailer's whole send
 * deadline to a UI action, and (b) hand a caller a TIMING ORACLE: every
 * refusal below returns in microseconds while a real relay attempt blocks,
 * so an owner could infer "this user has an email on file" from response
 * latency alone even though the response BODY never varies (Gate 2
 * finding). The outer try/catch is still defense in depth even though
 * `sendTemplatedMail` is documented to never throw.
 *
 * Gated on `getShareNotificationsEnabled()` (default OFF) — read live, same
 * as `appSharingEnabled` above, for the same restart-to-flip-a-toggle reason.
 * DROP does not verify email addresses (`createUser`/`updateUser` enforce
 * neither uniqueness nor validation), so this notification is an operator's
 * explicit opt-in to a known tradeoff, not a default nobody chose.
 *
 * `appUrl` is PLATFORM-derived (`<name>.<domainSuffix>`) ONLY — never
 * `computeAppUrl`, which resolves from the app's OWN drop.yaml `domains` /
 * `customDomain`. Those fields are tenant-authored, and this message already
 * carries an attacker-chosen app name (`isValidAppName` permits e.g.
 * `password-reset-required`) and an attacker-chosen sharer name (the signup
 * grammar permits `IT-Support`) inside a DKIM/SPF-aligned mail from the
 * operator's own relay — adding a tenant-controlled DOMAIN on top of that
 * would be a phishing primitive borrowing the operator's sender reputation,
 * not "an app name and a username" (Gate 2 finding). `platformUrl` (the
 * dashboard) is the link this notification actually leads with; `appUrl`
 * exists only because `ShareNotificationVars` requires it.
 *
 * Every refusal is LOGGED via `logActivityFor` (`mail-send-failed`), never a
 * bare `return` — this subsystem's own rule (`principal-quota.ts`'s header,
 * `.claude/CLAUDE.md`): "exceeding a limit returns a structured refusal,
 * never a silent kill". Without it, an owner sharing with enough colleagues
 * to trip the quota would see every later grant stop notifying with no way
 * to tell that apart from "mail was never configured" (Gate 2 finding).
 * `logActivityFor` never throws and never touches the response this
 * function already cannot affect.
 */
async function notifyShareGrant(requester: AuthContext, app: AppState, targetUserId: string): Promise<void> {
  const refuse = (detail: string) =>
    logActivityFor(requester, { action: 'mail-send-failed', appName: app.name, detail });

  try {
    if (!getSettingsManager().getShareNotificationsEnabled()) return;

    const target = getUserById(targetUserId);
    if (!target?.email) return; // no address on file — not a refusal, nothing to log

    // Platform-derived only — see the file header above. Undefined on a
    // localhost suffix, mirroring `computeAppUrl`'s own rule, without ever
    // consulting the app's own domains/customDomain.
    const domain = `${app.name}.${getDomainSuffix()}`;
    const appUrl = isLocalhostDomain(domain) ? undefined : `https://${domain}`;
    const platformUrl = getPublicUrl();
    // Both variables are typed as required strings in `ShareNotificationVars`
    // — nothing sensible to link to without them, so skip rather than send a
    // broken mail. A dev/localhost box choosing this is not a refusal worth
    // logging.
    if (!appUrl || !platformUrl) return;

    // sendMeteredMail (mail-quota.ts) — the check -> send -> charge-only-if-dialed
    // sequence, shared with POST /admin/mail/test against the same quota
    // singleton. Mail's `keysFor` has no unmetered branch (unlike deploys), so
    // an absent principal comes back `refused` rather than sending unmetered.
    const result = await sendMeteredMail(
      { principalId: requester.principalId, actorUserId: requester.userId },
      'share-notification',
      target.email,
      {
        appName: app.name,
        // The GRANTING user, resolved server-side — never anything from the
        // request body. `requester.userId` is exactly the id this grant just
        // stamped into `grantedBy` for `targetUserId`.
        sharerName: getUserById(requester.userId)?.username ?? requester.username,
        appUrl,
        platformUrl,
      }
    );

    if (result.status === 'refused') {
      await refuse(`share notification refused: ${result.reason}`);
      return;
    }
    // `unavailable` is local config (no relay host/from/credential) or an
    // input the mailer refused — nothing was dialed and nothing was charged.
    // Not a refusal worth logging on a box that simply has no mail set up.
    if (result.status === 'unavailable') return;
    if (result.failure) {
      // ADMIN-FACING ONLY (`MailFailureDetail`'s own doc comment) — logged
      // for whoever reads the activity log, never surfaced on this
      // tenant-reachable response.
      await refuse(`share notification relay attempt failed: ${result.failure.reason}`);
    }
  } catch (err) {
    // Defense in depth — `sendTemplatedMail` never throws, but this boundary
    // must hold on its own rather than trust that.
    console.warn('[apps.share] share notification failed:', err instanceof Error ? err.message : err);
  }
}

/** The caller's own grants (id + username) plus a COUNT of everyone else's. */
function ownView(
  access: AppAccessPolicy | undefined,
  requesterUserId: string
): {
  ownGrants: { userId: string; username?: string }[];
  ownGuests: { guestId: string; email: string; disabled: boolean }[];
  othersGrantedCount: number;
} {
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

  // Guests are counted by the SAME rule and into the SAME "everyone else"
  // number (DROP-155). The alternative — a separate `othersGuestCount` — would
  // report an app gated by an admin and populated entirely with
  // admin-invited guests as having nobody else on it, which is exactly the
  // disclosure asymmetry `grantedBy` exists to prevent, reintroduced on the
  // second list.
  //
  // A guest's own EMAIL is returned to whoever invited them, and only to them:
  // it is the only handle an owner has for a person with no username, so
  // "revoke the person I invited" is otherwise unreachable. Someone else's
  // invitee stays a count, exactly like someone else's grant.
  const guestGrantedBy = access?.guestGrantedBy ?? {};
  const ownGuests: { guestId: string; email: string; disabled: boolean }[] = [];
  for (const guestId of access?.guests ?? []) {
    if (guestGrantedBy[guestId] !== requesterUserId) {
      othersGrantedCount += 1;
      continue;
    }
    const record = getAppGuestManager().getGuestById(guestId);
    // A grant with no backing record is stale (the boot sweep prunes these).
    // Reported with the id alone rather than dropped, so an owner can still
    // revoke something they can see.
    ownGuests.push({
      guestId,
      email: record?.email ?? '',
      disabled: record?.disabled === true,
    });
  }

  return { ownGrants, ownGuests, othersGrantedCount };
}

/**
 * How many PEOPLE this policy admits — account holders and guests together.
 *
 * One bound on one thing, rather than two independent caps. The cap exists to
 * keep a policy small enough to reason about and to bound the work every
 * `/verify` does; neither of those cares which list a principal is on, and two
 * separate caps would let an owner admit twice as many people by alternating.
 */
function admittedCount(access: AppAccessPolicy | undefined): number {
  return (access?.allow.length ?? 0) + (access?.guests?.length ?? 0);
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
  if (!app || !canAccess(requester, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  // Read live on every call — see the file header on why this is a
  // `getSettingsManager()` read rather than a `runtime-config` accessor.
  if (!getSettingsManager().getAppSharingEnabled()) {
    return c.json(
      error(ErrorCodes.UNAUTHORIZED, 'Owner-initiated app sharing is disabled on this platform.', {
        reason: 'sharing_disabled',
      }),
      403
    );
  }

  const ops = getPlatformOps();
  if (!ops) {
    return c.json(error(ErrorCodes.SERVICE_UNAVAILABLE, 'Platform operations unavailable'), 503);
  }

  return { requester, name, app, ops };
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
  const view = ownView(access, requester.userId);

  const verdict = await ops.assessAccessGate(name);
  const policyPresent = access !== undefined;

  return c.json(
    success({
      policyPresent,
      // What is true of traffic right now, not merely what is on disk — the
      // same distinction admin's GET /access reports, and the read the kill
      // switch exists to make truthful.
      enforced: gateEnforced(verdict, policyPresent),
      // SPREAD, never a hand-picked pair. `ownView` grew `ownGuests` in
      // DROP-155 and every field it returns is part of the caller's own view
      // by construction — re-listing them here is how one gets silently
      // dropped from a response while the helper looks correct.
      ...view,
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

/** RFC-5321's practical ceiling for a whole address. */
const MAX_EMAIL_LENGTH = 254;

/**
 * Deliberately conservative, and deliberately NOT an attempt at RFC 5322.
 *
 * This value becomes the `To:` header of mail sent from the operator's own
 * SPF/DKIM-aligned relay, so the question is not "could a standards-compliant
 * mail server route this" but "is this unambiguously one plain address". Quoted
 * local parts, comments and address lists are all legal RFC 5322 and all things
 * this must never hand to nodemailer, which fans a list out to every address it
 * finds. `mailer.ts` re-checks separately — that is a backstop, not a licence
 * for this to be loose.
 */
const EMAIL_PATTERN = /^[^\s@,;<>"'\\]+@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/**
 * The `{ email }` branch: invite someone with NO DROP account (DROP-155).
 *
 * A sibling of the `{ username }` path rather than a mode inside it. The two
 * resolve different kinds of principal into different lists, with different
 * provenance maps and different revoke routes — the only thing they genuinely
 * share is the policy write, and that is shared by calling the same writer.
 *
 * THE REFUSALS ARE UNIFORM ON PURPOSE. Whether an address belongs to a DROP
 * user, is already a guest elsewhere, or has never been seen, the caller gets
 * one message. An owner who could tell those apart would have a directory
 * oracle over every account on the platform, one address at a time — the same
 * reason `refuseGrantTarget` collapses its four reasons into one.
 */
async function inviteGuest(
  c: Context,
  resolved: ResolvedShareRequest,
  rawEmail: unknown,
  gateApp: boolean
): Promise<Response> {
  const { requester, name, app, ops } = resolved;
  const isAdminCaller = requester.role === 'admin';

  // The operator opt-in, read LIVE — same posture as `appSharingEnabled`
  // above, and for the same restart-to-flip-a-toggle reason.
  if (!getSettingsManager().getGuestInvitesEnabled()) {
    return c.json(
      error(
        ErrorCodes.UNAUTHORIZED,
        'Inviting people without a DROP account is disabled on this platform.',
        { reason: 'guest_invites_disabled' }
      ),
      403
    );
  }

  if (typeof rawEmail !== 'string' || rawEmail.trim().length === 0) {
    throw new ValidationError('email is required');
  }
  const email = normalizeEmail(rawEmail);
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw new ValidationError('email is not a valid single email address');
  }

  const platformUrl = getPublicUrl();
  if (!platformUrl) {
    return c.json(
      error(
        ErrorCodes.CONFLICT,
        'This platform has no public URL configured, so an invitation link cannot be built.'
      ),
      409
    );
  }

  /** The ONE refusal every ineligible address gets. See this function's doc. */
  const refuseAddress = (reason: string): Response => {
    console.warn(`[apps.share] guest invite on '${name}' refused: ${reason}`);
    return c.json(
      error(ErrorCodes.VALIDATION_ERROR, `'${email}' cannot be invited to '${name}'.`),
      400
    );
  };

  // The INVITE end of the collision rule; `createUser`/`updateUser` hold the
  // other end. Both are needed and the pair is not redundant: a one-directional
  // check is walked past by taking the address from the other side afterwards.
  if (emailHeldByAnyUser(email)) return refuseAddress('address belongs to a DROP account');

  // Pre-check, before any guest record exists — the same fast-path shape the
  // username branch uses, and here it has a second job: `resolveOrCreateGuest`
  // below CREATES a record, and a record created for a grant that then gets
  // refused would sit inert but still hold the address against the collision
  // rule. The authoritative re-check still happens inside the write closure.
  const preAccess = getAppConfigServiceOrNull()?.getConfig(name)?.access;
  if (preAccess === undefined && !gateApp) {
    return c.json(
      error(
        ErrorCodes.CONFLICT,
        `'${name}' is not gated yet. Sharing it will make it sign-in-only for everyone else — ` +
          `resend with { "gateApp": true } to confirm.`
      ),
      409
    );
  }
  if (admittedCount(preAccess) >= MAX_ACCESS_ALLOW_ENTRIES) {
    return c.json(
      error(
        ErrorCodes.CONFLICT,
        `'${name}' already has ${MAX_ACCESS_ALLOW_ENTRIES} people with access — remove someone before adding another.`
      ),
      409
    );
  }

  let guest;
  try {
    guest = await getAppGuestManager().resolveOrCreateGuest(email, name, requester.userId);
  } catch (err) {
    if (err instanceof GuestStoreCorruptError) {
      return c.json(
        error(ErrorCodes.SERVICE_UNAVAILABLE, 'Guest records are unavailable right now.'),
        503
      );
    }
    throw err;
  }

  type InviteOutcome = 'invited' | 'already-invited' | 'cap-exceeded' | 'needs-confirmation';
  const invite: { outcome: InviteOutcome; hadPolicyBefore: boolean; adminAuthoredCount?: number } = {
    outcome: 'invited',
    hadPolicyBefore: false,
  };

  const updatedConfig = await getAppConfigService().setAccessPolicy(name, existing => {
    const current = existing.access;
    invite.hadPolicyBefore = current !== undefined;

    // Read at write EXECUTION time, never from the snapshot above — an admin's
    // DELETE /access landing between the pre-check and here must be seen, or
    // this silently re-installs the guard they just removed.
    if (current === undefined && !gateApp) {
      invite.outcome = 'needs-confirmation';
      return NO_CHANGE;
    }

    const guests = current?.guests ?? [];
    // Idempotent re-invite short-circuits BEFORE the cap, exactly as the
    // username branch does: re-inviting someone already on the list at exactly
    // the cap must still work (it mints a fresh invite, which is the whole
    // point of a resend).
    if (guests.includes(guest.id)) {
      invite.outcome = 'already-invited';
      return NO_CHANGE;
    }
    if (admittedCount(current) >= MAX_ACCESS_ALLOW_ENTRIES) {
      invite.outcome = 'cap-exceeded';
      const grantedByMap = current?.grantedBy ?? {};
      const guestGrantedByMap = current?.guestGrantedBy ?? {};
      invite.adminAuthoredCount =
        (current?.allow ?? []).filter(id => grantedByMap[id] !== requester.userId).length +
        guests.filter(id => guestGrantedByMap[id] !== requester.userId).length;
      return NO_CHANGE;
    }

    return {
      mode: 'drop-users',
      allow: current?.allow ?? [],
      grantedBy: current?.grantedBy,
      guests: [...guests, guest.id],
      guestGrantedBy: { ...(current?.guestGrantedBy ?? {}), [guest.id]: requester.userId },
    };
  });

  if (!updatedConfig) {
    return c.json(
      error(
        ErrorCodes.CONFLICT,
        `Application '${name}' is still being deployed — try again once it has finished.`
      ),
      409
    );
  }
  if (invite.outcome === 'needs-confirmation') {
    return c.json(
      error(
        ErrorCodes.CONFLICT,
        `'${name}' is not gated yet. Sharing it will make it sign-in-only for everyone else — ` +
          `resend with { "gateApp": true } to confirm.`
      ),
      409
    );
  }
  if (invite.outcome === 'cap-exceeded') {
    const adminAuthoredCount = invite.adminAuthoredCount ?? 0;
    const advice =
      adminAuthoredCount > 0
        ? `${adminAuthoredCount} of them granted by an administrator — ask an admin to remove one, or revoke someone you invited yourself.`
        : 'remove someone before adding another.';
    return c.json(
      error(
        ErrorCodes.CONFLICT,
        `'${name}' already has ${MAX_ACCESS_ALLOW_ENTRIES} people with access — ${advice}`
      ),
      409
    );
  }

  // Minted AFTER the grant is on disk. A live invite for a grant that was
  // refused is a credential for access nobody agreed to; the reverse — a grant
  // whose invite failed to mint — is an owner pressing resend.
  let minted;
  try {
    minted = await getAppGuestManager().mintInviteToken({
      appName: name,
      guestId: guest.id,
      email: guest.email,
      createdBy: requester.userId,
    });
  } catch (err) {
    if (err instanceof InviteCapacityError) {
      return c.json(
        error(
          ErrorCodes.RATE_LIMITED,
          err.reason === 'per_creator'
            ? 'You have too many invitations outstanding. Wait for some to expire or be used.'
            : 'This platform has too many invitations outstanding right now.'
        ),
        429
      );
    }
    if (err instanceof InviteStoreCorruptError) {
      return c.json(
        error(ErrorCodes.SERVICE_UNAVAILABLE, 'Invitations are unavailable right now.'),
        503
      );
    }
    throw err;
  }

  // Id in the PATH, secret in the FRAGMENT — the split C0 recommended, and the
  // reason the mail body carries only the operator's own domain. Built from
  // `getPublicUrl()`, which is also what the template re-checks the origin
  // against: a link on any other origin fails to render rather than being sent.
  const inviteUrl = `${platformUrl}/api/v1/app-access/invite/${minted.id}#${minted.secret}`;

  const mail = await sendMeteredMail(
    { principalId: requester.principalId, actorUserId: requester.userId },
    'guest-invite',
    guest.email,
    {
      appName: name,
      inviterName: getUserById(requester.userId)?.username ?? requester.username,
      inviteUrl,
      platformUrl,
      expiresInHours: INVITE_TTL_HOURS,
    }
  );

  let applyError: string | undefined;
  const justCreated = !invite.hadPolicyBefore && invite.outcome === 'invited';
  if (justCreated || app.accessGateUnapplied === true) {
    applyError = await reEmit(ops, name);
  }

  const detail =
    isAdminCaller && requester.userId !== app.userId
      ? `${guest.email} (admin-invited)`
      : guest.email;
  await logActivityFor(requester, { action: 'guest-invited', appName: name, detail });

  // THE LINK COMES BACK only when the mail was never sent — `unavailable` means
  // no relay is configured, or the mailer refused the input, so nothing was
  // dialed. Two reasons this is right rather than a leak:
  //
  //  - the requester AUTHORED this invitation moments ago and is the one
  //    person entitled to the link; this is the same once-only disclosure
  //    `POST /auth/api-keys` already makes for a freshly minted key;
  //  - without it, a platform with no SMTP relay cannot invite anyone at all,
  //    and the feature is unusable rather than degraded.
  //
  // Never on `attempted`, even with a `failure`: there the relay was dialed and
  // the message may yet be delivered, so handing the link back as well would
  // widen the disclosure for no gain.
  const undelivered = mail.status !== 'attempted';
  return c.json(
    success({
      message:
        invite.outcome === 'already-invited'
          ? `A new invitation for '${guest.email}' has been created for '${name}'.`
          : `'${guest.email}' has been invited to '${name}'.`,
      ...ownView(updatedConfig.access, requester.userId),
      mailSent: mail.status === 'attempted',
      ...(undelivered ? { inviteUrl } : {}),
      ...(applyError ? { applyError } : {}),
    })
  );
}

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
  const { requester, name, app, ops } = resolved;
  const isAdminCaller = requester.role === 'admin';

  // Pre-check, before anything is persisted — same reason the admin PUT
  // /access route pre-checks: a deploy in flight makes the re-emission below
  // throw, and by then the policy would already be on disk.
  if (ops.isAppInProgress(name)) {
    return inProgressResponse(c, name);
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

  const body = (await c.req.json().catch(() => ({}))) as {
    username?: unknown;
    email?: unknown;
    gateApp?: unknown;
  };

  // ONE of the two, never both. `{ username, email }` together has no sensible
  // meaning — they name different kinds of principal — and silently preferring
  // one would make which principal got access depend on a field-order detail
  // nobody wrote down.
  if (body.username !== undefined && body.email !== undefined) {
    throw new ValidationError('Provide either username or email, not both');
  }
  if (body.email !== undefined) {
    return inviteGuest(c, resolved, body.email, body.gateApp === true);
  }

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
    /** Set only on a fresh grant — the id `notifyShareGrant` below mails. */
    targetUserId?: string;
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
    if (admittedCount(current) >= MAX_ACCESS_ALLOW_ENTRIES) {
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
      const guestGrantedByMap = current?.guestGrantedBy ?? {};
      grant.adminAuthoredCount =
        allow.filter(id => grantedByMap[id] !== requester.userId).length +
        (current?.guests ?? []).filter(id => guestGrantedByMap[id] !== requester.userId).length;
      return NO_CHANGE;
    }
    grant.targetUserId = liveUser!.id;
    return {
      mode: 'drop-users',
      allow: [...allow, liveUser!.id],
      grantedBy: { ...(current?.grantedBy ?? {}), [liveUser!.id]: requester.userId },
    };
  });

  if (!updatedConfig) {
    return c.json(
      error(
        ErrorCodes.CONFLICT,
        `Application '${name}' is still being deployed — try again once it has finished.`
      ),
      409
    );
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
    applyError = await reEmit(ops, name);
  }

  if (grant.outcome === 'granted') {
    // An admin acting through this owner-facing route is audited as such —
    // `requester.userId !== app.userId` means the freshly-stamped
    // `grantedBy` entry is NOT owner-authored, which the three dedicated
    // `access-share-*` actions would otherwise collapse into an
    // indistinguishable owner action (Gate 2 finding).
    const detail =
      isAdminCaller && requester.userId !== app.userId ? `${username} (admin-granted)` : username;
    await logActivityFor(requester, { action: 'access-share-granted', appName: name, detail });
    // Fired only for a FRESH grant, never a re-grant of an existing entry
    // (`already-granted` is a distinct outcome) — see `notifyShareGrant`'s
    // own doc comment for why this can never change the response above, and
    // for why it is fired with `void` rather than `await` (Gate 2 fix #2).
    if (grant.targetUserId) {
      void notifyShareGrant(requester, app, grant.targetUserId);
    }
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
      ...view,
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
  const { requester, name, app, ops } = resolved;
  const isAdminCaller = requester.role === 'admin';

  if (ops.isAppInProgress(name)) {
    return inProgressResponse(c, name);
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
    applyError = await reEmit(ops, name);
  }

  if (revoke.removed) {
    // Same admin-attribution reasoning as POST's grant log — see there.
    const detail =
      isAdminCaller && revoke.grantor !== app.userId
        ? `${targetUserId} (admin-revoked)`
        : targetUserId;
    await logActivityFor(requester, { action: 'access-share-revoked', appName: name, detail });
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

// DELETE /apps/:name/share/guests/:guestId — revoke one guest.
//
// A FOUR-segment path, and that is worth stating because it is what makes this
// route's guards easy to miss: `/apps/:name/share/:userId` binds exactly one
// segment, so it does NOT match this, and neither the dedicated rate-limit
// bucket nor the explicit role floor reaches here without a third registration
// of its own in `server.ts`. A revoke route silently falling through to the
// general `/apps/*` guard is precisely the shape DROP-153 already had to fix
// once for the three-segment form.
//
// Like the user revoke, deliberately NOT gated on enforceability: an operator
// must always be able to remove a control, including on a box that can no
// longer enforce it.
shareRoutes.delete('/:name/share/guests/:guestId', async c => {
  const resolved = await resolveShareRequest(c, 'Revoking a guest');
  if (resolved instanceof Response) return resolved;
  const { requester, name, app, ops } = resolved;
  const isAdminCaller = requester.role === 'admin';

  if (ops.isAppInProgress(name)) {
    return inProgressResponse(c, name);
  }

  const guestId = c.req.param('guestId');
  if (!guestId || guestId.length > MAX_USER_ID_LENGTH) {
    throw new ValidationError(`Invalid guest id (max ${MAX_USER_ID_LENGTH} chars)`);
  }

  const access = getAppConfigServiceOrNull()?.getConfig(name)?.access;
  const onThisApp = (access?.guests ?? []).includes(guestId);
  const grantor = access?.guestGrantedBy?.[guestId];

  // The same no-op-not-refusal posture the user revoke takes, and for the same
  // reason: a 403 for "someone else invited them" against a 200 for "never
  // existed" is itself a membership oracle over the admin-authored list that
  // `ownView` deliberately reduces to a count.
  if (!onThisApp || (!isAdminCaller && grantor !== requester.userId)) {
    return c.json(
      success({ message: `Nothing to revoke for '${name}'`, revoked: false })
    );
  }

  // ONLY AN ADMIN MAY REMOVE A DISABLED RECORD.
  //
  // `disabled` is an admin's decision about a person. Deleting the record frees
  // the `(email, appName)` key, so an owner who could delete it could re-invite
  // the same address a second later and get a fresh, ENABLED guest — a clean
  // bypass of the disable, performed entirely through owner-level routes. The
  // grant itself is still revocable by the owner (that is what the branch
  // below does); what they cannot do is destroy the tombstone.
  const record = getAppGuestManager().getGuestById(guestId);
  if (record?.disabled === true && !isAdminCaller) {
    return c.json(
      error(
        ErrorCodes.UNAUTHORIZED,
        'This guest was disabled by an administrator. Ask an admin to remove them.'
      ),
      403
    );
  }

  // `reapGuest` and not a bare policy edit: a guest id can carry LIVE INVITES,
  // and removing the grant while leaving an invite redeemable would let the
  // next click put the same person straight back on the list. The reaper
  // revokes the app-config grant FIRST and clears its own bookkeeping second,
  // so a crash between the two still leaves the guest without access.
  //
  // AWAITED before the response. A fire-and-forget revoke that is acknowledged
  // and then lost to a restart resurrects a guest whose session is still
  // valid — the plan's durability-before-acknowledgement rule, and the one
  // place on this route where it bites.
  try {
    await reapGuest(guestId);
  } catch (err) {
    if (err instanceof GuestStoreCorruptError) {
      return c.json(
        error(ErrorCodes.SERVICE_UNAVAILABLE, 'Guest records are unavailable right now.'),
        503
      );
    }
    throw err;
  }

  // Same rule as the user revoke: re-emit only when the platform's own record
  // says the last apply never landed. An ordinary revoke needs no Caddy reload,
  // because `/verify` reads the policy live on every request.
  let applyError: string | undefined;
  if (app.accessGateUnapplied === true) {
    applyError = await reEmit(ops, name);
  }

  const detail =
    isAdminCaller && grantor !== requester.userId
      ? `${record?.email ?? guestId} (admin-revoked)`
      : (record?.email ?? guestId);
  await logActivityFor(requester, { action: 'guest-revoked', appName: name, detail });

  return c.json(
    success({
      message: `Guest access revoked for '${name}'`,
      revoked: true,
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
  const { requester, name, app, ops } = resolved;
  const isAdminCaller = requester.role === 'admin';

  if (ops.isAppInProgress(name)) {
    return inProgressResponse(c, name);
  }

  const clear: { cleared: boolean; refusedMixed: boolean } = { cleared: false, refusedMixed: false };
  const updatedConfig = await getAppConfigService().setAccessPolicy(name, existing => {
    const current = existing.access;
    if (!current) return NO_CHANGE; // nothing to clear
    const grantedBy = current.grantedBy ?? {};
    const guestGrantedBy = current.guestGrantedBy ?? {};
    // BOTH lists, and `guests` is the half that made the old rule unsound:
    // `[].every()` is `true`, so an app gated by an admin whose entire
    // population was admin-INVITED GUESTS passed the all-requester-authored
    // test on an empty `allow` and could be cleared — un-gating it — by any
    // owner (DROP-155 plan section B).
    const allRequesterAuthored =
      current.allow.every(id => grantedBy[id] === requester.userId) &&
      (current.guests ?? []).every(id => guestGrantedBy[id] === requester.userId);
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
    applyError = await reEmit(ops, name);
    // Same admin-attribution reasoning as POST's grant log — see there. A
    // clear only ever succeeds when every entry was requester-authored, so
    // an admin requester means none of them were owner-authored.
    await logActivityFor(requester, {
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
