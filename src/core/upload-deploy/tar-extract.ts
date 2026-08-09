/**
 * Hardened tar.gz extraction (PRD-039)
 *
 * Extracts an uploaded gzipped tarball into a destination directory with the
 * defenses a remote, agent-uploaded archive requires: a magic-byte check
 * before any decompression happens, an entry-type allowlist (regular files
 * and directories only — everything else aborts the whole archive), a
 * `.git`-metadata rejection (including Windows path aliases that resolve to
 * the same directory), our own path-containment check on every entry (never
 * trusting node-tar's internal guard alone), case/Unicode-collision rejection
 * within one archive, incremental caps on decompressed bytes and entry count
 * enforced mid-stream, and a wall-clock timeout on the whole extraction. Any
 * rejection cleans up whatever was partially written.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import { Parser as TarParser, ReadEntry } from 'tar';
import { isVcsMetadataComponent } from '../../utils/upload-paths';

export interface TarExtractLimits {
  /** Abort once the cumulative decompressed byte count across all entries exceeds this. */
  maxUncompressedBytes: number;
  /** Abort once the archive's entry count exceeds this (files + directories). */
  maxEntries: number;
  /** Wall-clock budget for the whole extraction, in milliseconds. */
  timeoutMs: number;
}

export interface TarExtractResult {
  fileCount: number;
  dirCount: number;
  bytesWritten: number;
}

export type ArchiveRejectReason =
  | 'not_gzip'
  | 'invalid_archive'
  | 'disallowed_entry_type'
  | 'path_escape'
  | 'path_collision'
  | 'vcs_metadata'
  | 'too_many_bytes'
  | 'too_many_entries'
  | 'timeout'
  | 'empty_archive';

/** Thrown whenever an archive is rejected outright (never a partial extraction). */
export class ArchiveRejectedError extends Error {
  constructor(
    public readonly reason: ArchiveRejectReason,
    message?: string
  ) {
    super(message ?? `Archive rejected (${reason})`);
    this.name = 'ArchiveRejectedError';
  }
}

/** tar type names that are safe to materialize on disk. Everything else — symlinks,
 * hardlinks, device/FIFO/socket nodes, GNU long-path meta records that leak through,
 * etc. — aborts the whole archive rather than being silently skipped. */
const REGULAR_FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);

/**
 * Extract a gzipped tarball at `archivePath` into `destDir` (created if it
 * doesn't exist). Rejects (and cleans up `destDir`) on any hardening
 * violation or on an empty archive (zero regular files written).
 */
export async function extractTarball(
  archivePath: string,
  destDir: string,
  limits: TarExtractLimits
): Promise<TarExtractResult> {
  // Magic-byte check happens before any decompression is even created.
  await assertGzipMagicBytes(archivePath);

  await fsp.mkdir(destDir, { recursive: true });

  const result = await runExtraction(archivePath, destDir, limits);

  if (result.fileCount === 0) {
    await fsp.rm(destDir, { recursive: true, force: true });
    throw new ArchiveRejectedError('empty_archive', 'Archive contains no regular files');
  }

  return result;
}

async function assertGzipMagicBytes(archivePath: string): Promise<void> {
  const fh = await fsp.open(archivePath, 'r');
  try {
    const buf = Buffer.alloc(2);
    const { bytesRead } = await fh.read(buf, 0, 2, 0);
    if (bytesRead < 2 || buf[0] !== 0x1f || buf[1] !== 0x8b) {
      throw new ArchiveRejectedError(
        'not_gzip',
        'Archive is not a valid gzip stream (bad magic bytes)'
      );
    }
  } finally {
    await fh.close();
  }
}

/**
 * Resolves an entry's on-disk path and requires it to stay within `destDir`.
 * Computed with `path.resolve` (which itself collapses `..` segments and
 * treats a leading path separator / drive letter as absolute) rather than
 * trusting node-tar's own internal path guard.
 */
function resolveContained(destDir: string, entryPath: string): string {
  const resolved = path.resolve(destDir, entryPath);
  const withSep = destDir.endsWith(path.sep) ? destDir : destDir + path.sep;
  if (resolved !== destDir && !resolved.startsWith(withSep)) {
    throw new ArchiveRejectedError(
      'path_escape',
      `Entry path escapes destination directory: ${entryPath}`
    );
  }
  return resolved;
}

// `isVcsMetadataComponent` (case/alias-aware `.git` component match) now
// lives in `src/utils/upload-paths.ts`, imported above, so the dashboard's
// browser-side archive builder (DROP-141) can share the exact same rule
// without pulling `node:fs`/`node:zlib`/`node:path`/node-tar into its bundle.
// `src/api/mcp/tools.ts`'s `validateStagedRelativePath` imports it from
// there too, rather than from this file.

function runExtraction(
  archivePath: string,
  destDir: string,
  limits: TarExtractLimits
): Promise<TarExtractResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let fileCount = 0;
    let dirCount = 0;
    let entryCount = 0;
    let totalBytes = 0;
    let activeWrites = 0;
    let parserEnded = false;
    const seenKeys = new Set<string>();

    const readStream = fs.createReadStream(archivePath);
    const gunzip = zlib.createGunzip();
    // Left non-strict rather than passing `strict: true` — the 'warn' listener
    // below is the control point instead. node-tar's own defects (a bad
    // checksum, an unrecognized archive format, ...) surface as 'warn' events
    // rather than throwing, and treating any of them as advisory would let the
    // entry that triggered it be silently dropped: `fileCount` would still
    // reflect every OTHER entry, `extractTarball` would resolve, and the
    // caller's `syncTree` would then prune the destination to match this
    // partial tree — deleting files that were never part of the upload.
    // Every warning is therefore fatal (settling with the same cleanup path
    // as any other rejection), with one narrow, deliberate carve-out inside
    // the listener itself — see its own comment.
    const parser = new TarParser();
    parser.on('warn', (code: string, message: string) => {
      // TAR_BAD_ARCHIVE is emitted unconditionally when the parser reaches
      // 'done' having seen no valid entry at all — including a legitimately
      // empty archive, which has nothing to do with a dropped entry. Every
      // other warning means an entry the parser saw was rejected internally
      // (e.g. a bad checksum), which is exactly the case that must not be
      // treated as advisory: letting it through would silently drop that
      // entry, still resolve with a partial tree, and let syncTree's prune
      // treat that partial tree as authoritative. This carve-out is safe
      // specifically because it can only fire when fileCount is also 0 (a
      // real entry would have set the parser's own "saw a valid entry" flag
      // and suppressed TAR_BAD_ARCHIVE), so `extractTarball` still rejects
      // that archive below via `empty_archive` — nothing gets a free pass.
      if (code === 'TAR_BAD_ARCHIVE') return;
      settle(new ArchiveRejectedError('invalid_archive', `${code}: ${message}`));
    });

    const timer = setTimeout(() => {
      settle(new ArchiveRejectedError('timeout', `Extraction exceeded ${limits.timeoutMs}ms wall-clock limit`));
    }, limits.timeoutMs);

    function settle(err?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      try {
        readStream.destroy();
      } catch {
        /* ignore */
      }
      try {
        gunzip.destroy();
      } catch {
        /* ignore */
      }
      try {
        parser.abort(err ?? new Error('extraction aborted'));
      } catch {
        /* ignore */
      }

      if (err) {
        fsp
          .rm(destDir, { recursive: true, force: true })
          .catch(() => undefined)
          .finally(() => reject(err));
      } else {
        resolve({ fileCount, dirCount, bytesWritten: totalBytes });
      }
    }

    function maybeFinish(): void {
      if (!settled && parserEnded && activeWrites === 0) {
        settle();
      }
    }

    readStream.on('error', (err) => settle(err));
    gunzip.on('error', (err) => settle(new ArchiveRejectedError('invalid_archive', err.message)));
    parser.on('error', (err) => settle(err));

    parser.on('entry', (entry: ReadEntry) => {
      if (settled) {
        entry.resume();
        return;
      }

      entryCount++;
      if (entryCount > limits.maxEntries) {
        entry.resume();
        settle(
          new ArchiveRejectedError(
            'too_many_entries',
            `Archive exceeds the maximum of ${limits.maxEntries} entries`
          )
        );
        return;
      }

      const isFile = REGULAR_FILE_TYPES.has(entry.type);
      const isDir = entry.type === 'Directory';
      if (!isFile && !isDir) {
        entry.resume();
        settle(
          new ArchiveRejectedError(
            'disallowed_entry_type',
            `Entry '${entry.path}' has disallowed type '${entry.type}'`
          )
        );
        return;
      }

      // Reject any entry with a `.git` path component, at any depth
      // (`vendor/foo/.git/config`, not just a root-level `.git/`), including
      // the case, trailing-dot/space, and Windows-alias variants normalized
      // away by `isVcsMetadataComponent` (see its own doc comment). An
      // uploaded `.git/` can overwrite the app's real one (syncTree's
      // DEFAULT_PRESERVE is `['node_modules']` only), and
      // `POST /git/redeploy/<app>` later runs `git pull` in that directory ON
      // THE HOST as the `drop` user — a poisoned `.git/config` (e.g. an
      // `ext::sh -c ...` remote URL) is then arbitrary command execution.
      // Rejecting the whole archive rather than stripping the entry is
      // deliberate and mirrors this file's stance on REGULAR_FILE_TYPES
      // above: a hostile archive never gets a partial, silently-modified
      // extraction. Adding `.git` to DEFAULT_PRESERVE instead would be wrong
      // — that list is shared with monorepo materialization and has nothing
      // to do with rejecting untrusted input.
      // Read `entry.path`, NEVER the raw header name field: node-tar consumes a
      // PAX extended header (typeflag 'x') internally and applies its `path=`
      // record to the following entry before emitting it, so a header claiming
      // `innocuous.txt` can carry `.git/config`. Measured — with this guard
      // removed, such an archive extracts successfully. `entry.path` is the
      // post-override value and is the only safe thing to check here.
      const pathComponents = entry.path.split(/[\\/]/);
      if (pathComponents.some(isVcsMetadataComponent)) {
        entry.resume();
        settle(
          new ArchiveRejectedError(
            'vcs_metadata',
            `Entry '${entry.path}' contains a '.git' path component`
          )
        );
        return;
      }

      let resolved: string;
      try {
        resolved = resolveContained(destDir, entry.path);
      } catch (err) {
        entry.resume();
        settle(err as Error);
        return;
      }

      const key = resolved.normalize('NFC').toLowerCase();
      if (seenKeys.has(key)) {
        entry.resume();
        settle(
          new ArchiveRejectedError(
            'path_collision',
            `Duplicate entry path within archive (case/Unicode collision): ${entry.path}`
          )
        );
        return;
      }
      seenKeys.add(key);

      if (isDir) {
        try {
          fs.mkdirSync(resolved, { recursive: true });
        } catch (err) {
          entry.resume();
          settle(err as Error);
          return;
        }
        dirCount++;
        entry.resume();
        return;
      }

      // Regular file. Directories are created synchronously so there's no
      // async gap between validating an entry and writing it — the next
      // 'entry' event can't race a still-in-flight mkdir.
      try {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
      } catch (err) {
        entry.resume();
        settle(err as Error);
        return;
      }

      activeWrites++;
      const ws = fs.createWriteStream(resolved);

      entry.on('data', (chunk: Buffer) => {
        if (settled) return;
        totalBytes += chunk.length;
        if (totalBytes > limits.maxUncompressedBytes) {
          // Abort mid-stream as soon as the cap is crossed, not after the
          // entry (or the archive) finishes.
          settle(
            new ArchiveRejectedError(
              'too_many_bytes',
              `Archive exceeds the maximum of ${limits.maxUncompressedBytes} uncompressed bytes`
            )
          );
        }
      });

      entry.on('error', (err) => settle(err as Error));
      ws.on('error', (err) => settle(err));
      ws.on('finish', () => {
        fileCount++;
        activeWrites--;
        maybeFinish();
      });

      entry.pipe(ws);
    });

    parser.on('end', () => {
      parserEnded = true;
      maybeFinish();
    });

    readStream.pipe(gunzip).pipe(parser as unknown as NodeJS.WritableStream);
  });
}
