/**
 * Minimal pure-JS USTAR tar writer (DROP-141).
 *
 * Builds a tar archive as an array of `Uint8Array` chunks — never one
 * contiguous allocation — so a browser caller can hand the result straight to
 * `new Blob(parts)` without doubling memory for a large upload. Mirrors the
 * read side at `src/core/upload-deploy/tar-extract.ts`.
 *
 * `Uint8Array`/`TextEncoder` only — zero DOM types, zero `node:*` imports.
 * The root tsconfig compiles this file (and ts-jest compiles it per-file for
 * its test) against `lib: ["ES2022"]` with no `dom` lib, and the dashboard's
 * Vite bundle must be able to pull it in unchanged.
 *
 * Every byte-level decision below was measured against this repo's node-tar
 * 7.5.19 parser by a plan-stage reviewer — each one fails *silently*:
 * node-tar accepts the archive and produces a wrong result rather than an
 * error. See `docs/plans/2026-08-09-upload-git-token-cpu-fixes.md` Item 1.
 */

/** A file to place in the archive. Directories are not supported — the only
 * consumer (`extractTarball`) `mkdir`s parents per file. */
export interface TarEntry {
  path: string;
  data: Uint8Array;
}

/** Thrown when a path (or one of its components) cannot be represented in a
 * USTAR header, or a file exceeds the format's octal size-field limit. The
 * message always names the offending path. */
export class TarWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TarWriteError';
  }
}

const HEADER_SIZE = 512;

/** Largest value the 12-byte octal `size` field can hold as 11 digits + NUL
 * (`0o77777777777`). Base-256 size encoding would extend this, but it's
 * unreachable behind the 100 MB upload cap and is untested surface here. */
const MAX_ENTRY_SIZE = 0o77777777777;

const encoder = new TextEncoder();

/** USTAR header field offsets/lengths (POSIX.1-1988 "ustar" format). */
const NAME = { offset: 0, length: 100 };
const MODE = { offset: 100, length: 8 };
const UID = { offset: 108, length: 8 };
const GID = { offset: 116, length: 8 };
const SIZE = { offset: 124, length: 12 };
const MTIME = { offset: 136, length: 12 };
const CHKSUM = { offset: 148, length: 8 };
const TYPEFLAG = { offset: 156, length: 1 };
const MAGIC = { offset: 257, length: 6 };
const VERSION = { offset: 263, length: 2 };
const UNAME = { offset: 265, length: 32 };
const GNAME = { offset: 297, length: 32 };
const DEVMAJOR = { offset: 329, length: 8 };
const DEVMINOR = { offset: 337, length: 8 };
const PREFIX = { offset: 345, length: 155 };

/** Writes `value` as a NUL-terminated octal field, left-padded with zeros to
 * `field.length - 1` digits. Used for every numeric field except `chksum`,
 * which has its own layout (see `writeChecksum`). */
function writeOctal(header: Uint8Array, field: { offset: number; length: number }, value: number): void {
  const digits = value.toString(8).padStart(field.length - 1, '0');
  // padStart pads but never truncates, so an oversized value would run past
  // the field into the next one — and `writeChecksum`, computed last, would
  // then make that corruption verify. Unreachable through today's callers
  // (size is guarded by MAX_ENTRY_SIZE, mtime overflows in 2242, the rest are
  // constants), but this is a shared util reachable from two bundles and the
  // failure would be silent, so refuse rather than rely on the callers.
  if (digits.length > field.length - 1) {
    throw new TarWriteError(`Value ${value} does not fit a ${field.length}-byte octal tar field`);
  }
  header.set(encoder.encode(digits + '\0'), field.offset);
}

/** Writes raw bytes into a field with NO NUL terminator — required for `name`
 * and `prefix`, where a value that exactly fills the field must not be
 * truncated to make room for one. Callers guarantee `bytes.length <=
 * field.length` (the prefix/name split below enforces it). */
function writeBytes(header: Uint8Array, field: { offset: number; length: number }, bytes: Uint8Array): void {
  header.set(bytes, field.offset);
}

/** Writes a NUL-terminated string field, truncated to `field.length - 1`
 * bytes if needed. Used for `uname`/`gname`, which POSIX requires to
 * terminate (the opposite convention from `name`/`prefix`). */
function writeTerminatedString(header: Uint8Array, field: { offset: number; length: number }, value: string): void {
  const bytes = encoder.encode(value).slice(0, field.length - 1);
  header.set(bytes, field.offset);
  // Any remaining bytes, including the terminator, are already zero on a
  // freshly-allocated header.
}

/**
 * Six octal digits + NUL + space at offset 148 — NOT eight zero-padded
 * digits. node-tar scans forward from 148 to the first NUL-or-space; a
 * full-width 7-digit field pushes into the typeflag byte at 156 and is read
 * as a ninth octal digit, inflating the parsed sum 8x and failing the
 * checksum for every entry. Field layout matches the read side's own
 * `octalField`/`buildHeader` in `tar-extract.test.ts`.
 */
function writeChecksum(header: Uint8Array): void {
  // Sum the header with the checksum field itself treated as eight ASCII
  // spaces, per the USTAR spec.
  header.set(encoder.encode('        '), CHKSUM.offset);
  let sum = 0;
  for (let i = 0; i < HEADER_SIZE; i++) sum += header[i];
  const digits = sum.toString(8).padStart(6, '0');
  header.set(encoder.encode(digits + '\0 '), CHKSUM.offset);
}

/**
 * Splits an entry path into USTAR `name`/`prefix` fields when it doesn't fit
 * in the 100-byte `name` field alone. This is a WINDOWED search, not "split
 * at the last `/`": the split is valid only at a `/` byte index `i` with
 * `i <= 155` (fits `prefix`) AND `len - i - 1 <= 100` (fits `name`), i.e.
 * `i >= len - 101`. The first (lowest-index) qualifying `/` is used. All
 * lengths are counted in encoded UTF-8 bytes, never `String.length` — a
 * 40-character CJK path can be 120+ bytes, and overflowing `name` corrupts
 * the fields written after it (the checksum, computed last, then makes that
 * corruption look valid).
 *
 * If no qualifying `/` exists, the final path component alone exceeds 100
 * bytes and is unrepresentable in USTAR at any total path length — this
 * throws rather than silently truncating.
 */
function splitPath(path: string): { name: Uint8Array; prefix: Uint8Array } {
  const full = encoder.encode(path);
  if (full.length <= NAME.length) {
    return { name: full, prefix: new Uint8Array(0) };
  }

  const minIndex = Math.max(0, full.length - NAME.length - 1);
  // `- 2`, not `- 1`: splitting at the FINAL byte leaves `name` empty, and
  // node-tar reads the result as `prefix + '/'`, retypes the entry as a
  // directory and silently discards its body. `normalizeEntryPath` strips
  // trailing slashes so the only current caller cannot reach it, but
  // `buildTar` is exported with no such precondition on `TarEntry.path`.
  const maxIndex = Math.min(PREFIX.length, full.length - 2);
  for (let i = minIndex; i <= maxIndex; i++) {
    if (full[i] === 0x2f /* '/' */) {
      return { prefix: full.slice(0, i), name: full.slice(i + 1) };
    }
  }

  throw new TarWriteError(
    `Path component exceeds the 100-byte USTAR name limit and cannot be split: ${path}`
  );
}

/**
 * Builds a USTAR archive (files only, no directory entries) as an array of
 * chunks: a fresh 512-byte header, the body, and `(512 - (len % 512)) % 512`
 * bytes of padding per entry, followed by the two 512-byte zero blocks that
 * terminate a tar stream. The caller concatenates (`Buffer.concat` on the
 * server, `new Blob(parts)` in the browser) rather than this function
 * allocating one contiguous buffer for the whole archive.
 */
export function buildTar(entries: TarEntry[]): Uint8Array[] {
  const chunks: Uint8Array[] = [];

  for (const entry of entries) {
    if (entry.data.byteLength > MAX_ENTRY_SIZE) {
      throw new TarWriteError(
        `File exceeds the maximum size representable in a USTAR header (${MAX_ENTRY_SIZE} bytes): ${entry.path}`
      );
    }

    const { name, prefix } = splitPath(entry.path);

    // A fresh header per entry, never a reused scratch buffer: stray bytes
    // left over at offset 157 (`linkname`) make node-tar reject a
    // typeflag-'0' entry outright and desync the rest of the archive.
    const header = new Uint8Array(HEADER_SIZE);
    writeBytes(header, NAME, name);
    writeOctal(header, MODE, 0o644);
    writeOctal(header, UID, 0);
    writeOctal(header, GID, 0);
    // Size is derived from `data.byteLength` in the same expression that
    // pushes the body below, so the two can never drift.
    writeOctal(header, SIZE, entry.data.byteLength);
    writeOctal(header, MTIME, Math.floor(Date.now() / 1000));
    header[TYPEFLAG.offset] = 0x30; // '0' -- regular file
    writeTerminatedString(header, UNAME, '');
    writeTerminatedString(header, GNAME, '');
    writeOctal(header, DEVMAJOR, 0);
    writeOctal(header, DEVMINOR, 0);
    writeBytes(header, PREFIX, prefix);
    // Exact bytes 75 73 74 61 72 00 30 30 ("ustar\0" + "00"). GNU's
    // "ustar  \0" (two spaces, no second NUL) makes node-tar accept the
    // entry but silently discard the `prefix` field, flattening long paths
    // so they overwrite each other.
    header.set(encoder.encode('ustar\0'), MAGIC.offset);
    header.set(encoder.encode('00'), VERSION.offset);

    writeChecksum(header);

    chunks.push(header);
    chunks.push(entry.data);
    // The outer `% 512` matters: without it, an exact-multiple body
    // (including a zero-byte file) emits a stray full block. Omitting
    // padding entirely desyncs the parser and loses the following entry.
    const padLength = (HEADER_SIZE - (entry.data.byteLength % HEADER_SIZE)) % HEADER_SIZE;
    if (padLength > 0) {
      chunks.push(new Uint8Array(padLength));
    }
  }

  // Two zero-filled 512-byte blocks terminate a tar stream.
  chunks.push(new Uint8Array(HEADER_SIZE));
  chunks.push(new Uint8Array(HEADER_SIZE));

  return chunks;
}
