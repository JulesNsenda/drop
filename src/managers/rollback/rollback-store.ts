/**
 * Per-app rollback snapshots (#296): the last-good tree of an app, kept so a
 * redeploy that builds cleanly and then behaves badly can be undone without
 * the caller still holding the previous source.
 *
 * WHAT AN ARTIFACT IS. Under both isolation modes the runtime starts an app
 * straight from its directory — PM2 uses it as `cwd`, docker bind-mounts it
 * read-only at /app — and builds run in place. So the complete restorable
 * state of a deploy's CODE is that directory, build output and dependencies
 * included. One copy of it is runtime-agnostic by construction: a restore
 * followed by the ordinary restart path behaves identically in both modes.
 *
 * WHEN. Captured immediately BEFORE an upload or git redeploy overwrites a
 * RUNNING app — i.e. the tree that was serving. That is one retained copy (the
 * last-good), not two: capturing after success would need both the current
 * and the previous tree to make "roll back" mean anything. Deploys that land
 * files by other routes (a folder dropped straight into webapps, a monorepo
 * child re-materialization) are not captured, and nothing claims they are.
 *
 * WHERE. `<dropRoot>/data/rollback/<app>/`, deliberately NOT under
 * `data/appdata/<app>/`: that directory is mounted read-write into the running
 * app, which could then plant code that survives a redeploy by way of a
 * rollback.
 *
 * DISK. A snapshot roughly doubles an app's code footprint, so it is only
 * taken when the tree, the app's data dir and the copy all fit under the
 * per-app ceiling, and the ceiling sweep charges it to the app — dropping the
 * snapshot, rather than parking the app, when that is what pushes it over.
 *
 * NOT RESTORED, and every caller must say so: the database and Redis (a
 * rollback that restores code but not schema is a trap, so it claims nothing
 * about data), the app's data dir, secrets and environment.
 *
 * SYMLINKS. `syncTree` skips links, which would strip `node_modules/.bin` and
 * break the restored app, so copies here use `fs.cp` with `verbatimSymlinks`:
 * a link is copied AS a link, never followed. A restore never writes into the
 * existing tree: it empties the app directory (fs.rm does not follow links)
 * and moves a fresh copy in, so a link planted in the bad deploy cannot
 * redirect a write outside the app.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { writeJsonAtomic } from '../../utils/atomic-write';
import { hasEnoughDisk } from '../../utils/disk';
import { isValidAppName } from '../../api/middleware/validate';
import { measureTree, configuredCeilingBytes, MB } from '../guardrail/disk-ceiling';
import { getStateManager } from '../app/state-manager';
import { getAppConfigService } from '../app/app-config';

export interface RollbackSnapshotMeta {
  appName: string;
  /** When the tree was captured — i.e. when the deploy that replaced it began. */
  takenAt: string;
  bytes: number;
  /** AppConfig.outputDirectory at capture, restored with the tree (static apps serve from it). */
  outputDirectory?: string;
}

export type CaptureResult =
  | { captured: true; meta: RollbackSnapshotMeta }
  | { captured: false; reason: string };

/** Everything a rollback does NOT put back. Reported verbatim by the API. */
export const NOT_RESTORED = ['database', 'redis', 'appdata', 'secrets', 'environment'] as const;

export class NoRollbackSnapshotError extends Error {
  constructor(appName: string) {
    super(`No rollback snapshot exists for '${appName}'.`);
    this.name = 'NoRollbackSnapshotError';
  }
}

export class RollbackStore {
  /** Per-app serialization: a capture and a restore must never interleave. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly dropRoot: string) {}

  get root(): string {
    return path.join(this.dropRoot, 'data', 'rollback');
  }

  /** The snapshot directory for an app. Throws on a name that could escape the root. */
  dirFor(appName: string): string {
    if (!isValidAppName(appName)) throw new Error(`Invalid app name: '${appName}'`);
    return path.join(this.root, appName);
  }

  private treeDir(appName: string): string {
    return path.join(this.dirFor(appName), 'tree');
  }

  private metaPath(appName: string): string {
    return path.join(this.dirFor(appName), 'meta.json');
  }

  private withLock<T>(appName: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(appName) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(appName, tail);
    void tail.then(() => {
      if (this.locks.get(appName) === tail) this.locks.delete(appName);
    });
    return run;
  }

  /** The app's snapshot, or null. A meta file without its tree counts as none. */
  async get(appName: string): Promise<RollbackSnapshotMeta | null> {
    try {
      const meta = JSON.parse(await fs.readFile(this.metaPath(appName), 'utf-8')) as RollbackSnapshotMeta;
      await fs.access(this.treeDir(appName));
      return meta;
    } catch {
      return null;
    }
  }

  /**
   * Copy `appPath` as the app's last-good tree, replacing any older snapshot.
   * Never throws: a snapshot is a convenience, and failing one must never fail
   * the deploy that asked for it.
   */
  capture(
    appName: string,
    appPath: string,
    opts: { outputDirectory?: string; maxDiskMb?: number } = {}
  ): Promise<CaptureResult> {
    return this.withLock(appName, async (): Promise<CaptureResult> => {
      const dir = this.dirFor(appName);
      const staging = path.join(dir, `tree.tmp-${randomUUID()}`);
      try {
        const tree = await measureTree(appPath);
        if (tree.truncated) {
          await this.removeUnlocked(appName);
          return { captured: false, reason: 'the app tree is too large to measure' };
        }

        const ceiling = opts.maxDiskMb && opts.maxDiskMb > 0 ? opts.maxDiskMb * MB : configuredCeilingBytes();
        if (ceiling > 0) {
          const data = await measureTree(path.join(this.dropRoot, 'data', 'appdata', appName));
          if (tree.bytes * 2 + data.bytes > ceiling) {
            // A snapshot that does not fit is dropped, not kept stale: an
            // older tree restored over a much newer app is worse than none.
            await this.removeUnlocked(appName);
            return { captured: false, reason: 'a snapshot would not fit under the per-app disk ceiling' };
          }
        }

        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const disk = await hasEnoughDisk(dir);
        if (!disk.ok) {
          return { captured: false, reason: 'the host is low on free disk' };
        }

        await fs.cp(appPath, staging, {
          recursive: true,
          verbatimSymlinks: true,
          errorOnExist: false,
          force: true,
        });
        await fs.rm(this.treeDir(appName), { recursive: true, force: true });
        await fs.rename(staging, this.treeDir(appName));

        const meta: RollbackSnapshotMeta = {
          appName,
          takenAt: new Date().toISOString(),
          bytes: tree.bytes,
          ...(opts.outputDirectory !== undefined ? { outputDirectory: opts.outputDirectory } : {}),
        };
        await writeJsonAtomic(this.metaPath(appName), meta);
        return { captured: true, meta };
      } catch (err) {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
        return {
          captured: false,
          reason: `snapshot failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    });
  }

  /**
   * Replace the contents of `appPath` with the snapshot. The snapshot is kept,
   * so a second rollback is a no-op rather than an error. Throws
   * NoRollbackSnapshotError when there is nothing to restore.
   */
  restoreInto(appName: string, appPath: string): Promise<RollbackSnapshotMeta> {
    return this.withLock(appName, async () => {
      const meta = await this.get(appName);
      if (!meta) throw new NoRollbackSnapshotError(appName);

      // A full copy first, beside the snapshot: if this fails, the app's
      // current tree has not been touched yet.
      const staging = path.join(this.dirFor(appName), `restore.tmp-${randomUUID()}`);
      try {
        await fs.cp(this.treeDir(appName), staging, {
          recursive: true,
          verbatimSymlinks: true,
          errorOnExist: false,
          force: true,
        });

        await fs.mkdir(appPath, { recursive: true });
        for (const entry of await fs.readdir(appPath)) {
          await fs.rm(path.join(appPath, entry), { recursive: true, force: true });
        }
        for (const entry of await fs.readdir(staging)) {
          const from = path.join(staging, entry);
          const to = path.join(appPath, entry);
          try {
            await fs.rename(from, to);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
            await fs.cp(from, to, { recursive: true, verbatimSymlinks: true });
          }
        }
        return meta;
      } finally {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }

  /** Forget an app's snapshot. Best-effort; used at teardown and by the ceiling sweep. */
  remove(appName: string): Promise<void> {
    return this.withLock(appName, () => this.removeUnlocked(appName));
  }

  private async removeUnlocked(appName: string): Promise<void> {
    await fs.rm(this.dirFor(appName), { recursive: true, force: true }).catch(() => undefined);
  }
}

let instance: RollbackStore | null = null;

/** Bind the store to the DROP root. The platform calls this once at startup. */
export function initRollbackStore(dropRoot: string): RollbackStore {
  instance = new RollbackStore(dropRoot);
  return instance;
}

/** The store, or null when the platform has not configured one (isolated tests, CLI). */
export function getRollbackStore(): RollbackStore | null {
  return instance;
}

export function resetRollbackStore(): void {
  instance = null;
}

/**
 * The deploy-path hook: snapshot an existing app's tree before a redeploy
 * overwrites it — but only when that tree is the one SERVING (status
 * `running`). A tree mid-build, errored or stopped is not "last good".
 *
 * Best-effort in every respect. No store configured, an unknown app, a failed
 * copy: all return quietly, because the deploy itself must proceed regardless.
 */
export async function captureBeforeRedeploy(appName: string): Promise<CaptureResult> {
  const store = getRollbackStore();
  if (!store) return { captured: false, reason: 'rollback is not configured' };
  try {
    const app = getStateManager().getApp(appName);
    if (!app) return { captured: false, reason: 'unknown app' };
    if (app.status !== 'running') {
      return { captured: false, reason: `the app is ${app.status}, not running` };
    }
    let config;
    try {
      config = getAppConfigService().getConfig(appName);
    } catch {
      config = undefined;
    }
    // The tree that is SERVING: the current release for an app on the
    // zero-downtime strategy (#298), its source folder otherwise.
    const appPath = config?.currentRelease?.path || config?.path || app.path;
    return await store.capture(appName, appPath, {
      outputDirectory: config?.outputDirectory,
      maxDiskMb: config?.maxDiskMb,
    });
  } catch (err) {
    return { captured: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
