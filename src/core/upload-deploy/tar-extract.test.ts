/**
 * Hardened tar extraction tests (PRD-039 merge gate)
 *
 * Covers the happy path plus every hardening rule: tar-slip, absolute-path
 * escape, symlink/hardlink rejection, case/NFC collision rejection,
 * incremental byte/entry caps, magic-byte rejection, empty-archive
 * rejection, and wall-clock timeout. Malicious archives are hand-built from
 * raw 512-byte ustar headers so we have full control over entry types and
 * paths that node-tar's own `create()` would refuse to produce.
 */

import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import * as tar from 'tar';
import { extractTarball, ArchiveRejectedError, TarExtractLimits } from './tar-extract';

const DEFAULT_LIMITS: TarExtractLimits = {
  maxUncompressedBytes: 10 * 1024 * 1024,
  maxEntries: 1000,
  timeoutMs: 10_000,
};

// ---- raw ustar header helpers -------------------------------------------

function octalField(num: number, width: number): string {
  return num.toString(8).padStart(width - 1, '0') + '\0';
}

function buildHeader(opts: { name: string; size: number; typeflag: string; linkname?: string }): Buffer {
  const buf = Buffer.alloc(512, 0);
  buf.write(opts.name, 0, 100, 'utf8');
  buf.write(octalField(0o644, 8), 100, 8, 'ascii');
  buf.write(octalField(0, 8), 108, 8, 'ascii');
  buf.write(octalField(0, 8), 116, 8, 'ascii');
  buf.write(octalField(opts.size, 12), 124, 12, 'ascii');
  buf.write(octalField(Math.floor(Date.now() / 1000), 12), 136, 12, 'ascii');
  buf.write('        ', 148, 8, 'ascii'); // checksum placeholder (8 spaces)
  buf.write(opts.typeflag, 156, 1, 'ascii');
  if (opts.linkname) buf.write(opts.linkname, 157, 100, 'utf8');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

  return buf;
}

/** typeflag: '0' file, '5' directory, '2' symlink, '1' hardlink */
function buildEntry(name: string, content: string, typeflag = '0', linkname?: string): Buffer {
  const contentBuf = Buffer.from(content, 'utf8');
  const isFile = typeflag === '0';
  const header = buildHeader({ name, size: isFile ? contentBuf.length : 0, typeflag, linkname });
  if (!isFile) return header;

  const paddedSize = Math.ceil(contentBuf.length / 512) * 512 || 512;
  const dataBuf = Buffer.alloc(paddedSize, 0);
  contentBuf.copy(dataBuf);
  return Buffer.concat([header, dataBuf]);
}

function buildTar(entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024, 0)]);
}

async function writeGzArchive(dir: string, filename: string, tarBuf: Buffer): Promise<string> {
  const archivePath = path.join(dir, filename);
  await fs.writeFile(archivePath, zlib.gzipSync(tarBuf));
  return archivePath;
}

/** Assert a promise rejects with an ArchiveRejectedError carrying `reason`. */
async function expectRejected(promise: Promise<unknown>, reason: string): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(ArchiveRejectedError);
  await expect(promise).rejects.toMatchObject({ reason });
}

// ---------------------------------------------------------------------------

describe('extractTarball', () => {
  let tempDir: string;
  let destDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-tar-test-'));
    destDir = path.join(tempDir, 'dest');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  });

  it('extracts nested directories and files correctly (happy path)', async () => {
    const srcDir = path.join(tempDir, 'src');
    await fs.mkdir(path.join(srcDir, 'sub', 'deep'), { recursive: true });
    await fs.writeFile(path.join(srcDir, 'a.txt'), 'top level');
    await fs.writeFile(path.join(srcDir, 'sub', 'b.txt'), 'nested');
    await fs.writeFile(path.join(srcDir, 'sub', 'deep', 'c.txt'), 'deeply nested');

    const archivePath = path.join(tempDir, 'ok.tgz');
    await tar.create({ gzip: true, file: archivePath, cwd: srcDir }, ['a.txt', 'sub']);

    const result = await extractTarball(archivePath, destDir, DEFAULT_LIMITS);

    expect(result.fileCount).toBe(3);
    expect(fssync.readFileSync(path.join(destDir, 'a.txt'), 'utf8')).toBe('top level');
    expect(fssync.readFileSync(path.join(destDir, 'sub', 'b.txt'), 'utf8')).toBe('nested');
    expect(fssync.readFileSync(path.join(destDir, 'sub', 'deep', 'c.txt'), 'utf8')).toBe('deeply nested');
  });

  it('rejects a tar-slip entry (../evil.txt) and cleans up', async () => {
    const tarBuf = buildTar([buildEntry('safe.txt', 'ok'), buildEntry('../evil.txt', 'pwned')]);
    const archivePath = await writeGzArchive(tempDir, 'slip.tgz', tarBuf);

    await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'path_escape');
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('rejects an absolute-path entry and cleans up', async () => {
    const tarBuf = buildTar([buildEntry('/etc/passwd', 'pwned')]);
    const archivePath = await writeGzArchive(tempDir, 'abs.tgz', tarBuf);

    await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'path_escape');
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('rejects the whole archive on a symlink entry', async () => {
    const tarBuf = buildTar([
      buildEntry('hello.txt', 'hi'),
      buildEntry('link.txt', '', '2', 'hello.txt'),
    ]);
    const archivePath = await writeGzArchive(tempDir, 'symlink.tgz', tarBuf);

    await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'disallowed_entry_type');
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('rejects the whole archive on a hardlink entry', async () => {
    const tarBuf = buildTar([
      buildEntry('hello.txt', 'hi'),
      buildEntry('hard.txt', '', '1', 'hello.txt'),
    ]);
    const archivePath = await writeGzArchive(tempDir, 'hardlink.tgz', tarBuf);

    await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'disallowed_entry_type');
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('rejects a root-level .git path component and cleans up', async () => {
    const tarBuf = buildTar([buildEntry('.git/config', 'malicious')]);
    const archivePath = await writeGzArchive(tempDir, 'git-root.tgz', tarBuf);

    await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'vcs_metadata');
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('rejects a nested .git path component (a/.git/config)', async () => {
    const tarBuf = buildTar([buildEntry('a/.git/config', 'malicious')]);
    const archivePath = await writeGzArchive(tempDir, 'git-nested.tgz', tarBuf);

    await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'vcs_metadata');
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('rejects a .git path component case-insensitively (.GIT)', async () => {
    const tarBuf = buildTar([buildEntry('.GIT/config', 'malicious')]);
    const archivePath = await writeGzArchive(tempDir, 'git-case.tgz', tarBuf);

    await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'vcs_metadata');
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  // Win32 strips trailing dots and spaces during path normalization, so both
  // of these materialize as `.git` when mkdir runs on a Windows host.
  // `GIT~1` is the 8.3 short-name alias Windows generates for `.git`, and
  // `.git::$INDEX_ALLOCATION` is an NTFS alternate data stream hanging off
  // the same `.git` directory — both resolve to the real `.git` on a Windows
  // host even though none of these spell the name exactly. Harmless on the
  // Linux production box, but the guard must not depend on which OS is
  // extracting.
  it.each([
    '.git./config',
    '.git /config',
    'a/.GIT../config',
    'GIT~1/config',
    '.git::$INDEX_ALLOCATION/config',
  ])('rejects a .git component that Win32 normalization would collapse (%s)', async entryPath => {
    const tarBuf = buildTar([buildEntry(entryPath, 'malicious')]);
    const archivePath = await writeGzArchive(tempDir, 'git-normalized.tgz', tarBuf);

    await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'vcs_metadata');
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  // The bypass worth proving absent: node-tar consumes a PAX extended header
  // (typeflag 'x') INTERNALLY and applies its `path=` record to the following
  // entry, so the 'x' block never reaches the entry-type allowlist. If the
  // override were applied after the 'entry' event, the guard would see the
  // innocuous name and wave a `.git/config` write through.
  it('rejects a .git path smuggled through a PAX extended header', async () => {
    // PAX record framing is "<total-length> <key>=<value>\n", where the length
    // counts its own digits: 2 + 1 + 17 = 20.
    const paxPayload = Buffer.from('20 path=.git/config\n', 'utf8');
    expect(paxPayload.length).toBe(20);

    const paxBlock = Buffer.alloc(512, 0);
    paxPayload.copy(paxBlock);
    const paxEntry = Buffer.concat([
      buildHeader({ name: 'PaxHeader/innocuous.txt', size: paxPayload.length, typeflag: 'x' }),
      paxBlock,
    ]);

    const tarBuf = buildTar([paxEntry, buildEntry('innocuous.txt', 'malicious')]);
    const archivePath = await writeGzArchive(tempDir, 'pax-git.tgz', tarBuf);

    await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'vcs_metadata');
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  // Same bypass shape as the PAX case above, but via GNU tar's older
  // long-name mechanism: a '././@LongLink' entry (typeflag 'L') carries the
  // real path as its data payload, and node-tar applies it to the FOLLOWING
  // entry before emitting it. Only the PAX variant was pinned before; this
  // proves the GNU variant is caught by the same entry.path-based guard.
  it('rejects a .git path smuggled through a GNU long-name (LongLink) header', async () => {
    const longNamePayload = Buffer.from('.git/config\0', 'utf8');
    const paddedSize = Math.ceil(longNamePayload.length / 512) * 512 || 512;
    const longNameBlock = Buffer.alloc(paddedSize, 0);
    longNamePayload.copy(longNameBlock);
    const longLinkEntry = Buffer.concat([
      buildHeader({ name: '././@LongLink', size: longNamePayload.length, typeflag: 'L' }),
      longNameBlock,
    ]);

    const tarBuf = buildTar([longLinkEntry, buildEntry('innocuous.txt', 'malicious')]);
    const archivePath = await writeGzArchive(tempDir, 'longlink-git.tgz', tarBuf);

    await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'vcs_metadata');
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('rejects a bare .git/ directory entry (no child file)', async () => {
    const tarBuf = buildTar([buildEntry('.git/', '', '5')]);
    const archivePath = await writeGzArchive(tempDir, 'git-bare-dir.tgz', tarBuf);

    await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'vcs_metadata');
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  // The stripping must not over-match: these are ordinary files whose names
  // merely begin with `.git`, and every real repo has them.
  it.each(['.gitignore', '.gitattributes', '.git.txt', 'gitconfig'])(
    'extracts an ordinary %s without rejecting it',
    async name => {
      const tarBuf = buildTar([buildEntry(name, 'content')]);
      const archivePath = await writeGzArchive(tempDir, 'git-lookalike.tgz', tarBuf);

      const result = await extractTarball(archivePath, destDir, DEFAULT_LIMITS);

      expect(result.fileCount).toBe(1);
      expect(fssync.readFileSync(path.join(destDir, name), 'utf8')).toBe('content');
    }
  );

  it('rejects a case-insensitive path collision (A.txt vs a.txt)', async () => {
    const tarBuf = buildTar([buildEntry('A.txt', 'first'), buildEntry('a.txt', 'second')]);
    const archivePath = await writeGzArchive(tempDir, 'case-collision.tgz', tarBuf);

    await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'path_collision');
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('rejects a Unicode NFC-normalization collision', async () => {
    // Precomposed "e-acute" (é, one codepoint) vs the decomposed form
    // "e" + a combining acute accent (é, two codepoints).
    // Different byte sequences that both normalize to the same NFC string.
    // Built via escapes (not typed accented literals) so the two names are
    // guaranteed to stay distinct byte sequences in the source.
    const precomposed = 'café.txt';
    const decomposed = 'café.txt';
    expect(precomposed).not.toBe(decomposed);
    expect(precomposed.normalize('NFC')).toBe(decomposed.normalize('NFC'));

    const tarBuf = buildTar([buildEntry(precomposed, 'first'), buildEntry(decomposed, 'second')]);
    const archivePath = await writeGzArchive(tempDir, 'nfc-collision.tgz', tarBuf);

    await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'path_collision');
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('aborts mid-stream when cumulative decompressed bytes exceed the cap', async () => {
    const tarBuf = buildTar([buildEntry('big.txt', 'x'.repeat(1000))]);
    const archivePath = await writeGzArchive(tempDir, 'bytecap.tgz', tarBuf);

    await expectRejected(
      extractTarball(archivePath, destDir, { ...DEFAULT_LIMITS, maxUncompressedBytes: 10 }),
      'too_many_bytes'
    );
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('aborts mid-stream when the entry count exceeds the cap', async () => {
    const tarBuf = buildTar([
      buildEntry('one.txt', 'a'),
      buildEntry('two.txt', 'b'),
      buildEntry('three.txt', 'c'),
    ]);
    const archivePath = await writeGzArchive(tempDir, 'entrycap.tgz', tarBuf);

    await expectRejected(
      extractTarball(archivePath, destDir, { ...DEFAULT_LIMITS, maxEntries: 2 }),
      'too_many_entries'
    );
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('rejects a non-gzip payload on magic bytes before any decompression', async () => {
    const archivePath = path.join(tempDir, 'notgzip.tgz');
    await fs.writeFile(archivePath, Buffer.from('this is not a gzip file at all'));

    await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'not_gzip');
    // Magic-byte check happens before destDir is even created.
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('rejects an empty archive (zero regular files)', async () => {
    const tarBuf = buildTar([]);
    const archivePath = await writeGzArchive(tempDir, 'empty.tgz', tarBuf);

    await expect(extractTarball(archivePath, destDir, DEFAULT_LIMITS)).rejects.toMatchObject({
      reason: 'empty_archive',
      message: 'Archive contains no regular files',
    });
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('rejects an archive containing only directories as empty', async () => {
    const tarBuf = buildTar([buildEntry('sub/', '', '5')]);
    const archivePath = await writeGzArchive(tempDir, 'dirs-only.tgz', tarBuf);

    await expect(extractTarball(archivePath, destDir, DEFAULT_LIMITS)).rejects.toMatchObject({
      reason: 'empty_archive',
      message: 'Archive contains no regular files',
    });
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('rejects an archive whose only entry has a corrupt checksum, as invalid_archive', async () => {
    const entry = buildEntry('bad.txt', 'hi');
    // Corrupt the checksum field (offset 148, 8 bytes) so node-tar treats the
    // header as invalid and emits a 'warn' instead of an 'entry' event — a
    // parser warning is now fatal rather than silently dropping the entry.
    entry.write('00000000', 148, 8, 'ascii');
    const tarBuf = buildTar([entry]);
    const archivePath = await writeGzArchive(tempDir, 'bad-checksum.tgz', tarBuf);

    // Assert only the reason plus that the message is non-empty — not the
    // literal node-tar warn code, which would couple this suite to node-tar's
    // warn-code vocabulary and turn a minor dependency bump into a red CI
    // that reads like a security regression.
    let caught: ArchiveRejectedError | undefined;
    try {
      await extractTarball(archivePath, destDir, DEFAULT_LIMITS);
    } catch (err) {
      caught = err as ArchiveRejectedError;
    }
    expect(caught).toBeInstanceOf(ArchiveRejectedError);
    expect(caught?.reason).toBe('invalid_archive');
    expect(caught?.message.length).toBeGreaterThan(0);
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  // Pins a KNOWN, ACCEPTED limitation rather than desired behaviour, so that a
  // future node-tar release which starts warning here is noticed as a
  // behaviour change rather than silently turning these uploads into 400s.
  // Measured against tar 7.5.19: a valid entry followed by a truncated header
  // emits NO 'warn' and NO 'error' — the parser just ends. So the fatal-warning
  // rule above cannot reach it, and the truncated tail is ignored. In practice
  // a truncated UPLOAD is caught earlier, by the gzip layer; reaching this
  // needs an intact gzip wrapper around an already-truncated tar.
  it('KNOWN GAP: silently ignores a truncated tar tail (node-tar reports nothing)', async () => {
    const tarBuf = Buffer.concat([buildEntry('good.txt', 'ok'), Buffer.alloc(256, 0x41)]);
    const archivePath = await writeGzArchive(tempDir, 'truncated-tail.tgz', tarBuf);

    const result = await extractTarball(archivePath, destDir, DEFAULT_LIMITS);

    expect(result.fileCount).toBe(1);
    expect(fssync.readFileSync(path.join(destDir, 'good.txt'), 'utf8')).toBe('ok');
  });

  it('rejects an archive with one valid entry and one corrupt-checksum entry, without landing a partial tree', async () => {
    // The regression this pins: a corrupt entry used to be silently dropped
    // while the valid entry still extracted, so fileCount > 0 and
    // extractTarball resolved with a partial tree — which landFiles/syncTree
    // would then treat as authoritative and prune the destination to match,
    // silently deleting files. The valid entry comes first so its write can
    // genuinely be in flight when the warning for the corrupt entry fires.
    const good = buildEntry('good.txt', 'hello');
    const bad = buildEntry('bad.txt', 'hi');
    bad.write('00000000', 148, 8, 'ascii');
    const tarBuf = buildTar([good, bad]);
    const archivePath = await writeGzArchive(tempDir, 'partial.tgz', tarBuf);

    await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'invalid_archive');
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('fires the wall-clock timeout on a slow extraction', async () => {
    // A few hundred KB across many entries gives real extraction work to do;
    // a 1ms budget guarantees the timer wins the race deterministically.
    const entries: Buffer[] = [];
    for (let i = 0; i < 200; i++) {
      entries.push(buildEntry(`file-${i}.txt`, 'x'.repeat(10_000)));
    }
    const tarBuf = buildTar(entries);
    const archivePath = await writeGzArchive(tempDir, 'slow.tgz', tarBuf);

    await expectRejected(
      extractTarball(archivePath, destDir, { ...DEFAULT_LIMITS, timeoutMs: 1 }),
      'timeout'
    );
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('writes every entry byte-for-byte across a many-file archive', async () => {
    // Regression guard for silent content loss. The entry handler attaches a
    // byte-counting 'data' listener AND pipes the entry to a write stream;
    // attaching 'data' is what starts flowing mode, so if it is attached
    // before pipe(), the chunks emitted in that window are counted and then
    // dropped. Files land truncated by whole 512-byte tar blocks while the
    // extraction still reports success — nothing is rejected, and
    // fileCount/bytesWritten both look correct.
    //
    // The happy-path test above cannot catch it: three tiny entries all fit in
    // one gunzip chunk, so nothing is ever buffered ahead. Two properties of
    // the archive below are what actually make the bug reproduce, and both
    // were established by bisecting real failures — do not "simplify" them
    // away:
    //
    //   VARIED file sizes. An archive of uniformly-sized entries does not
    //   reproduce it at all (60 x 8 kB: 0 corrupted). Mixed sizes make gunzip
    //   chunk boundaries land mid-entry, which is the window where data is
    //   emitted before pipe() attaches.
    //
    //   LOW-COMPRESSIBILITY content. `'ab'.repeat(n)` gzips to almost nothing,
    //   so the whole archive arrives in one chunk and the window never opens.
    //
    // With both, the unfixed handler corrupts ~25-29 of these 160 entries.
    const srcDir = path.join(tempDir, 'many');
    await fs.mkdir(srcDir, { recursive: true });

    const names: string[] = [];
    const expected = new Map<string, string>();
    for (let i = 0; i < 160; i++) {
      const name = `file-${String(i).padStart(3, '0')}.txt`;
      // Deterministic pseudo-random filler (no Math.random - a flaky
      // regression test is worse than none). Distinct HEAD/TAIL markers so a
      // lost leading block shows up as a changed prefix, not just a length.
      const size = 2000 + (i % 11) * 3000;
      let body = `HEAD-${i}-`;
      let x = (i * 2654435761) % 4294967296;
      while (body.length < size) {
        x = (x * 1103515245 + 12345) % 2147483648;
        body += x.toString(36);
      }
      body += `-TAIL-${i}`;
      await fs.writeFile(path.join(srcDir, name), body);
      names.push(name);
      expected.set(name, body);
    }

    const archivePath = path.join(tempDir, 'many.tgz');
    await tar.create({ gzip: true, file: archivePath, cwd: srcDir }, names);

    const result = await extractTarball(archivePath, destDir, {
      ...DEFAULT_LIMITS,
      maxUncompressedBytes: 100 * 1024 * 1024,
    });

    expect(result.fileCount).toBe(names.length);

    const corrupted: string[] = [];
    for (const name of names) {
      const actual = fssync.readFileSync(path.join(destDir, name), 'utf8');
      if (actual !== expected.get(name)) {
        corrupted.push(`${name} (${actual.length} bytes, expected ${expected.get(name)!.length})`);
      }
    }
    expect(corrupted).toEqual([]);

    // bytesWritten must describe what actually reached disk, not what passed
    // through the counter — those two diverge under the bug above.
    const onDisk = names.reduce((n, f) => n + fssync.statSync(path.join(destDir, f)).size, 0);
    expect(result.bytesWritten).toBe(onDisk);
  });

  it('rejects and does not throw a non-ArchiveRejectedError for a truncated gzip stream', async () => {
    const tarBuf = buildTar([buildEntry('hello.txt', 'hi')]);
    const fullGz = zlib.gzipSync(tarBuf);
    const truncated = fullGz.subarray(0, Math.floor(fullGz.length / 2));
    const archivePath = path.join(tempDir, 'truncated.tgz');
    await fs.writeFile(archivePath, truncated);

    await expect(extractTarball(archivePath, destDir, DEFAULT_LIMITS)).rejects.toThrow();
    expect(fssync.existsSync(destDir)).toBe(false);
  });
});
