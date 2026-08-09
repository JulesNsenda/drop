/**
 * tar-writer round-trip tests (DROP-141).
 *
 * The whole point of this file: don't trust a spec reading of USTAR, feed
 * the archive `buildTar` produces to node-tar (the backend's own parser,
 * already a root dependency) and `zlib.gunzipSync`. node-tar accepts a
 * malformed archive and produces a WRONG result rather than throwing, so
 * only the reference implementation catches the defects this covers.
 *
 * Importing node-tar/zlib here is fine — only `tar-writer.ts` itself must
 * stay DOM-free/node-free.
 */

import * as tar from 'tar';
import * as zlib from 'zlib';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildTar, TarWriteError, TarEntry } from './tar-writer';
import { extractTarball, TarExtractLimits } from '../core/upload-deploy/tar-extract';

/** tar type names the read side (`REGULAR_FILE_TYPES` in
 * `src/core/upload-deploy/tar-extract.ts`) treats as safe to materialize.
 * Not exported there, so mirrored here for the assertion. */
const REGULAR_FILE_TYPES = new Set(['File', 'OldFile', 'ContiguousFile']);

interface ParsedEntry {
  path: string;
  type: string;
  data: Buffer;
}

/** Concatenates `buildTar`'s chunk array into one buffer the way a server
 * would (`Buffer.concat`) — the browser side instead does `new
 * Blob(parts)`. */
function toBuffer(chunks: Uint8Array[]): Buffer {
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

/** Runs a tar buffer through a real gzip round-trip (mirroring the actual
 * upload pipeline: browser `CompressionStream('gzip')` → POST → server
 * `zlib.createGunzip()`) and then through node-tar's own `Parser`, failing
 * on any parser warning rather than silently ignoring a dropped entry —
 * exactly the trap `runExtraction`'s own `warn` listener guards against. */
function parseThroughNodeTar(tarBuf: Buffer): Promise<ParsedEntry[]> {
  const roundTripped = zlib.gunzipSync(zlib.gzipSync(tarBuf));

  return new Promise((resolve, reject) => {
    const entries: ParsedEntry[] = [];
    const parser = new tar.Parser();

    parser.on('warn', (code: string, message: string) => {
      reject(new Error(`node-tar warning (archive rejected by the real backend parser): ${code}: ${message}`));
    });
    parser.on('error', reject);
    parser.on('entry', (entry) => {
      const chunks: Buffer[] = [];
      entry.on('data', (chunk: Buffer) => chunks.push(chunk));
      entry.on('end', () => {
        entries.push({ path: entry.path, type: entry.type, data: Buffer.concat(chunks) });
      });
    });
    parser.on('end', () => resolve(entries));

    parser.end(roundTripped);
  });
}

async function roundTrip(entries: TarEntry[]): Promise<ParsedEntry[]> {
  return parseThroughNodeTar(toBuffer(buildTar(entries)));
}

const encoder = new TextEncoder();

describe('buildTar', () => {
  it('round-trips paths and byte content for multiple entries', async () => {
    const entries: TarEntry[] = [
      { path: 'index.html', data: encoder.encode('<html></html>') },
      { path: 'src/app.js', data: encoder.encode('console.log(1);') },
    ];

    const parsed = await roundTrip(entries);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].path).toBe('index.html');
    expect(parsed[0].data.toString('utf8')).toBe('<html></html>');
    expect(parsed[1].path).toBe('src/app.js');
    expect(parsed[1].data.toString('utf8')).toBe('console.log(1);');
    for (const entry of parsed) {
      expect(REGULAR_FILE_TYPES.has(entry.type)).toBe(true);
    }
  });

  it('round-trips a zero-byte entry', async () => {
    const parsed = await roundTrip([{ path: 'empty.txt', data: new Uint8Array(0) }]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('empty.txt');
    expect(parsed[0].data.length).toBe(0);
    expect(REGULAR_FILE_TYPES.has(parsed[0].type)).toBe(true);
  });

  it('round-trips a body of exactly 512 bytes without desyncing the next entry', async () => {
    const exactBlock = new Uint8Array(512).fill(7);
    const parsed = await roundTrip([
      { path: 'block.bin', data: exactBlock },
      { path: 'after.txt', data: encoder.encode('still here') },
    ]);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].path).toBe('block.bin');
    expect(parsed[0].data.length).toBe(512);
    expect(Buffer.compare(parsed[0].data, Buffer.from(exactBlock))).toBe(0);
    expect(parsed[1].path).toBe('after.txt');
    expect(parsed[1].data.toString('utf8')).toBe('still here');
  });

  it('round-trips a 150-byte path via the name/prefix split', async () => {
    // 50-byte directory + '/' + 99-byte filename = 150 bytes total, split at
    // index 50 (prefix 50 bytes, name 99 bytes) -- both within field limits.
    const path = `${'a'.repeat(50)}/${'b'.repeat(99)}`;
    expect(encoder.encode(path).length).toBe(150);

    const parsed = await roundTrip([{ path, data: encoder.encode('deep') }]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe(path);
    expect(parsed[0].data.toString('utf8')).toBe('deep');
  });

  it('finds an earlier qualifying "/" when the last "/" sits past the 155-byte prefix limit', async () => {
    // dirA (152 bytes) / dirB (46 bytes) / file (49 bytes) = 249 bytes total.
    // The LAST '/' is at index 199, which would need a 199-byte prefix --
    // over the 155-byte limit. The windowed search must instead use the
    // EARLIER '/' at index 152 (prefix 152 bytes, name 96 bytes), not fail
    // or silently misplace bytes by naively splitting at the last '/'.
    const dirA = 'a'.repeat(152);
    const dirB = 'b'.repeat(46);
    const file = 'c'.repeat(49);
    const path = `${dirA}/${dirB}/${file}`;
    expect(encoder.encode(path).length).toBe(249);

    const parsed = await roundTrip([{ path, data: encoder.encode('x') }]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe(path);
  });

  it('throws when a single path component exceeds 100 bytes, at any total path length', () => {
    const path = `dir/${'x'.repeat(120)}`;

    expect(() => buildTar([{ path, data: new Uint8Array(0) }])).toThrow(TarWriteError);
    expect(() => buildTar([{ path, data: new Uint8Array(0) }])).toThrow(/dir\/x+/);
  });

  it('round-trips non-ASCII (CJK and emoji) names', async () => {
    const entries: TarEntry[] = [
      { path: '目录/名前.txt', data: encoder.encode('こんにちは') },
      { path: '😀.png', data: encoder.encode('fake-png-bytes') },
    ];

    const parsed = await roundTrip(entries);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].path).toBe('目录/名前.txt');
    expect(parsed[0].data.toString('utf8')).toBe('こんにちは');
    expect(parsed[1].path).toBe('😀.png');
    expect(parsed[1].data.toString('utf8')).toBe('fake-png-bytes');
  });

  it('does not leak header bytes into the next entry when the first path is much longer than the second', async () => {
    const longPath = `${'a'.repeat(90)}/${'b'.repeat(90)}`;
    const parsed = await roundTrip([
      { path: longPath, data: encoder.encode('long entry body') },
      { path: 'x.txt', data: encoder.encode('short') },
    ]);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].path).toBe(longPath);
    expect(parsed[0].data.toString('utf8')).toBe('long entry body');
    expect(parsed[1].path).toBe('x.txt');
    expect(parsed[1].data.toString('utf8')).toBe('short');
    expect(REGULAR_FILE_TYPES.has(parsed[1].type)).toBe(true);
  });

  // The exact field widths are what discriminate `writeBytes` (no NUL
  // terminator, correct for name/prefix) from `writeTerminatedString` (which
  // would silently drop the field's last byte). Nothing else in this suite
  // lands on those boundaries, so a regression that swapped the two helpers
  // would pass every other test here.
  it('round-trips a name of exactly 100 bytes, which must not be NUL-terminated', async () => {
    const name = 'a'.repeat(100);
    expect(Buffer.byteLength(name, 'utf8')).toBe(100);

    const [entry] = await parseThroughNodeTar(toBuffer(buildTar([{ path: name, data: encoder.encode('x') }])));
    expect(entry.path).toBe(name); // a terminator would truncate this to 99
  });

  it('round-trips a prefix of exactly 155 bytes', async () => {
    // 155-byte prefix + '/' + a 40-byte name: both fields at/inside their
    // limits, with the prefix exactly full.
    const prefix = 'p'.repeat(155);
    const base = 'b'.repeat(40);
    const full = `${prefix}/${base}`;

    const [entry] = await parseThroughNodeTar(toBuffer(buildTar([{ path: full, data: encoder.encode('y') }])));
    expect(entry.path).toBe(full);
  });

  it('emits a well-formed terminator and nothing else for no entries', () => {
    // `buildTar` is exported with no precondition against an empty list — the
    // dashboard refuses that case earlier, but the contract should still hold.
    // Asserted on the bytes rather than round-tripped: node-tar emits
    // TAR_BAD_ARCHIVE for an archive with no entries (measured), and the
    // helper above treats any warning as fatal, which is the behaviour the
    // server's own extractor relies on.
    const buf = toBuffer(buildTar([]));

    expect(buf.length).toBe(1024);
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it('refuses a size that would overflow its octal field rather than corrupting the header', () => {
    // padStart pads but never truncates, so without the guard an oversized
    // value runs into the next field — and the checksum, computed last, makes
    // the corruption verify. A real buffer this size cannot be allocated, so
    // the guard is checked against a stubbed byteLength.
    const oversized = { path: 'big.bin', data: { byteLength: 0o77777777777 + 1 } as Uint8Array };
    expect(() => buildTar([oversized as TarEntry])).toThrow(TarWriteError);
  });

  it('refuses a path whose only "/" is its final byte, which would empty the name field', () => {
    // node-tar reads `prefix + '/'` with an empty name as a DIRECTORY and
    // discards the body. `normalizeEntryPath` strips trailing slashes, so the
    // dashboard cannot reach this — but `buildTar` is a public export.
    const trailing = `${'d'.repeat(120)}/`;
    expect(() => buildTar([{ path: trailing, data: encoder.encode('z') }])).toThrow(TarWriteError);
  });

  it('throws when a single-segment path alone exceeds 100 bytes', () => {
    const longPath = 'a'.repeat(150);
    expect(() => buildTar([{ path: longPath, data: new Uint8Array(0) }])).toThrow(TarWriteError);
  });

  describe('against the hardened server-side extractor', () => {
    // `tar.Parser` above proves node-tar can read the bytes; this closes the
    // gap between "node-tar parses it" and "the actual production endpoint
    // (`extractTarball`, with its gzip-magic gate, path containment,
    // collision detection and disk write) accepts it end to end." Short
    // ASCII paths only here: `path.resolve(tmpdir, <long path>)` can exceed
    // Windows' ~260-char MAX_PATH, which would fail this dev box for a
    // reason that has nothing to do with the writer — the long/prefix-split
    // paths are already covered above against `tar.Parser` directly.
    const DEFAULT_LIMITS: TarExtractLimits = {
      maxUncompressedBytes: 10 * 1024 * 1024,
      maxEntries: 1000,
      timeoutMs: 10_000,
    };

    let tempDir: string;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-tar-writer-test-'));
    });

    afterEach(async () => {
      await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
    });

    it('is accepted by extractTarball and lands the expected files on disk', async () => {
      const entries: TarEntry[] = [
        { path: 'index.html', data: encoder.encode('<html></html>') },
        { path: 'src/app.js', data: encoder.encode('console.log(1);') },
        { path: 'empty.txt', data: new Uint8Array(0) },
        { path: 'block.bin', data: new Uint8Array(512).fill(9) },
      ];

      const archivePath = path.join(tempDir, 'upload.tgz');
      await fs.writeFile(archivePath, zlib.gzipSync(toBuffer(buildTar(entries))));

      const destDir = path.join(tempDir, 'dest');
      const result = await extractTarball(archivePath, destDir, DEFAULT_LIMITS);

      expect(result.fileCount).toBe(4);
      expect(fssync.readFileSync(path.join(destDir, 'index.html'), 'utf8')).toBe('<html></html>');
      expect(fssync.readFileSync(path.join(destDir, 'src', 'app.js'), 'utf8')).toBe('console.log(1);');
      expect(fssync.readFileSync(path.join(destDir, 'empty.txt')).length).toBe(0);
      expect(fssync.readFileSync(path.join(destDir, 'block.bin')).length).toBe(512);
    });
  });
});
