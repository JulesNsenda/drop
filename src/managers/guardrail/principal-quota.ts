/**
 * Per-principal deploy quota (Step 8b).
 *
 * DISTINCT FROM THE CIRCUIT BREAKER, and the difference is the whole point:
 * the breaker stops a *failing* loop and resets the moment a deploy succeeds,
 * so a caller who alternates success and failure is never throttled by it.
 * This caps total VOLUME regardless of outcome — an agent redeploying
 * successfully a hundred times an hour is still spending the box's build
 * capacity, and nothing in Step 7 notices.
 *
 * Exceeding returns a structured refusal, never a silent kill.
 *
 * `PrincipalQuota` is also the engine behind the MAIL quota (DROP-154) —
 * `getMailQuota()` below, a second instance rather than a fork, per the
 * plan's own reasoning: this eviction/capacity policy was reasoned about
 * once and duplicating it would duplicate the chance to get it wrong twice.
 * Mail differs from deploys in exactly two ways, both driven by
 * `PrincipalQuotaOptions` rather than hardcoded: it has no unmetered branch
 * (an absent principal REFUSES rather than passing free — see `keysFor`),
 * and it fails closed when the tracked-principal table is full (see
 * `failClosedWhenFull` on `check`/`record`) rather than degrading by quietly
 * leaving new principals untracked, which for an outbound channel is a
 * straightforward cap bypass.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { writeJsonAtomic } from '../../utils/atomic-write';
import type { DeployActorInfo } from './deploy-breaker';

/** Deploys per principal per window. */
const DEFAULT_PRINCIPAL_LIMIT = 20;
/**
 * Deploys per HUMAN per window, across every session and credential they have.
 *
 * Looser than the per-principal limit and separately enforced, for the same
 * reason the breaker has an owner backstop: `oauth:<sub>::<sid>` embeds the
 * session, so a fresh authorization-code exchange mints a brand-new principal
 * with a brand-new empty quota. An autonomous agent cannot reach that flow —
 * re-consent needs a session-authenticated approval an OAuth token cannot make
 * — but a user clicking "reconnect" gets a clean hour, and that needs no
 * malice at all. This window spans every session, so re-minting cannot escape
 * it.
 */
const DEFAULT_OWNER_LIMIT = 60;
const WINDOW_MS = 60 * 60 * 1000;

/**
 * Cap on tracked PRINCIPAL entries.
 *
 * Generous, because TTL pruning already bounds the file to principals that
 * deployed within the last hour. It exists only so a caller minting identities
 * in a loop cannot grow the file without limit.
 *
 * Nothing live is ever evicted to make room — see `record`. Evicting by age or
 * insertion order would throw out whichever entry sits closest to its limit,
 * which is precisely the record a re-minting caller wants gone.
 */
const MAX_TRACKED_PRINCIPALS = 5000;

export interface QuotaKey {
  key: string;
  limit: number;
  /**
   * Owner entries are never dropped for capacity: they are bounded by the
   * number of real users, and they are the window a re-minting caller cannot
   * escape. If the principal cap is ever reached, per-principal tracking
   * degrades and this keeps enforcing.
   */
  kind: 'principal' | 'owner';
}

export interface QuotaVerdict {
  allowed: boolean;
  /** The limit that refused, when refused. */
  limit?: number;
  used?: number;
  retryAfterSeconds?: number;
  /**
   * Set only on the `failClosedWhenFull` refusal path — the table itself is
   * at capacity, not the key's own window. `used`/`retryAfterSeconds` do not
   * apply: the key was never tracked, so there is nothing to report aging
   * out.
   */
  reason?: 'table_full';
}

/**
 * The result of `PrincipalQuota#keysFor`. See its doc comment for why this
 * is a union rather than `QuotaKey[] | null`.
 */
export type MeteredKeys =
  | { metered: true; keys: QuotaKey[] }
  | { metered: false; reason: 'no_principal' };

/** Refusal raised by the quota. Distinct from the breaker's DeployRefusedError. */
export class QuotaExceededError extends Error {
  constructor(
    public readonly used: number,
    public readonly limit: number,
    public readonly retryAfterSeconds: number
  ) {
    super(`Deploy quota exceeded (${used}/${limit} this hour). Retry in ${retryAfterSeconds}s.`);
    this.name = 'QuotaExceededError';
  }
}

function principalLimit(): number {
  const raw = parseInt(process.env.DROP_MAX_REDEPLOYS_PER_HOUR || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PRINCIPAL_LIMIT;
}

function ownerLimit(): number {
  const raw = parseInt(process.env.DROP_MAX_REDEPLOYS_PER_HOUR_PER_USER || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_OWNER_LIMIT;
}

/**
 * Shared key-building shape for a principal-bearing actor, factored out so
 * the deploy free function below and the instance method `keysFor` cannot
 * silently diverge — a second implementation copy is exactly the fork this
 * file exists to avoid.
 */
function buildQuotaKeys(
  actor: DeployActorInfo,
  principalLimitValue: number,
  ownerLimitValue: number
): QuotaKey[] {
  const keys: QuotaKey[] = [
    { key: actor.principalId as string, limit: principalLimitValue, kind: 'principal' },
  ];
  if (actor.actorUserId) {
    keys.push({ key: `owner::${actor.actorUserId}`, limit: ownerLimitValue, kind: 'owner' });
  }
  return keys;
}

/**
 * The quota keys for a caller.
 *
 * Automation (no principal) is deliberately NOT quota'd: it has no human to
 * attribute volume to, and every platform restart re-deploys the whole fleet
 * through the watcher — which would otherwise spend every owner's allowance on
 * a reboot. Its runaway case is the breaker's automation key.
 *
 * Deploy-only: reads the env-var-backed limits directly. The mail instance
 * uses `PrincipalQuota#keysFor` instead, which has no unmetered branch — see
 * the module doc comment.
 */
export function quotaKeysFor(actor: DeployActorInfo): QuotaKey[] {
  if (!actor.principalId) return [];
  return buildQuotaKeys(actor, principalLimit(), ownerLimit());
}

interface QuotaStore {
  /** key -> deploy timestamps (ms), all inside the window. */
  deploys: Record<string, number[]>;
}

export interface PrincipalQuotaOptions {
  /** Override the tracked-principal cap. Tests, and per-box tuning. */
  maxTrackedPrincipals?: number;
  /** Override the rolling window. Deploys use one hour; tests, and mail. */
  windowMs?: number;
  /**
   * Override the per-principal limit used by `keysFor` (NOT by the free
   * `quotaKeysFor`, which always reads the deploy env var). Falls back to
   * the same env-var-backed default as deploys when unset, so a caller that
   * does not pass this explicitly gets the same number either way rather
   * than two limit sources silently drifting apart.
   */
  principalLimit?: number;
  /** Override the per-owner limit used by `keysFor`. Same fallback as above. */
  ownerLimit?: number;
  /**
   * Whether an actor with no `principalId` is unmetered (deploy's automation
   * escape hatch — see `quotaKeysFor`) or refused outright.
   *
   * Default `true`, preserving deploy behaviour exactly. Mail sets this
   * `false`: an absent principal on an outbound channel is not automation
   * with nothing to attribute volume to, it is an unmetered send path.
   */
  unmeteredWithoutPrincipal?: boolean;
  /**
   * Whether a brand-new principal, arriving while the tracked-principal
   * table is already at `maxTrackedPrincipals`, is refused (`check`
   * returns `{ allowed: false, reason: 'table_full' }`, `record` returns
   * `false`) or silently left untracked as before.
   *
   * Default `false`, preserving deploy behaviour exactly: `record` still
   * degrades gracefully rather than refusing, because the owner window
   * keeps enforcing regardless (see `record`'s own comment). Mail sets this
   * `true` — leaving a principal untracked there is not graceful
   * degradation, it is a caller who can mint principals evading the
   * per-principal limit entirely once the table fills.
   */
  failClosedWhenFull?: boolean;
}

export class PrincipalQuota {
  private readonly storePath: string;
  private readonly maxTrackedPrincipals: number;
  private readonly windowMs: number;
  private readonly principalLimitOverride?: number;
  private readonly ownerLimitOverride?: number;
  private readonly unmeteredWithoutPrincipal: boolean;
  private readonly failClosedWhenFull: boolean;
  /**
   * IN-MEMORY IS AUTHORITATIVE; the file is durability across a restart.
   *
   * Deliberately not the other way round. Reading the file on the check path
   * would make every disk error fail OPEN — a bypass available to anyone who
   * can make a write fail — whereas this way a failed write costs at most the
   * count across a restart.
   */
  private store: QuotaStore = { deploys: {} };
  private initialized = false;
  /** The in-flight persist, so callers can await it on shutdown. */
  private lastSave: Promise<void> = Promise.resolve();

  constructor(storePath: string, opts: PrincipalQuotaOptions = {}) {
    this.storePath = storePath;
    this.maxTrackedPrincipals = opts.maxTrackedPrincipals ?? MAX_TRACKED_PRINCIPALS;
    this.windowMs = opts.windowMs ?? WINDOW_MS;
    this.principalLimitOverride = opts.principalLimit;
    this.ownerLimitOverride = opts.ownerLimit;
    this.unmeteredWithoutPrincipal = opts.unmeteredWithoutPrincipal ?? true;
    this.failClosedWhenFull = opts.failClosedWhenFull ?? false;
  }

  /**
   * Instance-scoped equivalent of the module-level `quotaKeysFor`.
   *
   * Returns a discriminated union rather than `QuotaKey[] | null` on
   * purpose: `[]` already means "no gating needed" (`check([])` allows), so
   * a caller writing `keysFor(actor) ?? []` would silently reconstruct the
   * unmetered branch this exists to remove. `metered: false` must be handled
   * explicitly by the caller.
   */
  keysFor(actor: DeployActorInfo): MeteredKeys {
    if (!actor.principalId) {
      return this.unmeteredWithoutPrincipal
        ? { metered: true, keys: [] }
        : { metered: false, reason: 'no_principal' };
    }
    return {
      metered: true,
      keys: buildQuotaKeys(
        actor,
        this.principalLimitOverride ?? principalLimit(),
        this.ownerLimitOverride ?? ownerLimit()
      ),
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      const raw = await fs.readFile(this.storePath, 'utf-8');
      const parsed = JSON.parse(raw) as QuotaStore;
      this.store = { deploys: parsed?.deploys ?? {} };
      this.pruneAll(Date.now());
    } catch {
      this.store = { deploys: {} };
    }
    this.initialized = true;
  }

  /**
   * Whether adding `keys` would need to start tracking a NEW principal while
   * the table is already at `maxTrackedPrincipals`.
   *
   * Shared by `check` and `record` so the two agree: "known" must be read
   * BEFORE `prune` in both places (an aged-out-but-still-present key is
   * still "known" for capacity purposes; only a genuinely new key needs a
   * fresh slot). Owner keys never count against the cap — see `record`'s own
   * comment on `kind === 'principal'`.
   */
  private wouldOverflowTable(keys: QuotaKey[]): boolean {
    if (Object.keys(this.store.deploys).length < this.maxTrackedPrincipals) return false;
    return keys.some(
      ({ key, kind }) => kind === 'principal' && this.store.deploys[key] === undefined
    );
  }

  /** Whether a deploy may proceed. Counts nothing. */
  check(keys: QuotaKey[], now = Date.now()): QuotaVerdict {
    if (this.failClosedWhenFull && this.wouldOverflowTable(keys)) {
      // The table itself is full, not any individual key's window. Deploys
      // never reach here (`failClosedWhenFull` defaults false); mail refuses
      // rather than falling into `record`'s degrade-gracefully path, which
      // for an outbound channel is a cap bypass — see the module doc.
      return { allowed: false, reason: 'table_full' };
    }
    for (const { key, limit } of keys) {
      const used = this.prune(key, now).length;
      if (used >= limit) {
        // Room frees when the OLDEST deploy in the window ages out.
        const oldest = this.store.deploys[key][0];
        const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
        return { allowed: false, limit, used, retryAfterSeconds };
      }
    }
    return { allowed: true };
  }

  /**
   * Count a deploy against every key. Call only once a deploy is ADMITTED — a
   * refused attempt must never consume the allowance that refused it.
   *
   * Returns `false` (and records nothing at all) when `failClosedWhenFull`
   * refuses the whole call — an action that never happened must not consume
   * even the keys that still had room, matching the rule above. Deploys
   * (`failClosedWhenFull` false) always get `true`; they keep the older
   * per-key degrade-gracefully behaviour below instead, which
   * `wouldOverflowTable` guards this branch from ever reaching for them.
   */
  record(keys: QuotaKey[], now = Date.now()): boolean {
    if (this.failClosedWhenFull && this.wouldOverflowTable(keys)) {
      return false;
    }
    for (const { key, kind } of keys) {
      const known = this.store.deploys[key] !== undefined;
      if (
        !known &&
        kind === 'principal' &&
        Object.keys(this.store.deploys).length >= this.maxTrackedPrincipals
      ) {
        // Cap reached. Skip tracking this NEW principal rather than evicting a
        // live entry to make room: whatever got evicted would be the record
        // closest to its limit, which is exactly what a caller minting
        // identities is trying to achieve. The owner window still counts them.
        continue;
      }
      const list = this.prune(key, now);
      list.push(now);
      this.store.deploys[key] = list;
    }
    this.lastSave = this.save();
    return true;
  }

  /**
   * Await the in-flight persist.
   *
   * Recording is deliberately fire-and-forget — a deploy must not wait on a
   * disk write — so shutdown and tests need a way to let the last one land.
   */
  async flush(): Promise<void> {
    await this.lastSave;
  }

  /** Drop a key entirely. Tests and operator override. */
  reset(key: string): void {
    delete this.store.deploys[key];
  }

  /** How many deploys are counted against a key right now. */
  used(key: string, now = Date.now()): number {
    return this.prune(key, now).length;
  }

  /** Timestamps still inside the window, pruned in place. */
  private prune(key: string, now: number): number[] {
    const cutoff = now - this.windowMs;
    const kept = (this.store.deploys[key] ?? []).filter((at) => at > cutoff);
    if (kept.length === 0) delete this.store.deploys[key];
    else this.store.deploys[key] = kept;
    return kept;
  }

  private pruneAll(now: number): void {
    for (const key of Object.keys(this.store.deploys)) this.prune(key, now);
  }

  private async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.storePath), { recursive: true });
      await writeJsonAtomic(this.storePath, this.store);
    } catch {
      // Best-effort. The in-memory count is authoritative, so a failed write
      // costs the count across a restart and never opens the gate.
    }
  }
}

let instance: PrincipalQuota | null = null;

/**
 * The singleton.
 *
 * The platform passes an absolute path under DROP_ROOT during startup. The
 * fallback is RELATIVE and therefore resolves against the process CWD — which
 * is wherever `drop serve` happened to be launched, not the DROP root — so it
 * is a last resort for callers that run before initialization, never the
 * intended production path.
 */
export function getPrincipalQuota(storePath?: string): PrincipalQuota {
  if (!instance) {
    instance = new PrincipalQuota(storePath ?? 'data/drop-svc/principal-quotas.json');
  }
  return instance;
}

export function resetPrincipalQuota(): void {
  instance = null;
}

let mailInstance: PrincipalQuota | null = null;

/**
 * The mail singleton (DROP-154). Same engine, same RELATIVE-fallback caveat
 * as `getPrincipalQuota` above, but the two DELIBERATE option differences
 * described on the module doc comment: no unmetered branch, and fails closed
 * when the tracked-principal table is full. A caller needing different
 * limits or window can construct its own `PrincipalQuota` directly — this
 * singleton exists for the common case of one shared mail quota.
 *
 * Not wired into any route or into `platform.ts` here — that is a later
 * slice's job (§7/§9 of the plan). Note for that wiring: nothing calls
 * `flush()` on this instance today (the deploy singleton's is flushed in
 * `platform.stop()`), and `QuotaExceededError`'s message is worded for
 * deploys ("Deploy quota exceeded... Retry in Xs") — a mail caller catching
 * it should not surface that string to a user.
 */
export function getMailQuota(storePath?: string): PrincipalQuota {
  if (!mailInstance) {
    mailInstance = new PrincipalQuota(storePath ?? 'data/drop-svc/mail-quotas.json', {
      unmeteredWithoutPrincipal: false,
      failClosedWhenFull: true,
    });
  }
  return mailInstance;
}

export function resetMailQuota(): void {
  mailInstance = null;
}
