/**
 * The wire contract of `/apps/:name/share` (DROP-153, DROP-155), kept out of
 * the React layer so the root jest suite can pin it.
 *
 * Two components now talk to these routes — `ShareCard` (the owner's view)
 * and `AccessTab` (the admin's) — and before this file existed each of them
 * re-derived the same three facts inline, with a paragraph of comment apiece
 * explaining why the obvious shorter version is wrong. That is the shape of
 * thing that drifts: the two copies were already one refusal code apart.
 *
 * DOM-free on purpose, same as `redeploy-credential.ts`: root
 * `tsconfig.json` is `lib: ["ES2022"]` with no DOM, which is what lets the
 * root jest suite compile and run the test beside this file. Nothing here may
 * reach for `window`, `fetch` or a React import.
 */

/** A DROP account the CALLER granted access to — never someone else's grant. */
export interface OwnGrant {
  userId: string;
  username?: string;
}

/**
 * A guest the CALLER invited (DROP-155). Someone else's invitee is a number in
 * `othersGrantedCount`, never a row — the same rule that hides another
 * person's account grants, applied to the second list.
 */
export interface OwnGuest {
  guestId: string;
  /** Empty when the grant is stale — a policy entry whose record the boot sweep has not reaped yet. */
  email: string;
  disabled: boolean;
}

/** `GET /apps/:name/share`. Deliberately narrower than the admin `/access` view. */
export interface ShareView {
  policyPresent: boolean;
  enforced: boolean;
  ownGrants: OwnGrant[];
  ownGuests: OwnGuest[];
  othersGrantedCount: number;
  gateApplied: boolean | null;
  enforceable: boolean;
  blockers: string[];
}

/**
 * Which platform toggle refused a `/share` request, if one did.
 *
 * TWO separate settings gate these routes and they are not interchangeable:
 * `app-sharing` guards every `/share` route, and `guest-invites` guards only
 * the `{ email }` branch — so guest invites can be switched ON and a request
 * still refuse because sharing is off. A caller that collapses them tells the
 * operator to flip the wrong switch.
 *
 * Both are read LIVE by the routes on every request, not from a config
 * snapshot, so ANY response can carry the refusal — not just the initial
 * load. An admin can flip a toggle off while the panel is already open, which
 * is why callers classify every response through here rather than only the
 * first one.
 */
export type ShareRefusal = 'sharing' | 'guests';

export function shareRefusal(res: { status: number; error?: unknown }): ShareRefusal | null {
  if (res.status !== 403) return null;
  const reason = (res.error as { details?: { reason?: string } } | undefined)?.details?.reason;
  if (reason === 'sharing_disabled') return 'sharing';
  if (reason === 'guest_invites_disabled') return 'guests';
  return null;
}

/**
 * The one-off invitation link, or nothing.
 *
 * `mailSent === false`, NOT merely "a url came back". The server makes the two
 * equivalent today, and asserting the invariant here means a response that
 * ever carried both would withhold the secret rather than publish a link to an
 * invitation that WAS delivered to its recipient.
 *
 * When it does come back it is the only copy in existence — nothing stores the
 * secret — so a caller that drops it has destroyed the invitation.
 */
export function inviteSecretUrl(
  data: { mailSent?: boolean; inviteUrl?: string } | undefined
): string | undefined {
  return data?.mailSent === false ? data.inviteUrl : undefined;
}

/**
 * The banner for a write that SUCCEEDED while the gate it depends on did not
 * reach the proxy. Reporting only the success half is the lie the `gateApplied`
 * signal exists to prevent: the person was granted access to an app that is
 * not actually being gated.
 *
 * Takes the past-tense verb because the six call sites genuinely differ
 * ("Shared", "Invited", "Revoked"), and builds the ERROR string only — the
 * success branch reads `res.data.message` in some callers and a literal in
 * others, and folding that in here would flatten a real difference.
 */
export function gateNotReappliedText(pastTense: string, applyError: string): string {
  return `${pastTense}, but the gate was not re-applied: ${applyError}`;
}
