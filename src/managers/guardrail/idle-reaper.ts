/**
 * Idle teardown for agent-created apps (Step 9).
 *
 * An agent that spins up throwaway apps leaves them running forever. This
 * reaps the ones that are demonstrably doing nothing — and it deletes, which
 * means every guard here exists to stop it deleting something it shouldn't.
 *
 * THE SIGNAL: cumulative CPU time, not a Caddy access log.
 * ------------------------------------------------------
 * The obvious signal is the access log's mtime, and it is the wrong one on
 * this platform:
 *   - it needs Caddy, so a localhost-domain install has no signal at all;
 *   - it misses apps hit directly on their port;
 *   - and dropkit.sh is PUBLIC, so any passing bot refreshes the mtime and
 *     nothing is ever reaped — the feature would silently do nothing.
 * A CPU-time delta needs none of that. It is docker-only in its authoritative
 * form, which is why an app with no reading is never reaped rather than
 * treated as idle.
 */

const HOUR_MS = 60 * 60 * 1000;

/** Default idle window before an agent-created app is reaped. */
const DEFAULT_IDLE_HOURS = 24;
/**
 * Sweeps to run in DRY-RUN before the first real reap.
 *
 * This deletes apps and their databases. A signal that is subtly wrong — a
 * runtime that reports 0, a clock that jumped — should show up as logged
 * would-have-reaped lines first, not as a fleet that is gone.
 */
const DEFAULT_DRY_RUN_SWEEPS = 3;
/**
 * CPU nanoseconds of movement that count as "did something".
 *
 * Not zero: a container burns a trickle of CPU just existing (runtime
 * bookkeeping, a language runtime's idle timers), and a strict `> 0` test would
 * read every app as active forever and reap nothing. 50ms across a whole sweep
 * is far below what serving even one request costs.
 */
const ACTIVITY_THRESHOLD_NS = 50_000_000;

export interface IdleCandidate {
  name: string;
  /** Only agent-created apps are ever reaped. */
  agentCreated?: boolean;
  /** Operator opt-out. */
  noReap?: boolean;
  createdAt?: string;
  /** Cumulative CPU ns, or undefined when the runtime cannot report it. */
  cpuTotalNs?: number;
  status?: string;
}

export interface IdleSweepState {
  /** name -> last cumulative CPU reading. */
  lastCpu: Map<string, number>;
  /** name -> when the app last demonstrably did work. */
  lastActive: Map<string, number>;
}

export function createIdleSweepState(): IdleSweepState {
  return { lastCpu: new Map(), lastActive: new Map() };
}

export function idleWindowMs(): number {
  const raw = parseInt(process.env.DROP_IDLE_REAP_HOURS || '', 10);
  if (!Number.isFinite(raw)) return DEFAULT_IDLE_HOURS * HOUR_MS;
  // 0 DISABLES, and is the documented off switch — distinct from a nonsense
  // value, which falls back to the default rather than to "reap immediately".
  if (raw < 0) return DEFAULT_IDLE_HOURS * HOUR_MS;
  return raw * HOUR_MS;
}

export function dryRunSweeps(): number {
  const raw = parseInt(process.env.DROP_IDLE_REAP_DRY_RUNS || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_DRY_RUN_SWEEPS;
}

export interface SweepResult {
  /** Apps that should be torn down. */
  reap: string[];
  /** Why the sweep declined to reap anything, when it did. */
  abortReason?: string;
}

/**
 * Decide what to reap. Pure — it deletes nothing and touches no runtime.
 *
 * @param now injected so the decision is testable without waiting a day.
 */
export function planIdleSweep(
  candidates: IdleCandidate[],
  state: IdleSweepState,
  now: number
): SweepResult {
  const windowMs = idleWindowMs();
  if (windowMs <= 0) return { reap: [], abortReason: 'disabled' };

  // Record activity for EVERY app first, including ones that will never be
  // reaped — the global liveness check below reads the whole fleet, and an app
  // excluded from reaping is still evidence that the signal works.
  let anyReading = false;
  let anyRecentlyActive = false;
  for (const app of candidates) {
    if (typeof app.cpuTotalNs !== 'number') continue;
    anyReading = true;
    const previous = state.lastCpu.get(app.name);
    state.lastCpu.set(app.name, app.cpuTotalNs);

    if (previous === undefined) {
      // First reading is a BASELINE, never evidence of idleness. Treating it as
      // idle would make every app reapable the moment the platform restarts.
      state.lastActive.set(app.name, now);
      anyRecentlyActive = true;
      continue;
    }
    // A counter that went BACKWARDS means the process restarted, so the app is
    // demonstrably alive and its old total is meaningless.
    const delta = app.cpuTotalNs - previous;
    if (delta < 0 || delta >= ACTIVITY_THRESHOLD_NS) {
      state.lastActive.set(app.name, now);
      anyRecentlyActive = true;
    }
  }

  // GLOBAL LIVENESS PRECONDITION. If nothing anywhere reports a reading, the
  // signal source is broken — a runtime that stopped answering, a permissions
  // change, a docker daemon that is gone — and every app looks idle at once.
  // Reaping then deletes the entire fleet in one sweep, which is the single
  // worst thing this code could do.
  if (!anyReading) return { reap: [], abortReason: 'no runtime reported CPU usage' };
  if (!anyRecentlyActive) {
    return { reap: [], abortReason: 'no app on the box showed any activity' };
  }

  const reap: string[] = [];
  for (const app of candidates) {
    // Only apps an agent created. A human's app is never reaped automatically,
    // whatever it is doing.
    if (app.agentCreated !== true) continue;
    if (app.noReap === true) continue;
    // An app with no reading was never measured. Absent is not idle.
    if (typeof app.cpuTotalNs !== 'number') continue;
    // Nothing to reclaim from an app that is not running, and tearing one down
    // here would race whatever stopped it.
    if (app.status !== 'running') continue;

    // Younger than the window: it cannot have been idle for a full window yet,
    // and this guards the case where lastActive was lost to a restart.
    const createdMs = app.createdAt ? new Date(app.createdAt).getTime() : NaN;
    if (!Number.isFinite(createdMs) || now - createdMs < windowMs) continue;

    const active = state.lastActive.get(app.name);
    // No recorded activity at all means this sweep is the first that has ever
    // seen it — the baseline above sets one for anything with a reading, so
    // reaching here means we cannot say, and we do not reap on cannot-say.
    if (active === undefined) continue;
    if (now - active >= windowMs) reap.push(app.name);
  }

  return { reap };
}

export { ACTIVITY_THRESHOLD_NS, DEFAULT_IDLE_HOURS };
