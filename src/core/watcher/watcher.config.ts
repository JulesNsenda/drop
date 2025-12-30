/**
 * Watcher Configuration Defaults
 *
 * Default configuration values and ignore patterns for the Watcher Service.
 */

import { WatcherConfig } from './watcher.types';

export const DEFAULT_DEBOUNCE_MS = 2000;
export const DEFAULT_POLL_INTERVAL = 1000;
export const DEFAULT_MAX_DEPTH = 3;

export const DEFAULT_IGNORE_PATTERNS: string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/.drop/**',
  '**/*.log',
  '**/.DS_Store',
  '**/Thumbs.db',
  '**/.env.local',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/__pycache__/**',
  '**/venv/**',
  '**/.venv/**',
  '**/vendor/**',
  '**/.cache/**',
  '**/.tmp/**',
  '**/tmp/**',
  '**/*.swp',
  '**/*.swo',
  '**/*~',
];

export const DEFAULT_WATCHER_CONFIG: WatcherConfig = {
  appsDir: process.env.DROP_APPS_DIR || '/var/drop/apps',
  debounceMs: parseInt(process.env.DROP_WATCHER_DEBOUNCE || String(DEFAULT_DEBOUNCE_MS), 10),
  ignorePatterns: DEFAULT_IGNORE_PATTERNS,
  maxDepth: parseInt(process.env.DROP_WATCHER_DEPTH || String(DEFAULT_MAX_DEPTH), 10),
  usePolling: process.env.DROP_WATCHER_POLLING === 'true',
  pollInterval: parseInt(process.env.DROP_WATCHER_POLL_INTERVAL || String(DEFAULT_POLL_INTERVAL), 10),
  followSymlinks: true,
  persistent: true,
};

export function createWatcherConfig(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
  const config = { ...DEFAULT_WATCHER_CONFIG, ...overrides };

  // Merge ignore patterns instead of replacing
  if (overrides.ignorePatterns) {
    config.ignorePatterns = [
      ...DEFAULT_IGNORE_PATTERNS,
      ...overrides.ignorePatterns.filter(p => !DEFAULT_IGNORE_PATTERNS.includes(p)),
    ];
  }

  return config;
}
