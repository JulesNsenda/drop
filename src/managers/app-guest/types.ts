/**
 * Persisted shapes for the guest credential class (DROP-155).
 *
 * Kept separate from `app-guest-manager.ts` so `src/api/app-access/
 * session-token.ts` (a sibling change, already merged into this branch) can
 * import `GuestRecord` without pulling in the manager's fs/crypto surface.
 */

/** The namespace every guest id is minted under — see `GuestRecord.id`'s own doc. */
export const GUEST_ID_PREFIX = 'guest:';

/**
 * A person with no DROP account, admitted to exactly ONE app by redeeming a
 * single-use invite. `email` + `appName` is the de-dup key (see
 * `resolveOrCreateGuest`) — the same address invited to a second app gets a
 * SEPARATE record, never a second `allow`-style entry on this one, so a
 * guest session token (`app_guest_session`, `src/api/app-access/
 * session-token.ts`) can bind to `appName` directly rather than trusting the
 * audience/app claim alone.
 */
export interface GuestRecord {
  /**
   * `guest:<crypto.randomUUID()>`. Namespaced so a tenant matching a header
   * value against known DROP user ids fails closed rather than accidentally
   * matching, and random (not derived from the email) so a guest re-created
   * after deletion cannot inherit a stale grant under the same id.
   * `isValidGuestRecord` refuses to LOAD a record whose `id` lacks this
   * prefix — the guarantee is structural, not merely a minting convention.
   */
  id: string;
  /** Normalized (`normalizeEmail`) — never the raw, caller-cased address. */
  email: string;
  /** The one app this guest was invited to and may open. */
  appName: string;
  /** ISO instant. */
  createdAt: string;
  /** The user id that first resolved this (email, appName) pair into a guest. */
  createdBy: string;
  disabled: boolean;
  /** Set together with `disabled: true`. Absent while `disabled` is false. */
  disabledBy?: string;
  /** ISO instant, updated best-effort (fire-and-forget — see the manager's own doc). */
  lastSeenAt?: string;
  /**
   * Same field name and semantics as `User.credentialsInvalidBefore`
   * (`src/api/middleware/auth.ts`) — stamped on disable, checked by
   * `verifyAppGuestSessionToken` via the SAME `predatesInvalidationStamp`
   * helper the user class uses. Never cleared: there is no guest re-enable
   * path (see the manager's class doc for why).
   */
  credentialsInvalidBefore?: string;
}

/** The persisted, at-rest shape of one invite token. Never carries the raw secret. */
export interface InviteTokenRecord {
  /** Non-secret lookup key — the id is not what protects this credential, the secret is. */
  id: string;
  /** sha256 hex digest of the raw secret. Compared with `crypto.timingSafeEqual`, never `===`. */
  secretHash: string;
  /** The app this invite admits to — bound at mint, never supplied by the redeemer. */
  appName: string;
  /** The guest this invite resolves to on redemption — already created by the time of mint. */
  guestId: string;
  /** Normalized, carried through so the redemption payload doesn't need a second guest-store read. */
  email: string;
  /** epoch ms. */
  createdAt: number;
  /** epoch ms. */
  expiresAt: number;
  /** The user id who sent the invite (the `{ email }` branch caller). */
  createdBy: string;
}

/** What a successful `redeemInviteToken` proves. */
export interface InviteRedemption {
  guestId: string;
  appName: string;
  email: string;
}

/** Result of a successful mint: the id is persisted, the secret is NOT. */
export interface MintedInvite {
  id: string;
  secret: string;
}
