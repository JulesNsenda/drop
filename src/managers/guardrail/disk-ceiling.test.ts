/**
 * Per-app disk ceiling.
 *
 * This is ACCOUNTING, not a cap — it measures and reports, and the caller
 * parks. The properties worth pinning are therefore about the measurement
 * being honest: it must not follow a symlink out of the tree, must not hang on
 * a loop, and must not silently read a bad config as "no limit".
 */

import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import * as os from 'os';
import { measureTree, findOverCeiling, configuredCeilingBytes, toMb } from './disk-ceiling';

const MB = 1024 * 1024;

/**
 * Whether this box can create symlinks at all.
 *
 * Windows refuses without Developer Mode (EPERM). The symlink tests below used
 * to `return` on that failure, which reads as a PASS — a mutation that made the
 * walk follow symlinks went undetected locally for exactly that reason. Skipped
 * VISIBLY instead, so a green run here never claims coverage it does not have;
 * CI runs on Linux, where they execute for real.
 */
const canSymlink = (() => {
  const probe = fssync.mkdtempSync(path.join(os.tmpdir(), 'drop-symprobe-'));
  try {
    fssync.symlinkSync(probe, path.join(probe, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    fssync.rmSync(probe, { recursive: true, force: true });
  }
})();
const itSymlink = canSymlink ? it : it.skip;

describe('measureTree', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-disk-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const write = async (rel: string, bytes: number) => {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, Buffer.alloc(bytes));
  };

  it('sums files across nested directories', async () => {
    await write('a.bin', 1000);
    await write('nested/b.bin', 2000);
    await write('nested/deep/c.bin', 3000);

    const usage = await measureTree(root);

    expect(usage.bytes).toBe(6000);
    expect(usage.truncated).toBe(false);
  });

  it('returns zero for a directory that does not exist, rather than throwing', async () => {
    // An app may have no data dir yet. A sweep that threw would abandon every
    // app after the first one that had never written anything.
    const usage = await measureTree(path.join(root, 'never-created'));

    expect(usage.bytes).toBe(0);
  });

  itSymlink('does NOT follow a symlink out of the tree', async () => {
    // Two failures at once if it did: the measurement escapes the app's own
    // tree, and an app could charge someone else's bytes to itself — or, worse,
    // point at a huge shared directory and park itself into an unusable state.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-outside-'));
    try {
      await fs.writeFile(path.join(outside, 'huge.bin'), Buffer.alloc(50_000));
      await write('small.bin', 100);
      await fs.symlink(outside, path.join(root, 'link'), 'dir');

      const usage = await measureTree(root);

      expect(usage.bytes).toBe(100);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  itSymlink('terminates on a symlink loop', async () => {
    // Following links would recurse forever and hang the sweep — and with it
    // the platform's timer.
    await write('small.bin', 100);
    await fs.symlink(root, path.join(root, 'self'), 'dir');

    const usage = await measureTree(root);

    expect(usage.bytes).toBe(100);
  });

  it('reports truncation rather than a quietly-low number', async () => {
    // A floor presented as a total would let a deep tree sit under its ceiling
    // forever. The caller says "at least this much" when it parks.
    let deep = root;
    for (let i = 0; i < 20; i++) {
      deep = path.join(deep, `d${i}`);
    }
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(deep, 'buried.bin'), Buffer.alloc(500));

    const usage = await measureTree(root);

    expect(usage.truncated).toBe(true);
  });
});

describe('configuredCeilingBytes', () => {
  const saved = process.env.DROP_MAX_APP_DISK_MB;

  afterEach(() => {
    if (saved === undefined) delete process.env.DROP_MAX_APP_DISK_MB;
    else process.env.DROP_MAX_APP_DISK_MB = saved;
  });

  it('defaults to 2048 MB when unset', () => {
    delete process.env.DROP_MAX_APP_DISK_MB;
    expect(configuredCeilingBytes()).toBe(2048 * MB);
  });

  it('honours an explicit value', () => {
    process.env.DROP_MAX_APP_DISK_MB = '512';
    expect(configuredCeilingBytes()).toBe(512 * MB);
  });

  it('treats an explicit 0 as DISABLED', () => {
    process.env.DROP_MAX_APP_DISK_MB = '0';
    expect(configuredCeilingBytes()).toBe(0);
  });

  it('falls back to the default on nonsense rather than to "no limit"', () => {
    // parseInt('abc') is NaN, and NaN <= 0 is false — a naive guard would let
    // NaN through and every comparison against it would be false, silently
    // disabling the ceiling.
    process.env.DROP_MAX_APP_DISK_MB = 'not-a-number';
    expect(configuredCeilingBytes()).toBe(2048 * MB);

    process.env.DROP_MAX_APP_DISK_MB = '-5';
    expect(configuredCeilingBytes()).toBe(2048 * MB);
  });
});

describe('findOverCeiling', () => {
  let root: string;
  const saved = process.env.DROP_MAX_APP_DISK_MB;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-ceiling-'));
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.DROP_MAX_APP_DISK_MB;
    else process.env.DROP_MAX_APP_DISK_MB = saved;
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const app = async (name: string, bytes: number) => {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'blob.bin'), Buffer.alloc(bytes));
    return dir;
  };

  it('reports only the apps over their ceiling', async () => {
    process.env.DROP_MAX_APP_DISK_MB = '1';
    const big = await app('big', 2 * MB);
    const small = await app('small', 1000);

    const over = await findOverCeiling([
      { name: 'big', paths: [big] },
      { name: 'small', paths: [small] },
    ]);

    expect(over.map((o) => o.name)).toEqual(['big']);
  });

  it('sums every path charged to an app', async () => {
    // An app grows in two places — its own tree and its data dir — and either
    // alone can be under the ceiling while the pair is over it.
    process.env.DROP_MAX_APP_DISK_MB = '1';
    const a = await app('src', (2 * MB) / 3);
    const b = await app('data', (2 * MB) / 3);

    const over = await findOverCeiling([{ name: 'two-parts', paths: [a, b] }]);

    expect(over).toHaveLength(1);
  });

  it('lets a per-app override RAISE the ceiling', async () => {
    process.env.DROP_MAX_APP_DISK_MB = '1';
    const big = await app('big', 2 * MB);

    const over = await findOverCeiling([{ name: 'big', paths: [big], maxDiskMb: 10 }]);

    expect(over).toEqual([]);
  });

  it('treats a per-app 0 as an EXEMPTION, not as a zero allowance', async () => {
    // The distinction matters: an operator exempting one legitimately large app
    // must not accidentally park it instantly instead.
    process.env.DROP_MAX_APP_DISK_MB = '1';
    const big = await app('big', 2 * MB);

    const over = await findOverCeiling([{ name: 'big', paths: [big], maxDiskMb: 0 }]);

    expect(over).toEqual([]);
  });

  it('reports nothing at all when the ceiling is globally disabled', async () => {
    process.env.DROP_MAX_APP_DISK_MB = '0';
    const big = await app('big', 5 * MB);

    expect(await findOverCeiling([{ name: 'big', paths: [big] }])).toEqual([]);
  });

  it('reports how far over, so the park reason is actionable', async () => {
    process.env.DROP_MAX_APP_DISK_MB = '1';
    const big = await app('big', 3 * MB);

    const [verdict] = await findOverCeiling([{ name: 'big', paths: [big] }]);

    expect(verdict.overBy).toBeGreaterThan(0);
    expect(toMb(verdict.bytes)).toBeGreaterThan(toMb(verdict.ceilingBytes));
  });

  it('does not need every path to exist', async () => {
    process.env.DROP_MAX_APP_DISK_MB = '1';
    const src = await app('src', 2 * MB);

    const over = await findOverCeiling([
      { name: 'no-data-dir', paths: [src, path.join(root, 'never-created')] },
    ]);

    expect(over).toHaveLength(1);
  });
});

describe('platform integration surface', () => {
  it('exports a sweep interval shorter than the daily log-retention sweep', async () => {
    // The reason this does not ride the retention timer: a day of unchecked
    // growth is most of a disk.
    const { DISK_SWEEP_INTERVAL_MS } = await import('./disk-ceiling');
    expect(DISK_SWEEP_INTERVAL_MS).toBeLessThan(24 * 60 * 60 * 1000);
  });

  it('is reachable from a real fs layout', () => {
    expect(typeof fssync.existsSync).toBe('function');
  });
});
