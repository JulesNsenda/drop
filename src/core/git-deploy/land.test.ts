/**
 * Landing tracked files in an app folder (no git involved: the clone is a
 * plain directory here).
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { landTracked, readManifest, writeManifest } from './land';

const LIMITS = { maxBytes: 10 * 1024 * 1024, maxEntries: 1000 };

describe('landTracked', () => {
  let root: string;
  let clone: string;
  let app: string;

  async function write(base: string, rel: string, content: string): Promise<void> {
    const abs = path.join(base, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }

  async function exists(p: string): Promise<boolean> {
    return fs.lstat(p).then(
      () => true,
      () => false
    );
  }

  function link(target: string, at: string): Promise<void> {
    return fs.symlink(target, at, process.platform === 'win32' ? 'junction' : 'dir');
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-land-'));
    clone = path.join(root, 'clone');
    app = path.join(root, 'app');
    await fs.mkdir(clone);
    await fs.mkdir(app);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('copies tracked files and never writes .git', async () => {
    await write(clone, 'a.txt', 'A');
    await write(clone, 'sub/b.txt', 'B');
    await write(clone, '.git/config', 'x');

    const landed = await landTracked({
      cloneDir: clone,
      appDir: app,
      files: ['a.txt', 'sub/b.txt'],
      previous: null,
      limits: LIMITS,
    });

    expect(landed).toEqual(['a.txt', 'sub/b.txt']);
    expect(await fs.readFile(path.join(app, 'sub', 'b.txt'), 'utf-8')).toBe('B');
    expect(await exists(path.join(app, '.git'))).toBe(false);
  });

  it('leaves untracked files alone, and prunes only previously-landed files that are gone upstream', async () => {
    await write(app, 'kept.txt', 'old');
    await write(app, 'removed-upstream.txt', 'old');
    await write(app, 'sub/also-removed.txt', 'old');
    await write(app, 'sub/untracked.txt', 'mine');
    await write(app, 'data.db', 'app state');
    await write(app, 'node_modules/dep/index.js', 'dep');
    await write(clone, 'kept.txt', 'new');

    await landTracked({
      cloneDir: clone,
      appDir: app,
      files: ['kept.txt'],
      previous: ['kept.txt', 'removed-upstream.txt', 'sub/also-removed.txt', 'node_modules/dep/index.js'],
      limits: LIMITS,
    });

    expect(await fs.readFile(path.join(app, 'kept.txt'), 'utf-8')).toBe('new');
    expect(await exists(path.join(app, 'removed-upstream.txt'))).toBe(false);
    expect(await exists(path.join(app, 'sub', 'also-removed.txt'))).toBe(false);
    expect(await fs.readFile(path.join(app, 'sub', 'untracked.txt'), 'utf-8')).toBe('mine');
    expect(await fs.readFile(path.join(app, 'data.db'), 'utf-8')).toBe('app state');
    // node_modules is never pruned, even when a manifest names a path in it.
    expect(await exists(path.join(app, 'node_modules', 'dep', 'index.js'))).toBe(true);
  });

  it('prunes nothing without a previous manifest', async () => {
    await write(app, 'stale.txt', 'old');
    await write(clone, 'a.txt', 'A');

    await landTracked({ cloneDir: clone, appDir: app, files: ['a.txt'], previous: null, limits: LIMITS });

    expect(await exists(path.join(app, 'stale.txt'))).toBe(true);
  });

  it('removes a leftover .git directory, and a symlinked .git as a link only', async () => {
    await write(clone, 'a.txt', 'A');
    await write(app, '.git/config', 'tenant-written');
    await landTracked({ cloneDir: clone, appDir: app, files: ['a.txt'], previous: null, limits: LIMITS });
    expect(await exists(path.join(app, '.git'))).toBe(false);

    const target = path.join(root, 'target');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'sentinel'), 'safe');
    await link(target, path.join(app, '.git'));
    await landTracked({ cloneDir: clone, appDir: app, files: ['a.txt'], previous: null, limits: LIMITS });
    expect(await exists(path.join(app, '.git'))).toBe(false);
    expect(await fs.readFile(path.join(target, 'sentinel'), 'utf-8')).toBe('safe');
  });

  it('refuses to write through a directory symlink planted where a tracked directory goes', async () => {
    const target = path.join(root, 'elsewhere');
    await fs.mkdir(target);
    await link(target, path.join(app, 'sub'));
    await write(clone, 'sub/b.txt', 'B');

    await expect(
      landTracked({ cloneDir: clone, appDir: app, files: ['sub/b.txt'], previous: null, limits: LIMITS })
    ).rejects.toThrow(/symbolic link/);

    expect(await exists(path.join(target, 'b.txt'))).toBe(false);
  });

  it('replaces a file symlink at a tracked path without writing through it', async () => {
    const outside = path.join(root, 'outside.txt');
    await fs.writeFile(outside, 'host file');
    try {
      await fs.symlink(outside, path.join(app, 'a.txt'));
    } catch {
      return; // symlink creation not permitted on this host
    }
    await write(clone, 'a.txt', 'A');

    await landTracked({ cloneDir: clone, appDir: app, files: ['a.txt'], previous: null, limits: LIMITS });

    expect(await fs.readFile(outside, 'utf-8')).toBe('host file');
    expect((await fs.lstat(path.join(app, 'a.txt'))).isSymbolicLink()).toBe(false);
    expect(await fs.readFile(path.join(app, 'a.txt'), 'utf-8')).toBe('A');
  });

  it('does not follow a directory symlink when pruning', async () => {
    const target = path.join(root, 'elsewhere');
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, 'b.txt'), 'victim');
    await link(target, path.join(app, 'sub'));
    await write(clone, 'a.txt', 'A');

    await landTracked({
      cloneDir: clone,
      appDir: app,
      files: ['a.txt'],
      previous: ['a.txt', 'sub/b.txt'],
      limits: LIMITS,
    });

    expect(await fs.readFile(path.join(target, 'b.txt'), 'utf-8')).toBe('victim');
  });

  it('aborts when a listed file is missing from the clone, writing nothing', async () => {
    await write(clone, 'a.txt', 'A');

    await expect(
      landTracked({ cloneDir: clone, appDir: app, files: ['a.txt', 'gone.txt'], previous: null, limits: LIMITS })
    ).rejects.toThrow(/missing from the clone/);
    expect(await exists(path.join(app, 'a.txt'))).toBe(false);
  });

  it('refuses a clone path that runs through a symlinked directory', async () => {
    const elsewhere = path.join(root, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.writeFile(path.join(elsewhere, 'b.txt'), 'outside the clone');
    await link(elsewhere, path.join(clone, 'sub'));

    await expect(
      landTracked({ cloneDir: clone, appDir: app, files: ['sub/b.txt'], previous: null, limits: LIMITS })
    ).rejects.toThrow(/plain directories/);
    expect(await exists(path.join(app, 'sub'))).toBe(false);
  });

  it('refuses over-long names before writing anything', async () => {
    await write(clone, 'a.txt', 'A');
    const long = `${'x'.repeat(256)}.txt`;

    await expect(
      landTracked({ cloneDir: clone, appDir: app, files: ['a.txt', long], previous: null, limits: LIMITS })
    ).rejects.toThrow(/over-long/);
    expect(await exists(path.join(app, 'a.txt'))).toBe(false);
  });

  it('does not delete a file whose name differs only by case from one it just wrote (on a case-insensitive volume)', async () => {
    await write(app, 'probe-lower', 'x');
    const insensitive = await exists(path.join(app, 'PROBE-LOWER'));
    await fs.rm(path.join(app, 'probe-lower'));
    await write(app, 'README.md', 'old');
    await write(clone, 'readme.md', 'new');

    await landTracked({
      cloneDir: clone,
      appDir: app,
      files: ['readme.md'],
      previous: ['README.md'],
      limits: LIMITS,
    });

    const names = await fs.readdir(app);
    if (insensitive) {
      // One entry, holding the new content: the prune must not have removed it.
      expect(names.map((n) => n.toLowerCase())).toEqual(['readme.md']);
      expect(await fs.readFile(path.join(app, 'readme.md'), 'utf-8')).toBe('new');
    } else {
      expect(names).toEqual(['readme.md']);
    }
  });

  it('calls onCreatedAppDir only when this land created the folder', async () => {
    await write(clone, 'a.txt', 'A');
    const made = jest.fn();
    await landTracked({ cloneDir: clone, appDir: app, files: ['a.txt'], previous: null, limits: LIMITS, onCreatedAppDir: made });
    expect(made).not.toHaveBeenCalled();

    const fresh = path.join(root, 'fresh');
    await landTracked({ cloneDir: clone, appDir: fresh, files: ['a.txt'], previous: null, limits: LIMITS, onCreatedAppDir: made });
    expect(made).toHaveBeenCalledTimes(1);
  });

  it('refuses a repository over the entry or size caps before writing anything', async () => {
    await write(clone, 'a.txt', 'A');
    await write(clone, 'b.txt', 'B');

    await expect(
      landTracked({
        cloneDir: clone,
        appDir: app,
        files: ['a.txt', 'b.txt'],
        previous: null,
        limits: { maxBytes: 1024, maxEntries: 1 },
      })
    ).rejects.toThrow(/maximum of 1 entries/);
    await expect(
      landTracked({
        cloneDir: clone,
        appDir: app,
        files: ['a.txt', 'b.txt'],
        previous: null,
        limits: { maxBytes: 1, maxEntries: 100 },
      })
    ).rejects.toThrow(/checkout size/);

    expect(await exists(path.join(app, 'a.txt'))).toBe(false);
  });

  it('refuses unsafe tracked paths', async () => {
    for (const bad of ['../x', '.git/config', 'a/../b', 'sub/.GIT/x']) {
      await expect(
        landTracked({ cloneDir: clone, appDir: app, files: [bad], previous: null, limits: LIMITS })
      ).rejects.toThrow(/unsafe path/);
    }
  });

  it('refuses an app folder that is itself a symlink', async () => {
    const real = path.join(root, 'real');
    await fs.mkdir(real);
    const linked = path.join(root, 'linked-app');
    await link(real, linked);
    await write(clone, 'a.txt', 'A');

    await expect(
      landTracked({ cloneDir: clone, appDir: linked, files: ['a.txt'], previous: null, limits: LIMITS })
    ).rejects.toThrow(/symbolic link/);
    expect(await exists(path.join(real, 'a.txt'))).toBe(false);
  });
});

describe('manifest store', () => {
  it('round-trips, and treats a missing or corrupt file as "no manifest"', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-manifest-'));
    try {
      expect(await readManifest(dir, 'app')).toBeNull();
      await writeManifest(dir, 'app', ['a.txt', 'sub/b.txt']);
      expect(await readManifest(dir, 'app')).toEqual(['a.txt', 'sub/b.txt']);
      await fs.writeFile(path.join(dir, 'app.json'), '{not json');
      expect(await readManifest(dir, 'app')).toBeNull();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
