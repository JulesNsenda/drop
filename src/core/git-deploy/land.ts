/**
 * Landing a git clone in an app folder.
 *
 * The clone lives in a platform-owned temp directory; this copies the files the
 * repository TRACKS into the app folder and nothing else. Two properties that
 * a tree-mirroring sync (`syncTree`) does not give:
 *
 * - Only paths the repository itself once tracked are ever deleted. Anything
 *   else in the folder (files an app wrote beside its code, a `.env`, a build
 *   product) is left alone. The platform remembers the previously landed file
 *   list in its own state (`data/drop-svc/git-manifests/<app>.json`) and
 *   deletes only paths in that list that the new list no longer has. With no
 *   previous list, nothing is deleted.
 * - Every write is made as if the folder were hostile, because a container can
 *   write to it: directories are created one level at a time and verified to
 *   be real directories (not links) with `lstat`, a link anywhere on the way
 *   refuses the land, a file is written only after any existing entry has been
 *   removed (never through it) and with `COPYFILE_EXCL`.
 *
 * No `.git` is ever written, and any `.git` found at the top of the folder
 * (a directory, a file, or a link — removed as a link, never followed) is
 * removed.
 */

import * as fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import type { Stats } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { writeJsonAtomic } from '../../utils/atomic-write';
import { isVcsMetadataComponent } from '../../utils/upload-paths';

export interface LandLimits {
  /** Cap on the summed size of the files to copy. */
  maxBytes: number;
  /** Cap on files plus directories created. */
  maxEntries: number;
}

export interface LandRequest {
  cloneDir: string;
  appDir: string;
  /** Tracked regular files, repository-relative with `/` separators. */
  files: string[];
  /** The previously landed file list, or `null` when there is none. */
  previous: string[] | null;
  limits: LandLimits;
  /** Called right after THIS land created the app folder (and not before). */
  onCreatedAppDir?: () => void;
}

/** Longest single path component and longest whole destination path we will write. */
const MAX_SEGMENT_BYTES = 255;
const MAX_PATH_LENGTH = 4000;

/** Split and validate one repository-relative path. */
function segmentsOf(rel: string): string[] {
  const segs = rel.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..' || s.includes('\0') || s.includes('\\') || isVcsMetadataComponent(s)) {
      throw new Error(`Refusing to land unsafe path: ${rel}`);
    }
    if (Buffer.byteLength(s, 'utf8') > MAX_SEGMENT_BYTES) {
      throw new Error(`Refusing to land a path with an over-long name: ${rel.slice(0, 80)}`);
    }
  }
  return segs;
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function refuseLink(rel: string): Error {
  return new Error(`Refusing to write through a symbolic link in the app folder: ${rel || '.'}`);
}

/**
 * Make sure `abs` is a real directory (created one level, non-recursively, when
 * absent). A link refuses; a regular file in the way is replaced.
 */
async function ensureRealDir(abs: string, rel: string): Promise<void> {
  let st = await lstatOrNull(abs);
  if (st?.isSymbolicLink()) throw refuseLink(rel);
  if (st && !st.isDirectory()) {
    await fs.rm(abs, { force: true });
    st = null;
  }
  if (!st) {
    await fs.mkdir(abs);
    st = await fs.lstat(abs);
    if (!st.isDirectory()) throw refuseLink(rel);
  }
}

/** Remove whatever sits at `abs` as the entry itself (a link is unlinked, not followed). */
async function clearEntry(abs: string): Promise<void> {
  const st = await lstatOrNull(abs);
  if (!st) return;
  await fs.rm(abs, { recursive: st.isDirectory() && !st.isSymbolicLink(), force: true });
}

/** Remove a leftover `.git` (any case/alias) from the top of the app folder. */
async function removeDotGit(appDir: string): Promise<void> {
  for (const entry of await fs.readdir(appDir)) {
    if (isVcsMetadataComponent(entry)) {
      await fs.rm(path.join(appDir, entry), { recursive: true, force: true });
    }
  }
}

/**
 * Walk to `rel`'s parent inside `appDir` WITHOUT creating anything, returning
 * false when a component is missing, not a directory, or a link. Used by the
 * prune, which must never follow a link planted where a tracked directory was.
 */
async function parentIsPlainDirs(appDir: string, segs: string[]): Promise<boolean> {
  let cur = appDir;
  for (const s of segs.slice(0, -1)) {
    cur = path.join(cur, s);
    const st = await lstatOrNull(cur);
    if (!st || !st.isDirectory() || st.isSymbolicLink()) return false;
  }
  return true;
}

/**
 * Whether the app folder's volume ignores case. Probed once per land with a
 * throwaway file, because the answer decides whether `Readme.md` and
 * `README.md` are the same entry.
 */
async function probeCaseInsensitive(appDir: string): Promise<boolean> {
  const stem = `.drop-case-probe-${randomBytes(6).toString('hex')}`;
  const lower = path.join(appDir, stem);
  try {
    await fs.writeFile(lower, '', { flag: 'wx' });
    const upper = await lstatOrNull(path.join(appDir, stem.toUpperCase()));
    return upper !== null;
  } catch {
    return false;
  } finally {
    await fs.rm(lower, { force: true }).catch(() => undefined);
  }
}

/** Confirm every directory from `base` down to `rel`'s parent is a real directory. */
async function assertPlainParents(base: string, segs: string[], what: string): Promise<void> {
  let cur = base;
  for (const s of segs.slice(0, -1)) {
    cur = path.join(cur, s);
    const st = await lstatOrNull(cur);
    if (!st || !st.isDirectory() || st.isSymbolicLink()) {
      throw new Error(`${what} is not under plain directories: ${segs.join('/')}`);
    }
  }
}

export async function landTracked(req: LandRequest): Promise<string[]> {
  const { cloneDir, appDir, files, previous, limits, onCreatedAppDir } = req;

  // Validate and measure BEFORE writing anything, so a refusal leaves the app
  // exactly as it was.
  const rels: string[] = [];
  const dirs = new Set<string>();
  let bytes = 0;
  if (files.length > limits.maxEntries) {
    throw new Error(`Repository exceeds the maximum of ${limits.maxEntries} entries`);
  }
  for (const rel of files) {
    const segs = segmentsOf(rel);
    if (path.join(appDir, ...segs).length > MAX_PATH_LENGTH) {
      throw new Error(`Refusing to land an over-long path: ${rel.slice(0, 80)}`);
    }
    // Every file the index lists must be there: a clone that lost one is not a
    // clone to deploy from. (Tracked symlinks are listed separately and are
    // the only thing skipped on purpose.)
    await assertPlainParents(cloneDir, segs, 'Clone entry');
    const st = await lstatOrNull(path.join(cloneDir, ...segs));
    if (!st || !st.isFile()) {
      throw new Error(`Tracked file missing from the clone: ${rel.slice(0, 120)}`);
    }
    bytes += st.size;
    if (bytes > limits.maxBytes) {
      throw new Error(`Repository exceeds the maximum checkout size of ${Math.floor(limits.maxBytes / (1024 * 1024))} MB`);
    }
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
    rels.push(rel);
  }
  if (rels.length + dirs.size > limits.maxEntries) {
    throw new Error(`Repository exceeds the maximum of ${limits.maxEntries} entries`);
  }

  // The app folder itself: created if this is a first deploy, never a link.
  const root = await lstatOrNull(appDir);
  if (root?.isSymbolicLink()) throw refuseLink('');
  if (!root) {
    await fs.mkdir(appDir);
    onCreatedAppDir?.();
  } else if (!root.isDirectory()) throw new Error('App folder is not a directory');

  const insensitive = await probeCaseInsensitive(appDir);
  const fold = (t: string): string => (insensitive ? t.toLowerCase() : t);
  if (insensitive) {
    const seen = new Set<string>();
    for (const rel of rels) {
      const k = fold(rel);
      if (seen.has(k)) throw new Error('Repository has paths that differ only by case; this host cannot hold both');
      seen.add(k);
    }
  }

  // Copy. Every parent is re-checked with lstat for every file: nothing is
  // remembered between writes, because a container may be changing the folder.
  for (const rel of rels) {
    const segs = segmentsOf(rel);
    let cur = appDir;
    for (let i = 0; i < segs.length - 1; i++) {
      cur = path.join(cur, segs[i]);
      await ensureRealDir(cur, segs.slice(0, i + 1).join('/'));
    }
    const dest = path.join(cur, segs[segs.length - 1]);
    await clearEntry(dest);
    await fs.copyFile(path.join(cloneDir, ...segs), dest, fsConstants.COPYFILE_EXCL);
  }

  // Prune: only what the previous land wrote and this one no longer has.
  if (previous) {
    const now = new Set(rels.map(fold));
    for (const rel of previous) {
      if (now.has(fold(rel))) continue;
      let segs: string[];
      try {
        segs = segmentsOf(rel);
      } catch {
        continue;
      }
      if (segs.some((s) => fold(s) === 'node_modules')) continue;
      if (!(await parentIsPlainDirs(appDir, segs))) continue;
      const abs = path.join(appDir, ...segs);
      const st = await lstatOrNull(abs);
      // A directory here is not something the repository tracked as a file.
      if (!st || st.isDirectory()) continue;
      await fs.rm(abs, { force: true });
      // Tidy directories the removal emptied; rmdir refuses non-empty ones.
      for (let i = segs.length - 1; i > 0; i--) {
        try {
          await fs.rmdir(path.join(appDir, ...segs.slice(0, i)));
        } catch {
          break;
        }
      }
    }
  }

  await removeDotGit(appDir);
  return rels;
}

// ── Manifest store ───────────────────────────────────────────────────────────

interface ManifestFile {
  version: 1;
  files: string[];
}

function manifestPath(dir: string, appName: string): string {
  if (path.basename(appName) !== appName || appName.includes('..')) {
    throw new Error('Invalid app name for manifest');
  }
  return path.join(dir, `${appName}.json`);
}

/** The previously landed file list, or `null` (missing or unreadable: prune nothing). */
export async function readManifest(dir: string, appName: string): Promise<string[] | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(manifestPath(dir, appName), 'utf-8')) as ManifestFile;
    if (parsed?.version !== 1 || !Array.isArray(parsed.files)) return null;
    return parsed.files.filter((f): f is string => typeof f === 'string');
  } catch {
    return null;
  }
}

export async function writeManifest(dir: string, appName: string, files: string[]): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const value: ManifestFile = { version: 1, files };
  await writeJsonAtomic(manifestPath(dir, appName), value, { mode: 0o600 });
}
