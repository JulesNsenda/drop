/**
 * Tests for the hardened tenant-tree helpers.
 *
 * File-symlink / FIFO cases need POSIX (see utils/__testutils__/fs-links.ts);
 * directory links use a junction on Windows, and hard links work there too, so
 * those cases run everywhere.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import { readTenantFile, writeTenantFile, removeTenantPath, hashTenantFile } from './tenant-file';
import { itPosix, dirLink } from './__testutils__/fs-links';

// Wrapped (not replaced) so one test can make a handle's close() reject;
// `jest.spyOn(fs, ...)` throws here because ts-jest's namespace import has
// getter-only, non-configurable properties.
jest.mock('fs/promises', () => {
  const actual = jest.requireActual('fs/promises');
  return { ...actual, open: jest.fn(actual.open) };
});

describe('tenant-file', () => {
  let root: string;
  let tree: string;
  let outside: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-tenant-file-'));
    tree = path.join(root, 'tree');
    outside = path.join(root, 'outside');
    await fs.mkdir(tree);
    await fs.mkdir(outside);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('readTenantFile', () => {
    it('reads a regular file directly in the tree root', async () => {
      await fs.writeFile(path.join(tree, 'a.txt'), 'hello');
      const r = await readTenantFile(tree, 'a.txt', 100);
      expect(r.kind === 'ok' && r.content.toString()).toBe('hello');
    });

    it('reads an empty file', async () => {
      await fs.writeFile(path.join(tree, 'empty'), '');
      const r = await readTenantFile(tree, 'empty', 100);
      expect(r.kind === 'ok' && r.content.length).toBe(0);
    });

    it('reads a file inside a real directory', async () => {
      await fs.mkdir(path.join(tree, 'node_modules'));
      await fs.writeFile(path.join(tree, 'node_modules', '.m'), 'abc');
      const r = await readTenantFile(tree, path.join('node_modules', '.m'), 100);
      expect(r.kind === 'ok' && r.content.toString()).toBe('abc');
    });

    it('is absent for a missing file', async () => {
      expect(await readTenantFile(tree, 'nope', 100)).toEqual({ kind: 'absent', at: 'file' });
    });

    it('is absent at the parent when the parent directory is missing', async () => {
      expect(await readTenantFile(tree, 'node_modules/.m', 100)).toEqual({
        kind: 'absent',
        at: 'parent',
      });
    });

    it('is refused for a directory', async () => {
      await fs.mkdir(path.join(tree, 'd'));
      expect(await readTenantFile(tree, 'd', 100)).toEqual({ kind: 'refused' });
    });

    it('is refused for an oversize file', async () => {
      await fs.writeFile(path.join(tree, 'big'), 'x'.repeat(101));
      expect(await readTenantFile(tree, 'big', 100)).toEqual({ kind: 'refused' });
    });

    it('is refused for a hard link to a file outside the tree', async () => {
      const secret = path.join(outside, 'encryption.key');
      await fs.writeFile(secret, 'KEY');
      await fs.link(secret, path.join(tree, 'out.log'));
      expect(await readTenantFile(tree, 'out.log', 100)).toEqual({ kind: 'refused' });
    });

    itPosix('is refused for a symlink and never reads its target', async () => {
      const secret = path.join(outside, 'secret');
      await fs.writeFile(secret, 'top secret');
      await fs.symlink(secret, path.join(tree, 'link'));
      expect(await readTenantFile(tree, 'link', 100)).toEqual({ kind: 'refused' });
    });

    itPosix('is refused for a symlink to /dev/zero', async () => {
      await fs.symlink('/dev/zero', path.join(tree, 'zero'));
      expect(await readTenantFile(tree, 'zero', 100)).toEqual({ kind: 'refused' });
    });

    itPosix('is refused for a FIFO without hanging', async () => {
      execFileSync('mkfifo', [path.join(tree, 'fifo')]);
      expect(await readTenantFile(tree, 'fifo', 100)).toEqual({ kind: 'refused' });
    });

    it('is refused through a symlinked node_modules', async () => {
      await fs.writeFile(path.join(outside, '.m'), 'stolen');
      await dirLink(outside, path.join(tree, 'node_modules'));
      expect(await readTenantFile(tree, 'node_modules/.m', 100)).toEqual({ kind: 'refused' });
    });

    it('is refused through a symlinked ancestor', async () => {
      await fs.mkdir(path.join(outside, 'node_modules'));
      await fs.writeFile(path.join(outside, 'node_modules', '.m'), 'stolen');
      await dirLink(outside, path.join(tree, 'sub'));
      expect(await readTenantFile(tree, 'sub/node_modules/.m', 100)).toEqual({ kind: 'refused' });
    });

    it.each(['', '.', '..', 'a/..', '../x', 'a/../../x', 'node_modules/', 'node_modules/.'])(
      'is refused for relPath %p',
      async (rel) => {
        await fs.mkdir(path.join(tree, 'node_modules'));
        await fs.writeFile(path.join(root, 'x'), 'abc');
        expect(await readTenantFile(tree, rel, 100)).toEqual({ kind: 'refused' });
      }
    );

    it('is absent at the file for a missing target in an existing parent', async () => {
      await fs.mkdir(path.join(tree, 'node_modules'));
      expect(await readTenantFile(tree, 'node_modules/.m', 100)).toEqual({
        kind: 'absent',
        at: 'file',
      });
    });

    it('never rejects when closing the handle fails, and refuses instead', async () => {
      await fs.writeFile(path.join(tree, 'a.txt'), 'hello');
      const realOpen = jest.requireActual('fs/promises').open;
      const openMock = fs.open as unknown as jest.Mock;
      openMock.mockImplementationOnce(async (...args: unknown[]) => {
        const handle = await realOpen(...args);
        const realClose = handle.close.bind(handle);
        handle.close = async () => {
          await realClose();
          throw new Error('EIO');
        };
        return handle;
      });
      try {
        expect(await readTenantFile(tree, 'a.txt', 100)).toEqual({ kind: 'refused' });
      } finally {
        openMock.mockImplementation(realOpen);
      }
    });

    it('is refused for an absolute relPath', async () => {
      const secret = path.join(outside, 'secret');
      await fs.writeFile(secret, 'x');
      expect(await readTenantFile(tree, secret, 100)).toEqual({ kind: 'refused' });
    });
  });

  describe('hashTenantFile', () => {
    const sha = (v: string): string => crypto.createHash('sha256').update(v).digest('hex');

    it('equals the sha256 of the content', async () => {
      await fs.writeFile(path.join(tree, 'lock'), 'hello');
      expect(await hashTenantFile(tree, 'lock', 100)).toEqual({ kind: 'ok', sha256: sha('hello') });
    });

    it('hashes an empty file', async () => {
      await fs.writeFile(path.join(tree, 'lock'), '');
      expect(await hashTenantFile(tree, 'lock', 100)).toEqual({ kind: 'ok', sha256: sha('') });
    });

    it('streams a file larger than one chunk', async () => {
      const big = 'x'.repeat(200 * 1024);
      await fs.writeFile(path.join(tree, 'lock'), big);
      expect(await hashTenantFile(tree, 'lock', 1024 * 1024)).toEqual({
        kind: 'ok',
        sha256: sha(big),
      });
    });

    it('is absent for a missing file or parent', async () => {
      expect(await hashTenantFile(tree, 'nope', 100)).toEqual({ kind: 'absent' });
      expect(await hashTenantFile(tree, 'node_modules/.m', 100)).toEqual({ kind: 'absent' });
    });

    it('is refused for an oversize file', async () => {
      await fs.writeFile(path.join(tree, 'big'), 'x'.repeat(101));
      expect(await hashTenantFile(tree, 'big', 100)).toEqual({ kind: 'refused' });
    });

    it('is refused for a directory and a hard link', async () => {
      await fs.mkdir(path.join(tree, 'd'));
      expect(await hashTenantFile(tree, 'd', 100)).toEqual({ kind: 'refused' });
      const secret = path.join(outside, 'encryption.key');
      await fs.writeFile(secret, 'KEY');
      await fs.link(secret, path.join(tree, 'out.log'));
      expect(await hashTenantFile(tree, 'out.log', 100)).toEqual({ kind: 'refused' });
    });

    itPosix('is refused for a symlink', async () => {
      const secret = path.join(outside, 'secret');
      await fs.writeFile(secret, 'top secret');
      await fs.symlink(secret, path.join(tree, 'link'));
      expect(await hashTenantFile(tree, 'link', 100)).toEqual({ kind: 'refused' });
    });

    it('is refused through a symlinked parent', async () => {
      await fs.writeFile(path.join(outside, '.m'), 'stolen');
      await dirLink(outside, path.join(tree, 'node_modules'));
      expect(await hashTenantFile(tree, 'node_modules/.m', 100)).toEqual({ kind: 'refused' });
    });
  });

  describe('writeTenantFile', () => {
    it('writes into the tree root', async () => {
      expect(await writeTenantFile(tree, '.m', 'abc')).toBe(true);
      expect(await fs.readFile(path.join(tree, '.m'), 'utf-8')).toBe('abc');
    });

    it('writes into an existing real directory', async () => {
      await fs.mkdir(path.join(tree, 'node_modules'));
      expect(await writeTenantFile(tree, 'node_modules/.m', 'abc')).toBe(true);
      expect(await fs.readFile(path.join(tree, 'node_modules', '.m'), 'utf-8')).toBe('abc');
    });

    it('overwrites an existing regular file, truncating the old content', async () => {
      await fs.mkdir(path.join(tree, 'node_modules'));
      await fs.writeFile(path.join(tree, 'node_modules', '.m'), 'old-and-longer');
      expect(await writeTenantFile(tree, 'node_modules/.m', 'new')).toBe(true);
      expect(await fs.readFile(path.join(tree, 'node_modules', '.m'), 'utf-8')).toBe('new');
    });

    it('refuses when the directory is missing, and does not create it', async () => {
      expect(await writeTenantFile(tree, 'node_modules/.m', 'abc')).toBe(false);
      await expect(fs.access(path.join(tree, 'node_modules'))).rejects.toThrow();
    });

    it('refuses a hard link and leaves the other name untouched (no truncate)', async () => {
      const secret = path.join(outside, 'encryption.key');
      await fs.writeFile(secret, 'KEY');
      await fs.mkdir(path.join(tree, 'node_modules'));
      await fs.link(secret, path.join(tree, 'node_modules', '.m'));

      expect(await writeTenantFile(tree, 'node_modules/.m', 'abc')).toBe(false);
      expect(await fs.readFile(secret, 'utf-8')).toBe('KEY');
    });

    itPosix('refuses a symlinked file and leaves its target untouched', async () => {
      await fs.mkdir(path.join(tree, 'node_modules'));
      const secret = path.join(outside, 'encryption.key');
      await fs.writeFile(secret, 'KEY');
      await fs.symlink(secret, path.join(tree, 'node_modules', '.m'));

      expect(await writeTenantFile(tree, 'node_modules/.m', 'abc')).toBe(false);
      expect(await fs.readFile(secret, 'utf-8')).toBe('KEY');
    });

    it('refuses a symlinked node_modules and leaves the target alone', async () => {
      await dirLink(outside, path.join(tree, 'node_modules'));

      expect(await writeTenantFile(tree, 'node_modules/.m', 'abc')).toBe(false);
      expect(await fs.readdir(outside)).toEqual([]);
    });

    it('refuses a directory reached through a symlinked ancestor', async () => {
      await fs.mkdir(path.join(outside, 'node_modules'));
      await dirLink(outside, path.join(tree, 'sub'));

      expect(await writeTenantFile(tree, 'sub/node_modules/.m', 'abc')).toBe(false);
      expect(await fs.readdir(path.join(outside, 'node_modules'))).toEqual([]);
    });

    it('refuses when a directory sits at the target name', async () => {
      await fs.mkdir(path.join(tree, 'node_modules', '.m'), { recursive: true });
      expect(await writeTenantFile(tree, 'node_modules/.m', 'abc')).toBe(false);
      expect((await fs.lstat(path.join(tree, 'node_modules', '.m'))).isDirectory()).toBe(true);
    });

    itPosix('refuses when a FIFO sits at the target name, without hanging', async () => {
      await fs.mkdir(path.join(tree, 'node_modules'));
      execFileSync('mkfifo', [path.join(tree, 'node_modules', '.m')]);
      expect(await writeTenantFile(tree, 'node_modules/.m', 'abc')).toBe(false);
    });

    it.each(['', '.', '..', 'a/..', '../escape', 'a/../../escape', 'node_modules/'])(
      'refuses relPath %p',
      async (rel) => {
        await fs.mkdir(path.join(tree, 'node_modules'));
        expect(await writeTenantFile(tree, rel, 'abc')).toBe(false);
        await expect(fs.access(path.join(root, 'escape'))).rejects.toThrow();
        expect(await fs.readdir(path.join(tree, 'node_modules'))).toEqual([]);
      }
    );
  });

  describe('removeTenantPath', () => {
    it('is a no-op when the path is absent', async () => {
      await expect(removeTenantPath(tree, 'node_modules')).resolves.toBe(false);
    });

    it('is a no-op when the parent directory is absent', async () => {
      await expect(removeTenantPath(tree, 'node_modules/.m')).resolves.toBe(false);
    });

    it('removes a real directory recursively', async () => {
      await fs.mkdir(path.join(tree, 'node_modules', 'pkg'), { recursive: true });
      await fs.writeFile(path.join(tree, 'node_modules', 'pkg', 'index.js'), 'x');
      expect(await removeTenantPath(tree, 'node_modules')).toBe(true);
      await expect(fs.access(path.join(tree, 'node_modules'))).rejects.toThrow();
    });

    it('is false for a missing file in an existing parent', async () => {
      await fs.mkdir(path.join(tree, 'node_modules'));
      expect(await removeTenantPath(tree, 'node_modules/.m')).toBe(false);
    });

    it('removes a single file inside a real directory', async () => {
      await fs.mkdir(path.join(tree, 'node_modules'));
      await fs.writeFile(path.join(tree, 'node_modules', '.m'), 'abc');
      expect(await removeTenantPath(tree, 'node_modules/.m')).toBe(true);
      await expect(fs.access(path.join(tree, 'node_modules', '.m'))).rejects.toThrow();
      expect((await fs.lstat(path.join(tree, 'node_modules'))).isDirectory()).toBe(true);
    });

    it('unlinks a symlinked node_modules without touching the target', async () => {
      await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
      await dirLink(outside, path.join(tree, 'node_modules'));

      expect(await removeTenantPath(tree, 'node_modules')).toBe(true);

      await expect(fs.lstat(path.join(tree, 'node_modules'))).rejects.toThrow();
      expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf-8')).toBe('keep');
    });

    it('does not follow a symlinked subdirectory inside node_modules', async () => {
      await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
      await fs.mkdir(path.join(tree, 'node_modules'));
      await dirLink(outside, path.join(tree, 'node_modules', 'escape'));

      await removeTenantPath(tree, 'node_modules');

      await expect(fs.access(path.join(tree, 'node_modules'))).rejects.toThrow();
      expect(await fs.readFile(path.join(outside, 'keep.txt'), 'utf-8')).toBe('keep');
    });

    it('throws and leaves the target alone when the parent is a symlink', async () => {
      await fs.mkdir(path.join(outside, 'node_modules'));
      await fs.writeFile(path.join(outside, 'node_modules', 'keep.txt'), 'keep');
      await dirLink(outside, path.join(tree, 'sub'));

      await expect(removeTenantPath(tree, 'sub/node_modules')).rejects.toThrow();

      expect(await fs.readFile(path.join(outside, 'node_modules', 'keep.txt'), 'utf-8')).toBe(
        'keep'
      );
    });

    it('throws a generic message that carries no host path', async () => {
      await dirLink(outside, path.join(tree, 'sub'));

      const err = await removeTenantPath(tree, 'sub/node_modules').catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      const { message } = err as Error;
      expect(message).toBe('failed to remove sub/node_modules');
      expect(message).not.toContain(tree);
      expect(message).not.toContain(outside);
      expect(message).not.toContain(root);
      expect((err as Error).cause).toBeInstanceOf(Error);
    });

    it.each(['', '.', '..', 'a/..', 'a/../..'])('throws for relPath %p', async (rel) => {
      await expect(removeTenantPath(tree, rel)).rejects.toThrow(/failed to remove/);
      expect((await fs.lstat(tree)).isDirectory()).toBe(true);
    });
  });
});
