/**
 * Watcher Service Implementation
 *
 * Monitors the apps directory for file system changes and emits
 * events for detected applications and changes.
 */

import * as chokidar from 'chokidar';
import * as path from 'path';
import * as fs from 'fs/promises';
import { Stats } from 'fs';
import { eventBus } from '../event-bus';
import { Debouncer } from './debouncer';
import { parsePath, getAppDirectory, isConfigFile, isValidAppName } from './path-parser';
import { createWatcherConfig } from './watcher.config';
import {
  WatcherConfig,
  WatcherState,
  WatcherStats,
  WatchEventType,
  PendingChange,
} from './watcher.types';

export class WatcherService {
  private watcher: chokidar.FSWatcher | null = null;
  private readonly config: WatcherConfig;
  private readonly debouncer: Debouncer;
  private state: WatcherState = 'stopped';
  private startedAt: Date | null = null;
  private eventsEmitted = 0;
  private errorsLogged = 0;
  private readonly knownApps: Set<string> = new Set();
  private readonly pendingRebuilds: Map<string, NodeJS.Timeout> = new Map();
  private readonly REBUILD_DEBOUNCE_MS = 2000;

  /** File patterns that trigger a rebuild when changed */
  private readonly REBUILD_TRIGGERS = [
    'package.json',
    // Note: lock files are excluded to prevent infinite loops (npm install modifies them)
    'requirements.txt',
    'Pipfile',
    'pyproject.toml',
    'Dockerfile',
    'docker-compose.yml',
    'docker-compose.yaml',
    'drop.yaml',
    'tsconfig.json',
  ];

  /** File extensions that trigger a rebuild when changed */
  private readonly REBUILD_EXTENSIONS = ['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs'];

  constructor(config: Partial<WatcherConfig> = {}) {
    this.config = createWatcherConfig(config);
    this.debouncer = new Debouncer(
      this.config.debounceMs,
      this.handleDebouncedChanges.bind(this)
    );
  }

  async start(): Promise<void> {
    if (this.state === 'running' || this.state === 'starting') {
      return;
    }

    this.state = 'starting';

    try {
      // Ensure directory exists
      await this.ensureDirectory();

      // Initialize chokidar watcher
      this.watcher = chokidar.watch(this.config.appsDir, {
        ignored: this.config.ignorePatterns,
        persistent: this.config.persistent,
        // M1 review item 6 (round-2 diff pass): true, not false. chokidar's
        // OWN initial-scan events (an 'add'/'addDir' for every pre-existing
        // file/dir at startup) are not real changes — the previous fix
        // (a WatcherService "boot epoch" tagging every observed change
        // fromInitialScan, and processChange dropping tagged ones) worked
        // but was strictly more machinery than needed: getWatched() below
        // (handleReady's dir-scan loop) is populated by chokidar regardless
        // of ignoreInitial, so app-level onboarding for a pre-existing dir
        // never depended on the 'addDir' event in the first place. Letting
        // chokidar suppress the initial batch at the source removes an
        // entire class of bug (the epoch never clearing if 'ready' never
        // fires, a genuine change landing mid-scan being misclassified) for
        // one line.
        ignoreInitial: true,
        followSymlinks: this.config.followSymlinks,
        depth: this.config.maxDepth,
        usePolling: this.config.usePolling,
        interval: this.config.pollInterval,
        awaitWriteFinish: {
          stabilityThreshold: 500,
          pollInterval: 100,
        },
      });

      // Set up event handlers
      this.watcher
        .on('add', (filePath, stats) => this.handleEvent('add', filePath, stats))
        .on('change', (filePath, stats) => this.handleEvent('change', filePath, stats))
        .on('unlink', filePath => this.handleEvent('unlink', filePath))
        .on('addDir', (filePath, stats) => this.handleEvent('addDir', filePath, stats))
        .on('unlinkDir', filePath => this.handleEvent('unlinkDir', filePath))
        .on('error', error => this.handleError(error))
        .on('ready', () => this.handleReady());

      this.startedAt = new Date();
      this.state = 'running';

      eventBus.publish('watcher:started', {
        path: this.config.appsDir,
      });
    } catch (error) {
      this.state = 'error';
      this.errorsLogged++;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'stopping') {
      return;
    }

    this.state = 'stopping';

    // Flush any pending changes
    this.debouncer.flush();

    // Close watcher
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }

    this.state = 'stopped';

    eventBus.publish('watcher:stopped', {
      path: this.config.appsDir,
    });
  }

  getWatchedPaths(): string[] {
    if (!this.watcher) {
      return [];
    }

    const watched = this.watcher.getWatched();
    const paths: string[] = [];

    for (const dir of Object.keys(watched)) {
      for (const file of watched[dir]) {
        paths.push(path.join(dir, file));
      }
    }

    return paths;
  }

  getStats(): WatcherStats {
    return {
      state: this.state,
      startedAt: this.startedAt,
      watchedPaths: this.getWatchedPaths().length,
      eventsEmitted: this.eventsEmitted,
      errorsLogged: this.errorsLogged,
    };
  }

  getConfig(): WatcherConfig {
    return { ...this.config };
  }

  getKnownApps(): string[] {
    return Array.from(this.knownApps);
  }

  private async ensureDirectory(): Promise<void> {
    try {
      await fs.access(this.config.appsDir);
    } catch {
      await fs.mkdir(this.config.appsDir, { recursive: true });
    }
  }

  private handleEvent(type: WatchEventType, filePath: string, stats?: Stats): void {
    // Skip the root directory itself
    if (filePath === this.config.appsDir) {
      return;
    }

    const relativePath = path.relative(this.config.appsDir, filePath);

    // Add to debouncer
    this.debouncer.add(type, filePath, relativePath, stats);
  }

  private handleDebouncedChanges(changes: PendingChange[]): void {
    for (const change of changes) {
      this.processChange(change);
    }
  }

  private processChange(change: PendingChange): void {
    const parsed = parsePath(change.path, this.config.appsDir);
    const appDir = getAppDirectory(change.path, this.config.appsDir);

    if (!parsed.appName) {
      return;
    }

    // Determine if this is an app-level change or a file-level change
    const isAppDir = change.path === appDir;
    const isConfig = isConfigFile(change.path);

    switch (change.type) {
      case 'addDir':
        if (isAppDir) {
          this.handleAppDetected(parsed.appName, change.path, parsed.hostname, parsed.port);
        }
        break;

      case 'unlinkDir':
        if (isAppDir) {
          this.handleAppRemoved(parsed.appName, change.path);
        }
        break;

      case 'add':
      case 'change':
        if (isConfig) {
          this.handleConfigChange(parsed.appName, change.path);
        } else {
          this.handleFileChange(parsed.appName, change);
        }
        break;

      case 'unlink':
        if (isConfig) {
          this.handleConfigChange(parsed.appName, change.path);
        }
        break;
    }
  }

  private handleAppDetected(
    appName: string,
    appPath: string,
    _hostname: string | null,
    _port: number | null
  ): void {
    if (this.knownApps.has(appName)) {
      return;
    }

    this.knownApps.add(appName);
    this.eventsEmitted++;

    // The watcher only knows a directory appeared; it can't determine the app
    // type. Leave `type` unset — the detector resolves it and the platform
    // persists it after build. (Previously this overloaded `type` with the
    // literal 'hostname', writing an invalid AppType into config/state.)
    eventBus.publish('app:detected', {
      name: appName,
      path: appPath,
      type: undefined,
      // Marks this as DROP noticing a folder rather than anyone asking for a
      // deploy. The platform refuses to independently onboard a materialized
      // monorepo child, and that refusal keys off this — an API-originated
      // detection for the same app must still be honoured.
      origin: 'watcher',
    });
  }

  /**
   * Mark an app as already known so the watcher does not publish its own
   * app:detected for it. Called by the platform when an app was onboarded by
   * a non-watcher path (e.g. git deploy's deterministic publish) — without
   * this, the watcher's debounced flush would emit a duplicate detection for
   * the same app a few seconds later. Idempotent.
   */
  markAppKnown(appName: string): void {
    this.knownApps.add(appName);
  }

  private handleAppRemoved(appName: string, _appPath: string): void {
    if (!this.knownApps.has(appName)) {
      return;
    }

    this.knownApps.delete(appName);
    this.eventsEmitted++;

    eventBus.publish('app:removed', {
      appId: appName, // Using appName as ID for now
      name: appName,
    });
  }

  private handleFileChange(appName: string, change: PendingChange): void {
    this.eventsEmitted++;

    eventBus.publish('watcher:change', {
      path: change.path,
      changeType: change.type,
      relativePath: change.relativePath,
    });

    // Check if this is a significant file change that should trigger a rebuild
    if (this.shouldTriggerRebuild(change.path)) {
      this.scheduleRebuild(appName, change.path);
    }
  }

  /**
   * Check if a file change should trigger an app rebuild
   */
  private shouldTriggerRebuild(filePath: string): boolean {
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath);

    // Check for specific trigger files
    if (this.REBUILD_TRIGGERS.includes(fileName)) {
      return true;
    }

    // Check for trigger extensions
    if (this.REBUILD_EXTENSIONS.includes(ext)) {
      return true;
    }

    return false;
  }

  /**
   * Schedule a debounced rebuild for an app.
   * Multiple file changes within the debounce window are coalesced into one
   * rebuild.  If the app is currently locked (a deploy is in progress) the
   * pending rebuild is cancelled and silently dropped — the platform will do a
   * fresh build when it finishes the current one if the sources changed.
   */
  private scheduleRebuild(appName: string, changedFile: string): void {
    // Drop the event immediately if the app is currently being deployed.
    if (this.config.isAppLocked?.(appName)) {
      return;
    }

    // Cancel any pending rebuild for this app
    const existing = this.pendingRebuilds.get(appName);
    if (existing) {
      clearTimeout(existing);
    }

    // Schedule a new rebuild; re-check the lock when the timer fires to
    // handle the edge case where the build started between schedule and fire.
    const timeout = setTimeout(() => {
      this.pendingRebuilds.delete(appName);
      if (!this.config.isAppLocked?.(appName)) {
        this.emitAppUpdate(appName, changedFile);
      }
    }, this.REBUILD_DEBOUNCE_MS);

    this.pendingRebuilds.set(appName, timeout);
  }

  /**
   * Emit an app:update event to trigger rebuild/restart
   */
  private emitAppUpdate(appName: string, changedFile: string): void {
    const appPath = path.join(this.config.appsDir, appName);

    this.eventsEmitted++;

    eventBus.publish('app:update', {
      name: appName,
      path: appPath,
      reason: `File changed: ${path.basename(changedFile)}`,
    });
  }

  private handleConfigChange(_appName: string, configPath: string): void {
    this.eventsEmitted++;

    eventBus.publish('watcher:change', {
      path: configPath,
      changeType: 'change',
      relativePath: path.relative(this.config.appsDir, configPath),
    });
  }

  private handleReady(): void {
    // Scan for existing apps on startup. getWatched() is populated by
    // chokidar regardless of ignoreInitial — this loop is how a pre-existing
    // app dir (not yet in knownApps) is onboarded at boot, independent of
    // whichever 'add'/'addDir' events chokidar chose to suppress.
    const watched = this.watcher?.getWatched() || {};

    for (const dir of Object.keys(watched)) {
      const relativePath = path.relative(this.config.appsDir, dir);
      const segments = relativePath.split(path.sep).filter(s => s.length > 0);

      // Only consider first-level directories as apps
      if (segments.length === 1) {
        const appName = segments[0];
        // Skip invalid app names (., .., hidden dirs, etc.)
        if (!isValidAppName(appName)) {
          continue;
        }
        if (!this.knownApps.has(appName)) {
          const parsed = parsePath(dir, this.config.appsDir);
          this.handleAppDetected(appName, dir, parsed.hostname, parsed.port);
        }
      }
    }
  }

  private handleError(error: Error): void {
    this.errorsLogged++;
    console.error('[WatcherService] Error:', error.message);

    eventBus.publish('platform:error', {
      error,
      context: 'WatcherService',
    });
  }
}

// Singleton instance
let watcherInstance: WatcherService | null = null;

export function getWatcher(config?: Partial<WatcherConfig>): WatcherService {
  if (!watcherInstance) {
    watcherInstance = new WatcherService(config);
  }
  return watcherInstance;
}

export function resetWatcher(): void {
  if (watcherInstance) {
    watcherInstance.stop();
    watcherInstance = null;
  }
}
