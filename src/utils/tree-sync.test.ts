/**
 * `syncTree` is the shared landing step for deploy paths: copy the source
 * over the destination, delete what the source no longer has, keep a named
 * set regardless.
 *
 * Real filesystem throughout — the whole point is entry-kind flips, what `rm`
 * does to a symlink, and what survives a prune.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import { syncTree, DEFAULT_PRESERVE } from './tree-sync';

function linkDir(target: string, linkPath: string): void {
  fssync.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('syncTree', () => {
  let root: string;
  let src: string;
  let dest: string;

  beforeEach(async () => {
    root = path.join(
      os.tmpdir(),
      `drop-tree-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    src = path.join(root, 'src');
    dest = path.join(root, 'dest');
    await fs.mkdir(src, { recursive: true });
    await fs.mkdir(dest, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  const read = (p: string) => fs.readFile(p, 'utf-8');
  async function exists(p: string): Promise<boolean> {
    try {
      await fs.lstat(p);
      return true;
    } catch {
      return false;
    }
  }

  it('copies new entries, overwrites changed ones, deletes stale ones', async () => {
    await fs.writeFile(path.join(src, 'kept.txt'), 'new content');
    await fs.writeFile(path.join(src, 'added.txt'), 'added');
    await fs.writeFile(path.join(dest, 'kept.txt'), 'old content');
    await fs.writeFile(path.join(dest, 'stale.txt'), 'should go');

    await syncTree(src, dest);

    expect(await read(path.join(dest, 'kept.txt'))).toBe('new content');
    expect(await read(path.join(dest, 'added.txt'))).toBe('added');
    expect(await exists(path.join(dest, 'stale.txt'))).toBe(false);
  });

  it('creates the destination when it does not exist yet', async () => {
    const fresh = path.join(root, 'fresh');
    await fs.mkdir(path.join(src, 'nested'), { recursive: true });
    await fs.writeFile(path.join(src, 'nested', 'a.txt'), 'a');

    await syncTree(src, fresh);

    expect(await read(path.join(fresh, 'nested', 'a.txt'))).toBe('a');
  });

  it('prunes a stale file nested inside a directory that survives', async () => {
    await fs.mkdir(path.join(src, 'app'), { recursive: true });
    await fs.writeFile(path.join(src, 'app', 'keep.txt'), 'keep');
    await fs.mkdir(path.join(dest, 'app'), { recursive: true });
    await fs.writeFile(path.join(dest, 'app', 'keep.txt'), 'old');
    await fs.writeFile(path.join(dest, 'app', 'gone.txt'), 'stale');

    await syncTree(src, dest);

    expect(await read(path.join(dest, 'app', 'keep.txt'))).toBe('keep');
    expect(await exists(path.join(dest, 'app', 'gone.txt'))).toBe(false);
  });

  describe('the preserve list', () => {
    it('keeps node_modules even though the source never carries it', async () => {
      await fs.writeFile(path.join(src, 'index.js'), 'v2');
      await fs.mkdir(path.join(dest, 'node_modules', 'dep'), { recursive: true });
      await fs.writeFile(path.join(dest, 'node_modules', 'dep', 'index.js'), 'installed');

      await syncTree(src, dest, { preserve: DEFAULT_PRESERVE });

      // Deleting these pulled a running app's dependencies out from under it.
      expect(await read(path.join(dest, 'node_modules', 'dep', 'index.js'))).toBe('installed');
    });

    it('keeps a NESTED node_modules too (matched by name at any depth)', async () => {
      await fs.mkdir(path.join(src, 'pkg'), { recursive: true });
      await fs.writeFile(path.join(src, 'pkg', 'index.js'), 'v2');
      await fs.mkdir(path.join(dest, 'pkg', 'node_modules', 'dep'), { recursive: true });
      await fs.writeFile(path.join(dest, 'pkg', 'node_modules', 'dep', 'i.js'), 'installed');

      await syncTree(src, dest, { preserve: DEFAULT_PRESERVE });

      expect(await read(path.join(dest, 'pkg', 'node_modules', 'dep', 'i.js'))).toBe('installed');
    });

    it('does NOT keep dist — deleting build output is what forces a rebuild', async () => {
      // StaticBuildStrategy.preBuild resolves an existing dist/index.html as
      // "already built" before it checks for a source SPA, leaving
      // buildCommand unset; validate() then passes against that stale bundle.
      // If this test ever fails because someone added 'dist' to the preserve
      // list, the platform silently serves the previous deploy's bundle.
      await fs.writeFile(path.join(src, 'index.js'), 'v2');
      await fs.mkdir(path.join(dest, 'dist'), { recursive: true });
      await fs.writeFile(path.join(dest, 'dist', 'index.html'), '<h1>v1</h1>');

      await syncTree(src, dest, { preserve: DEFAULT_PRESERVE });

      expect(await exists(path.join(dest, 'dist'))).toBe(false);
      expect(DEFAULT_PRESERVE).not.toContain('dist');
      expect(DEFAULT_PRESERVE).not.toContain('build');
    });
  });

  describe('entry-kind flips', () => {
    it('lands a file where a directory used to be', async () => {
      await fs.writeFile(path.join(src, 'thing'), 'now a file');
      await fs.mkdir(path.join(dest, 'thing', 'inner'), { recursive: true });
      await fs.writeFile(path.join(dest, 'thing', 'inner', 'x.txt'), 'old');

      await syncTree(src, dest);

      expect(await read(path.join(dest, 'thing'))).toBe('now a file');
    });

    it('lands a directory where a file used to be', async () => {
      // fs.cp throws ERR_FS_CP_DIR_TO_NON_DIR here and abandons the copy
      // mid-tree, leaving a permanently half-old/half-new directory.
      await fs.mkdir(path.join(src, 'thing'), { recursive: true });
      await fs.writeFile(path.join(src, 'thing', 'inner.txt'), 'now a dir');
      await fs.writeFile(path.join(dest, 'thing'), 'was a file');

      await syncTree(src, dest);

      expect(await read(path.join(dest, 'thing', 'inner.txt'))).toBe('now a dir');
    });

    it('replaces a symlink occupying a name the source needs', async () => {
      const outside = path.join(root, 'outside');
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(path.join(outside, 'secret.txt'), 'not ours');
      await fs.mkdir(path.join(src, 'assets'), { recursive: true });
      await fs.writeFile(path.join(src, 'assets', 'a.txt'), 'ours');
      linkDir(outside, path.join(dest, 'assets'));

      await syncTree(src, dest);

      expect((await fs.lstat(path.join(dest, 'assets'))).isSymbolicLink()).toBe(false);
      expect(await read(path.join(dest, 'assets', 'a.txt'))).toBe('ours');
      // The copy went into a real directory, not through the link.
      expect(await exists(path.join(outside, 'a.txt'))).toBe(false);
      expect(await read(path.join(outside, 'secret.txt'))).toBe('not ours');
    });
  });

  describe('symlink safety', () => {
    it('removes a stale symlink as a link, without following it', async () => {
      const outside = path.join(root, 'outside');
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(path.join(outside, 'keepme.txt'), 'another tenant');
      linkDir(outside, path.join(dest, 'stale-link'));

      await syncTree(src, dest);

      expect(await exists(path.join(dest, 'stale-link'))).toBe(false);
      // The prune deleted the link, never what it pointed at.
      expect(await read(path.join(outside, 'keepme.txt'))).toBe('another tenant');
    });

    it('does not reproduce a symlink found in the source', async () => {
      // Callers pre-reject these (tar-extract, expandMonorepo). Skipping rather
      // than copying keeps the aliasing hole from PR #158 closed if one slips.
      const outside = path.join(root, 'outside');
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(path.join(outside, 'secret.txt'), 'not ours');
      await fs.writeFile(path.join(src, 'real.txt'), 'ours');
      linkDir(outside, path.join(src, 'sneaky'));

      await syncTree(src, dest);

      expect(await read(path.join(dest, 'real.txt'))).toBe('ours');
      expect(await exists(path.join(dest, 'sneaky'))).toBe(false);
    });
  });
});
