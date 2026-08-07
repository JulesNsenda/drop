/**
 * M1 review item F - computeSourceMtimeMs's scan bounds:
 * docs/plans/2026-07-25-restart-isolation-and-marketing-split.md.
 *
 * Under isolation 'none' a tenant controls their own app directory and could
 * otherwise hold platform startup hostage with a huge/deep source tree, since
 * the scan runs serially per app inside boot reconciliation, before the API
 * server comes up. Three independent bounds guard against that: a depth cap
 * (12), an entry cap (20,000), and a wall-clock timeout (5s). Every bound must
 * fail the scan (never resolve a false "unchanged" from a partial walk).
 *
 * computeSourceMtimeMs is a private DropPlatform method that touches no
 * instance state besides the constructor's cheap, synchronous config/logger
 * setup - it can be invoked directly on a constructed-but-never-started
 * DropPlatform, without any real deploy/reconcile machinery. That keeps this
 * file fast and dependency-free.
 *
 * 'fs/promises' is mocked so stat/readdir/lstat are jest.fn()s whose DEFAULT
 * implementation delegates to the real function (jest.spyOn cannot wrap
 * these directly - the compiled ES module namespace object has non-
 * configurable properties, "Cannot redefine property"). That default keeps
 * the depth-cap tests running against a REAL nested temp directory with no
 * behaviour change; the entry-cap/timeout tests override the implementation
 * for just that test, then afterEach restores the real passthrough. None of
 * this mocks the assertion itself (computeSourceMtimeMs is never stubbed) -
 * only the I/O/clock boundary it depends on.
 */
import * as path from 'path';
import * as os from 'os';

jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises');
  return {
    ...actual,
    stat: jest.fn(actual.stat),
    readdir: jest.fn(actual.readdir),
    lstat: jest.fn(actual.lstat),
  };
});

import * as fsPromises from 'fs/promises';
import { createPlatform } from './platform';

const actualFs = jest.requireActual('fs/promises') as typeof fsPromises;

type PrivateScan = {
  computeSourceMtimeMs(appPath: string): Promise<{ hash: string; newestPath: string }>;
};

function makePlatform(): PrivateScan {
  // No dropRoot/appsDirectory needs to exist on disk - the constructor is
  // synchronous and touches no filesystem (see file header).
  return createPlatform({ dropRoot: '/fake-root', appsDirectory: '/fake-root/webapps' }) as unknown as PrivateScan;
}

describe('DropPlatform.computeSourceMtimeMs scan bounds (M1 review item F)', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    (fsPromises.stat as jest.Mock).mockImplementation(actualFs.stat);
    (fsPromises.readdir as jest.Mock).mockImplementation(actualFs.readdir);
    (fsPromises.lstat as jest.Mock).mockImplementation(actualFs.lstat);
    if (tempDir) {
      await actualFs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      tempDir = undefined;
    }
  });

  it('fails toward redeploy (throws) when the tree exceeds the depth cap (12)', async () => {
    tempDir = await actualFs.mkdtemp(path.join(os.tmpdir(), 'drop-scan-depth-'));
    let dir = tempDir;
    for (let i = 0; i < 14; i++) {
      dir = path.join(dir, 'd' + i);
      await actualFs.mkdir(dir);
    }

    const platform = makePlatform();
    await expect(platform.computeSourceMtimeMs(tempDir)).rejects.toThrow(/exceeded depth cap/);
  });

  it('does NOT throw for a tree within the depth cap (negative control)', async () => {
    tempDir = await actualFs.mkdtemp(path.join(os.tmpdir(), 'drop-scan-depth-ok-'));
    let dir = tempDir;
    for (let i = 0; i < 5; i++) {
      dir = path.join(dir, 'd' + i);
      await actualFs.mkdir(dir);
    }
    await actualFs.writeFile(path.join(dir, 'file.txt'), 'x');

    const platform = makePlatform();
    const result = await platform.computeSourceMtimeMs(tempDir);
    // M1 review round-2 item 2: the signature is now a SHA-256 hash over the
    // whole tree's (relativePath, mtimeMs, size) tuples, not a raw mtime
    // number — this file tests SCAN BOUNDS, not the signal, so a type/format
    // check is all that's meaningful here.
    expect(typeof result.hash).toBe('string');
    expect(result.hash).toHaveLength(64);
  });

  it('fails toward redeploy (throws) when a single directory exceeds the entry cap (20,000)', async () => {
    const rootPath = '/synthetic-root-for-entry-cap-test';
    const entries = Array.from({ length: 20_001 }, (_, i) => ({
      name: 'file' + i,
      isDirectory: () => false,
    }));

    (fsPromises.stat as jest.Mock).mockResolvedValue({ mtimeMs: 1000 });
    (fsPromises.readdir as jest.Mock).mockResolvedValue(entries);
    (fsPromises.lstat as jest.Mock).mockResolvedValue({ mtimeMs: 1000 });

    const platform = makePlatform();
    await expect(platform.computeSourceMtimeMs(rootPath)).rejects.toThrow(/exceeded entry cap/);

    expect(fsPromises.stat).toHaveBeenCalled();
    expect(fsPromises.readdir).toHaveBeenCalled();
    // The throw lands at entry 20,001, so lstat resolves for most but not all
    // 20,001 synthetic entries.
    expect((fsPromises.lstat as jest.Mock).mock.calls.length).toBeGreaterThan(19_000);
  });

  it('does NOT throw for a directory within the entry cap (negative control)', async () => {
    const rootPath = '/synthetic-root-for-entry-cap-ok-test';
    const entries = Array.from({ length: 10 }, (_, i) => ({
      name: 'file' + i,
      isDirectory: () => false,
    }));

    (fsPromises.stat as jest.Mock).mockResolvedValue({ mtimeMs: 1000 });
    (fsPromises.readdir as jest.Mock).mockResolvedValue(entries);
    (fsPromises.lstat as jest.Mock).mockResolvedValue({ mtimeMs: 2000 });

    const platform = makePlatform();
    const result = await platform.computeSourceMtimeMs(rootPath);
    // M1 review round-2 item 2: hash, not a raw mtime — see the depth-cap
    // negative control's comment above.
    expect(typeof result.hash).toBe('string');
    expect(result.hash).toHaveLength(64);
  });

  it('fails toward redeploy (throws) when the scan exceeds the wall-clock timeout (5s)', async () => {
    const rootPath = '/synthetic-root-for-timeout-test';

    (fsPromises.stat as jest.Mock).mockResolvedValue({ mtimeMs: 1000 });
    (fsPromises.readdir as jest.Mock).mockResolvedValue([]);

    // computeSourceMtimeMs computes `deadline = Date.now() + 5000` once, then
    // walk()'s very first check compares Date.now() against that deadline -
    // BEFORE it ever calls readdir. Mocking Date.now to jump forward on its
    // second call trips that check immediately, without a real 5s sleep.
    const base = 1_700_000_000_000;
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(base) // deadline computation
      .mockReturnValue(base + 5_001); // walk()'s first check

    const platform = makePlatform();
    await expect(platform.computeSourceMtimeMs(rootPath)).rejects.toThrow(/exceeded timeout/);

    nowSpy.mockRestore();
  });

  it('does NOT throw when the clock stays within the timeout (negative control)', async () => {
    const rootPath = '/synthetic-root-for-timeout-ok-test';

    (fsPromises.stat as jest.Mock).mockResolvedValue({ mtimeMs: 1000 });
    (fsPromises.readdir as jest.Mock).mockResolvedValue([]);

    const platform = makePlatform();
    const result = await platform.computeSourceMtimeMs(rootPath);
    // M1 review round-2 item 2: hash, not a raw mtime — see the depth-cap
    // negative control's comment above.
    expect(typeof result.hash).toBe('string');
    expect(result.hash).toHaveLength(64);
  });
});
