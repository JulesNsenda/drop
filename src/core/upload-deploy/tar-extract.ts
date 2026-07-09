/**
 * Hardened tar.gz extraction (PRD-039)
 *
 * Extracts an uploaded gzipped tarball into a destination directory with the
 * defenses a remote, agent-uploaded archive requires: a magic-byte check
 * before any decompression happens, an entry-type allowlist (regular files
 * and directories only — everything else aborts the whole archive), our own
 * path-containment check on every entry (never trusting node-tar's internal
 * guard alone), case/Unicode-collision rejection within one archive,
 * incremental caps on decompressed bytes and entry count enforced mid-stream,
 * and a wall-clock timeout on the whole extraction. Any rejection cleans up
 * whatever was partially written.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import { Parser as TarParser, ReadEntry } from 'tar';

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
    const parser = new TarParser();

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
