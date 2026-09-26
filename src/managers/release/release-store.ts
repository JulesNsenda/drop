/**
 * Release directories (#298, step 3 of docs/plans/2026-09-26-zero-downtime-releases.md).
 *
 * An app on the `zero-downtime` deploy strategy is built into its own
 * directory per deploy — `data/releases/<app>/<releaseId>/` — and served from
 * there, instead of building and running in `webapps/<app>`. The source folder
 * keeps its role (uploads land there, `git pull` updates it, the watcher
 * watches it, drop.yaml is read from it); only the BUILT tree moves.
 *
 * Why this is the precondition for zero-downtime: builds run in place, and both
 * runtimes run an app straight from its directory (PM2 `cwd`, docker's
 * read-only bind mount). An in-place redeploy rewrites `node_modules` and the
 * build output underneath the process that is serving. With a release per
 * deploy, the previous release is not touched until the new one is running.
 *
 * Opt-in (maintainer decision): apps without `deploy.strategy: zero-downtime`
 * keep the in-place behaviour exactly.
 *
 * CONTAINMENT. A release path becomes the runtime's working directory, so every
 * path this module hands back — and every path read back from config before
 * use — must sit directly under this app's releases root. `isReleasePathOf`
 * is the check; callers must apply it to anything they read from storage.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { isValidAppName } from '../../api/middleware/validate';
import { parseDropYaml } from '../../core/detector/drop-yaml-parser';

/**
 * Not copied from the source into a release: VCS metadata, and dependency
 * trees the build installs fresh. Matched by path segment at any depth.
 * Build OUTPUT (`dist/`, `build/`, …) IS copied — some static apps ship it
 * pre-built, and it is theirs to ship.
 */
const NOT_COPIED = new Set(['.git', 'node_modules', '.venv']);

export class ReleaseStore {
  constructor(private readonly dropRoot: string) {}

  /** `data/releases/<app>`. Throws on a name that could escape the root. */
  rootFor(appName: string): string {
    if (!isValidAppName(appName)) throw new Error(`Invalid app name: '${appName}'`);
    return path.join(this.dropRoot, 'data', 'releases', appName);
  }

  /**
   * Whether `candidate` is a release directory of `appName`: exactly one
   * segment below the app's releases root, after resolution. Anything else —
   * a path elsewhere, the root itself, a nested path, `..` tricks — is not.
   */
  isReleasePathOf(appName: string, candidate: string | undefined): candidate is string {
    if (!candidate) return false;
    let root: string;
    try {
      root = this.rootFor(appName);
    } catch {
      return false;
    }
    const resolved = path.resolve(candidate);
    return path.dirname(resolved) === path.resolve(root) && path.basename(resolved) !== '';
  }

  /**
   * Copy the app's source into a fresh release directory and return its path.
   * `releaseId` is the deploy id the platform already minted, so a release is
   * addressable by the same id as its deploy episode and build log.
   */
  async stage(appName: string, sourcePath: string, releaseId: string): Promise<string> {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(releaseId)) {
      throw new Error(`Invalid release id: '${releaseId}'`);
    }
    const root = this.rootFor(appName);
    const dest = path.join(root, releaseId);
    await fs.mkdir(root, { recursive: true, mode: 0o755 });
    await fs.rm(dest, { recursive: true, force: true });
    const sourceRoot = path.resolve(sourcePath);
    await fs.cp(sourceRoot, dest, {
      recursive: true,
      // A link is copied AS a link, never followed — the same rule rollback
      // snapshots use, and what keeps any `.bin`-style link intact.
      verbatimSymlinks: true,
      filter: (src) => {
        const rel = path.relative(sourceRoot, src);
        return !rel.split(path.sep).some((segment) => NOT_COPIED.has(segment));
      },
    });
    return dest;
  }

  /** Remove one release directory. Refuses anything that is not one. */
  async discard(appName: string, releasePath: string): Promise<void> {
    if (!this.isReleasePathOf(appName, releasePath)) return;
    await fs.rm(releasePath, { recursive: true, force: true });
  }

  /** Remove every release of `appName` except the ones listed. */
  async prune(appName: string, keep: Array<string | undefined>): Promise<void> {
    const root = this.rootFor(appName);
    const kept = new Set(keep.filter((p): p is string => !!p).map((p) => path.resolve(p)));
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.resolve(root, entry);
      if (!kept.has(full)) await fs.rm(full, { recursive: true, force: true });
    }
  }

  /** Remove the app's whole releases tree (teardown, or opting back out). */
  async removeAll(appName: string): Promise<void> {
    await fs.rm(this.rootFor(appName), { recursive: true, force: true });
  }
}

/** Whether the app's drop.yaml opts it into release directories. Never throws. */
export async function wantsReleases(sourcePath: string): Promise<boolean> {
  try {
    const parsed = await parseDropYaml(sourcePath);
    return parsed.success && parsed.config?.deploy?.strategy === 'zero-downtime';
  } catch {
    return false;
  }
}
