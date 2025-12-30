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
import { parsePath, getAppDirectory, isConfigFile } from './path-parser';
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
        ignoreInitial: false,
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
    hostname: string | null,
    _port: number | null
  ): void {
    if (this.knownApps.has(appName)) {
      return;
    }

    this.knownApps.add(appName);
    this.eventsEmitted++;

    eventBus.publish('app:detected', {
      name: appName,
      path: appPath,
      type: hostname ? 'hostname' : undefined,
    });
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

  private handleFileChange(_appName: string, change: PendingChange): void {
    this.eventsEmitted++;

    eventBus.publish('watcher:change', {
      path: change.path,
      changeType: change.type,
      relativePath: change.relativePath,
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
    // Scan for existing apps on startup
    const watched = this.watcher?.getWatched() || {};

    for (const dir of Object.keys(watched)) {
      const relativePath = path.relative(this.config.appsDir, dir);
      const segments = relativePath.split(path.sep).filter(s => s.length > 0);

      // Only consider first-level directories as apps
      if (segments.length === 1) {
        const appName = segments[0];
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
