/**
 * DeployTracker
 *
 * Bus-observer that appends flat milestone rows to a durable store as
 * pipeline events fire, correlated by an observer-minted `deployId`. Deploy
 * *status* is never persisted — it is derived at read time from the rows
 * (see `getEpisodes`). See docs/plans/2026-07-06-p2-4-deploy-observability.md
 * for the full design rationale.
 *
 * Hard invariants (do not relax without re-reading the plan):
 *  - Every handler mutates in-memory state SYNCHRONOUSLY at the top, then
 *    fires `void this.persist()` — never `await` before mutating. EventBus
 *    publish is synchronous and cross-event ordering depends on this.
 *  - Close signals (`build:failed`, `app:updated{running|errored}`) are
 *    idempotent no-ops when no episode is open for the app (orphan guard —
 *    required because `app:updated{running}` also fires from startup
 *    reconcile and API start/restart, not only from real deploys).
 *  - Never store a raw `error.message` — `build:failed` rows carry only a
 *    `category`, never free-form error text.
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { writeJsonAtomic } from '../../utils/atomic-write';
import { getStateManager } from '../app/state-manager';
import type {
  EventBus,
  Unsubscribe,
  AppDetectedPayload,
  AppUpdatedPayload,
  BuildStartedPayload,
  BuildCompletedPayload,
  BuildFailedPayload,
} from '../../core/event-bus';
// AppUpdatePayload (the app:update/hot-reload payload) isn't re-exported by
// the core/event-bus barrel (only AppUpdatedPayload is) — pull it from the
// types module directly rather than editing the barrel, which is outside
// this module's scope.
import type { AppUpdatePayload } from '../../core/event-bus/event-bus.types';
import type {
  DeployRow,
  DeployEpisode,
  DeployStage,
  DeployStatus,
} from './deploy-tracker.types';

const MAX_ROWS = 1000;

type DeployTrigger = 'deploy' | 'hot-reload';

interface PendingTrigger {
  trigger: DeployTrigger;
  at: string;
}

interface DeployStore {
  rows: DeployRow[];
}

/** Payload shapes across the subscribed events all resolve to an app name this way. */
interface AppNameSource {
  appId?: string;
  name?: string;
  path?: string;
}

export class DeployTracker {
  private readonly storePath: string;
  private rows: DeployRow[] = [];
  private initialized = false;

  // Correlation cache: appName -> deployId of the currently-open episode.
  private readonly active: Map<string, string> = new Map();
  // Transient trigger tag, set by app:detected/app:update, consumed by build:started.
  private readonly pendingTrigger: Map<string, PendingTrigger> = new Map();

  // Save-coalescing (single-flight with a trailing re-run if dirtied),
  // mirroring AppStateManager's savePromise idiom.
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
      const parsed = JSON.parse(data) as Partial<DeployStore>;
      this.rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    } catch {
      // No store file yet (ENOENT) or a corrupt one — start empty. Deploy
      // history is observability, not a source of truth, so quarantining a
      // corrupt file is not worth the complexity here.
      this.rows = [];
    }

    this.initialized = true;
  }

  /** Wire the targeted handlers this tracker cares about. Returns one Unsubscribe. */
  subscribe(bus: EventBus): Unsubscribe {
    const unsubs: Unsubscribe[] = [
      bus.subscribe('app:detected', (payload) => this.handleAppDetected(payload)),
      bus.subscribe('app:update', (payload) => this.handleAppUpdate(payload)),
      bus.subscribe('build:started', (payload) => this.handleBuildStarted(payload)),
      bus.subscribe('build:completed', (payload) => this.handleBuildCompleted(payload)),
      bus.subscribe('build:failed', (payload) => this.handleBuildFailed(payload)),
      bus.subscribe('app:updated', (payload) => this.handleAppUpdated(payload)),
    ];

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }

  // ============ Event handlers ============
  // Each handler mutates synchronously, then fires a fire-and-forget persist.

  private handleAppDetected(payload: AppDetectedPayload): void {
    const appName = this.resolveAppName(payload);
    this.pendingTrigger.set(appName, { trigger: 'deploy', at: payload.timestamp.toISOString() });
    // Transient only — do NOT open an episode (avoids restart orphans).
  }

  private handleAppUpdate(payload: AppUpdatePayload): void {
    const appName = this.resolveAppName(payload);
    this.pendingTrigger.set(appName, { trigger: 'hot-reload', at: payload.timestamp.toISOString() });
    // Transient only — do NOT open an episode.
  }

  private handleBuildStarted(payload: BuildStartedPayload): void {
    const appName = this.resolveAppName(payload);
    const at = payload.timestamp.toISOString();

    // Mint a new deployId. If one was already open for this app (a new build
    // fired before the previous one closed), it is simply overwritten here —
    // the old episode stays un-terminated and derives as 'superseded' at read
    // time; we do not need to do anything special with it.
    const deployId = randomUUID();
    this.active.set(appName, deployId);

    const pending = this.pendingTrigger.get(appName);
    this.pendingTrigger.delete(appName);
    const userId = this.snapshotUserId(appName);

    this.rows.unshift({
      deployId,
      appName,
      userId,
      stage: 'triggered',
      at: pending?.at ?? at,
      detail: pending?.trigger,
    });
    this.rows.unshift({
      deployId,
      appName,
      userId,
      stage: 'build-started',
      at,
    });

    void this.persist();
  }

  private handleBuildCompleted(payload: BuildCompletedPayload): void {
    const appName = this.resolveAppName(payload);
    const deployId = this.active.get(appName);
    if (!deployId) return; // no open episode — nothing to correlate this to

    this.rows.unshift({
      deployId,
      appName,
      stage: 'build',
      at: payload.timestamp.toISOString(),
      ok: payload.success,
    });

    // NOT a close — build:completed{success:false} is followed by build:failed.
    void this.persist();
  }

  private handleBuildFailed(payload: BuildFailedPayload): void {
    const appName = this.resolveAppName(payload);
    const deployId = this.active.get(appName);
    if (!deployId) return; // orphan guard: idempotent no-op if nothing is open

    this.active.delete(appName); // CLOSE (failed)

    this.rows.unshift({
      deployId,
      appName,
      stage: 'build-failed',
      at: payload.timestamp.toISOString(),
      // Never store payload.error.message (raw npm stderr can carry absolute
      // paths / env dumps) — category only.
      category: 'build-failed',
    });

    void this.persist();
  }

  private handleAppUpdated(payload: AppUpdatedPayload): void {
    const status = payload.changes?.status;
    if (status !== 'running' && status !== 'errored') return; // all other statuses ignored

    const appName = this.resolveAppName(payload);
    const deployId = this.active.get(appName);
    if (!deployId) return; // orphan guard: startup reconcile / API start/restart also fire this

    this.active.delete(appName); // CLOSE (succeeded or failed)

    this.rows.unshift({
      deployId,
      appName,
      stage: status === 'running' ? 'running' : 'errored',
      at: payload.timestamp.toISOString(),
    });

    void this.persist();
  }

  // ============ Read ============

  /** Grouped + derived episodes, newest-first. */
  getEpisodes(appName?: string, limit?: number): DeployEpisode[] {
    const groups = new Map<string, DeployRow[]>();
    // this.rows is stored newest-first; the first row seen per app while
    // iterating it is therefore that app's newest deployId.
    const newestDeployIdByApp = new Map<string, string>();

    for (const row of this.rows) {
      if (appName && row.appName !== appName) continue;

      if (!newestDeployIdByApp.has(row.appName)) {
        newestDeployIdByApp.set(row.appName, row.deployId);
      }

      const group = groups.get(row.deployId);
      if (group) {
        group.push(row);
      } else {
        groups.set(row.deployId, [row]);
      }
    }

    const episodes: DeployEpisode[] = [];
    for (const [deployId, groupRows] of groups) {
      episodes.push(this.deriveEpisode(deployId, groupRows, newestDeployIdByApp));
    }

    episodes.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));

    return typeof limit === 'number' ? episodes.slice(0, limit) : episodes;
  }

  /** Drop all rows for an app (delete-time) and clear its in-memory state. */
  purgeApp(appName: string): void {
    this.rows = this.rows.filter((row) => row.appName !== appName);
    this.active.delete(appName);
    this.pendingTrigger.delete(appName);
    void this.persist();
  }

  /** Await any in-flight/queued persist. Test/graceful-shutdown affordance only. */
  async flush(): Promise<void> {
    await this.savePromise;
  }

  // ============ Internals ============

  private resolveAppName(payload: AppNameSource): string {
    if (payload.appId) return payload.appId;
    if (payload.name) return payload.name;
    if (payload.path) return path.basename(payload.path);
    return 'unknown';
  }

  private snapshotUserId(appName: string): string | undefined {
    try {
      return getStateManager().getApp(appName)?.userId;
    } catch {
      // StateManager not configured in this process (e.g. isolated tests) —
      // fall back to unowned/legacy.
      return undefined;
    }
  }

  private deriveEpisode(
    deployId: string,
    groupRows: DeployRow[],
    newestDeployIdByApp: Map<string, string>
  ): DeployEpisode {
    // Rows are newest-first overall (each new row is unshifted onto
    // `this.rows`), so a filtered subset for one deployId is also
    // newest-first in true insertion order. Reversing it — rather than
    // sorting by `at` — gives chronological order without misordering rows
    // that share a millisecond timestamp (very common with back-to-back
    // synchronous publishes).
    const rows = [...groupRows].reverse();
    const appName = rows[0].appName;
    // Owner snapshot lives on the build-started/triggered rows; carry it onto
    // the episode so the route can tenant-filter on the SNAPSHOT (not a live
    // getApp lookup — that would leak across app-name reuse).
    const userId = rows.find((row) => row.userId !== undefined)?.userId;

    const triggeredRow = rows.find((row) => row.stage === 'triggered');
    const trigger = this.deriveTrigger(triggeredRow?.detail);

    const stages: DeployStage[] = [];
    let previousAt: string | undefined;
    for (const row of rows) {
      const stage: DeployStage = {
        stage: row.stage,
        at: row.at,
        ok: row.ok,
        category: row.category,
      };
      if (previousAt) {
        stage.durationMs = new Date(row.at).getTime() - new Date(previousAt).getTime();
      }
      stages.push(stage);
      previousAt = row.at;
    }

    const runningRow = rows.find((row) => row.stage === 'running');
    const failedRow = rows.find((row) => row.stage === 'build-failed' || row.stage === 'errored');
    const terminalRow = runningRow ?? failedRow;

    const status = this.deriveStatus(appName, deployId, runningRow, failedRow, newestDeployIdByApp);

    const startedAt = rows[0].at;
    const endedAt = terminalRow?.at;
    const durationMs = endedAt
      ? new Date(endedAt).getTime() - new Date(startedAt).getTime()
      : undefined;

    return {
      deployId,
      appName,
      userId,
      trigger,
      status,
      startedAt,
      endedAt,
      durationMs,
      stages,
    };
  }

  private deriveStatus(
    appName: string,
    deployId: string,
    runningRow: DeployRow | undefined,
    failedRow: DeployRow | undefined,
    newestDeployIdByApp: Map<string, string>
  ): DeployStatus {
    if (runningRow) return 'succeeded';
    if (failedRow) return 'failed';

    const isNewestForApp = newestDeployIdByApp.get(appName) === deployId;
    if (isNewestForApp && this.active.get(appName) === deployId) return 'in-progress';
    if (!isNewestForApp) return 'superseded';

    // Newest episode, not currently active, no terminal row. Usually this is a
    // deploy interrupted by a platform restart. BUT PM2/containers outlive a
    // DROP crash, so the app may actually be running — its close event (or its
    // persist) just didn't survive the restart. Cross-check the live app
    // status so we don't mislabel a healthy app's last deploy as interrupted.
    if (this.currentAppStatus(appName) === 'running') return 'succeeded';
    return 'interrupted';
  }

  private currentAppStatus(appName: string): string | undefined {
    try {
      return getStateManager().getApp(appName)?.status;
    } catch {
      return undefined;
    }
  }

  private deriveTrigger(detail: string | undefined): 'deploy' | 'hot-reload' | 'unknown' {
    if (detail === 'deploy' || detail === 'hot-reload') return detail;
    return 'unknown';
  }

  // ============ Persistence (save-coalescing) ============

  private async persist(): Promise<void> {
    this.dirty = true;
    if (this.savePromise) {
      return this.savePromise;
    }
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
    // Trim to MAX_ROWS newest-first on every persist (rows.unshift keeps the
    // newest at the front, so slice(0, MAX_ROWS) keeps the newest N).
    this.rows = this.rows.slice(0, MAX_ROWS);
    try {
      await writeJsonAtomic(this.storePath, { rows: this.rows } as DeployStore);
    } catch (error) {
      console.error('[deploy-tracker] failed to persist deploy rows:', error);
    }
  }
}

// ============ Singleton ============

let instance: DeployTracker | null = null;

export function getDeployTracker(storePath?: string): DeployTracker {
  if (!instance) {
    if (!storePath) {
      throw new Error('DeployTracker storePath required on first call');
    }
    instance = new DeployTracker(storePath);
  }
  return instance;
}

export function resetDeployTracker(): void {
  instance = null;
}
