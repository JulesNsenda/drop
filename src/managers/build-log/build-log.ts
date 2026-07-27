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
  /**
   * The timestamp portion ONLY (`2026-07-27T07-13-56-456Z`). The deploy id is
   * a separate field and must never be folded in here or into `id`: both are
   * exposed through GET /logs/:name/builds, so concatenating them would leak
   * the deploy id into two documented API fields and change their shape.
   */
  timestamp: string;
  logFile: string;
  /**
   * Deploy this log belongs to, parsed back out of the filename. Absent for
   * logs written before deploy-id threading, and whenever the caller did not
   * supply one.
   */
  deployId?: string;
}

/**
 * Separates the timestamp from the deploy id in a build-log filename.
 *
 * A double dash is unambiguous: `startBuild` builds the timestamp portion via
 * `toISOString().replace(/[:.]/g, '-')`, which yields single dashes only
 * (`2026-07-27T07-13-56-456Z`) and can never itself contain `--`. A UUID
 * likewise contains only single dashes.
 */
const DEPLOY_ID_SEPARATOR = '--';

/** Split a build-log basename (no `.log`) into its timestamp and deploy id. */
function parseLogBasename(basename: string): { timestamp: string; deployId?: string } {
  const at = basename.indexOf(DEPLOY_ID_SEPARATOR);
  if (at === -1) return { timestamp: basename };
  return {
    timestamp: basename.slice(0, at),
    deployId: basename.slice(at + DEPLOY_ID_SEPARATOR.length) || undefined,
  };
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
   *
   * `deployId`, when supplied, is encoded into the FILENAME rather than kept
   * in memory, so a build log stays addressable by deploy after a restart —
   * this service holds no durable index. It does not enter `logId`, which
   * remains timestamp-keyed as before.
   */
  async startBuild(appName: string, timestamp: Date, deployId?: string): Promise<string> {
    const appLogDir = path.join(this.baseDir, appName);
    await fsp.mkdir(appLogDir, { recursive: true });

    const iso = timestamp.toISOString().replace(/[:.]/g, '-');
    const logId = `${appName}-${iso}`;
    const basename = deployId ? `${iso}${DEPLOY_ID_SEPARATOR}${deployId}` : iso;
    const logFile = path.join(appLogDir, `${basename}.log`);

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
        .map((f) => {
          // Parse the deploy id back out rather than letting it ride along in
          // `id`/`timestamp` — see BuildLogEntry.timestamp. Sorting is still
          // correct because the timestamp is the filename PREFIX, so the
          // suffix never affects lexical order.
          const { timestamp, deployId } = parseLogBasename(f.replace(/\.log$/, ''));
          return {
            id: `${appName}-${timestamp}`,
            appName,
            timestamp,
            logFile: path.join(appLogDir, f),
            ...(deployId ? { deployId } : {}),
          };
        });
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
   * Return the content of the build log for a specific deploy, or null if no
   * log for that deploy exists (never written, or aged out by retention).
   *
   * Resolves through `listBuilds` rather than reconstructing a filename: the
   * timestamp half is not derivable from the deploy id, and this way an entry
   * whose file has been deleted simply doesn't match.
   */
  async getBuildLogByDeployId(appName: string, deployId: string): Promise<string | null> {
    if (!deployId) return null;
    const entry = (await this.listBuilds(appName)).find((e) => e.deployId === deployId);
    if (!entry) return null;
    return this.getBuildLog(entry.logFile);
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
