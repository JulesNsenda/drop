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

/** One tracked regular file: repository-relative `/` path, its git blob id and mode. */
export interface TrackedFile {
  path: string;
  sha: string;
  /** `100644`, or `100755` when the executable bit is set. */
  mode: string;
}

/**
 * What identifies a file's landed state: blob id AND mode, so a commit that only
 * flips the executable bit is a change. A manifest value without a mode (older
 * lists, or version-1 entries) never equals this, so such a file is rewritten
 * once and recorded with its mode.
 */
export function fileStamp(file: { sha: string; mode: string }): string {
  return file.sha === '' ? '' : `${file.sha}:${file.mode}`;
}

/** What a land wrote: path to its stamp (see fileStamp). An empty value means "written, state unknown". */
export type LandedFiles = Map<string, string>;

export interface LandRequest {
  cloneDir: string;
  appDir: string;
  /** Tracked regular files of the clone. */
  files: TrackedFile[];
  /**
   * The previously landed files, or `null` when there is none. A file whose id
   * is unchanged (and whose copy is still a regular file) is not rewritten; a
   * path absent from the new list is the only kind that is ever deleted.
   */
  previous: LandedFiles | null;
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
async function assertPlainParents(
  base: string,
  segs: string[],
  what: string,
  verified: Set<string>
): Promise<void> {
  let cur = base;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = path.join(cur, segs[i]);
    // Each directory is looked at once per land; the clone is ours alone.
    const key = segs.slice(0, i + 1).join('/');
    if (verified.has(key)) continue;
    const st = await lstatOrNull(cur);
    if (!st || !st.isDirectory() || st.isSymbolicLink()) {
      throw new Error(`${what} is not under plain directories: ${segs.join('/')}`);
    }
    verified.add(key);
  }
}

export async function landTracked(req: LandRequest): Promise<LandedFiles> {
  const { cloneDir, appDir, files, previous, limits, onCreatedAppDir } = req;

  // Validate and measure BEFORE writing anything, so a refusal leaves the app
  // exactly as it was.
  const planned: Array<{ rel: string; segs: string[]; stamp: string; mode: string; size: number }> = [];
  const dirs = new Set<string>();
  let bytes = 0;
  if (files.length > limits.maxEntries) {
    throw new Error(`Repository exceeds the maximum of ${limits.maxEntries} entries`);
  }
  const verifiedCloneDirs = new Set<string>();
  for (const file of files) {
    const rel = file.path;
    const segs = segmentsOf(rel);
    if (path.join(appDir, ...segs).length > MAX_PATH_LENGTH) {
      throw new Error(`Refusing to land an over-long path: ${rel.slice(0, 80)}`);
    }
    // Every file the index lists must be there: a clone that lost one is not a
    // clone to deploy from. (Tracked symlinks are listed separately and are
    // the only thing skipped on purpose.)
    await assertPlainParents(cloneDir, segs, 'Clone entry', verifiedCloneDirs);
    const st = await lstatOrNull(path.join(cloneDir, ...segs));
    if (!st || !st.isFile()) {
      throw new Error(`Tracked file missing from the clone: ${rel.slice(0, 120)}`);
    }
    bytes += st.size;
    if (bytes > limits.maxBytes) {
      throw new Error(`Repository exceeds the maximum checkout size of ${Math.floor(limits.maxBytes / (1024 * 1024))} MB`);
    }
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
    planned.push({ rel, segs, stamp: fileStamp(file), mode: file.mode, size: st.size });
  }
  if (planned.length + dirs.size > limits.maxEntries) {
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
    for (const { rel } of planned) {
      const k = fold(rel);
      if (seen.has(k)) throw new Error('Repository has paths that differ only by case; this host cannot hold both');
      seen.add(k);
    }
  }

  // Copy. The caller holds the app's exclusive reservation, so nothing else is
  // writing the folder: each directory is verified once per land.
  const checkedDirs = new Set<string>();
  const landed: LandedFiles = new Map();
  for (const { rel, segs, stamp, mode, size } of planned) {
    let cur = appDir;
    for (let i = 0; i < segs.length - 1; i++) {
      cur = path.join(cur, segs[i]);
      const key = segs.slice(0, i + 1).join('/');
      if (!checkedDirs.has(key)) {
        await ensureRealDir(cur, key);
        checkedDirs.add(key);
      }
    }
    const dest = path.join(cur, segs[segs.length - 1]);
    landed.set(rel, stamp);

    // Unchanged since the last land and still a plain file of the right size:
    // leave it (no rewrite, no new mtime for the watcher or a signature).
    const before = await lstatOrNull(dest);
    if (
      stamp !== '' &&
      previous?.get(rel) === stamp &&
      before?.isFile() &&
      !before.isSymbolicLink() &&
      before.size === size
    ) {
      continue;
    }
    // A directory in the way must go first; anything else is replaced by the
    // rename below (a link is replaced, never followed).
    if (before?.isDirectory() && !before.isSymbolicLink()) await clearEntry(dest);
    // Write beside the target, then rename over it: there is no moment when
    // the path is missing or half-written.
    const tmp = path.join(cur, `.drop-land-${randomBytes(6).toString('hex')}`);
    try {
      await fs.copyFile(path.join(cloneDir, ...segs), tmp, fsConstants.COPYFILE_EXCL);
      // The executable bit is part of what the repository tracks: set it (or
      // clear it) explicitly rather than trusting what the checkout produced.
      if (process.platform !== 'win32') await fs.chmod(tmp, mode === '100755' ? 0o755 : 0o644);
      await fs.rename(tmp, dest);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  // Prune: only what the previous land wrote and this one no longer has.
  if (previous) {
    const now = new Set([...landed.keys()].map(fold));
    for (const rel of previous.keys()) {
      if (now.has(fold(rel))) continue;
      let segs: string[];
      try {
        segs = segmentsOf(rel);
      } catch {
        continue;
      }
      if (segs.some((seg) => fold(seg) === 'node_modules')) continue;
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
  return landed;
}

// ── Manifest store ───────────────────────────────────────────────────────────

interface ManifestFile {
  version: 2;
  files: Record<string, string>;
}

/**
 * Where the saved file lists live, given the platform's `data` directory. The
 * ONE place the location is built: the platform, app teardown and rollback all
 * go through it.
 */
export function gitManifestDir(dataDir: string): string {
  return path.join(dataDir, 'drop-svc', 'git-manifests');
}

/** One app's saved file list. Throws on a name that could escape the directory. */
export function gitManifestPath(manifestDir: string, appName: string): string {
  if (!appName || path.basename(appName) !== appName || appName.includes('..')) {
    throw new Error('Invalid app name for manifest');
  }
  return path.join(manifestDir, `${appName}.json`);
}

/**
 * The previously landed files, or `null` (missing or unreadable: prune nothing).
 * A version-1 file (paths only) reads with unknown ids, so every file is
 * rewritten once and the ids are recorded.
 */
export async function readManifest(dir: string, appName: string): Promise<LandedFiles | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(gitManifestPath(dir, appName), 'utf-8')) as {
      version?: number;
      files?: unknown;
    };
    if (parsed?.version === 2 && parsed.files && typeof parsed.files === 'object') {
      const out: LandedFiles = new Map();
      for (const [k, v] of Object.entries(parsed.files as Record<string, unknown>)) {
        out.set(k, typeof v === 'string' ? v : '');
      }
      return out;
    }
    if (parsed?.version === 1 && Array.isArray(parsed.files)) {
      return new Map(parsed.files.filter((f): f is string => typeof f === 'string').map((f) => [f, '']));
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeManifest(dir: string, appName: string, files: LandedFiles): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const value: ManifestFile = { version: 2, files: Object.fromEntries(files) };
  await writeJsonAtomic(gitManifestPath(dir, appName), value, { mode: 0o600 });
}
