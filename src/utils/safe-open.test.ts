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
import {
  chmodDirNoFollow,
  openRegularFileNoFollow,
  openRegularFileForWriteNoFollow,
} from './safe-open';
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

describe('openRegularFileForWriteNoFollow', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-safe-open-w-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('creates a missing file and hands back a writable handle', async () => {
    const file = path.join(root, 'new.txt');
    const opened = await openRegularFileForWriteNoFollow(file);
    expect(opened.kind).toBe('ok');
    if (opened.kind === 'ok') {
      await opened.handle.writeFile('hi');
      await opened.handle.close();
    }
    expect(await fs.readFile(file, 'utf-8')).toBe('hi');
  });

  it('does not truncate an existing file at open time', async () => {
    const file = path.join(root, 'a.txt');
    await fs.writeFile(file, 'keep-me');
    const opened = await openRegularFileForWriteNoFollow(file);
    expect(opened.kind).toBe('ok');
    if (opened.kind === 'ok') {
      expect(opened.stat.size).toBe(7);
      await opened.handle.close();
    }
    expect(await fs.readFile(file, 'utf-8')).toBe('keep-me');
  });

  it('is refused for a directory', async () => {
    expect(await openRegularFileForWriteNoFollow(root)).toEqual({ kind: 'refused' });
  });

  it('refuses a hard link and leaves the other name untouched', async () => {
    const secret = path.join(root, 'encryption.key');
    await fs.writeFile(secret, 'KEY');
    const link = path.join(root, 'out.log');
    await fs.link(secret, link);
    expect(await openRegularFileForWriteNoFollow(link)).toEqual({ kind: 'refused' });
    expect(await fs.readFile(secret, 'utf-8')).toBe('KEY');
  });

  itPosix('refuses a symlink and never touches its target', async () => {
    const target = path.join(root, 'target');
    await fs.writeFile(target, 'untouched');
    const link = path.join(root, 'link');
    await fs.symlink(target, link);
    expect(await openRegularFileForWriteNoFollow(link)).toEqual({ kind: 'refused' });
    expect(await fs.readFile(target, 'utf-8')).toBe('untouched');
  });

  itPosix('refuses a dangling symlink without creating its target', async () => {
    const link = path.join(root, 'dangling');
    await fs.symlink(path.join(root, 'ghost'), link);
    expect(await openRegularFileForWriteNoFollow(link)).toEqual({ kind: 'refused' });
    await expect(fs.access(path.join(root, 'ghost'))).rejects.toThrow();
  });

  itPosix('refuses a FIFO without hanging', async () => {
    const fifo = path.join(root, 'fifo');
    execFileSync('mkfifo', [fifo]);
    expect(await openRegularFileForWriteNoFollow(fifo)).toEqual({ kind: 'refused' });
  });

  // lstat is the first guard; make it lie so the open flags and the fstat
  // recheck are what stop a FIFO swapped in after the check.
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
      expect(await openRegularFileForWriteNoFollow(fifo)).toEqual({ kind: 'refused' });
    } finally {
      lstatMock.mockImplementation(realLstat);
    }
  });
});

describe('chmodDirNoFollow', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-safe-chmod-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  itPosix('makes a real directory u+rwx and drops setuid/setgid/sticky', async () => {
    const dir = path.join(root, 'd');
    await fs.mkdir(dir);
    await fs.chmod(dir, 0o3555);
    expect(await chmodDirNoFollow(dir)).toBe(true);
    expect((await fs.stat(dir)).mode & 0o7777).toBe(0o755);
  });

  itPosix('never follows a symlink at the path: the link target keeps its mode', async () => {
    const target = path.join(root, 'host-dir');
    await fs.mkdir(target);
    await fs.chmod(target, 0o500);
    const link = path.join(root, 'link');
    await fs.symlink(target, link);
    expect(await chmodDirNoFollow(link)).toBe(false);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o500);
    await fs.chmod(target, 0o700);
  });

  itPosix('refuses a regular file', async () => {
    const file = path.join(root, 'f');
    await fs.writeFile(file, 'x');
    await fs.chmod(file, 0o400);
    expect(await chmodDirNoFollow(file)).toBe(false);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o400);
  });
});
