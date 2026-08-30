import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { tailFile, MAX_TAIL_BYTES } from './tail-file';

/**
 * Extracted from ProcessManager so the container runtime can read the same
 * DROP-owned log files the same way (#264). The bound is the point of it: a
 * tenant controls how fast its log grows, and this runs in the single-process
 * platform, so an unbounded read is a memory-exhaustion lever rather than just
 * a slow response.
 */
describe('tailFile', () => {
  let dir: string;
  const write = (name: string, body: string): string => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body);
    return p;
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-tail-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns the last lines of a short file', () => {
    const p = write('a.log', ['one', 'two', 'three'].join('\n'));
    return expect(tailFile(p, 10)).resolves.toEqual(['one', 'two', 'three']);
  });

  it('reads only the tail of a file longer than the window', async () => {
    const p = write('b.log', Array.from({ length: 5000 }, (_, i) => `line-${i}`).join('\n'));
    const out = await tailFile(p, 5);
    // Byte-sliced, so the count is approximate and the first entry is usually a
    // partial line — callers take .slice(-lines). What must hold is that the
    // END of the file is what came back, and that it is not the whole file.
    expect(out.length).toBeLessThan(5000);
    expect(out[out.length - 1]).toBe('line-4999');
  });

  it('never reads more than the byte cap, however many lines are asked for', async () => {
    const big = 'x'.repeat(MAX_TAIL_BYTES * 2);
    const p = write('c.log', big);
    const out = await tailFile(p, 1_000_000);
    expect(out.join('\n').length).toBeLessThanOrEqual(MAX_TAIL_BYTES);
  });

  it('returns [] for an empty file', async () => {
    expect(await tailFile(write('d.log', ''), 10)).toEqual([]);
  });

  it('returns [] when asked for no lines rather than opening the file', async () => {
    expect(await tailFile(path.join(dir, 'does-not-exist.log'), 0)).toEqual([]);
  });

  it('rejects for a missing file, so callers decide what absence means', async () => {
    await expect(tailFile(path.join(dir, 'missing.log'), 10)).rejects.toThrow();
  });
});
