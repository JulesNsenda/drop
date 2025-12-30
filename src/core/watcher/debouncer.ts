/**
 * Change Debouncer
 *
 * Aggregates rapid file system changes into single events
 * to prevent overwhelming downstream handlers.
 */

import { WatchEventType, PendingChange } from './watcher.types';
import type { Stats } from 'fs';

export type DebouncedCallback = (changes: PendingChange[]) => void;

export class Debouncer {
  private readonly debounceMs: number;
  private readonly callback: DebouncedCallback;
  private readonly pending: Map<string, PendingChange> = new Map();
  private timeoutId: NodeJS.Timeout | null = null;
  private flushTimeoutId: NodeJS.Timeout | null = null;

  constructor(debounceMs: number, callback: DebouncedCallback) {
    this.debounceMs = debounceMs;
    this.callback = callback;
  }

  /**
   * Add a change to the pending queue
   */
  add(
    type: WatchEventType,
    path: string,
    relativePath: string,
    stats?: Stats
  ): void {
    const now = new Date();
    const existing = this.pending.get(path);

    if (existing) {
      // Update existing pending change
      existing.type = this.mergeEventTypes(existing.type, type);
      existing.lastSeen = now;
      existing.count++;
      if (stats) {
        existing.stats = stats;
      }
    } else {
      // Add new pending change
      this.pending.set(path, {
        type,
        path,
        relativePath,
        firstSeen: now,
        lastSeen: now,
        count: 1,
        stats,
      });
    }

    this.scheduleFlush();
  }

  /**
   * Flush all pending changes immediately
   */
  flush(): void {
    this.clearTimers();

    if (this.pending.size > 0) {
      const changes = Array.from(this.pending.values());
      this.pending.clear();
      this.callback(changes);
    }
  }

  /**
   * Clear all pending changes without flushing
   */
  clear(): void {
    this.clearTimers();
    this.pending.clear();
  }

  /**
   * Get count of pending changes
   */
  getPendingCount(): number {
    return this.pending.size;
  }

  /**
   * Check if a path is pending
   */
  isPending(path: string): boolean {
    return this.pending.has(path);
  }

  private scheduleFlush(): void {
    // Clear existing timer
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
    }

    // Schedule new flush
    this.timeoutId = setTimeout(() => {
      this.flush();
    }, this.debounceMs);

    // Also set a max wait time to prevent infinite delays with continuous changes
    if (!this.flushTimeoutId) {
      this.flushTimeoutId = setTimeout(() => {
        this.flush();
      }, this.debounceMs * 3);
    }
  }

  private clearTimers(): void {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    if (this.flushTimeoutId) {
      clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }
  }

  /**
   * Merge two event types to determine the final event type
   */
  private mergeEventTypes(previous: WatchEventType, current: WatchEventType): WatchEventType {
    // If it was added and then changed, it's still an add
    if (previous === 'add' && current === 'change') {
      return 'add';
    }

    // If it was added and then deleted, it's a no-op (remove from pending)
    if (previous === 'add' && current === 'unlink') {
      return 'unlink';
    }

    // If it was deleted and then added, it's a change
    if (previous === 'unlink' && current === 'add') {
      return 'change';
    }

    // For directories
    if (previous === 'addDir' && current === 'unlinkDir') {
      return 'unlinkDir';
    }
    if (previous === 'unlinkDir' && current === 'addDir') {
      return 'addDir';
    }

    // Default to the current event type
    return current;
  }
}
