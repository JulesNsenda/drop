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
  // of these materialize as `.git` when mkdir runs on a Windows host
  // (CVE-2019-1353 class). Distinct directories on Linux, but the guard must
  // not depend on which OS is extracting.
  it.each(['.git./config', '.git /config', 'a/.GIT../config'])(
    'rejects a .git component that Win32 normalization would collapse (%s)',
    async entryPath => {
      const tarBuf = buildTar([buildEntry(entryPath, 'malicious')]);
      const archivePath = await writeGzArchive(tempDir, 'git-normalized.tgz', tarBuf);

      await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'vcs_metadata');
      expect(fssync.existsSync(destDir)).toBe(false);
    }
  );

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

    await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'empty_archive');
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('rejects an archive containing only directories as empty', async () => {
    const tarBuf = buildTar([buildEntry('sub/', '', '5')]);
    const archivePath = await writeGzArchive(tempDir, 'dirs-only.tgz', tarBuf);

    await expectRejected(extractTarball(archivePath, destDir, DEFAULT_LIMITS), 'empty_archive');
    expect(fssync.existsSync(destDir)).toBe(false);
  });

  it('surfaces the first parser warning in the empty_archive message', async () => {
    const entry = buildEntry('bad.txt', 'hi');
    // Corrupt the checksum field (offset 148, 8 bytes) so node-tar treats the
    // header as invalid and emits a 'warn' (TAR_ENTRY_INVALID) instead of an
    // 'entry' event — exercising the empty_archive path with a captured
    // warning rather than a legitimately empty archive.
    entry.write('00000000', 148, 8, 'ascii');
    const tarBuf = buildTar([entry]);
    const archivePath = await writeGzArchive(tempDir, 'bad-checksum.tgz', tarBuf);

    await expect(extractTarball(archivePath, destDir, DEFAULT_LIMITS)).rejects.toMatchObject({
      reason: 'empty_archive',
      message: expect.stringContaining('TAR_ENTRY_INVALID'),
    });
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
