/**
 * DeployDetailStore
 *
 * Bus-observer recording ONE diagnostic record per failed deploy, keyed by the
 * platform-minted `deployId`. Sits alongside DeployTracker: rows say what
 * happened and when, a detail says why it failed.
 *
 * WHY AN OBSERVER, not writes inside the platform's error branches. There are
 * three start paths (handleStartApp, handleAppUpdate, restartApp) and the
 * write sites would have to be duplicated across all of them — the redeploy
 * path is the one such duplication has historically missed, and it is the
 * dominant path for an agent. One subscriber covers all three by construction.
 *
 * Hard invariants, inherited from DeployTracker (do not relax):
 *  - Handlers mutate in-memory state SYNCHRONOUSLY at the top, then fire
 *    `void this.persist()`. EventBus publish is synchronous and cross-event
 *    ordering depends on it. Never `await` before mutating.
 *  - Never store a raw `error.message`. Every persisted field is
 *    DROP-generated — see the field discipline note in deploy-detail.types.ts.
 *
 * Correlation mirrors DeployTracker exactly: `build:started` opens an entry
 * keyed by app name, terminal events resolve it back to a deployId. The boot
 * phase runs in a different handler from the one that minted the id, so
 * resolving by app name here is what lets `deploy:failed` stay id-free.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { writeJsonAtomic } from '../../utils/atomic-write';
import { getStateManager } from '../app/state-manager';
import type {
  EventBus,
  Unsubscribe,
  BuildStartedPayload,
  BuildFailedPayload,
  AppUpdatedPayload,
} from '../../core/event-bus';
import type { DeployFailedPayload } from '../../core/event-bus/event-bus.types';
import type { DeployDetail, RuntimeLogOffsets } from './deploy-detail.types';

/**
 * Cap. Lower than DeployTracker's 1000 rows because a detail is only written
 * for a FAILED deploy, and one deploy produces many rows but at most one
 * detail.
 */
const MAX_DETAILS = 500;

/**
 * Whether a retention window has closed. A MALFORMED timestamp counts as
 * expired, not immortal: `new Date('garbage').getTime()` is NaN and every
 * comparison against NaN is false, so a naive `<= now` would keep a
 * hand-edited or half-written record forever.
 */
function isExpired(retainUntil: string | undefined, now = Date.now()): boolean {
  if (retainUntil === undefined) return false;
  const at = new Date(retainUntil).getTime();
  return !Number.isFinite(at) || at <= now;
}

/** Ids that are safe to use as a store key or a path component. */
const SAFE_DEPLOY_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Hours a torn-down app's deploy details survive. */
function getRetentionHours(): number {
  const raw = process.env.DROP_DEPLOY_DETAIL_RETENTION_H;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 24;
}

interface DeployDetailStoreFile {
  details: DeployDetail[];
}

export class DeployDetailStore {
  private readonly storePath: string;
  private details: DeployDetail[] = [];
  private initialized = false;

  /** appName -> deployId of the currently-open episode (mirrors DeployTracker.active). */
  private readonly active: Map<string, string> = new Map();

  /**
   * appName -> offsets captured just before the process started, held until a
   * failure actually needs them. PENDING rather than written eagerly, mirroring
   * DeployTracker.pendingTrigger: a detail is written only for a FAILED deploy,
   * and recording offsets at start time would mint one for every successful
   * deploy too — inflating the store and breaking the cap's rationale.
   */
  private readonly pendingRuntimeLog: Map<string, RuntimeLogOffsets> = new Map();

  private savePromise: Promise<void> | null = null;
  private dirty = false;

  constructor(storePath: string) {
    this.storePath = storePath;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await fs.mkdir(path.dirname(this.storePath), { recursive: true });

    try {
      const data = await fs.readFile(this.storePath, 'utf-8');
      const parsed = JSON.parse(data) as Partial<DeployDetailStoreFile>;
      this.details = Array.isArray(parsed.details) ? parsed.details : [];
    } catch {
      // No store file yet (ENOENT) or a corrupt one — start empty. Deploy
      // diagnostics are observability, not a source of truth; quarantining a
      // corrupt file is not worth the complexity. Same call as DeployTracker.
      this.details = [];
    }

    // Sweep anything whose window closed while the platform was down.
    await this.sweepExpired();

    this.initialized = true;
  }

  subscribe(bus: EventBus): Unsubscribe {
    const unsubs: Unsubscribe[] = [
      bus.subscribe('build:started', (payload) => this.handleBuildStarted(payload)),
      bus.subscribe('build:failed', (payload) => this.handleBuildFailed(payload)),
      bus.subscribe('deploy:failed', (payload) => this.handleDeployFailed(payload)),
      bus.subscribe('app:updated', (payload) => this.handleAppUpdated(payload)),
    ];

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }

  // ============ Event handlers ============

  private handleBuildStarted(payload: BuildStartedPayload): void {
    const appName = payload.appId;
    // Adopt the publisher's id, like DeployTracker. Without one there is
    // nothing to key a detail to, so this deploy simply gets no detail rather
    // than one under an id nobody can reference.
    // Shape-check before it keys anything. Every producer today mints a
    // crypto.randomUUID, but the payload field is a bare `string?` and the
    // invariant that keeps it safe lives outside this file — a future
    // publisher threading a client-supplied correlation id must not be able
    // to turn this id into a path component or a store key.
    if (!payload.deployId || !SAFE_DEPLOY_ID.test(payload.deployId)) {
      this.active.delete(appName);
      return;
    }
    this.active.set(appName, payload.deployId);
  }

  private handleBuildFailed(payload: BuildFailedPayload): void {
    const appName = payload.appId;
    const deployId = this.active.get(appName);
    if (!deployId) return; // orphan guard, same shape as DeployTracker's

    this.active.delete(appName); // terminal
    // A build failure never reached runtime.start(), so there is no runtime
    // log for THIS deploy. Drop anything a previous one left behind rather
    // than attaching another deploy's offsets.
    this.pendingRuntimeLog.delete(appName);

    this.record({
      deployId,
      appName,
      userId: this.snapshotUserId(appName),
      phase: 'build',
      stage: payload.stage,
      exitCode: payload.exitCode,
      command: payload.command,
      createdAt: payload.timestamp.toISOString(),
    });
  }

  private handleDeployFailed(payload: DeployFailedPayload): void {
    const appName = payload.appId;
    const deployId = this.active.get(appName);
    if (!deployId) return; // orphan guard

    // NOT terminal for the episode — the platform writes status 'errored'
    // immediately after, and that app:updated is what closes it. Deleting here
    // would leave that close unable to resolve its id.
    this.record({
      deployId,
      appName,
      userId: this.snapshotUserId(appName),
      phase: 'boot',
      reason: payload.reason,
      runtimeLog: this.pendingRuntimeLog.get(appName),
      createdAt: payload.timestamp.toISOString(),
    });
  }

  private handleAppUpdated(payload: AppUpdatedPayload): void {
    const status = payload.changes?.status;
    // Only terminal statuses close. Matches DeployTracker so the two stores
    // never disagree about which episode is open for an app.
    if (status !== 'running' && status !== 'errored') return;
    this.active.delete(payload.appId);
    this.pendingRuntimeLog.delete(payload.appId);
  }

  /**
   * Stash where this deploy's runtime output begins. Called by the platform
   * immediately before `runtime.start()` — the one part of this feature that
   * cannot be a bus subscriber, because it reads file sizes that the start is
   * about to change.
   *
   * Takes an app name, not a deployId: the caller does not have one. The id is
   * minted in handleBuildApp/handleAppUpdate but the start happens in a
   * different handler, so this resolves it the same way every other handler
   * here does. A start with no open episode (restartApp — a restart is not a
   * deploy) simply stashes nothing.
   */
  noteRuntimeLog(appName: string, offsets: RuntimeLogOffsets): void {
    if (!this.active.has(appName)) return;
    this.pendingRuntimeLog.set(appName, offsets);
  }

  /**
   * Called at teardown. Severs each retained detail from the app's log files
   * and stamps a retention window.
   *
   * This is the SEC-3 fix. `runtimeLog` holds a path keyed on the app NAME
   * plus a byte offset, and teardown FREES that name — so a record that kept
   * them would, once another tenant registered the same name, resolve to
   * THEIR stdout. Clearing the pointer is what closes that, and it closes it
   * completely: there is no longer any path from a retained record to a log
   * file.
   *
   * It does NOT copy the bytes out. The plan specifies a copy so a torn-down
   * deploy's output stays readable, but nothing reads it yet — `get_deploy_logs`
   * is a later step. Writing durable, uncapped copies of tenant stdout with no
   * consumer is all of the cost and none of the benefit, and it would also
   * mean `?keepData=false` — an explicit "destroy my data" — CREATING a new
   * copy of output that routinely contains DATABASE_URL and injected secrets.
   * The copy belongs with its reader, where bounding, symlink safety and the
   * keepData interaction can be settled against a real consumer.
   *
   * What survives is the metadata: stage, exit code, command, reason. All
   * DROP-generated, matching this store's documented invariant.
   *
   * `await`s the persist rather than firing it: the caller deletes the log
   * directories immediately after, and a crash in between would otherwise
   * leave the on-disk record holding live name-keyed offsets and no
   * retainUntil — reloaded on restart in exactly the pre-fix state, and
   * invisible to the serve-time guard, which keys on retainUntil.
   */
  async retainForApp(appName: string): Promise<void> {
    const mine = this.details.filter((d) => d.appName === appName);
    if (mine.length === 0) return;

    const retainUntil = new Date(Date.now() + getRetentionHours() * 3600_000).toISOString();
    for (const detail of mine) {
      detail.retainUntil = retainUntil;
      detail.runtimeLog = undefined;
    }

    await this.sweepExpired();
    await this.persist();
  }

  /** Drop details whose retention window has closed. */
  async sweepExpired(now = Date.now()): Promise<void> {
    const before = this.details.length;
    this.details = this.details.filter((d) => !isExpired(d.retainUntil, now));
    if (this.details.length !== before) await this.persist();
  }

  // ============ Reads ============

  /**
   * The detail for a deploy, or undefined. Callers MUST tenant-filter on `userId`.
   *
   * Expiry is enforced HERE as well as by the sweep. The platform can stay up
   * for weeks, so a window that only closed on restart would not be a window
   * at all — the sweep reclaims storage, this makes the window real.
   */
  getDetail(deployId: string): DeployDetail | undefined {
    const detail = this.details.find((d) => d.deployId === deployId);
    if (!detail || isExpired(detail.retainUntil)) return undefined;
    return detail;
  }

  /** Details for an app, newest first. Callers MUST tenant-filter on `userId`. */
  getDetails(appName: string, limit = 20): DeployDetail[] {
    return this.details
      .filter((d) => d.appName === appName && !isExpired(d.retainUntil))
      .slice(0, limit);
  }

  /**
   * Drop every detail for an app immediately, ignoring retention. NOT the
   * teardown path — teardown calls `retainForApp`, which keeps the records for
   * their window. This is the hard-delete escape hatch.
   */
  purgeApp(appName: string): void {
    const before = this.details.length;
    this.details = this.details.filter((d) => d.appName !== appName);
    this.active.delete(appName);
    this.pendingRuntimeLog.delete(appName);
    if (this.details.length !== before) void this.persist();
  }

  /** Await any in-flight persist. Tests and shutdown. */
  async flush(): Promise<void> {
    await this.savePromise;
  }

  // ============ Internals ============

  private record(detail: DeployDetail): void {
    // One detail per deploy. A build failure followed by a boot failure for
    // the same id cannot happen (a failed build never boots), but a duplicate
    // publish can — replace rather than accumulate, so a deployId always
    // resolves to exactly one record.
    const existing = this.details.findIndex((d) => d.deployId === detail.deployId);
    if (existing !== -1) {
      this.details[existing] = detail;
    } else {
      this.details.unshift(detail);
    }
    void this.persist();
  }

  private snapshotUserId(appName: string): string | undefined {
    try {
      return getStateManager().getApp(appName)?.userId;
    } catch {
      // StateManager not configured in this process (isolated tests).
      return undefined;
    }
  }

  private async persist(): Promise<void> {
    this.dirty = true;
    if (this.savePromise) return this.savePromise;
    this.savePromise = this.runSaveLoop();
    return this.savePromise;
  }

  private async runSaveLoop(): Promise<void> {
    try {
      while (this.dirty) {
        this.dirty = false;
        await this.doPersist();
      }
    } finally {
      this.savePromise = null;
    }
  }

  private async doPersist(): Promise<void> {
    this.details = this.details.slice(0, MAX_DETAILS);
    try {
      await writeJsonAtomic(this.storePath, { details: this.details } as DeployDetailStoreFile);
    } catch (error) {
      console.error('[deploy-detail] failed to persist deploy details:', error);
    }
  }
}

// ============ Singleton ============

let instance: DeployDetailStore | null = null;

export function getDeployDetailStore(storePath?: string): DeployDetailStore {
  if (!instance) {
    if (!storePath) {
      throw new Error('DeployDetailStore storePath required on first call');
    }
    instance = new DeployDetailStore(storePath);
  }
  return instance;
}

export function resetDeployDetailStore(): void {
  instance = null;
}
