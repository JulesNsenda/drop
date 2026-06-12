/**
 * Build Log Service
 *
 * Captures per-deploy build output to timestamped files under
 * data/logs/builds/<app>/. Enforces retention of the last N build logs.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';

const MAX_BUILD_LOGS = 10;

export interface BuildLogEntry {
  id: string;
  appName: string;
  timestamp: string;
  logFile: string;
}

interface ActiveLog {
  stream: fs.WriteStream;
  file: string;
}

export class BuildLogService {
  private readonly baseDir: string;
  private readonly activeLogs: Map<string, ActiveLog> = new Map();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  /**
   * Start capturing a new build. Returns a log ID.
   */
  async startBuild(appName: string, timestamp: Date): Promise<string> {
    const appLogDir = path.join(this.baseDir, appName);
    await fsp.mkdir(appLogDir, { recursive: true });

    const iso = timestamp.toISOString().replace(/[:.]/g, '-');
    const logId = `${appName}-${iso}`;
    const logFile = path.join(appLogDir, `${iso}.log`);

    const stream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf-8' });
    this.activeLogs.set(logId, { stream, file: logFile });
    return logId;
  }

  /**
   * Append a line to an active build log. No-op if logId is unknown.
   */
  writeLine(logId: string, line: string): void {
    const entry = this.activeLogs.get(logId);
    if (!entry) return;
    const ts = new Date().toISOString();
    entry.stream.write(`[${ts}] ${line}\n`);
  }

  /**
   * Close the log stream and enforce retention (keep last MAX_BUILD_LOGS per app).
   */
  async finishBuild(logId: string, appName: string): Promise<void> {
    const entry = this.activeLogs.get(logId);
    if (!entry) return;

    await new Promise<void>((resolve) => {
      entry.stream.end(resolve);
    });
    this.activeLogs.delete(logId);

    await this.enforceRetention(appName);
  }

  /**
   * List build log entries for an app, newest first.
   */
  async listBuilds(appName: string): Promise<BuildLogEntry[]> {
    const appLogDir = path.join(this.baseDir, appName);
    try {
      const files = await fsp.readdir(appLogDir);
      const logs = files
        .filter((f) => f.endsWith('.log'))
        .sort()
        .reverse()
        .map((f) => ({
          id: `${appName}-${f.replace('.log', '')}`,
          appName,
          timestamp: f.replace('.log', ''),
          logFile: path.join(appLogDir, f),
        }));
      return logs;
    } catch {
      return [];
    }
  }

  /**
   * Return the content of the most recent build log for an app.
   */
  async getLatestBuildLog(appName: string): Promise<string | null> {
    const entries = await this.listBuilds(appName);
    if (!entries.length) return null;
    try {
      return await fsp.readFile(entries[0].logFile, 'utf-8');
    } catch {
      return null;
    }
  }

  /**
   * Return the content of a specific build log file.
   */
  async getBuildLog(logFile: string): Promise<string | null> {
    try {
      const appLogDirResolved = path.resolve(this.baseDir);
      const fileResolved = path.resolve(logFile);
      if (!fileResolved.startsWith(appLogDirResolved)) return null;
      return await fsp.readFile(logFile, 'utf-8');
    } catch {
      return null;
    }
  }

  private async enforceRetention(appName: string): Promise<void> {
    const appLogDir = path.join(this.baseDir, appName);
    try {
      const files = (await fsp.readdir(appLogDir))
        .filter((f) => f.endsWith('.log'))
        .sort();
      if (files.length > MAX_BUILD_LOGS) {
        const toDelete = files.slice(0, files.length - MAX_BUILD_LOGS);
        for (const f of toDelete) {
          await fsp.unlink(path.join(appLogDir, f)).catch(() => undefined);
        }
      }
    } catch {
      // Directory may not exist yet; ignore
    }
  }
}

let instance: BuildLogService | null = null;

export function getBuildLogService(baseDir?: string): BuildLogService {
  if (!instance) {
    if (!baseDir) throw new Error('BuildLogService not initialized: provide baseDir');
    instance = new BuildLogService(baseDir);
  }
  return instance;
}

export function resetBuildLogService(): void {
  instance = null;
}
