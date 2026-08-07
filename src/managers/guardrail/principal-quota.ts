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
}

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
 * The quota keys for a caller.
 *
 * Automation (no principal) is deliberately NOT quota'd: it has no human to
 * attribute volume to, and every platform restart re-deploys the whole fleet
 * through the watcher — which would otherwise spend every owner's allowance on
 * a reboot. Its runaway case is the breaker's automation key.
 */
export function quotaKeysFor(actor: DeployActorInfo): QuotaKey[] {
  if (!actor.principalId) return [];
  const keys: QuotaKey[] = [
    { key: actor.principalId, limit: principalLimit(), kind: 'principal' },
  ];
  if (actor.actorUserId) {
    keys.push({ key: `owner::${actor.actorUserId}`, limit: ownerLimit(), kind: 'owner' });
  }
  return keys;
}

interface QuotaStore {
  /** key -> deploy timestamps (ms), all inside the window. */
  deploys: Record<string, number[]>;
}

export interface PrincipalQuotaOptions {
  /** Override the tracked-principal cap. Tests, and per-box tuning. */
  maxTrackedPrincipals?: number;
}

export class PrincipalQuota {
  private readonly storePath: string;
  private readonly maxTrackedPrincipals: number;
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

  /** Whether a deploy may proceed. Counts nothing. */
  check(keys: QuotaKey[], now = Date.now()): QuotaVerdict {
    for (const { key, limit } of keys) {
      const used = this.prune(key, now).length;
      if (used >= limit) {
        // Room frees when the OLDEST deploy in the window ages out.
        const oldest = this.store.deploys[key][0];
        const retryAfterSeconds = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
        return { allowed: false, limit, used, retryAfterSeconds };
      }
    }
    return { allowed: true };
  }

  /**
   * Count a deploy against every key. Call only once a deploy is ADMITTED — a
   * refused attempt must never consume the allowance that refused it.
   */
  record(keys: QuotaKey[], now = Date.now()): void {
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
    const cutoff = now - WINDOW_MS;
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
