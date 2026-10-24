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
 *  - removals never follow a symlink out of the tree.
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
 * readTenantFile, hashTenantFile and writeTenantFile never throw for a hostile tree: a refusal
 * is a normal outcome the caller turns into "treat as unknown / do nothing".
 * removeTenantPath is the one exception and THROWS on refusal or failure, on
 * purpose: a wipe that did not happen must fail the build rather than let it
 * proceed on a stale tree. The error is always the generic
 * `failed to remove <relPath>` (the cause is attached, not interpolated), so an
 * absolute host path never reaches build-failure text; relPath is
 * platform-chosen, never tenant-chosen.
 */

import { constants as fsConstants } from 'fs';
import type { Stats } from 'fs';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import type { FileHandle } from 'fs/promises';
import * as path from 'path';
import { isPathStrictlyWithin } from './paths';
import { NOFOLLOW, NONBLOCK, isPlainSingleLinkFile, openRegularFileNoFollow } from './safe-open';

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

    try {
      const existing = await fs.lstat(target);
      if (!existing.isFile()) return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }

    const handle = await fs.open(
      target,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | NOFOLLOW | NONBLOCK,
      0o644
    );
    try {
      const opened = await handle.stat();
      if (!isPlainSingleLinkFile(opened)) return false;
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
