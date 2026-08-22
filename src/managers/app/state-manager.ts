/**
 * App State Manager
 *
 * Simple JSON file-based state persistence for DROP apps.
 * Provides zero-config state tracking without requiring external databases.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { eventBus } from '../../core/event-bus';
import { writeJsonAtomic } from '../../utils/atomic-write';
import type { GitSource } from '../../core/git-deploy/git-deploy.types';

export type AppStatus =
  | 'pending'
  | 'building'
  | 'starting'
  | 'running'
  | 'stopped'
  | 'errored'
  // Set by the post-deploy liveness watch when an already-`running` app begins
  // restarting repeatedly. NOT used as a first-deploy outcome — a deploy that
  // never comes up resolves to `errored` so the deploy tracker closes the
  // episode (it only closes on `running`/`errored`).
  | 'crash-looping'
  // Parked by the secret preflight (PRD-051): the app declares required secrets
  // in its drop.yaml that are neither set nor auto-generatable, so DROP did NOT
  // start it (avoiding a runtime crash-loop). `missingSecrets` names what to
  // set; the app starts on the next restart once they are present.
  | 'needs-config';
export type AppType = 'nodejs' | 'python' | 'go' | 'static' | 'docker' | 'unknown';

export interface AppState {
  name: string;
  type: AppType;
  status: AppStatus;
  port?: number;
  pid?: number;
  path: string;
  framework?: string;
  hostname?: string;
  createdAt: string;
  updatedAt: string;
  lastDeployedAt?: string;
  /**
   * Set alongside `status: 'running'` when the readiness gate RAN but the app
   * did not prove ready — docker-mode bind-with-no-HTTP-answer, or a declared
   * `healthCheck` whose port never bound. The app is left running (DROP-063's
   * leniency: a slow starter must not be killed), but nothing has confirmed it
   * serves.
   *
   * A FLAG, deliberately not an `AppStatus` member. There are ~20
   * `status === 'running'` comparisons, and they answer at least four
   * different questions — counts toward capacity / supervise it / something is
   * serving, don't clobber it / did it prove healthy. A new status member
   * silently fails two of them: the stop-before-swap guard in
   * `handleAppUpdate` matches neither branch, making a redeploy a no-op while
   * DROP reports success, and `lastDeployedAt` below is written only on
   * 'running'.
   *
   * ABSENT is not the same as verified — it means legacy, or a path where
   * readiness never ran. Only `=== true` is a positive "did not prove ready".
   */
  readinessUnverified?: boolean;
  buildDuration?: number;
  error?: string;
  gitSource?: GitSource;
  userId?: string;
  customDomain?: string;
  /**
   * Env-var names the app declared as required (drop.yaml `secrets:`) that were
   * missing at start, set alongside `status: 'needs-config'` (PRD-051). Cleared
   * once the app starts. Surfaced to the dashboard/MCP so the operator knows
   * exactly what to set.
   */
  missingSecrets?: string[];
  /**
   * Why DROP stopped this app on its own, when it did.
   *
   * A FLAG, deliberately not an `AppStatus` member (ARCH-14) — the same
   * reasoning as `readinessUnverified` above. There are ~20
   * `status === 'running'` comparisons answering at least four different
   * questions, and a new status member silently fails some of them.
   *
   * A parked app carries `status: 'stopped'`, so every existing consumer keeps
   * working; this only explains WHY, so the operator is not left staring at an
   * app that stopped for no visible reason. Cleared when the app starts again.
   */
  parkedReason?: string;
  /**
   * A build finished and is waiting for a human to promote it (Step 6d).
   *
   * A FLAG, not an `AppStatus` member (ARCH-14). The app's status is whatever
   * it already was — a previously-running app keeps `running`, because the OLD
   * version is still serving and untouched; a brand-new app stays `stopped`,
   * because nothing has ever served. Both are true statements about what is
   * running, which is what `status` answers; this answers a different
   * question, so it gets its own field.
   */
  awaitingPromotion?: boolean;
  /**
   * True when this app carries a browser access-gate policy (DROP-152) that
   * the platform could NOT enforce, and false once it can.
   *
   * A FLAG, not an `AppStatus` member, for the same reason
   * `readinessUnverified` above is one: it answers a different question from
   * "what is running", and the ~20 `status === 'running'` comparisons would
   * silently mis-answer several of theirs if it became a status.
   *
   * Written on every route configuration and by the boot sweep, in ALL THREE
   * directions -- true, false, and ABSENT. Absent means the app has no gate
   * policy at all, which is not the same as an enforced one, so removing a
   * gate must DELETE the key rather than leave the last verdict behind:
   * `updateApp` is a spread merge, and merely omitting the key would leave an
   * app flagged once flagged forever, exactly as `readinessUnverified` above
   * records. `setAccessGateUnapplied` is the writer that gets this right.
   */
  accessGateUnapplied?: boolean;
  /**
   * Grouping tag for apps expanded from a single monorepo deploy (e.g.
   * `ezsign-backend` / `ezsign-frontend` both tagged `group: ezsign`). Set via
   * `updateApp(name, { group })`, not `registerApp` — `AppConfig` (app-config.ts)
   * is the source of truth for `group`; this mirrors it for state consumers
   * that only read `AppState`. Absent for standalone apps.
   */
  group?: string;
  /**
   * True for the state entry of a monorepo CONTAINER repo (the cloned folder
   * whose root drop.yaml declares `services:`). The deploy-from-git path
   * registers the repo before detection can know it's a container, and the
   * entry must survive — its `gitSource` is what webhook auto-redeploys match
   * on — but it is not a runnable app: listings hide it, DELETE on it tears
   * down the whole group, and removeGroup cleans it up. Tagged with the
   * group's name in `group` (which can differ from this entry's own name when
   * drop.yaml sets `name:`/`group:`). Set by expandMonorepo on every
   * expansion, so pre-existing phantoms self-heal on the next redeploy.
   */
  isGroupContainer?: boolean;
}

export interface StateManagerConfig {
  stateFilePath: string;
}

export class AppStateManager {
  private readonly config: StateManagerConfig;
  private apps: Map<string, AppState> = new Map();
  private initialized = false;
  private saveDebounceTimer: NodeJS.Timeout | null = null;
  private savePromise: Promise<void> = Promise.resolve();

  constructor(config: StateManagerConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure directory exists
    const dir = path.dirname(this.config.stateFilePath);
    await fs.mkdir(dir, { recursive: true });

    // Load existing state
    await this.load();
    this.initialized = true;
  }

  async close(): Promise<void> {
    // Ensure any pending saves are flushed
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    await this.save();
    this.initialized = false;
  }

  private async load(): Promise<void> {
    let data: string;
    try {
      data = await fs.readFile(this.config.stateFilePath, 'utf-8');
    } catch {
      // No state file yet — first run.
      this.apps.clear();
      return;
    }

    try {
      const parsed = JSON.parse(data);
      if (parsed.apps && Array.isArray(parsed.apps)) {
        this.apps.clear();
        for (const app of parsed.apps) {
          this.apps.set(app.name, app);
        }
      }
    } catch (err) {
      // Corrupt state file. apps.json is the least-authoritative store (ports
      // come from app-config, the watcher re-detects apps), but it solely
      // holds userId/gitSource/user-stopped flags — so quarantine it for
      // forensics rather than silently overwriting, then continue empty.
      await this.quarantineCorruptStateFile(err);
      this.apps.clear();
    }
  }

  private async quarantineCorruptStateFile(err: unknown): Promise<void> {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const quarantinePath = `${this.config.stateFilePath}.corrupt-${ts}`;
      await fs.rename(this.config.stateFilePath, quarantinePath);
      console.error(
        `[state-manager] Corrupt state file quarantined to ${quarantinePath}:`,
        err instanceof Error ? err.message : err
      );
    } catch (renameErr) {
      console.error('[state-manager] Failed to quarantine corrupt state file:', renameErr);
    }
  }

  private async save(): Promise<void> {
    // Serialize overlapping saves so two debounced flushes can't interleave
    // their temp writes.
    this.savePromise = this.savePromise.then(() => this.doSave());
    return this.savePromise;
  }

  private async doSave(): Promise<void> {
    try {
      const data = {
        version: 1,
        updatedAt: new Date().toISOString(),
        apps: Array.from(this.apps.values()),
      };
      await writeJsonAtomic(this.config.stateFilePath, data);
    } catch (error) {
      console.error('Failed to save app state:', error);
    }
  }

  private scheduleSave(): void {
    // Debounce saves to avoid excessive writes
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      this.save();
      this.saveDebounceTimer = null;
    }, 500);
  }

  // ============ App Operations ============

  async registerApp(name: string, appPath: string, type: AppType = 'unknown', framework?: string): Promise<AppState> {
    const now = new Date().toISOString();
    const existing = this.apps.get(name);

    const app: AppState = {
      // MERGE over `existing`, do not rebuild from a literal.
      //
      // This used to be a literal naming ~12 fields, which meant every field
      // NOT named was silently dropped. registerApp runs for every app on
      // every boot (syncStateWithConfigs), so a dropped field is lost on each
      // restart — and each new AppState field inherits the trap. It cost
      // `readinessUnverified` its entire purpose (written at deploy, destroyed
      // unread on the next boot) before this was noticed, and it was already
      // silently dropping `missingSecrets`, `group`, `isGroupContainer`,
      // `customDomain` and `error` in shipped code.
      //
      // Preserve-by-default. The overrides below are the only fields
      // registerApp genuinely owns.
      ...existing,
      name,
      type,
      path: appPath,
      // The caller's value wins when it has one; otherwise keep what detection
      // previously established rather than blanking it.
      framework: framework ?? existing?.framework,
      hostname: `${name}.localhost`,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      // Preserve 'stopped' status so user-stopped apps don't auto-restart.
      // Everything else resets: this app is about to be (re)deployed.
      status: existing?.status === 'stopped' ? 'stopped' : 'pending',
      // No process is claimed yet — status has just reset to 'pending', so a
      // pid carried from the previous run would name a process this entry no
      // longer stands behind. syncStateWithProcesses re-establishes it.
      // (Same as the old behaviour, which dropped it; now it is deliberate.)
      pid: undefined,
    };

    this.apps.set(name, app);
    this.scheduleSave();

    // Only emit app:created if this is a genuinely new app
    if (!existing) {
      eventBus.publish('app:created', {
        appId: name,
        name,
        type,
      });
    }

    return app;
  }

  async updateApp(name: string, updates: Partial<AppState>): Promise<AppState | null> {
    const app = this.apps.get(name);
    if (!app) return null;

    const updated: AppState = {
      ...app,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    this.apps.set(name, updated);
    this.scheduleSave();

    eventBus.publish('app:updated', {
      appId: name,
      changes: updates,
    });

    return updated;
  }

  /**
   * Record (or clear) the access-gate verdict for one app -- see
   * `AppState.accessGateUnapplied`.
   *
   * `undefined` DELETES the key, which a spread-merge `updateApp` cannot
   * express; that is the whole reason this exists rather than a bare
   * `updateApp(name, { accessGateUnapplied })`.
   *
   * Change-guarded: the callers run over every app on every route
   * configuration and over every config at boot, and an unguarded write would
   * fire an `app:updated` event and schedule a save per app per pass, for a
   * value that is absent on almost all of them.
   */
  async setAccessGateUnapplied(
    name: string,
    value: boolean | undefined
  ): Promise<AppState | null> {
    const app = this.apps.get(name);
    if (!app) return null;
    if (app.accessGateUnapplied === value) return app;

    if (value === undefined) {
      delete app.accessGateUnapplied;
      return this.updateApp(name, {});
    }
    return this.updateApp(name, { accessGateUnapplied: value });
  }

  async setAppStatus(name: string, status: AppStatus, details?: { port?: number; pid?: number; error?: string; missingSecrets?: string[]; readinessUnverified?: boolean; parkedReason?: string; awaitingPromotion?: boolean }): Promise<AppState | null> {
    const app = this.apps.get(name);
    if (!app) return null;

    // Clear stale error when app transitions to a healthy state
    if ((status === 'running' || status === 'building' || status === 'starting') && !details?.error) {
      delete app.error;
    }
    // Clear the needs-config secret list whenever the app leaves that state
    // (PRD-051), unless the caller is explicitly setting a fresh list.
    if (status !== 'needs-config' && details?.missingSecrets === undefined) {
      delete app.missingSecrets;
    }

    // The readiness verdict is CALLER-supplied, because only the caller knows
    // whether the readiness gate actually ran. Keyed on the VALUE, matching the
    // missingSecrets convention above — NOT on key presence, or an explicitly
    // passed `undefined` would read as "verified" and clear a real failure:
    //
    //   undefined -> readiness did not run (handleAppUpdate, restartApp).
    //                Leave any existing flag alone; asserting either way is a lie.
    //   true      -> ran, and the app did not prove ready.
    //   false     -> ran and passed. Actively CLEAR — updateApp is a spread
    //                merge, so merely omitting the key would leave an app
    //                flagged once flagged forever, through every clean redeploy.
    const { readinessUnverified, ...rest } = details ?? {};
    if (readinessUnverified === false) {
      delete app.readinessUnverified;
    }

    // A park explains why DROP stopped the app itself. Any transition to a
    // LIVE state clears it: the reason no longer holds, and updateApp is a
    // spread merge, so leaving it would keep explaining a stop that has since
    // been undone. Set only by the caller that parks.
    if (status === 'running' || status === 'building' || status === 'starting') {
      delete app.parkedReason;
    }

    return this.updateApp(name, {
      status,
      ...rest,
      ...(readinessUnverified === true ? { readinessUnverified: true } : {}),
      ...(status === 'running' ? { lastDeployedAt: new Date().toISOString() } : {}),
    });
  }

  async removeApp(name: string): Promise<boolean> {
    const app = this.apps.get(name);
    if (!app) return false;

    this.apps.delete(name);
    this.scheduleSave();

    eventBus.publish('app:removed', {
      appId: name,
      name,
    });

    eventBus.publish('app:deleted', {
      appId: name,
      name,
    });

    return true;
  }

  // ============ Query Operations ============

  getApp(name: string): AppState | undefined {
    return this.apps.get(name);
  }

  getAllApps(): AppState[] {
    return Array.from(this.apps.values());
  }

  getAppsByStatus(status: AppStatus): AppState[] {
    return this.getAllApps().filter((app) => app.status === status);
  }

  getRunningApps(): AppState[] {
    return this.getAppsByStatus('running');
  }

  hasApp(name: string): boolean {
    return this.apps.has(name);
  }

  // ============ Port Management ============

  getUsedPorts(): number[] {
    return this.getAllApps()
      .filter((app) => app.port !== undefined)
      .map((app) => app.port as number);
  }

  // ============ Statistics ============

  getStats(): { total: number; running: number; stopped: number; errored: number } {
    const apps = this.getAllApps();
    return {
      total: apps.length,
      running: apps.filter((a) => a.status === 'running').length,
      stopped: apps.filter((a) => a.status === 'stopped').length,
      errored: apps.filter((a) => a.status === 'errored').length,
    };
  }
}

// Singleton instance
let stateManagerInstance: AppStateManager | null = null;

export function getStateManager(config?: StateManagerConfig): AppStateManager {
  if (!stateManagerInstance) {
    if (!config) {
      throw new Error('StateManager config required on first call');
    }
    stateManagerInstance = new AppStateManager(config);
  }
  return stateManagerInstance;
}

export function resetStateManager(): void {
  if (stateManagerInstance) {
    stateManagerInstance.close();
    stateManagerInstance = null;
  }
}
