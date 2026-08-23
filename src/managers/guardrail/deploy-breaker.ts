/**
 * Deploy circuit breaker (Step 7, Feature 3).
 *
 * A sliding window of consecutive failures per key. Five failures in ten
 * minutes opens the breaker for fifteen; a SUCCESS clears the window entirely,
 * so an agent that is making progress is never throttled — only one stuck in a
 * loop is.
 *
 * IN-MEMORY ONLY, and a restart clears it. That is deliberate: this is a
 * loop-stopper, not a security control. The evidence of what happened is
 * retained durably in deploy-details.json; this only decides whether to keep
 * spending build capacity on something that keeps failing the same way.
 */

import {
  getPrincipalQuota,
  QuotaExceededError,
} from './principal-quota';

/** Failures within the window before the breaker opens. */
const DEFAULT_THRESHOLD = 5;
/** How far back failures are counted. */
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
/** How long the breaker stays open once tripped. */
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
/**
 * Failures across ALL of one human's sessions and apps before the backstop
 * opens. Looser than the per-principal threshold on purpose: this window spans
 * everything they are doing, so it must not fire on someone legitimately
 * juggling several apps.
 */
const DEFAULT_OWNER_THRESHOLD = 15;

export interface BreakerVerdict {
  allowed: boolean;
  /** Seconds until the breaker closes. Present only when blocked. */
  retryAfterSeconds?: number;
  /** How many failures are currently counted against the key. */
  failures: number;
}

interface KeyState {
  /** Timestamps of failures still inside the window. */
  failures: number[];
  /** When the cooldown ends, if the breaker is open. */
  openUntil?: number;
}

export interface DeployBreakerOptions {
  threshold?: number;
  /** Threshold for the coarser owner-level backstop. Looser by design — see ownerKey. */
  ownerThreshold?: number;
  windowMs?: number;
  cooldownMs?: number;
}

/**
 * Key for a deploy attempt.
 *
 * A REDEPLOY keys on app + principal, so one runaway agent cannot throttle a
 * different agent working on the same app, and cannot be dodged by switching
 * apps.
 *
 * A NEW app keys on the principal and a fixed marker rather than the app name.
 * Step 10 gives every ephemeral deploy a fresh random name, so a per-name key
 * would start at zero every time and never accumulate — the loop this is meant
 * to stop is exactly the one that keeps creating new names.
 */
export function breakerKey(principalId: string | undefined, appName?: string): string {
  const principal = principalId ?? 'anonymous';
  return appName ? `${appName}::${principal}` : `${principal}::__new__`;
}

/** Key for a deploy DROP itself triggered, where there is no caller principal. */
export function automationKey(source: 'webhook' | 'watcher', appName: string): string {
  return `${source}::${appName}`;
}

/**
 * Coarser BACKSTOP key, one per human.
 *
 * The per-principal window alone is defeatable without any attacker effort: a
 * fresh authorization-code exchange mints a new `sid`, hence a brand-new
 * principal with no failure history. An autonomous agent cannot reach that
 * flow — re-consent needs a session-authenticated approval an OAuth token
 * cannot make — but a user who clicks "reconnect" after a trip clears the
 * cooldown, which is the realistic path and needs no malice at all.
 *
 * So a deploy is checked against BOTH windows and must pass both. This one is
 * deliberately looser (a larger threshold), because it spans every session and
 * every app a human has: it exists to stop a loop that keeps re-minting
 * identities, not to throttle someone working normally across several apps.
 */
export function ownerKey(userId: string): string {
  return `owner::${userId}`;
}

/**
 * A key together with the rules that apply to it.
 *
 * The threshold travels WITH the key rather than being inferred from its text:
 * an app may legitimately be named `owner`, which makes `breakerKey(p, 'owner')`
 * read as `owner::<principal>` and would otherwise hand an attacker-chosen app
 * name the looser backstop budget.
 */
export interface GuardrailKey {
  key: string;
  /** Failures inside the window before this key opens. */
  threshold: number;
  /**
   * Whether a success wipes this window.
   *
   * TRUE for the per-principal window: it exists to stop a loop, and a success
   * proves the caller is making progress.
   *
   * FALSE for the owner backstop, and that difference is what makes it a
   * backstop at all. `breakerKey(principal, undefined)` is one shared
   * `<principal>::__new__` bucket for every new-app deploy, so if a success
   * cleared the owner window too, four expensive failing deploys followed by
   * one trivial static app that builds in a second would wipe both windows —
   * repeatable forever, and neither would ever reach its threshold. The owner
   * window decays only by time, which is sufficient: `prune` already drops
   * anything older than the window, so a caller cannot accumulate toward it on
   * a history of successes. (An earlier revision of this file claimed they
   * could; that was simply wrong — only failures are ever stored.)
   */
  clearOnSuccess: boolean;
}

export class DeployBreaker {
  /** Defaults. Callers pass the applicable one explicitly via GuardrailKey. */
  readonly threshold: number;
  readonly ownerThreshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly state: Map<string, KeyState> = new Map();

  constructor(opts: DeployBreakerOptions = {}) {
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    this.ownerThreshold = opts.ownerThreshold ?? DEFAULT_OWNER_THRESHOLD;
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
    this.cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  /** Whether a deploy may proceed. Pure with respect to failure counting. */
  check(key: string, now = Date.now()): BreakerVerdict {
    const entry = this.state.get(key);
    if (!entry) return { allowed: true, failures: 0 };

    if (entry.openUntil !== undefined) {
      if (entry.openUntil > now) {
        return {
          allowed: false,
          retryAfterSeconds: Math.ceil((entry.openUntil - now) / 1000),
          failures: entry.failures.length,
        };
      }
      // Cooldown served. Reopen for business with a CLEAN window — carrying the
      // old failures forward would re-trip on the next single failure, turning
      // one bad patch into a permanent block.
      this.state.delete(key);
      return { allowed: true, failures: 0 };
    }

    return { allowed: true, failures: this.prune(entry, now).length };
  }

  /**
   * Record a failed deploy. Returns the verdict for the NEXT attempt, so a
   * caller can report "this was your last one" in the same breath.
   */
  recordFailure(key: string, now = Date.now(), threshold = this.threshold): BreakerVerdict {
    const entry = this.state.get(key) ?? { failures: [] };
    const failures = this.prune(entry, now);
    failures.push(now);
    entry.failures = failures;

    if (failures.length >= threshold) {
      entry.openUntil = now + this.cooldownMs;
    }
    this.state.set(key, entry);

    return this.check(key, now);
  }

  /**
   * Record a successful deploy, clearing the window.
   *
   * Total reset, not a decrement: the breaker exists to stop a LOOP, and a
   * success proves the caller is making progress. Leaving four failures on the
   * board would trip them on their next unrelated stumble.
   */
  recordSuccess(key: string): void {
    this.state.delete(key);
  }

  /** Forget a key entirely (app deleted, or an operator override). */
  reset(key: string): void {
    this.state.delete(key);
  }

  /** Drop everything. Tests and shutdown. */
  clear(): void {
    this.state.clear();
  }

  private prune(entry: KeyState, now: number): number[] {
    const cutoff = now - this.windowMs;
    entry.failures = entry.failures.filter((at) => at > cutoff);
    return entry.failures;
  }
}

let instance: DeployBreaker | null = null;

export function getDeployBreaker(opts?: DeployBreakerOptions): DeployBreaker {
  if (!instance) instance = new DeployBreaker(opts);
  return instance;
}

export function resetDeployBreaker(): void {
  instance = null;
}

/** The guardrail-relevant slice of a deploy request or event payload. */
export interface DeployActorInfo {
  principalId?: string;
  actorUserId?: string;
  automationSource?: 'webhook';
}

/**
 * Refusal raised by a pre-check at a deploy ENTRY point.
 *
 * Distinct from the platform's in-pipeline refusal (which reports through
 * failDeployEpisode so a polling caller gets an outcome): here nothing has been
 * started yet, so the caller is told synchronously and no episode exists.
 */
export class DeployRefusedError extends Error {
  constructor(
    public readonly failures: number,
    public readonly retryAfterSeconds: number
  ) {
    super(`Too many failed deploys (${failures}). Retry in ${retryAfterSeconds}s.`);
    this.name = 'DeployRefusedError';
  }
}

/**
 * The keys a deploy is checked against, in order.
 *
 * TWO windows for a real caller, and the deploy must pass BOTH. The
 * per-principal one is defeatable with no attacker effort: a fresh
 * authorization-code exchange mints a new sid, hence a new principal with no
 * failure history. An autonomous agent cannot reach that flow — re-consent
 * needs a session-authenticated approval an OAuth token cannot make — but a
 * user clicking "reconnect" after a trip clears their own cooldown, which is
 * the realistic path and needs no malice at all. The owner window spans every
 * session and app that human has, so re-minting an identity does not escape it.
 *
 * Automation gets ONE key and no owner window: it has no human to attribute the
 * failures to, and borrowing the app owner's would let a looping webhook consume
 * the quota of someone who did nothing.
 *
 * Lives here rather than on the platform because the entry points (upload,
 * git clone) pre-check with it too, and two copies of this would drift.
 */
export function guardrailKeysFor(
  appName: string,
  isNewApp: boolean,
  actor: DeployActorInfo
): GuardrailKey[] {
  const breaker = getDeployBreaker();
  if (!actor.principalId) {
    return [
      {
        key: automationKey(actor.automationSource ?? 'watcher', appName),
        threshold: breaker.threshold,
        clearOnSuccess: true,
      },
    ];
  }
  const keys: GuardrailKey[] = [
    {
      key: breakerKey(actor.principalId, isNewApp ? undefined : appName),
      threshold: breaker.threshold,
      clearOnSuccess: true,
    },
  ];
  // Only when the actor's own human is known. Falling back to the app's owner
  // would be wrong in both directions: a NEW app has no state to read, so every
  // user's first-deploy failures would share one bucket and any user could lock
  // out every other.
  if (actor.actorUserId) {
    keys.push({
      key: ownerKey(actor.actorUserId),
      threshold: breaker.ownerThreshold,
      // Decay-only. See GuardrailKey.clearOnSuccess.
      clearOnSuccess: false,
    });
  }
  return keys;
}

/** First refusal among the keys, or an allow. */
export function checkGuardrailKeys(keys: GuardrailKey[]): BreakerVerdict {
  const breaker = getDeployBreaker();
  // Short-circuits deliberately. `check` is NOT side-effect-free: it deletes a
  // key whose cooldown has lapsed. Evaluating every key on an attempt that is
  // already refused would silently expire the owner backstop's cooldown on
  // traffic that was rejected — i.e. rejected retries would reset it.
  for (const { key } of keys) {
    const verdict = breaker.check(key);
    if (!verdict.allowed) return verdict;
  }
  return { allowed: true, failures: 0 };
}

/**
 * Admit a deploy at an ENTRY point, before any expensive work.
 *
 * The in-pipeline gates sit at the build, which leaves everything BEFORE the
 * build unmetered: upload-deploy extracts and lands the archive, and git-deploy
 * clones the repo, both before the platform ever sees an event. A refused
 * caller could still make DROP do that work on every attempt.
 *
 * ORDER MATTERS. Breaker first, then quota, and the quota is spent only once
 * BOTH have passed — a refused attempt must never consume the allowance that
 * would have refused it, and a breaker refusal must not burn quota either.
 *
 * The breaker outcome is still recorded once, by the platform, for the episode
 * this admits; only the quota is counted here, because volume is counted on
 * admission rather than on outcome.
 */
export async function admitDeploy(
  appName: string,
  isNewApp: boolean,
  actor: DeployActorInfo
): Promise<void> {
  const verdict = checkGuardrailKeys(guardrailKeysFor(appName, isNewApp, actor));
  if (!verdict.allowed) {
    throw new DeployRefusedError(verdict.failures, verdict.retryAfterSeconds ?? 0);
  }

  const quota = getPrincipalQuota();
  await quota.initialize();
  const keysResult = quota.keysFor(actor);
  if (!keysResult.metered) return; // automation escape hatch — nothing to meter, see keysFor's own doc
  const q = quota.check(keysResult.keys);
  if (!q.allowed) {
    throw new QuotaExceededError(q.used ?? 0, q.limit ?? 0, q.retryAfterSeconds ?? 0);
  }
  quota.record(keysResult.keys);
}

/**
 * Breaker-only pre-check, synchronous.
 *
 * Kept separate from admitDeploy so the platform's in-pipeline gates stay
 * synchronous and, more importantly, do NOT spend quota: they run on the same
 * deploy an entry point already counted, and counting twice would halve every
 * caller's real allowance.
 */
export function assertDeployAllowed(
  appName: string,
  isNewApp: boolean,
  actor: DeployActorInfo
): void {
  const verdict = checkGuardrailKeys(guardrailKeysFor(appName, isNewApp, actor));
  if (!verdict.allowed) {
    throw new DeployRefusedError(verdict.failures, verdict.retryAfterSeconds ?? 0);
  }
}
