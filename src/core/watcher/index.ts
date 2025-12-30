/**
 * Watcher Module
 *
 * Exports the WatcherService, configuration, and related utilities.
 */

export { WatcherService, getWatcher, resetWatcher } from './watcher';
export { Debouncer } from './debouncer';
export {
  parsePath,
  isValidHostname,
  extractAppName,
  getAppDirectory,
  isConfigFile,
} from './path-parser';
export {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_MAX_DEPTH,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_WATCHER_CONFIG,
  createWatcherConfig,
} from './watcher.config';

export type {
  WatcherConfig,
  WatchEventType,
  WatchEvent,
  ParsedPath,
  PendingChange,
  WatcherState,
  WatcherStats,
} from './watcher.types';
