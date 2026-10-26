/**
 * Open a regular file for reading without being steered by what a tenant left
 * at the path.
 *
 * Under isolation=docker a build container writes the app tree as the platform
 * uid, and under isolation=none a live pm2 app runs as the platform uid, so a
 * file the platform is about to read can be a symlink at
 * data/drop-svc/encryption.key, a FIFO, a link at /dev/zero, or a HARD LINK to
 * a platform file (a hard link passes lstat, O_NOFOLLOW and isFile; only the
 * link count gives it away).
 *
 * This primitive alone is race-safe against a concurrently-running tenant: it
 * vets exactly one component (the last) with O_NOFOLLOW and judges the HANDLE
 * it got back with fstat, so there is no check-then-act window on the file
 * itself. It says nothing about the directories above the file; callers that
 * need those vetted too (tenant-file.ts) carry their own preconditions.
 */

import { constants as fsConstants } from 'fs';
import type { Stats } from 'fs';
import * as fs from 'fs/promises';
import type { FileHandle } from 'fs/promises';

// O_NOFOLLOW / O_NONBLOCK do not exist on Windows (undefined there); `?? 0`
// degrades them to no-ops. The lstat checks below are the primary guard and
// carry the weight on Windows, where tenant code does not share a bind mount.
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
// O_NONBLOCK makes open() of a FIFO return immediately instead of parking a
// libuv thread until a writer appears.
const NONBLOCK = fsConstants.O_NONBLOCK ?? 0;

export type OpenResult =
  | { kind: 'absent' }
  | { kind: 'refused' }
  | { kind: 'ok'; handle: FileHandle; stat: Stats };

export type OpenForWriteResult =
  | { kind: 'refused' }
  | { kind: 'ok'; handle: FileHandle; stat: Stats };

/** What a vetted handle must be: a regular file with no other name. */
export function isPlainSingleLinkFile(stat: Stats): boolean {
  return stat.isFile() && stat.nlink <= 1;
}

/**
 * Open a plain, singly-linked regular file for reading without following a
 * link. `ok` carries the handle and the HANDLE's stat (so size and type are
 * those of the file actually opened) and the caller closes the handle. `absent`
 * is ENOENT on the lstat; every other outcome is `refused`, with the handle
 * already closed.
 *
 * lstat before open so a symlink is refused rather than followed; O_NOFOLLOW
 * so a swap between the two cannot be raced; O_NONBLOCK so a FIFO swapped in
 * cannot park the open; fstat to confirm what was opened is a regular file
 * with no other name. nlink > 1 is refused: none of the legitimate callers
 * (lockfiles, markers, pm2 logs) is ever hard-linked.
 */
export async function openRegularFileNoFollow(filePath: string): Promise<OpenResult> {
  try {
    let stat;
    try {
      stat = await fs.lstat(filePath);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? { kind: 'absent' }
        : { kind: 'refused' };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) return { kind: 'refused' };

    const handle = await fs.open(filePath, fsConstants.O_RDONLY | NOFOLLOW | NONBLOCK);
    let ok = false;
    try {
      const opened = await handle.stat();
      if (!isPlainSingleLinkFile(opened)) return { kind: 'refused' };
      ok = true;
      return { kind: 'ok', handle, stat: opened };
    } finally {
      if (!ok) await handle.close();
    }
  } catch {
    return { kind: 'refused' };
  }
}

/**
 * Open a regular file for WRITING without following a link, creating it when
 * it does not exist. `ok` carries the handle and the HANDLE's stat and the
 * caller closes the handle; every other outcome is `refused`, with the handle
 * already closed. There is no `absent`: a missing file is created.
 *
 * An existing entry must be a regular file (lstat, so a symlink is refused
 * rather than followed). The open carries no O_TRUNC: truncating at open time
 * would destroy a hard-linked platform file before the handle could be vetted,
 * so the handle is fstat'd first (regular, nlink <= 1) and the CALLER truncates
 * only after an `ok`. O_NOFOLLOW stops a swap between the lstat and the open;
 * O_NONBLOCK keeps a swapped-in FIFO from parking the open.
 */
export async function openRegularFileForWriteNoFollow(
  filePath: string
): Promise<OpenForWriteResult> {
  try {
    try {
      const existing = await fs.lstat(filePath);
      if (!existing.isFile()) return { kind: 'refused' };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'refused' };
    }

    const handle = await fs.open(
      filePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | NOFOLLOW | NONBLOCK,
      0o644
    );
    let ok = false;
    try {
      const opened = await handle.stat();
      if (!isPlainSingleLinkFile(opened)) return { kind: 'refused' };
      ok = true;
      return { kind: 'ok', handle, stat: opened };
    } finally {
      if (!ok) await handle.close();
    }
  } catch {
    return { kind: 'refused' };
  }
}

/**
 * Make the directory at `dirPath` u+rwx without ever following a link at the
 * last component: it is opened O_DIRECTORY|O_NOFOLLOW and changed through the
 * HANDLE, so a link swapped in after the caller's lstat fails the open (ELOOP
 * or ENOTDIR) instead of steering the chmod at a host path. Only the permission
 * bits are carried over (setuid/setgid/sticky are dropped). Returns true when a
 * real directory was changed, false when the path is a link or not a directory.
 * Only the LAST component is guarded: the caller vouches for the parent.
 *
 * On Windows (no O_NOFOLLOW/O_DIRECTORY, and no tenant sharing a bind mount)
 * it falls back to an lstat-checked path chmod.
 */
export async function chmodDirNoFollow(dirPath: string): Promise<boolean> {
  if (process.platform === 'win32') {
    const stat = await fs.lstat(dirPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    await fs.chmod(dirPath, (stat.mode & 0o777) | 0o700);
    return true;
  }
  let handle: FileHandle;
  try {
    handle = await fs.open(dirPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR') return false;
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) return false;
    await handle.chmod((stat.mode & 0o777) | 0o700);
    return true;
  } finally {
    await handle.close();
  }
}
