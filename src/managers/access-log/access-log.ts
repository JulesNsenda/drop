/**
 * Access Log Service (DROP-152)
 *
 * Records the access gate's per-request admit/refuse decisions. This is the
 * evidence trail behind a governance claim ("who has opened this app") — it
 * is deliberately append-only and MUST NOT be able to influence the decision
 * it records: the gate calls `record()` fire-and-forget, after the decision
 * is already made.
 *
 * Two properties set this apart from every other logger in the codebase:
 *  - it sits on the request hot path, so `record()` never awaits and never
 *    throws (the same posture as LogRetentionService.pruneOnce: "log hygiene
 *    must not crash the platform" — here that's writes instead of deletes);
 *  - a gated PUBLIC app hands an anonymous attacker the trigger. Identical
 *    (app, principal, decision) hits within a short window are aggregated
 *    into one row with a count, and a per-app-per-day byte cap stops a
 *    refusal flood from growing the log without bound. The cap NEVER
 *    suppresses admits — an attacker must not be able to blind the admit
 *    trail by flooding refusals.
 */

import * as path from 'path';
import * as fs from 'fs/promises';

export interface AccessLogEntry {
  appName: string;
  decision: 'admit' | 'refuse';
  /** Absent for an anonymous refusal. */
  userId?: string;
  username?: string;
  /** Why refused. */
  reason?: string;
}

export interface AccessLogOptions {
  /** Aggregation window for identical (app, principal, decision) hits. */
  windowMs?: number;
  /** Per-app, per-day byte budget before refusal rows are suppressed. */
  capBytesPerAppPerDay?: number;
  /** How often a suppressed-refusal summary row is emitted once capped. */
  summaryIntervalMs?: number;
}

const DEFAULT_WINDOW_MS = 5_000;
const DEFAULT_CAP_BYTES_PER_APP_PER_DAY = 5 * 1024 * 1024; // 5MB
const DEFAULT_SUMMARY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

interface Aggregate {
  appName: string;
  decision: 'admit' | 'refuse';
  userId?: string;
  username?: string;
  reason?: string;
  count: number;
  timer: NodeJS.Timeout;
}

interface SuppressedCounter {
  count: number;
  windowStart: string;
  timer: NodeJS.Timeout;
}

/** UTC calendar day, so the byte cap and the filename never disagree about "today". */
function dayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function principalKey(entry: AccessLogEntry): string {
  return entry.userId ?? 'anonymous';
}

// NUL can't appear in an app name, decision literal or userId, so it is a
// safe join separator for a composite map key.
function aggregateKey(entry: AccessLogEntry): string {
  return `${entry.appName}\u0000${entry.decision}\u0000${principalKey(entry)}`;
}

function appDayKey(appName: string, day: string): string {
  return `${appName}\u0000${day}`;
}

export class AccessLogService {
  private readonly logsRoot: string;
  private readonly windowMs: number;
  private readonly capBytesPerAppPerDay: number;
  private readonly summaryIntervalMs: number;

  // Identical (app, principal, decision) hits within `windowMs`, waiting to
  // collapse into one row.
  private readonly aggregates = new Map<string, Aggregate>();
  // Bytes written per (app, day) — the refusal-cap accounting. Resets only
  // when the process restarts; that's an accepted limitation of an
  // in-memory counter, not a durable budget.
  private readonly bytesPerAppDay = new Map<string, number>();
  // Refusal rows suppressed by the cap, counted (never written per-event)
  // until the hourly summary flush.
  private readonly suppressed = new Map<string, SuppressedCounter>();

  constructor(logsRoot: string, options: AccessLogOptions = {}) {
    this.logsRoot = logsRoot;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.capBytesPerAppPerDay = options.capBytesPerAppPerDay ?? DEFAULT_CAP_BYTES_PER_APP_PER_DAY;
    this.summaryIntervalMs = options.summaryIntervalMs ?? DEFAULT_SUMMARY_INTERVAL_MS;
  }

  /**
   * Record an access decision. Fire-and-forget: never awaits, never throws.
   * The caller is on the authorization hot path — a disk-full or a
   * permissions drift here must never become an access-control decision.
   */
  record(entry: AccessLogEntry): void {
    try {
      const key = aggregateKey(entry);
      const existing = this.aggregates.get(key);
      if (existing) {
        existing.count++;
        return;
      }
      const timer = setTimeout(() => {
        void this.flushAggregate(key);
      }, this.windowMs);
      timer.unref?.();
      this.aggregates.set(key, {
        appName: entry.appName,
        decision: entry.decision,
        userId: entry.userId,
        username: entry.username,
        reason: entry.reason,
        count: 1,
        timer,
      });
    } catch {
      // Never let a logging failure touch the access decision.
    }
  }

  /**
   * Flush every pending aggregate and suppressed-refusal summary
   * immediately. Called from platform.stop() so an in-flight aggregation
   * window is never silently lost on a deploy/restart.
   */
  async flush(): Promise<void> {
    // Each key is flushed independently, and writeRow already swallows its
    // own disk errors — but one unexpected failure here must not stop the
    // rest of the drain, or a shutdown flush could leak every key after it.
    for (const key of Array.from(this.aggregates.keys())) {
      try {
        await this.flushAggregate(key);
      } catch {
        // See class doc: log hygiene must not crash the platform.
      }
    }
    for (const key of Array.from(this.suppressed.keys())) {
      try {
        await this.flushSuppressed(key);
      } catch {
        // See class doc: log hygiene must not crash the platform.
      }
    }
  }

  private async flushAggregate(key: string): Promise<void> {
    const agg = this.aggregates.get(key);
    if (!agg) return;
    this.aggregates.delete(key);
    clearTimeout(agg.timer);

    const day = dayKey();
    const adKey = appDayKey(agg.appName, day);

    // Admits are never suppressed, no matter how full the day's byte budget
    // is — only a refusal flood is capped.
    if (agg.decision === 'refuse' && this.isCapped(adKey)) {
      this.addSuppressed(adKey, agg.count);
      return;
    }

    await this.writeRow(
      day,
      {
        timestamp: new Date().toISOString(),
        appName: agg.appName,
        decision: agg.decision,
        ...(agg.userId ? { userId: agg.userId } : {}),
        ...(agg.username ? { username: agg.username } : {}),
        ...(agg.reason ? { reason: agg.reason } : {}),
        count: agg.count,
      },
      adKey
    );
  }

  private isCapped(adKey: string): boolean {
    return (this.bytesPerAppDay.get(adKey) ?? 0) >= this.capBytesPerAppPerDay;
  }

  private addSuppressed(adKey: string, count: number): void {
    const existing = this.suppressed.get(adKey);
    if (existing) {
      existing.count += count;
      return;
    }
    const timer = setTimeout(() => {
      void this.flushSuppressed(adKey);
    }, this.summaryIntervalMs);
    timer.unref?.();
    this.suppressed.set(adKey, { count, windowStart: new Date().toISOString(), timer });
  }

  private async flushSuppressed(adKey: string): Promise<void> {
    const entry = this.suppressed.get(adKey);
    if (!entry || entry.count === 0) return;
    this.suppressed.delete(adKey);
    clearTimeout(entry.timer);

    const [appName, day] = adKey.split('\u0000');
    // The summary row itself is never subject to the cap it's reporting on
    // — that's the release valve — and it doesn't count toward the cap
    // either, or a busy summary stream could re-trigger its own throttling.
    await this.writeRow(
      day,
      {
        timestamp: new Date().toISOString(),
        appName,
        decision: 'refuse',
        reason: 'refusal-cap-reached: summary of suppressed rows',
        count: entry.count,
        windowStart: entry.windowStart,
      },
      adKey,
      false
    );
  }

  /**
   * Append one JSONL row to the day's access log and account its bytes
   * against the (app, day) refusal cap.
   *
   * Extension is deliberately `.access.log`, NOT `.jsonl`: LogRetentionService
   * prunes files matching /\.log(\.[\w-]+)?$/ and this service has no
   * retention logic of its own — a `.jsonl` file on this per-request write
   * path would silently never be pruned and grow forever.
   */
  private async writeRow(
    day: string,
    row: Record<string, unknown>,
    adKey: string,
    countTowardsCap = true
  ): Promise<void> {
    try {
      const accessDir = path.join(this.logsRoot, 'access');
      await fs.mkdir(accessDir, { recursive: true });
      const file = path.join(accessDir, `${day}.access.log`);
      const line = JSON.stringify(row) + '\n';
      await fs.appendFile(file, line, 'utf-8');
      if (countTowardsCap) {
        this.bytesPerAppDay.set(
          adKey,
          (this.bytesPerAppDay.get(adKey) ?? 0) + Buffer.byteLength(line)
        );
      }
    } catch {
      // Disk-full / permissions drift must not surface — see class doc.
    }
  }
}

let instance: AccessLogService | null = null;

export function getAccessLog(logsRoot?: string, options?: AccessLogOptions): AccessLogService {
  if (!instance) {
    if (!logsRoot) throw new Error('AccessLogService not initialized: provide logsRoot');
    instance = new AccessLogService(logsRoot, options);
  }
  return instance;
}

export function resetAccessLog(): void {
  instance = null;
}
