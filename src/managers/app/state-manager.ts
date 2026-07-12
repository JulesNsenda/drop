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

export type AppStatus = 'pending' | 'building' | 'starting' | 'running' | 'stopped' | 'errored';
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
  buildDuration?: number;
  error?: string;
  gitSource?: GitSource;
  userId?: string;
  customDomain?: string;
  /**
   * Grouping tag for apps expanded from a single monorepo deploy (e.g.
   * `ezsign-backend` / `ezsign-frontend` both tagged `group: ezsign`). Set via
   * `updateApp(name, { group })`, not `registerApp` — `AppConfig` (app-config.ts)
   * is the source of truth for `group`; this mirrors it for state consumers
   * that only read `AppState`. Absent for standalone apps.
   */
  group?: string;
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
      name,
      type,
      // Preserve 'stopped' status so user-stopped apps don't auto-restart
      status: existing?.status === 'stopped' ? 'stopped' : 'pending',
      path: appPath,
      framework,
      hostname: `${name}.localhost`,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      // Preserve important fields from existing state (for restart scenarios)
      port: existing?.port,
      lastDeployedAt: existing?.lastDeployedAt,
      buildDuration: existing?.buildDuration,
      gitSource: existing?.gitSource,
      userId: existing?.userId,
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

  async setAppStatus(name: string, status: AppStatus, details?: { port?: number; pid?: number; error?: string }): Promise<AppState | null> {
    const app = this.apps.get(name);
    if (!app) return null;

    // Clear stale error when app transitions to a healthy state
    if ((status === 'running' || status === 'building' || status === 'starting') && !details?.error) {
      delete app.error;
    }

    return this.updateApp(name, {
      status,
      ...details,
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
