/**
 * AppGuestManager (DROP-155) — guest records AND invite tokens, one module.
 *
 * The plan's own reasoning for keeping these together: they share a
 * lifetime (an invite exists only to mint a guest that then outlives it),
 * the same key space (`guest:<uuid>` — an invite is bound to a guest id, a
 * guest is looked up by that same id), and the same reaper (`reapGuest`
 * deletes a guest's record AND its live invites in one durable operation).
 * One `platform.ts` init, one `reset*()`.
 *
 * Two independent, file-backed stores, each with its OWN corrupt flag and
 * its OWN write-serialization queue (a guest write and an invite write must
 * never block on each other):
 *
 *  - `app-guests.json` — `GuestRecord`s, keyed by id. Memory-authoritative:
 *    every read (`getGuestById`, `listGuests`, ...) answers from the
 *    in-memory map, never from disk. But every SECURITY-RELEVANT mutation
 *    (resolve-or-create, disable, reap) `await`s its write before returning
 *    — the one exception is `touchLastSeen`, fire-and-forget by design (see
 *    its own doc). Without durability-before-ack, a restart between the ack
 *    and the write resurrects a revoked guest whose 8h session is still
 *    valid.
 *
 *  - `app-guest-invites.json` — `InviteTokenRecord`s, keyed by id. Persisted
 *    rather than an in-memory `Map` (unlike `flow-code.ts`'s codes/flows,
 *    which are fine to lose): a push to `develop` restarts the platform on
 *    every deploy, and an in-memory invite would die with it while the
 *    guest session it eventually mints outlives a redeploy by hours — a
 *    push during that window would silently and asymmetrically kill only
 *    the not-yet-redeemed invites.
 *
 * CORRUPT HANDLING DELIBERATELY DIVERGES FROM `settings-manager.ts`. That
 * store clears its `corrupt` flag on every successful write because it is
 * "fully reconstructible from a single admin PUT" (its own comment). This
 * store is the opposite: it holds every guest grant on the estate, and nothing
 * reconstructs it from one admin action. So here: while EITHER store is
 * corrupt, every mutating method on that store REFUSES (throws) rather than
 * writing — a `doPersist*` success must never clear `*Corrupt`, because doing
 * so would (a) overwrite unreadable-but-possibly-forensically-recoverable
 * bytes with a partial in-memory view built from nothing, and (b) unblock
 * `reapGuest`, which would then read "no backing record" as "safe to prune"
 * and strip every app-config guest entry on the estate — exactly the mass
 * deletion the plan's "corrupt store ⇒ skip reconciliation entirely"
 * correction exists to prevent. Recovery is by restart (fix or restore the
 * file, then reload), not a self-healing write, on purpose.
 *
 * There is no guest re-enable path. `disableGuest` stamps
 * `credentialsInvalidBefore` (same field, same semantics as `User`'s, in
 * `src/api/middleware/auth.ts`) and that stamp is never cleared — reviving a
 * disabled guest goes through delete + re-invite (`reapGuest`, then a fresh
 * `resolveOrCreateGuest`), which is also why "only an admin may delete a
 * disabled record" is a rule this module documents but does NOT enforce: it
 * has no `AuthContext`/role concept, and enforcing it is the caller's job
 * (the DELETE route).
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { writeJsonAtomic } from '../../utils/atomic-write';
import { GUEST_ID_PREFIX, type GuestRecord, type InviteTokenRecord, type InviteRedemption, type MintedInvite } from './types';

const isWindows = process.platform === 'win32';
const DEFAULT_DROP_ROOT = isWindows ? 'C:\\drop' : '/var/drop';

function defaultGuestsFilePath(): string {
  const dropRoot = process.env.DROP_ROOT || DEFAULT_DROP_ROOT;
  return path.join(dropRoot, 'data', 'drop-svc', 'app-guests.json');
}

function defaultInvitesFilePath(): string {
  const dropRoot = process.env.DROP_ROOT || DEFAULT_DROP_ROOT;
  return path.join(dropRoot, 'data', 'drop-svc', 'app-guest-invites.json');
}

/**
 * 24 hours.
 *
 * This number was argued down from 72 deliberately, and the reasoning is worth
 * keeping because the pressure to raise it will come back. `flow-code.ts` sets
 * the house position: its access code is 60 SECONDS and single-use, because a
 * credential that transits a URL lands in logs and history. An invite is a
 * strictly higher-value credential than that code — it grants a NEW IDENTITY
 * rather than a session for someone already authenticated — so it cannot also
 * be the longest-lived thing in the system. 72h extended the house constraint
 * by 4300×; 24h extends it by 1400× and is already generous for a link that
 * only has to survive one working day.
 *
 * The recovery path for a missed invite is the OWNER re-sending, not a longer
 * fuse: an expired invite is a person asking a colleague to click a button,
 * while a long-lived one is a bearer credential sitting in a mailbox nobody is
 * watching.
 */
export const INVITE_TTL_HOURS = 24;
export const INVITE_TTL_MS = INVITE_TTL_HOURS * 60 * 60 * 1000;

/**
 * Cap on LIVE invite tokens, estate-wide. Generous — TTL pruning already
 * bounds the file to invites minted in the last `INVITE_TTL_HOURS` — and
 * exists only so the FILE cannot grow without limit, mirroring
 * `MAX_TRACKED_PRINCIPALS` (`principal-quota.ts`).
 *
 * NOT the anti-abuse control on its own — `principal-quota.ts`'s own doc is
 * explicit that a cap must be "per principal and per owning user, never
 * global (a global cap is a DoS any tenant can trigger)". `
 * MAX_LIVE_INVITE_TOKENS_PER_CREATOR` below is that per-principal bound;
 * this one only stops the estate-wide file from growing without limit once
 * many principals are each within their own bound.
 */
export const MAX_LIVE_INVITE_TOKENS = 500;

/**
 * Cap on live invite tokens ONE `createdBy` (an inviting user id) may have
 * outstanding at once, estate-wide. This is the actual anti-abuse control —
 * without it, one tenant minting invites in a loop exhausts
 * `MAX_LIVE_INVITE_TOKENS` and blocks every OTHER app's invites too, exactly
 * the global-cap DoS shape `principal-quota.ts` was built to avoid.
 */
export const MAX_LIVE_INVITE_TOKENS_PER_CREATOR = 50;

/** Refused because the guest store is corrupt — see the class doc for why this fails closed rather than self-healing. */
export class GuestStoreCorruptError extends Error {
  constructor() {
    super('Guest store is corrupt; refusing every guest operation until the store is repaired and the platform restarted');
    this.name = 'GuestStoreCorruptError';
  }
}

/** Refused because the invite store is corrupt — same reasoning as `GuestStoreCorruptError`. */
export class InviteStoreCorruptError extends Error {
  constructor() {
    super('Invite store is corrupt; refusing every invite operation until the store is repaired and the platform restarted');
    this.name = 'InviteStoreCorruptError';
  }
}

/**
 * Refused because a cap was reached even after pruning expired entries.
 * `reason` distinguishes WHICH cap — mirroring `principal-quota.ts`'s
 * `QuotaVerdict.reason?: 'table_full'`, for the same reason: an operator
 * hitting the estate-wide ceiling and one hitting their own per-creator
 * window need different responses, and collapsing both into one undifferentiated
 * error throws away exactly the information that made that precedent's cap
 * debuggable.
 */
export class InviteCapacityError extends Error {
  constructor(public readonly reason: 'global' | 'per_creator') {
    super(
      reason === 'global'
        ? 'Too many live invite tokens estate-wide; try again once some have expired or been redeemed'
        : 'Too many live invite tokens for this inviter; try again once some have expired or been redeemed'
    );
    this.name = 'InviteCapacityError';
  }
}

export interface AppGuestManagerConfig {
  guestsFilePath?: string;
  invitesFilePath?: string;
  /** Test-only override of `MAX_LIVE_INVITE_TOKENS`. */
  maxLiveInviteTokens?: number;
  /** Test-only override of `MAX_LIVE_INVITE_TOKENS_PER_CREATOR`. */
  maxLiveInviteTokensPerCreator?: number;
}

/**
 * The app-config side of "everywhere it appears" — `AppConfigService#
 * pruneGuestEntries` (`src/managers/app/app-config.ts`, a sibling change),
 * built to mirror `pruneAllowListEntries` exactly. Called through this
 * narrow local type, and injectable on `reapGuest`, for two independent
 * reasons: it keeps this file's own tests runnable regardless of the exact
 * landing order of the parallel app-config.ts slice, and it lets
 * `reapGuest`'s tests assert the ORDER (access revoked before local
 * bookkeeping) without spinning up a real `AppConfigService`.
 */
type PruneAppConfigGuestEntries = (guestId: string) => Promise<unknown>;

async function defaultPruneAppConfigGuestEntries(guestId: string): Promise<unknown> {
  // `OrNull`, not `getAppConfigService()` — AppConfigService requires an
  // explicit options object on its OWN first call anywhere in the process
  // and throws otherwise ("options required on first call"). A caller that
  // deletes/reaps a guest before app-config has been initialized (an
  // unusual boot order, or a unit test exercising only this module and
  // auth) has structurally nothing to prune yet either: no `AppConfig` can
  // have a `guests` entry for an app-config service that has never been
  // constructed. Treat that as "nothing to prune", not a crash.
  const { getAppConfigServiceOrNull } = await import('../app/app-config');
  const service = getAppConfigServiceOrNull();
  if (!service) return undefined;
  return service.pruneGuestEntries(guestId);
}

export interface ReapGuestDeps {
  pruneAppConfigGuestEntries?: PruneAppConfigGuestEntries;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/** Constant-time compare of two equal-length-when-valid hex digests. Mirrors `flow-code.ts`'s `timingSafeEqualStrings`. */
function timingSafeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length — compare lengths first and return early, leaking only that. Both
  // inputs here are sha256 hex digests (64 chars) whenever the caller passed
  // a real secret, so this branch is not reachable on a genuine attempt.
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Guards every field a loaded `GuestRecord` must have, INCLUDING the
 * `guest:` prefix on `id` — the namespacing guarantee in `types.ts`'s own
 * doc is structural only if a record lacking it is refused at load, not
 * merely produced correctly by `resolveOrCreateGuest`. A single malformed
 * row is dropped (logged, not loaded); it does not mark the whole store
 * corrupt — that flag is reserved for "the file itself could not be
 * trusted", not "one hand-edited row is wrong".
 */
function isValidGuestRecord(raw: unknown): raw is GuestRecord {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    r.id.startsWith(GUEST_ID_PREFIX) &&
    typeof r.email === 'string' &&
    typeof r.appName === 'string' &&
    typeof r.createdAt === 'string' &&
    typeof r.createdBy === 'string' &&
    typeof r.disabled === 'boolean'
  );
}

function isValidInviteRecord(raw: unknown): raw is InviteTokenRecord {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.secretHash === 'string' &&
    typeof r.appName === 'string' &&
    typeof r.guestId === 'string' &&
    r.guestId.startsWith(GUEST_ID_PREFIX) &&
    typeof r.email === 'string' &&
    typeof r.createdAt === 'number' &&
    typeof r.expiresAt === 'number' &&
    typeof r.createdBy === 'string'
  );
}

export class AppGuestManager {
  private readonly guestsFilePath: string;
  private readonly invitesFilePath: string;
  private readonly maxLiveInviteTokens: number;
  private readonly maxLiveInviteTokensPerCreator: number;

  private guests: Map<string, GuestRecord> = new Map();
  // True only while app-guests.json exists but failed to parse/validate as a
  // whole. See the class doc for why this deliberately never self-clears on
  // a successful write — only a fresh `load()` clears it.
  private guestsCorrupt = false;

  private invites: Map<string, InviteTokenRecord> = new Map();
  private invitesCorrupt = false;

  // Two independent write-serialization chains (see `runQueued`'s own doc):
  // sequences writes to each store so two overlapping calls can't interleave
  // their temp-file writes, WITHOUT letting one rejected write permanently
  // block every later one.
  private guestQueue: Promise<unknown> = Promise.resolve();
  private inviteQueue: Promise<unknown> = Promise.resolve();

  constructor(config?: AppGuestManagerConfig) {
    this.guestsFilePath = config?.guestsFilePath || defaultGuestsFilePath();
    this.invitesFilePath = config?.invitesFilePath || defaultInvitesFilePath();
    this.maxLiveInviteTokens = config?.maxLiveInviteTokens ?? MAX_LIVE_INVITE_TOKENS;
    this.maxLiveInviteTokensPerCreator =
      config?.maxLiveInviteTokensPerCreator ?? MAX_LIVE_INVITE_TOKENS_PER_CREATOR;
  }

  /** (Re)load both stores from disk. Never throws — a corrupt/missing file is reflected in `isCorrupt()`/`isInviteStoreCorrupt()`, not an exception. */
  async load(): Promise<void> {
    await Promise.all([this.loadGuests(), this.loadInvites()]);
  }

  async close(): Promise<void> {
    // No-op: every write this class makes is already awaited by its caller
    // (or, for the one fire-and-forget path, explicitly caught) — see the
    // class doc. Nothing pending to flush, matching settings-manager's
    // close().
  }

  isCorrupt(): boolean {
    return this.guestsCorrupt;
  }

  isInviteStoreCorrupt(): boolean {
    return this.invitesCorrupt;
  }

  // ============ Guest reads (memory-authoritative, fail closed on corrupt) ============

  getGuestById(id: string): GuestRecord | undefined {
    if (this.guestsCorrupt) return undefined;
    return this.guests.get(id);
  }

  getGuestByEmail(email: string, appName: string): GuestRecord | undefined {
    if (this.guestsCorrupt) return undefined;
    return this.findGuestByEmailAndApp(normalizeEmail(email), appName);
  }

  listGuests(): GuestRecord[] {
    if (this.guestsCorrupt) return [];
    return Array.from(this.guests.values());
  }

  guestExists(id: string): boolean {
    return this.getGuestById(id) !== undefined;
  }

  private findGuestByEmailAndApp(normalizedEmail: string, appName: string): GuestRecord | undefined {
    for (const record of this.guests.values()) {
      if (record.email === normalizedEmail && record.appName === appName) return record;
    }
    return undefined;
  }

  /**
   * Whether ANY guest, on ANY app, holds this normalized email — the
   * primitive the plan's "email-collision rule is enforced at both ends"
   * correction needs: a user account must not be creatable (or renameable)
   * to an address a guest already holds, checked GLOBALLY, not scoped to one
   * app the way `getGuestByEmail` is.
   *
   * THROWS on a corrupt store rather than returning `false` the way the
   * other reads return `[]`/`undefined`. Every other getter fails closed in
   * the "may this act" direction (empty = deny), but "is this address
   * taken" is the OPPOSITE polarity: answering `false` while blind would
   * PERMIT the very parallel-identity collision the rule exists to close,
   * not deny an action. A caller (the user-creation/rename path) must
   * treat this exception as "cannot verify, refuse the write" — the same
   * fail-closed posture, expressed the only way that is actually closed for
   * a boolean whose safe default flips depending on what asks it.
   */
  emailHeldByAnyGuest(email: string): boolean {
    if (this.guestsCorrupt) throw new GuestStoreCorruptError();
    const normalized = normalizeEmail(email);
    for (const record of this.guests.values()) {
      if (record.email === normalized) return true;
    }
    return false;
  }

  // ============ Guest writes ============

  /**
   * Resolve the (email, appName) pair to a guest, creating one if none
   * exists yet — in ONE write chain, so two concurrent invites to the same
   * address for the same app cannot mint two guests.
   *
   * The concurrency guarantee is NOT the write-serialization queue below
   * (that only orders writes to disk) — it is that the lookup-decide-insert
   * sequence below contains no `await` before `this.guests.set(...)`. Node
   * runs that whole sequence to completion before yielding to any other
   * async call, so a second concurrent call's own lookup can only observe
   * the first call's insert as already-done or not-yet-started, never
   * halfway. Do not add an `await` between the lookup and the `set` without
   * re-deriving this guarantee.
   *
   * Returns the EXISTING record unmodified if one is found — including a
   * `disabled` one. There is no re-enable-by-invite: reviving a disabled
   * guest goes through `reapGuest` + a fresh call here, never a silent flip
   * back to `disabled: false`. The caller (the `{ email }` share route) is
   * responsible for deciding whether re-inviting a disabled guest is even
   * allowed; this method only resolves identity.
   */
  async resolveOrCreateGuest(email: string, appName: string, createdBy: string): Promise<GuestRecord> {
    if (this.guestsCorrupt) throw new GuestStoreCorruptError();

    const normalizedEmail = normalizeEmail(email);

    // --- synchronous section: no await above this line ---
    let record = this.findGuestByEmailAndApp(normalizedEmail, appName);
    let created = false;
    if (!record) {
      record = {
        id: `${GUEST_ID_PREFIX}${crypto.randomUUID()}`,
        email: normalizedEmail,
        appName,
        createdAt: new Date().toISOString(),
        createdBy,
        disabled: false,
      };
      this.guests.set(record.id, record);
      created = true;
    }
    // --- end synchronous section ---

    if (created) {
      try {
        await this.persistGuests();
      } catch (err) {
        // Roll back the in-memory insert on a failed write — otherwise a
        // caller's retry (same email + app) would find the unpersisted
        // record already in the map and skip the write entirely (the
        // `!record` branch above never re-fires), leaving a guest live in
        // this process's memory that was never actually saved.
        this.guests.delete(record.id);
        throw err;
      }
    }
    return record;
  }

  /**
   * Disable a guest: sets `disabled` and stamps `credentialsInvalidBefore`
   * (same field/semantics as `User`'s — see the class doc). Durable before
   * returning, per the plan's "durability before acknowledgement" — a
   * restart between the ack and the write would otherwise resurrect a
   * revoked guest whose session is still valid.
   *
   * Idempotent: re-disabling an already-disabled guest is a no-op that
   * still returns the current record, without re-stamping (and re-writing)
   * `credentialsInvalidBefore` — bumping it forward on every repeat call
   * would keep invalidating sessions minted since the FIRST disable, not
   * just ones that predate it.
   */
  async disableGuest(id: string, disabledBy: string): Promise<GuestRecord | null> {
    if (this.guestsCorrupt) throw new GuestStoreCorruptError();

    const record = this.guests.get(id);
    if (!record) return null;
    if (record.disabled) return record;

    const previous = {
      disabled: record.disabled,
      disabledBy: record.disabledBy,
      credentialsInvalidBefore: record.credentialsInvalidBefore,
    };
    record.disabled = true;
    record.disabledBy = disabledBy;
    record.credentialsInvalidBefore = new Date().toISOString();

    try {
      await this.persistGuests();
    } catch (err) {
      // Roll back so a retry is not silently swallowed by the "already
      // disabled" idempotent short-circuit above — a failed write must
      // leave nothing half-applied that a caller's retry can't see.
      record.disabled = previous.disabled;
      record.disabledBy = previous.disabledBy;
      record.credentialsInvalidBefore = previous.credentialsInvalidBefore;
      throw err;
    }
    return record;
  }

  /**
   * Best-effort `lastSeenAt` bump. The ONE deliberate exception to
   * "durability before acknowledgement" in this class — see the plan's own
   * carve-out: losing the most recent open time to a crash between the
   * update and the write is a cosmetic loss, not a security one, and
   * awaiting a write on every gated request this class would otherwise be
   * on the hot path for is not a cost worth paying for that field alone.
   *
   * The write is still queued through the SAME `persistGuests()`/`runQueued`
   * path as every durable write (so it can't interleave a torn write with
   * one), and any failure is caught and logged rather than becoming an
   * unhandled rejection — and, per `runQueued`'s own doc, a failure here
   * does not poison a later `await`ed write's ability to succeed.
   */
  touchLastSeen(id: string): void {
    if (this.guestsCorrupt) return;
    const record = this.guests.get(id);
    if (!record) return;
    record.lastSeenAt = new Date().toISOString();
    this.persistGuests().catch((err) => {
      console.error('[app-guest] failed to persist lastSeenAt (best-effort, not retried):', err);
    });
  }

  // ============ The reaper ============

  /**
   * Remove one guest everywhere it appears — callable both on an explicit
   * guest deletion and from a boot-time self-healing pass over stale
   * app-config references (the caller of the latter, `platform.ts`, is
   * responsible for deciding WHICH ids are stale; this function just makes
   * removing one of them complete).
   *
   * ORDER MATTERS: the app-config access grant is revoked FIRST, this
   * store's own bookkeeping second. If the process dies between the two,
   * the guest has already lost access (the security-relevant half), and a
   * later boot pass or repeat call finishes the cleanup — `pruneGuestEntries`
   * and the deletes below are both idempotent.
   *
   * Skipped ENTIRELY when the guest store is corrupt — not "prune what we
   * can": with the store unreadable, "guest not found here" cannot be
   * distinguished from "guest exists but we can't see it", and treating the
   * former as license to strip every app-config guest entry would turn one
   * unreadable file into permanent deletion of every guest grant on the
   * estate (the plan's own §-Corrections warning). Safe to call while
   * corrupt — it just does nothing.
   */
  async reapGuest(guestId: string, deps: ReapGuestDeps = {}): Promise<void> {
    if (this.guestsCorrupt) return;

    const pruneAppConfig = deps.pruneAppConfigGuestEntries ?? defaultPruneAppConfigGuestEntries;
    await pruneAppConfig(guestId);

    const hadGuest = this.guests.delete(guestId);

    let removedInvite = false;
    // Invites bound to this guest are the OTHER thing "everywhere it
    // appears" covers — a stale invite for a deleted guest would otherwise
    // sit live for up to INVITE_TTL_HOURS, redeemable into a session for a
    // guest that no longer resolves (verifyAppGuestSessionToken's live
    // re-read would refuse it, but there is no reason to leave it live).
    for (const [tokenId, invite] of this.invites) {
      if (invite.guestId === guestId) {
        this.invites.delete(tokenId);
        removedInvite = true;
      }
    }

    const writes: Promise<unknown>[] = [];
    if (hadGuest) writes.push(this.persistGuests());
    if (removedInvite && !this.invitesCorrupt) writes.push(this.persistInvites());
    await Promise.all(writes);
  }

  // ============ Invite tokens ============

  /**
   * Mint a single-use invite bound to one app and one (already-resolved)
   * guest. Secret is >=256 bits from `crypto.randomBytes`, never persisted
   * raw — only its sha256 hex digest is. Durable before returning: the
   * secret this method hands back is the ONLY copy that will ever exist in
   * plaintext, so the record naming its hash must be on disk before a
   * caller acts on (e.g. emails) the raw value.
   */
  async mintInviteToken(params: {
    appName: string;
    guestId: string;
    email: string;
    createdBy: string;
  }): Promise<MintedInvite> {
    if (this.invitesCorrupt) throw new InviteStoreCorruptError();

    this.pruneExpiredInvites();
    if (this.invites.size >= this.maxLiveInviteTokens) {
      throw new InviteCapacityError('global');
    }
    // Per-creator bound FIRST-CLASS, not merely covered by the global one —
    // see MAX_LIVE_INVITE_TOKENS_PER_CREATOR's own doc: without this, one
    // principal minting invites in a loop exhausts the global cap and blocks
    // every other app's invites too.
    let liveForCreator = 0;
    for (const record of this.invites.values()) {
      if (record.createdBy === params.createdBy) liveForCreator++;
    }
    if (liveForCreator >= this.maxLiveInviteTokensPerCreator) {
      throw new InviteCapacityError('per_creator');
    }

    const id = crypto.randomUUID();
    const secret = crypto.randomBytes(32).toString('base64url'); // 256 bits
    const now = Date.now();
    const record: InviteTokenRecord = {
      id,
      secretHash: hashSecret(secret),
      appName: params.appName,
      guestId: params.guestId,
      email: normalizeEmail(params.email),
      createdAt: now,
      expiresAt: now + INVITE_TTL_MS,
      createdBy: params.createdBy,
    };
    this.invites.set(id, record);

    await this.persistInvites();
    return { id, secret };
  }

  /**
   * Redeem a single-use invite. Delete-before-check, exactly like
   * `flow-code.ts`'s `consumeAppAccessCode`: the id is deleted from memory
   * BEFORE the secret, expiry or anything else is checked, so a concurrent
   * replay (two requests presenting the same id+secret at once) finds
   * nothing on its second look, and a WRONG secret still burns the token —
   * "presented in the wrong hands" and "hopelessly confused client" get the
   * same fate, neither gets a second attempt.
   *
   * Secret comparison is `crypto.timingSafeEqual` over sha256 digests, never
   * `===` — the id is an attacker-supplied lookup key, so timing on the
   * secret comparison must not leak anything.
   *
   * Returns only `{ guestId, appName, email }` — NOT an app-binding
   * decision. A caller minting a guest session for a specific app must
   * check the result with `inviteBoundToApp` itself; this function has no
   * "expected app" to compare against, because the invite URL
   * (`/api/v1/app-access/invite/<id>#<secret>`) never names one — the app is
   * exactly the thing redemption reveals.
   *
   * If the persisted delete fails, this THROWS rather than returning the
   * redemption payload — returning it after a failed write is the "spent
   * invite replayable after a restart" case durability-before-acknowledgement
   * exists to prevent.
   */
  async redeemInviteToken(id: string, secret: string): Promise<InviteRedemption | null> {
    if (this.invitesCorrupt) return null;

    const prunedAny = this.pruneExpiredInvites();

    // --- synchronous section: delete before any check, no await above this line ---
    const record = this.invites.get(id);
    const existed = this.invites.delete(id);
    // --- end synchronous section ---

    if (existed || prunedAny) {
      // Durable before the caller can act on the outcome — see the method
      // doc. Propagates on failure (no try/catch): a failed persist must
      // surface as an error, not a false "redeemed".
      await this.persistInvites();
    }

    if (!record) return null;
    if (record.expiresAt <= Date.now()) return null;
    if (!timingSafeEqualStrings(hashSecret(secret), record.secretHash)) return null;

    return { guestId: record.guestId, appName: record.appName, email: record.email };
  }

  /** Lazy prune, like `flow-code.ts`'s — a `setInterval` leaks a Jest open handle. Returns whether anything was removed. */
  private pruneExpiredInvites(): boolean {
    const now = Date.now();
    let removed = false;
    for (const [id, record] of this.invites) {
      if (record.expiresAt <= now) {
        this.invites.delete(id);
        removed = true;
      }
    }
    return removed;
  }

  // ============ Persistence ============

  private async loadGuests(): Promise<void> {
    this.guests.clear();
    this.guestsCorrupt = false;

    let data: string;
    try {
      data = await fs.readFile(this.guestsFilePath, 'utf-8');
    } catch (err) {
      // ENOENT = never set (first run) — not corrupt. Anything else (EACCES,
      // EIO, a root-owned file after a restore) is exactly as untrustworthy
      // as unparseable JSON and must fail closed the same way.
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.guestsCorrupt = true;
        console.error('[app-guest] guest store unreadable, refusing all guest operations:', err);
      }
      return;
    }

    try {
      const parsed = JSON.parse(data);
      // Valid JSON but not the expected shape (`null`, `5`, `{}` with no
      // `guests` array) is just as untrustworthy as unparseable bytes.
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { guests?: unknown }).guests)) {
        throw new Error('app-guests.json does not contain a guests array');
      }
      for (const raw of (parsed as { guests: unknown[] }).guests) {
        if (isValidGuestRecord(raw)) {
          this.guests.set(raw.id, raw);
        } else {
          console.error('[app-guest] dropping a malformed guest record on load:', raw);
        }
      }
    } catch (err) {
      console.error('[app-guest] corrupt guest store, refusing all guest operations until repaired + restarted:', err);
      this.guests.clear();
      this.guestsCorrupt = true;
    }
  }

  private async loadInvites(): Promise<void> {
    this.invites.clear();
    this.invitesCorrupt = false;

    let data: string;
    try {
      data = await fs.readFile(this.invitesFilePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.invitesCorrupt = true;
        console.error('[app-guest] invite store unreadable, refusing all invite operations:', err);
      }
      return;
    }

    try {
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { invites?: unknown }).invites)) {
        throw new Error('app-guest-invites.json does not contain an invites array');
      }
      for (const raw of (parsed as { invites: unknown[] }).invites) {
        if (isValidInviteRecord(raw)) {
          this.invites.set(raw.id, raw);
        } else {
          console.error('[app-guest] dropping a malformed invite record on load');
        }
      }
    } catch (err) {
      console.error('[app-guest] corrupt invite store, refusing all invite operations until repaired + restarted:', err);
      this.invites.clear();
      this.invitesCorrupt = true;
    }
  }

  /**
   * Serialize writes to `queueField` without letting a rejected write
   * poison later ones. `chain.then(fn, fn)` runs `fn` next regardless of
   * whether the PRIOR task settled or rejected (both handlers are `fn`
   * itself, called with an argument it ignores), so ordering is preserved
   * even after a failure. The `run` promise (this task's own outcome) is
   * what the caller gets back and may reject; the stored `queue` is reset to
   * an always-fulfilled continuation of it, so the NEXT call's `.then` is
   * never scheduled off a rejected promise. Without this second half, one
   * transient write failure (e.g. the Windows AV/indexer rename race
   * `atomic-write.ts` already retries around) would permanently disable
   * every later save on this store, in this process, until a restart —
   * settings-manager.ts's own `setPublicUrl` comment names this exact trap.
   */
  private runQueued<T>(queue: Promise<unknown>, fn: () => Promise<T>): { run: Promise<T>; next: Promise<unknown> } {
    const run = queue.then(fn, fn) as Promise<T>;
    const next = run.then(
      () => undefined,
      () => undefined
    );
    return { run, next };
  }

  private persistGuests(): Promise<void> {
    const { run, next } = this.runQueued(this.guestQueue, () => this.doPersistGuests());
    this.guestQueue = next;
    return run;
  }

  private async doPersistGuests(): Promise<void> {
    const dir = path.dirname(this.guestsFilePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const snapshot = { version: 1, guests: Array.from(this.guests.values()) };
    // Mode 0600: plaintext guest email addresses at rest, matching every
    // other security-adjacent store under data/drop-svc/. Deliberately does
    // NOT clear `guestsCorrupt` — see the class doc.
    await writeJsonAtomic(this.guestsFilePath, snapshot, { mode: 0o600 });
  }

  private persistInvites(): Promise<void> {
    const { run, next } = this.runQueued(this.inviteQueue, () => this.doPersistInvites());
    this.inviteQueue = next;
    return run;
  }

  private async doPersistInvites(): Promise<void> {
    const dir = path.dirname(this.invitesFilePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const snapshot = { version: 1, invites: Array.from(this.invites.values()) };
    await writeJsonAtomic(this.invitesFilePath, snapshot, { mode: 0o600 });
  }
}

// ============ Singleton + free-function surface ============
//
// `getAppGuestById` is exported as a plain synchronous function (not a
// method a caller must fetch a manager instance to reach) because
// `session-token.ts`'s `verifyAppGuestSessionToken` calls it on every
// request with no `await` — it re-reads the live guest record the same way
// `getUserById` (`auth.ts`) does for the user class. Like
// `getSettingsManager()`, `getAppGuestManager()` never requires an explicit
// config on first call and is safe to call before `load()` has run (reads
// answer from an empty map rather than throwing).

let instance: AppGuestManager | null = null;

export function getAppGuestManager(config?: AppGuestManagerConfig): AppGuestManager {
  if (!instance) {
    instance = new AppGuestManager(config);
  }
  return instance;
}

/**
 * The one `reset*()` this module exposes (the plan's own "one platform.ts
 * init, one reset*()" — see the class doc). Named `resetAppGuests`, not
 * `resetAppGuestManager`: `src/api/app-access/session-token.test.ts` (a
 * sibling change already on this branch) imports it under this name as part
 * of the interface it depends on, and there is exactly one reset function to
 * name, so this file matches that name rather than keeping two exports for
 * one operation.
 */
export function resetAppGuests(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/** Synchronous live lookup — see the module doc above for why this must never become `async`. */
export function getAppGuestById(id: string): GuestRecord | undefined {
  return getAppGuestManager().getGuestById(id);
}

/**
 * Whether ANY guest already holds this email, GLOBALLY — the primitive the
 * plan's "email-collision rule enforced at both ends" correction needs.
 * THROWS on a corrupt store — see `AppGuestManager#emailHeldByAnyGuest`'s
 * own doc for why this reader fails closed by throwing rather than
 * returning `false` the way the other reads return empty/undefined.
 */
export function emailHeldByAnyGuest(email: string): boolean {
  return getAppGuestManager().emailHeldByAnyGuest(email);
}

/**
 * Test/route convenience over `resolveOrCreateGuest`, with the parameter
 * ORDER `session-token.test.ts` calls it with (`appName` before `email`) and
 * an optional `createdBy` (defaults to `'system'` — most callers of this
 * specific convenience are tests or a boot-time fixture, not an admin
 * action; a real invite from `POST /apps/:name/share`'s `{ email }` branch
 * should pass the actual inviting user id instead of relying on the
 * default).
 */
export function createAppGuest(appName: string, email: string, createdBy = 'system'): Promise<GuestRecord> {
  return getAppGuestManager().resolveOrCreateGuest(email, appName, createdBy);
}

/**
 * Set (only) a guest's disabled state. `disabled: false` is REFUSED — there
 * is no guest re-enable path (see the class doc for why: reviving a
 * disabled guest goes through delete + re-invite, which is what keeps "only
 * an admin may delete a disabled record" from being bypassable by a
 * re-enable call that skips that check entirely). The boolean parameter
 * exists to match the shape callers reach for, not to offer a second
 * value.
 */
export async function setAppGuestDisabled(
  guestId: string,
  disabled: boolean,
  disabledBy = 'system'
): Promise<GuestRecord | null> {
  // `async`, not a plain function that `throw`s — a synchronous throw out of
  // a function typed `Promise<...>` bypasses `.catch()` (it never becomes a
  // rejection), which every OTHER refusal in this module surfaces as. A
  // caller written as `setAppGuestDisabled(id, false).catch(...)` would see
  // an uncaught exception instead.
  if (!disabled) {
    throw new Error(
      'Guests cannot be re-enabled — delete (deleteAppGuest) and re-invite (createAppGuest) instead'
    );
  }
  return getAppGuestManager().disableGuest(guestId, disabledBy);
}

/**
 * Module-level convenience wrapper — see `AppGuestManager#reapGuest`'s own
 * doc for the contract. This is the PRIMITIVE name for "remove a guest
 * everywhere it appears".
 */
export function reapGuest(guestId: string, deps?: ReapGuestDeps): Promise<void> {
  return getAppGuestManager().reapGuest(guestId, deps);
}

/**
 * Public deletion entry point — an alias for `reapGuest`, not a second
 * implementation: guest deletion IS the reaper (see the class doc's "prune
 * on guest deletion, not only at boot"), so there is exactly one removal
 * code path regardless of which name a caller reaches for. Named to match
 * `session-token.test.ts`'s import.
 */
export function deleteAppGuest(guestId: string, deps?: ReapGuestDeps): Promise<void> {
  return reapGuest(guestId, deps);
}

/**
 * Pure binding check: does a redeemed invite belong to `appName`? Exported
 * rather than folded into `redeemInviteToken` (which has no "expected app"
 * to compare against — see that method's own doc) so a caller minting a
 * guest session for a specific app has an explicit, independently-testable
 * refusal instead of an inline `redemption.appName === appName` at the call
 * site.
 */
export function inviteBoundToApp(redemption: InviteRedemption, appName: string): boolean {
  return redemption.appName === appName;
}

export { normalizeEmail };
