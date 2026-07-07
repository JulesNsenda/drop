import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { writeFileAtomic, writeJsonAtomic } from './atomic-write';

describe('atomic-write', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-atomic-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('writes file contents', async () => {
    const target = path.join(dir, 'out.txt');
    await writeFileAtomic(target, 'hello');
    expect(await fs.readFile(target, 'utf-8')).toBe('hello');
  });

  it('overwrites an existing file', async () => {
    const target = path.join(dir, 'out.txt');
    await writeFileAtomic(target, 'first');
    await writeFileAtomic(target, 'second');
    expect(await fs.readFile(target, 'utf-8')).toBe('second');
  });

  it('serializes objects with writeJsonAtomic', async () => {
    const target = path.join(dir, 'data.json');
    await writeJsonAtomic(target, { a: 1, b: [2, 3] });
    expect(JSON.parse(await fs.readFile(target, 'utf-8'))).toEqual({ a: 1, b: [2, 3] });
  });

  it('does not leave a temp file behind', async () => {
    const target = path.join(dir, 'data.json');
    await writeJsonAtomic(target, { ok: true });
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(['data.json']);
  });

  it('applies the requested mode on POSIX', async () => {
    if (process.platform === 'win32') return; // mode bits are not meaningful on Windows
    const target = path.join(dir, 'secret.json');
    await writeJsonAtomic(target, { s: 1 }, { mode: 0o600 });
    const stat = await fs.stat(target);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('handles concurrent writes to the same target without clobbering temp files', async () => {
    // Regression test for audit P3-3: the temp file path used to be derived
    // only from process.pid, so two concurrent writeJsonAtomic calls to the
    // SAME target file shared one temp path and could stomp on each other
    // (one call's open/write racing another's rename/unlink) before either
    // rename landed. The fix appends a per-call random suffix so concurrent
    // writers never share a temp file.
    const target = path.join(dir, 'concurrent.json');
    const payloadA = { writer: 'a', value: 1 };
    const payloadB = { writer: 'b', value: 2 };

    const results = await Promise.allSettled([
      writeJsonAtomic(target, payloadA),
      writeJsonAtomic(target, payloadB),
    ]);

    for (const result of results) {
      expect(result.status).toBe('fulfilled');
    }

    const finalContents = await fs.readFile(target, 'utf-8');
    const finalValue = JSON.parse(finalContents);
    expect([payloadA, payloadB]).toContainEqual(finalValue);

    // No stray temp files should remain in the directory.
    const entries = await fs.readdir(dir);
    expect(entries).toEqual(['concurrent.json']);
  });

  it('runs many concurrent writers to the same target without errors', async () => {
    const target = path.join(dir, 'many-writers.json');
    const writerCount = 20;
    const payloads = Array.from({ length: writerCount }, (_, i) => ({ i }));

    const results = await Promise.allSettled(
      payloads.map((payload) => writeJsonAtomic(target, payload))
    );

    for (const result of results) {
      expect(result.status).toBe('fulfilled');
    }

    const finalValue = JSON.parse(await fs.readFile(target, 'utf-8'));
    expect(payloads).toContainEqual(finalValue);

    const entries = await fs.readdir(dir);
    expect(entries).toEqual(['many-writers.json']);
  });
});
