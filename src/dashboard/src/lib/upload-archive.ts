/**
 * Browser-side archive builder for dashboard upload-deploy (DROP-141).
 *
 * Turns a `FileList` (folder/file picker or a plain drop) into a gzipped
 * USTAR tarball ready to POST as the raw body of `/apps/:name/source`. This
 * is DOM glue ONLY — `File`, `Blob`, `CompressionStream`, `Response` — none
 * of which exist under the root tsconfig's `lib: ["ES2022"]` (no `dom` lib),
 * which ts-jest compiles test files against. All pure path/tar logic lives in
 * `src/utils/tar-writer.ts` and `src/utils/upload-paths.ts`, which root tsc,
 * eslint and jest can all reach. NO TEST may import this file.
 */
import { buildTar, TarEntry, TarWriteError } from '../../../utils/tar-writer';
import {
  normalizeEntryPath,
  stripCommonRoot,
  findCollisions,
  isExcludedByDefault,
  PathNormalizationError,
} from '../../../utils/upload-paths';

/** Thrown for any archive-building failure; message is meant to be shown to
 * the user verbatim. */
export class UploadArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadArchiveError';
  }
}

/**
 * Client-side cap on total UNCOMPRESSED bytes, checked from `file.size`
 * before any bytes are read. The only existing cap (`getUploadMaxBytes`,
 * 100 MB) is server-side and applies to the COMPRESSED result only —
 * `buildTar` materializes every file's bytes and the gzip step holds a
 * second copy, so an uncapped folder is a tab OOM with no error, not a
 * clean rejection.
 *
 * 200 MB, not higher: every file is read into a `Uint8Array` before
 * `buildTar` runs, so the JS heap holds the whole uncompressed selection at
 * once, and `new Blob(chunks)` then copies it again. Peak is therefore well
 * ABOVE this number, which is the reason to keep it conservative. It is also
 * already past the point of usefulness — source trees compress roughly 3-5x,
 * so a 200 MB selection is at or over the server's 100 MB COMPRESSED cap
 * anyway; a larger budget mostly buys crashed tabs and 413s. The precise
 * enforcement remains the server's.
 */
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

/** Mirrors the server's extraction entry-count cap (`platform.ts`). */
const MAX_ENTRIES = 20000;

const CLI_ALTERNATIVE = 'Use the drop CLI (`drop deploy <path>`) instead.';

export interface BuiltArchive {
  /** Gzipped tar, ready to POST as-is. */
  blob: Blob;
  /** Number of files included (after exclusions). */
  fileCount: number;
  /** Compressed size in bytes, i.e. `blob.size`. */
  bytes: number;
  /** Paths excluded by default (`.git`, `node_modules`), for display. */
  skipped: string[];
}

/**
 * Build a gzipped tar `Blob` from a `FileList`.
 *
 * Order matters: normalize + strip the common root first so exclusion and
 * collision checks see the same paths the tar writer will use; exclude
 * before checking collisions or budgets, since an excluded file should never
 * be able to trigger either; check budgets before reading any bytes, since
 * that's the whole point of a client-side cap.
 */
export async function buildArchiveFromFiles(files: FileList): Promise<BuiltArchive> {
  if (typeof CompressionStream === 'undefined') {
    throw new UploadArchiveError(
      `This browser can't compress uploads in-tab (needs CompressionStream: Chrome 80+, Firefox 113+, Safari 16.4+). ${CLI_ALTERNATIVE}`
    );
  }

  const rawFiles: File[] = [];
  const rawPaths: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const rawPath = file.webkitRelativePath || file.name;
    try {
      rawPaths.push(normalizeEntryPath(rawPath));
    } catch (err) {
      throw new UploadArchiveError(
        err instanceof PathNormalizationError ? err.message : `Invalid path: ${rawPath}`
      );
    }
    rawFiles.push(file);
  }

  const strippedPaths = stripCommonRoot(rawPaths);

  const skipped: string[] = [];
  const kept: { file: File; path: string }[] = [];
  for (let i = 0; i < rawFiles.length; i++) {
    const path = strippedPaths[i];
    if (isExcludedByDefault(path)) {
      skipped.push(path);
    } else {
      kept.push({ file: rawFiles[i], path });
    }
  }

  const collisions = findCollisions(kept.map((k) => k.path));
  if (collisions.length > 0) {
    const [a, b] = collisions[0];
    throw new UploadArchiveError(`Two files would collide once uploaded: "${a}" and "${b}"`);
  }

  if (kept.length > MAX_ENTRIES) {
    throw new UploadArchiveError(
      `Too many files (${kept.length}); the server accepts at most ${MAX_ENTRIES} per archive. ${CLI_ALTERNATIVE}`
    );
  }

  const totalBytes = kept.reduce((sum, k) => sum + k.file.size, 0);
  if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
    throw new UploadArchiveError(
      `Selection is too large (${Math.ceil(totalBytes / (1024 * 1024))} MB uncompressed) to build in the browser. ${CLI_ALTERNATIVE}`
    );
  }

  const entries: TarEntry[] = [];
  for (const k of kept) {
    const data = new Uint8Array(await k.file.arrayBuffer());
    entries.push({ path: k.path, data });
  }

  let chunks: Uint8Array[];
  try {
    chunks = buildTar(entries);
  } catch (err) {
    throw new UploadArchiveError(err instanceof TarWriteError ? err.message : 'Failed to build archive');
  }

  // `Uint8Array[]` isn't assignable to `BlobPart[]` under TS's DOM lib
  // (a `Uint8Array<ArrayBufferLike>` vs. the stricter `ArrayBufferView<ArrayBuffer>`
  // `BlobPart` expects) — a typings mismatch only, `Blob` accepts any
  // `ArrayBufferView` at runtime regardless of its backing buffer type.
  const tarBlob = new Blob(chunks as BlobPart[]);
  const gzipped = tarBlob.stream().pipeThrough(new CompressionStream('gzip'));
  const blob = await new Response(gzipped).blob();

  return { blob, fileCount: kept.length, bytes: blob.size, skipped };
}
