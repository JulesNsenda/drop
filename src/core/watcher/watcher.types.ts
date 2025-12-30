/**
 * Watcher Service Type Definitions
 *
 * Defines all types for file system watching and event handling.
 */

import type { Stats } from 'fs';

// Watcher configuration
export interface WatcherConfig {
  appsDir: string;
  debounceMs: number;
  ignorePatterns: string[];
  maxDepth: number;
  usePolling: boolean;
  pollInterval: number;
  followSymlinks: boolean;
  persistent: boolean;
}

// Watch event types (from chokidar)
export type WatchEventType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

// Internal watch event
export interface WatchEvent {
  type: WatchEventType;
  path: string;
  relativePath: string;
  appName: string | null;
  hostname: string | null;
  port: number | null;
  timestamp: Date;
  stats?: Stats;
}

// Parsed path information
export interface ParsedPath {
  appName: string;
  hostname: string | null;
  port: number | null;
  relativePath: string;
}

// Debounced change aggregation
export interface PendingChange {
  type: WatchEventType;
  path: string;
  relativePath: string;
  firstSeen: Date;
  lastSeen: Date;
  count: number;
  stats?: Stats;
}

// Watcher state
export type WatcherState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

// Watcher statistics
export interface WatcherStats {
  state: WatcherState;
  startedAt: Date | null;
  watchedPaths: number;
  eventsEmitted: number;
  errorsLogged: number;
}
