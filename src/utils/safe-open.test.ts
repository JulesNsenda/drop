/**
 * Tests for the safe-open read primitive.
 *
 * File-symlink / FIFO cases need POSIX (see utils/__testutils__/fs-links.ts);
 * the hard-link and directory cases run everywhere.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { openRegularFileNoFollow } from './safe-open';
import { itPosix } from './__testutils__/fs-links';

// Wrapped (not replaced) so the open-path guard test can make lstat lie for one
// path; `jest.spyOn(fs, ...)` throws here because ts-jest's namespace import
// has getter-only, non-configurable properties.
jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises');
  return { ...actual, lstat: jest.fn(actual.lstat) };
});

describe('openRegularFileNoFollow', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-safe-open-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('opens a regular file and reports the handle stat', async () => {
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'hello');
    const opened = await openRegularFileNoFollow(file);
    expect(opened.kind).toBe('ok');
    if (opened.kind === 'ok') {
      expect(opened.stat.size).toBe(5);
      await opened.handle.close();
    }
  });

  it('is absent for a missing file', async () => {
    expect(await openRegularFileNoFollow(path.join(root, 'nope'))).toEqual({ kind: 'absent' });
  });

  it('is refused for a directory', async () => {
    expect(await openRegularFileNoFollow(root)).toEqual({ kind: 'refused' });
  });

  it('refuses a file with a second hard link', async () => {
    const secret = path.join(root, 'encryption.key');
    await fs.writeFile(secret, 'KEY');
    const link = path.join(root, 'out.log');
    await fs.link(secret, link);
    expect(await openRegularFileNoFollow(link)).toEqual({ kind: 'refused' });
    expect(await openRegularFileNoFollow(secret)).toEqual({ kind: 'refused' });
  });

  itPosix('refuses a symlink', async () => {
    const secret = path.join(root, 'secret');
    await fs.writeFile(secret, 'top secret');
    const link = path.join(root, 'link');
    await fs.symlink(secret, link);
    expect(await openRegularFileNoFollow(link)).toEqual({ kind: 'refused' });
  });

  itPosix('refuses a FIFO without hanging', async () => {
    const fifo = path.join(root, 'fifo');
    execFileSync('mkfifo', [fifo]);
    expect(await openRegularFileNoFollow(fifo)).toEqual({ kind: 'refused' });
  });

  // lstat is the first guard, so a FIFO never reaches open() in normal runs.
  // Make lstat report a regular file for the FIFO path to prove the open
  // guards (O_NONBLOCK so open does not hang, fstat so the type is rechecked)
  // hold on their own against a swap between the check and the open.
  itPosix('refuses a FIFO swapped in after the lstat, without hanging', async () => {
    const fifo = path.join(root, 'fifo');
    execFileSync('mkfifo', [fifo]);
    const regular = path.join(root, 'regular');
    await fs.writeFile(regular, 'x');

    const realLstat = jest.requireActual('fs/promises').lstat;
    const lstatMock = fs.lstat as unknown as jest.Mock;
    lstatMock.mockImplementation((p: string, ...rest: unknown[]) =>
      realLstat(p === fifo ? regular : p, ...rest)
    );
    try {
      expect(await openRegularFileNoFollow(fifo)).toEqual({ kind: 'refused' });
    } finally {
      lstatMock.mockImplementation(realLstat);
    }
  });
});
