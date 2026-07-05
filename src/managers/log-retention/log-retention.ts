/**
 * Log Retention Service
 *
 * Prunes old, inactive log files under the DROP logs tree so a long-lived box
 * does not fill its disk. DROP writes per-app runtime logs (a dated file per
 * app deploy/start), Caddy logs, build logs, and its own platform log under
 * `data/logs/`; without pruning, accumulated dated files grow unbounded.
 *
 * Deletion is by modification time and strictly scoped to the logs root, so a
 * file that is still being written (recent mtime) is never touched, and nothing
 * outside the logs tree can be removed even if a symlink points elsewhere.
 *
 * SCOPE: mtime pruning bounds *accumulated inactive* files — apps that restart
 * often, plus rotated/old-day logs. It does NOT bound a single log file that a
 * long-running app appends to continuously (its mtime stays fresh). Size-based
 * rotation of live app log streams (pm2-logrotate for PM2; a rotating stream in
 * docker log capture) is a separate follow-up.
 */

import * as path from 'path';
import * as fsp from 'fs/promises';
import { Dirent } from 'fs';

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = DAY_MS;
const MAX_WALK_DEPTH = 4;

/** Matches DROP log files: `*.log` and rotated variants like `*.log.<ts>` / `*.log.1`. */
function isLogFile(name: string): boolean {
  return /\.log(\.[\w-]+)?$/.test(name);
}

export class LogRetentionService {
  private readonly logsRoot: string;
  private readonly retentionMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(logsRoot: string, retentionDays: number) {
    this.logsRoot = path.resolve(logsRoot);
    // Guard against a zero/negative window silently deleting everything.
    this.retentionMs = Math.max(1, retentionDays) * DAY_MS;
  }

  /** Start periodic pruning. Runs one sweep immediately, then daily. */
  start(): void {
    if (this.timer) return;
    void this.pruneOnce();
    this.timer = setInterval(() => void this.pruneOnce(), SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Delete log files older than the retention window. Returns the number of
   * files removed. Never throws — log hygiene must not crash the platform.
   */
  async pruneOnce(now: number = Date.now()): Promise<number> {
    const cutoff = now - this.retentionMs;
    try {
      return await this.walkAndPrune(this.logsRoot, cutoff, 0);
    } catch {
      // Logs dir may not exist yet, or a transient FS error — ignore.
      return 0;
    }
  }

  private async walkAndPrune(dir: string, cutoff: number, depth: number): Promise<number> {
    if (depth > MAX_WALK_DEPTH) return 0;
    // Containment: never operate outside the logs root.
    if (!path.resolve(dir).startsWith(this.logsRoot)) return 0;

    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return 0;
    }

    let removed = 0;
    for (const entry of entries) {
      // Never follow symlinks — they could point outside the logs tree.
      if (entry.isSymbolicLink()) continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        removed += await this.walkAndPrune(full, cutoff, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isLogFile(entry.name)) continue;

      try {
        const stat = await fsp.stat(full);
        if (stat.mtimeMs < cutoff) {
          await fsp.unlink(full);
          removed++;
        }
      } catch {
        // File vanished or is locked — skip.
      }
    }
    return removed;
  }
}

let instance: LogRetentionService | null = null;

export function getLogRetentionService(
  logsRoot?: string,
  retentionDays?: number
): LogRetentionService {
  if (!instance) {
    if (!logsRoot) {
      throw new Error('LogRetentionService not initialized: provide logsRoot');
    }
    instance = new LogRetentionService(logsRoot, retentionDays ?? 14);
  }
  return instance;
}

export function resetLogRetentionService(): void {
  if (instance) {
    instance.stop();
    instance = null;
  }
}
