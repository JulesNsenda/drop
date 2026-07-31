/**
 * Land one directory tree over another: copy what the source has, delete what
 * it doesn't, keep a named set regardless.
 *
 * Extracted from `UploadDeployService`'s `copyTree` + `pruneStale` pair, which
 * already had this shape, so the deploy paths share one implementation of the
 * tricky parts (entry-kind flips, symlink-safe deletion, a preserve list)
 * rather than each getting them subtly wrong.
 *
 * Callers must guarantee `srcDir` contains no symlinks — both do, by
 * construction: `tar-extract` rejects an archive carrying any non-regular
 * entry, and `expandMonorepo` refuses a service whose subtree contains a link.
 * Links in the source are therefore skipped rather than reproduced, because
 * copying one would recreate the aliasing hole closed in PR #158.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import type { Stats } from 'fs';

export interface SyncTreeOptions {
  /**
   * Entry names that survive the prune even when absent from the source,
   * matched by NAME at any depth (segment semantics, like the monorepo copy
   * exclusions) — so a nested package's `node_modules` is kept too.
   */
  preserve?: readonly string[];
}

/**
 * The set every deploy path should preserve.
 *
 * `node_modules` ONLY. `dist`/`build` are excluded **deliberately and
 * necessarily** — do not "complete" this list:
 *
 * `StaticBuildStrategy.preBuild` resolves an existing `dist/index.html` as
 * "already built" BEFORE it checks for a source SPA, returns early leaving
 * `buildCommand` unset, and `validate()` then passes against that stale
 * bundle. Deleting the previous output is currently the only thing forcing a
 * static app to rebuild on redeploy. Preserving it would turn "serves new
 * code" into "silently serves last deploy's bundle, reported green" — the
 * failure that got v2 of the monorepo materialization plan rejected.
 *
 * Preserving `node_modules` does NOT enable a skip-install: that path is dead
 * in the default case (`strategies/nodejs.ts` — the detector always supplies
 * an `installCommand`). What it buys is not deleting a running process's
 * dependencies out from under it mid-redeploy.
 */
export const DEFAULT_PRESERVE: readonly string[] = ['node_modules'];

/**
 * Copy every entry of `srcDir` into `destDir`, then remove entries under
 * `destDir` that `srcDir` doesn't have. `destDir` is created if absent, so a
 * first-time land is just a copy with nothing to prune.
 */
export async function syncTree(
  srcDir: string,
  destDir: string,
  options: SyncTreeOptions = {}
): Promise<void> {
  const preserve = new Set(options.preserve ?? []);
  await copyInto(srcDir, destDir);
  await prune(srcDir, destDir, preserve);
}

async function copyInto(srcDir: string, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      // A previous deploy may have left a file (or a link) at this name.
      // `fs.cp` throws ERR_FS_CP_DIR_TO_NON_DIR on that flip and abandons the
      // copy mid-tree, leaving a permanently half-old/half-new directory —
      // clear the entry instead so the kind change lands.
      await removeIfKind(destPath, (st) => !st.isDirectory());
      await copyInto(srcPath, destPath);
    } else if (entry.isFile()) {
      // Same flip in the other direction.
      await removeIfKind(destPath, (st) => st.isDirectory());
      await fs.copyFile(srcPath, destPath);
    }
    // Symlinks, devices, FIFOs: skipped. See the file header — callers
    // guarantee none, and reproducing a link is the hole PR #158 closed.
  }
}

async function prune(srcDir: string, destDir: string, preserve: Set<string>): Promise<void> {
  const [srcEntries, destEntries] = await Promise.all([
    fs.readdir(srcDir, { withFileTypes: true }),
    fs.readdir(destDir, { withFileTypes: true }),
  ]);
  const srcByName = new Map(srcEntries.map((e) => [e.name, e]));

  for (const destEntry of destEntries) {
    if (preserve.has(destEntry.name)) continue;

    const srcEntry = srcByName.get(destEntry.name);
    if (!srcEntry) {
      // `rm` on a symlink removes the LINK, never what it points at, so a link
      // planted in the app directory can't be used to delete outside it.
      await fs.rm(path.join(destDir, destEntry.name), { recursive: true, force: true });
      continue;
    }
    // Recurse only where both sides are real directories. A kind flip was
    // already resolved by the copy above, and `isDirectory()` here is lstat
    // semantics, so a link is never followed into.
    if (destEntry.isDirectory() && srcEntry.isDirectory()) {
      await prune(path.join(srcDir, destEntry.name), path.join(destDir, destEntry.name), preserve);
    }
  }
}

/** Remove `p` when it exists and its own kind (lstat, links not followed) matches. */
async function removeIfKind(p: string, matches: (st: Stats) => boolean): Promise<void> {
  let st: Stats;
  try {
    st = await fs.lstat(p);
  } catch {
    return;
  }
  // A link occupying the name is always cleared: it is never the directory or
  // regular file the source is about to land there.
  if (st.isSymbolicLink() || matches(st)) {
    await fs.rm(p, { recursive: true, force: true });
  }
}
