/**
 * Hardened host-side access to a tenant's app tree.
 *
 * Under isolation=docker the build container bind-mounts the app directory
 * read-write as the platform uid, so anything the tenant's install/postinstall
 * scripts leave behind is attacker-shaped input to the HOST process that comes
 * back afterwards: `node_modules` or a marker inside it can be a symlink at
 * data/drop-svc/encryption.key, a FIFO, a link at /dev/zero, or a hard link to
 * a platform file. Every host-side read, write or wipe of such a path goes
 * through here rather than a bare fs call, so there is one place that knows
 * the rules. Every call takes the same shape, `(treeRoot, relPath)`:
 *
 *  - reads are bounded and refuse anything that is not a plain, singly-linked
 *    regular file;
 *  - writes refuse a target whose parent directory is a symlink or escapes the
 *    tree, never create the directory, and never truncate until the opened
 *    handle has been vetted;
 *  - removals never follow a symlink out of the tree;
 *  - moves (moveTenantDirOut / moveTenantDirIn) rename without following the
 *    final component. moveTenantDirOut carries only a real directory; for
 *    moveTenantDirIn, whatever sits at the target (a partial tree, or a link a
 *    tenant planted) is renamed AS ITSELF out to a platform-chosen trash path,
 *    never followed and never deleted by the move.
 *
 * PRECONDITION (the directory-resolving helpers in this module only): no
 * tenant process with write access to the tree is running during a call. Node
 * has no openat, so vetting the parent directory and then using it is
 * check-then-act and relies on this. It holds for the docker build container
 * (PID-namespace-scoped, exited before postInstall) and for runtime containers
 * (/app is read-only); under isolation=none a live app can write its own tree,
 * so do not rely on these helpers there against a running tenant. The
 * primitive that IS safe against a live tenant is openRegularFileNoFollow in
 * safe-open.ts: it vets one component with O_NOFOLLOW and fstats the handle.
 *
 * readTenantFile, hashTenantFile, writeTenantFile and the two moves never throw for a hostile tree: a refusal
 * is a normal outcome the caller turns into "treat as unknown / do nothing".
 * removeTenantPath is the one exception and THROWS on refusal or failure, on
 * purpose: a wipe that did not happen must fail the build rather than let it
 * proceed on a stale tree. The error is always the generic
 * `failed to remove <relPath>` (the cause is attached, not interpolated), so an
 * absolute host path never reaches build-failure text; relPath is
 * platform-chosen, never tenant-chosen.
 */

import type { Stats } from 'fs';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';
import { isPathStrictlyWithin } from './paths';
import {
  chmodDirNoFollow,
  openRegularFileForWriteNoFollow,
  openRegularFileNoFollow,
} from './safe-open';

/**
 * The dependency directory the Node strategy installs into. Named once because
 * it is also the tenant-controlled directory the host must never follow a link
 * through (this module).
 */
export const NODE_MODULES_DIR = 'node_modules';

type Resolved =
  | { kind: 'ok'; target: string }
  | { kind: 'absent'; at: 'parent' }
  | { kind: 'refused' };

function isBareName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..';
}

/** Non-empty, relative, no `..` segment. */
function isSafeRelative(relPath: string): boolean {
  if (relPath === '' || path.isAbsolute(relPath)) return false;
  return !relPath.split(/[\\/]+/).includes('..');
}

/**
 * Resolve `<treeRoot>/<relPath>` to the absolute target path, having vetted its
 * PARENT. The last segment must be a bare name (so never the root). A parent
 * that is the tree root itself is accepted as-is; any other parent must lstat
 * as a real directory (not a link) and be a strict descendant of the root by
 * realpath (isPathStrictlyWithin fails closed on any error, which is right
 * here: "cannot resolve" must mean "do not touch"). A parent that does not
 * exist is `absent`, not a refusal.
 */
async function resolveContainedParent(treeRoot: string, relPath: string): Promise<Resolved> {
  const refused: Resolved = { kind: 'refused' };
  try {
    if (!isSafeRelative(relPath)) return refused;
    const name = path.basename(relPath);
    if (!isBareName(name)) return refused;

    const parentRel = path.dirname(path.normalize(relPath));
    const target = path.join(treeRoot, parentRel, name);
    if (parentRel === '.') return { kind: 'ok', target };

    const parent = path.join(treeRoot, parentRel);
    try {
      const stat = await fs.lstat(parent);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return refused;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { kind: 'absent', at: 'parent' };
      }
      return refused;
    }
    // lstat only vets the last component; realpath catches a linked ancestor.
    if (!(await isPathStrictlyWithin(treeRoot, parent))) return refused;
    return { kind: 'ok', target };
  } catch {
    return refused;
  }
}

type Vetted<T> =
  | { kind: 'absent'; at: 'parent' | 'file' }
  | { kind: 'refused' }
  | { kind: 'ok'; value: T };

/**
 * Resolve, open and vet `<treeRoot>/<relPath>`, then hand the vetted handle to
 * `consume`. Owns the size gate, the close, and the never-throw contract: a
 * consume that throws, or a close that rejects, is `refused` (content from a
 * handle that would not close cleanly is not vouched for).
 */
async function withVettedFile<T>(
  treeRoot: string,
  relPath: string,
  maxBytes: number,
  consume: (handle: FileHandle, stat: Stats) => Promise<T>
): Promise<Vetted<T>> {
  const resolved = await resolveContainedParent(treeRoot, relPath);
  if (resolved.kind !== 'ok') return resolved;

  const opened = await openRegularFileNoFollow(resolved.target);
  if (opened.kind === 'absent') return { kind: 'absent', at: 'file' };
  if (opened.kind === 'refused') return opened;
  const { handle, stat } = opened;
  let result: Vetted<T>;
  try {
    result =
      stat.size > maxBytes
        ? { kind: 'refused' }
        : { kind: 'ok', value: await consume(handle, stat) };
  } catch {
    result = { kind: 'refused' };
  }
  try {
    await handle.close();
  } catch {
    return { kind: 'refused' };
  }
  return result;
}

/**
 * Read up to `maxBytes` of `<treeRoot>/<relPath>`.
 *
 * `absent`: the target (`at: 'file'`) or its parent directory (`at: 'parent'`)
 * does not exist. `refused`: everything else that is not a plain regular file
 * no larger than `maxBytes` (symlink, FIFO, device, directory, hard link,
 * oversize, a linked or escaping parent, any error, including a failing
 * close). Callers must treat the two differently: absent is "nothing there",
 * refused is "something there that we will not vouch for".
 */
export async function readTenantFile(
  treeRoot: string,
  relPath: string,
  maxBytes: number
): Promise<
  { kind: 'absent'; at: 'parent' | 'file' } | { kind: 'refused' } | { kind: 'ok'; content: Buffer }
> {
  const vetted = await withVettedFile(treeRoot, relPath, maxBytes, async (handle, stat) => {
    const buf = Buffer.alloc(stat.size);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    return buf.subarray(0, total);
  });
  return vetted.kind === 'ok' ? { kind: 'ok', content: vetted.value } : vetted;
}

/**
 * Read `<treeRoot>/<relPath>` as trimmed UTF-8 text, for small markers. Same
 * outcomes as readTenantFile (`absent` keeps its `at`); `ok` carries the text.
 * Never throws. The text is tenant-controlled: do not log or echo it.
 */
export async function readTenantText(
  treeRoot: string,
  relPath: string,
  maxBytes: number
): Promise<
  { kind: 'absent'; at: 'parent' | 'file' } | { kind: 'refused' } | { kind: 'ok'; text: string }
> {
  const read = await readTenantFile(treeRoot, relPath, maxBytes);
  return read.kind === 'ok' ? { kind: 'ok', text: read.content.toString('utf-8').trim() } : read;
}

/**
 * SHA-256 of `<treeRoot>/<relPath>`, streamed from the vetted handle so a file
 * up to `maxBytes` is never buffered whole. Same containment and outcomes as
 * readTenantFile (the size cap is checked on the handle's fstat first).
 *
 * The stream is bounded to `maxBytes` too (`end`), so a file a tenant grows
 * after the size check still cannot make the hash run unbounded. Never throws.
 */
export async function hashTenantFile(
  treeRoot: string,
  relPath: string,
  maxBytes: number
): Promise<{ kind: 'absent' } | { kind: 'refused' } | { kind: 'ok'; sha256: string }> {
  const vetted = await withVettedFile(treeRoot, relPath, maxBytes, async (handle) => {
    const hash = crypto.createHash('sha256');
    // autoClose false: the single close in withVettedFile owns the handle's lifetime.
    const stream = handle.createReadStream({
      start: 0,
      end: Math.max(maxBytes - 1, 0),
      autoClose: false,
      highWaterMark: 1024 * 1024,
    });
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest('hex');
  });
  if (vetted.kind === 'absent') return { kind: 'absent' };
  return vetted.kind === 'ok' ? { kind: 'ok', sha256: vetted.value } : vetted;
}

/**
 * Write `content` to `<treeRoot>/<relPath>` if, and only if, its parent
 * directory already exists as a real directory inside the tree. Returns true
 * when written, false when refused or failed; never throws, never mkdirs (a
 * missing directory means there is nothing for the file to vouch for).
 *
 * If the target already exists it must be a regular file. The open carries no
 * O_TRUNC: truncating at open time would destroy a hard-linked platform file
 * before the handle could be vetted, so the handle is fstat'd first (regular,
 * nlink <= 1) and only then truncated. A direct open rather than
 * writeFileAtomic also leaves no temp file for a link to be planted at; the
 * caller is best-effort (a torn file is just a mismatch the next build redoes).
 */
export async function writeTenantFile(
  treeRoot: string,
  relPath: string,
  content: string | Buffer
): Promise<boolean> {
  try {
    const resolved = await resolveContainedParent(treeRoot, relPath);
    if (resolved.kind !== 'ok') return false;
    const { target } = resolved;

    const opened = await openRegularFileForWriteNoFollow(target);
    if (opened.kind !== 'ok') return false;
    const { handle } = opened;
    try {
      await handle.truncate(0);
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Move the real directory `<treeRoot>/<relPath>` OUT of the tree to `destPath`,
 * a platform-chosen path outside it (nothing may already be there). The in-tree
 * side is resolved like every other helper here; the entry is lstat'd and only a
 * real directory moves (a symlink or anything else is `refused`, so a link is
 * never carried out of the tree), and `fs.rename` never follows the final
 * component. The directory's top level is first made u+rwx (rename needs write
 * on the directory itself), so even a `failed` move can leave that one mode bit
 * changed; no content is touched. `absent`: nothing to move. `failed`: the
 * rename itself did not work; `code` is its errno class (`EXDEV` across filesystems, `EPERM`,
 * `ENOTEMPTY` for a leftover destination, ...), never a path, so the caller can
 * tell "cannot rename across devices" from every other failure and decide the
 * fallback. Never throws, never exposes a path in a message.
 */
export async function moveTenantDirOut(
  treeRoot: string,
  relPath: string,
  destPath: string
): Promise<
  | { kind: 'moved' }
  | { kind: 'absent' }
  | { kind: 'refused' }
  | { kind: 'failed'; code: string | undefined }
> {
  let source: string;
  try {
    const resolved = await resolveContainedParent(treeRoot, relPath);
    if (resolved.kind === 'absent') return { kind: 'absent' };
    if (resolved.kind === 'refused') return { kind: 'refused' };
    source = resolved.target;

    const stat = await fs.lstat(source).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (!stat) return { kind: 'absent' };
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { kind: 'refused' };
    // Moving a directory to another parent needs write permission on the
    // directory itself (its `..` entry changes); a tenant-made read-only
    // top directory would otherwise wedge the rename with EACCES. Only this
    // real directory is chmod'd, through a no-follow handle: a link swapped in
    // after the lstat fails the open instead of steering the chmod.
    await chmodDirNoFollow(source).catch(() => undefined);
  } catch {
    return { kind: 'refused' };
  }
  try {
    await fs.rename(source, destPath);
    return { kind: 'moved' };
  } catch (err) {
    return { kind: 'failed', code: (err as NodeJS.ErrnoException).code };
  }
}

/**
 * Move the platform-owned directory `srcPath` back IN to `<treeRoot>/<relPath>`
 * (the reverse of moveTenantDirOut) WITHOUT ever deleting anything first.
 * Whatever is at the target now (a partial install) is renamed OUT to
 * `trashPath` (platform-chosen, outside the tree, not existing yet; its real
 * top directory is first made u+rwx, as in moveTenantDirOut), and only then is
 * `srcPath` renamed in. If either rename fails, `srcPath` is still where it was,
 * so the caller can retry from it. An in-tree parent that is no longer
 * contained is refused. Returns true when restored; never throws.
 *
 * Removing `trashPath` is the caller's job (this module cannot reach the
 * aside-dir remover, and a failure there must not undo a restore): after a
 * `true`, the partial tree sits at `trashPath` if there was one.
 */
export async function moveTenantDirIn(
  treeRoot: string,
  relPath: string,
  srcPath: string,
  trashPath: string
): Promise<boolean> {
  try {
    const resolved = await resolveContainedParent(treeRoot, relPath);
    if (resolved.kind !== 'ok') return false;
    const { target } = resolved;

    const stat = await fs.lstat(target).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (stat) {
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        await chmodDirNoFollow(target).catch(() => undefined);
      }
      // A link or a file is renamed as itself: rename never follows it.
      await fs.rename(target, trashPath);
    }
    await fs.rename(srcPath, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove `<treeRoot>/<relPath>` without ever following a link out of the tree.
 * A symlink is unlinked as a link (its target is untouched); a directory is
 * removed recursively on the UNRESOLVED path (rm does not follow symlinks it
 * meets inside, it unlinks them). Returns true when something was removed,
 * false when it was absent.
 *
 * THROWS on refusal or failure (see the header), always as the generic
 * `failed to remove <relPath>` with the real error as `cause`.
 */
export async function removeTenantPath(treeRoot: string, relPath: string): Promise<boolean> {
  try {
    const resolved = await resolveContainedParent(treeRoot, relPath);
    if (resolved.kind === 'absent') return false;
    if (resolved.kind === 'refused') throw new Error('refused');
    const { target } = resolved;

    const stat = await fs.lstat(target).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (!stat) return false;

    if (stat.isSymbolicLink()) {
      await fs.unlink(target);
      return true;
    }
    await fs.rm(target, { recursive: true, force: true });
    return true;
  } catch (cause) {
    throw new Error('failed to remove ' + relPath, { cause });
  }
}
