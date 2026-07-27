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

/** Failures within the window before the breaker opens. */
const DEFAULT_THRESHOLD = 5;
/** How far back failures are counted. */
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
/** How long the breaker stays open once tripped. */
const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

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

export class DeployBreaker {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly state: Map<string, KeyState> = new Map();

  constructor(opts: DeployBreakerOptions = {}) {
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
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
  recordFailure(key: string, now = Date.now()): BreakerVerdict {
    const entry = this.state.get(key) ?? { failures: [] };
    const failures = this.prune(entry, now);
    failures.push(now);
    entry.failures = failures;

    if (failures.length >= this.threshold) {
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
