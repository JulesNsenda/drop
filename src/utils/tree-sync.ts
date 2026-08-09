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
 *
 * Callers must also guarantee `srcDir` carries no `.git` metadata from
 * untrusted input — enforced today by `extractTarball`'s `.git`-component
 * guard, not by anything in this file. `DEFAULT_PRESERVE` below deliberately
 * does NOT protect `.git`: preserve exempts a name from the prune, it does
 * not stop a hostile source tree from landing one in the first place.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import type { Stats } from 'fs';

export interface SyncTreeOptions {
  /**
   * Entry names that survive the prune even when absent from the source,
   * matched by NAME at any depth (segment semantics, like the monorepo copy
   * exclusions) — so a nested package's `node_modules` is kept too.
   *
   * More precisely: at any depth **whose ancestors also survive**. A
   * directory the source no longer has is removed whole, without consulting
   * this list for its children — which is the intent (a package that is gone
   * has no meaningful dependencies left behind), but it does mean preserve is
   * not an absolute exemption from deletion.
   */
  preserve?: readonly string[];

  /**
   * Source-side filter: entries whose path matches are treated as though the
   * source does not have them — not copied, and **not protected from the
   * prune**. That second half is the point. `exclude` and `preserve` are
   * opposites, not synonyms: excluding `dist` from the source is what makes
   * the prune delete a stale `dist` from the destination, which is what
   * forces a static app to rebuild.
   *
   * Matched against the path RELATIVE to the sync root, so a root that itself
   * sits under a matching name still copies. (Matching the absolute path —
   * what `expandMonorepo`'s `fs.cp` filter did — meant a service at
   * `packages/build` rejected its own copy root and silently copied nothing.)
   */
  exclude?: RegExp;
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
  const ctx: SyncContext = {
    root: srcDir,
    preserve: new Set(options.preserve ?? []),
    exclude: options.exclude,
  };
  await copyInto(srcDir, destDir, ctx);
  await prune(srcDir, destDir, ctx);
}

interface SyncContext {
  /** Sync root, so `exclude` can be matched relative to it. */
  root: string;
  preserve: Set<string>;
  exclude?: RegExp;
}

/** Whether the source filter hides this path from both halves of the sync. */
function isExcluded(srcPath: string, ctx: SyncContext): boolean {
  if (!ctx.exclude) return false;
  return ctx.exclude.test(path.relative(ctx.root, srcPath));
}

async function copyInto(srcDir: string, destDir: string, ctx: SyncContext): Promise<void> {
  await fs.mkdir(destDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (isExcluded(srcPath, ctx)) continue;

    if (entry.isDirectory()) {
      // A previous deploy may have left a file (or a link) at this name.
      // `fs.cp` throws ERR_FS_CP_DIR_TO_NON_DIR on that flip and abandons the
      // copy mid-tree, leaving a permanently half-old/half-new directory —
      // clear the entry instead so the kind change lands.
      await removeIfKind(destPath, (st) => !st.isDirectory());
      await copyInto(srcPath, destPath, ctx);
    } else if (entry.isFile()) {
      // Same flip in the other direction.
      await removeIfKind(destPath, (st) => st.isDirectory());
      await fs.copyFile(srcPath, destPath);
    }
    // Symlinks, devices, FIFOs: skipped. See the file header — callers
    // guarantee none, and reproducing a link is the hole PR #158 closed.
  }
}

async function prune(srcDir: string, destDir: string, ctx: SyncContext): Promise<void> {
  const [srcEntries, destEntries] = await Promise.all([
    fs.readdir(srcDir, { withFileTypes: true }),
    fs.readdir(destDir, { withFileTypes: true }),
  ]);
  // Excluded source entries are filtered out HERE too, so the destination sees
  // them as absent and the prune removes them. Skipping this would let a
  // source `dist/` — never copied — still vouch for a stale `dist/` in the
  // destination, and a static app would go on serving the old bundle.
  const srcByName = new Map(
    srcEntries.filter((e) => !isExcluded(path.join(srcDir, e.name), ctx)).map((e) => [e.name, e])
  );

  for (const destEntry of destEntries) {
    if (ctx.preserve.has(destEntry.name)) continue;

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
      await prune(path.join(srcDir, destEntry.name), path.join(destDir, destEntry.name), ctx);
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
