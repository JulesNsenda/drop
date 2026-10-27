/**
 * A rollback snapshot never carries repository metadata: restoring one must
 * not put a tenant-writable `.git` back into the app folder.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { RollbackStore } from './rollback-store';
import { gitManifestDir, gitManifestPath } from '../../core/git-deploy/land';
import * as diskUtils from '../../utils/disk';

describe('RollbackStore snapshots exclude .git', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-rollback-vcs-'));
    jest.spyOn(diskUtils, 'hasEnoughDisk').mockResolvedValue({ ok: true, freeMb: 999999 });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('copies the code but not .git, at any depth', async () => {
    const appPath = path.join(root, 'data', 'webapps', 'web');
    await fs.mkdir(path.join(appPath, '.git'), { recursive: true });
    await fs.mkdir(path.join(appPath, 'sub', '.git'), { recursive: true });
    await fs.writeFile(path.join(appPath, '.git', 'config'), '[core]');
    await fs.writeFile(path.join(appPath, 'sub', '.git', 'config'), '[core]');
    await fs.writeFile(path.join(appPath, 'index.js'), 'v1');
    await fs.writeFile(path.join(appPath, 'sub', 'b.js'), 'b');

    const store = new RollbackStore(root);
    const result = await store.capture('web', appPath);
    expect(result.captured).toBe(true);

    const tree = path.join(root, 'data', 'rollback', 'web', 'tree');
    expect(await fs.readFile(path.join(tree, 'index.js'), 'utf-8')).toBe('v1');
    expect(await fs.readFile(path.join(tree, 'sub', 'b.js'), 'utf-8')).toBe('b');
    await expect(fs.lstat(path.join(tree, '.git'))).rejects.toThrow();
    await expect(fs.lstat(path.join(tree, 'sub', '.git'))).rejects.toThrow();
  });

  it('snapshots the saved git file list and the commit with the tree, and restores both', async () => {
    const appPath = path.join(root, 'data', 'webapps', 'web');
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.js'), 'v1');
    const manifest = gitManifestPath(gitManifestDir(path.join(root, 'data')), 'web');
    await fs.mkdir(path.dirname(manifest), { recursive: true });
    await fs.writeFile(manifest, '{"version":2,"files":{"index.js":"aaa"}}');
    const store = new RollbackStore(root);
    const captured = await store.capture('web', appPath, { gitCommit: 'c0ffee' });
    expect(captured.captured && captured.meta.gitCommit).toBe('c0ffee');

    // The redeploy that follows rewrites the list.
    await fs.writeFile(manifest, '{"version":2,"files":{"index.js":"bbb","new.js":"ccc"}}');
    await store.restoreInto('web', appPath);

    expect(JSON.parse(await fs.readFile(manifest, 'utf-8')).files).toEqual({ 'index.js': 'aaa' });
  });

  it('a restore of a snapshot taken with no saved list drops the live list', async () => {
    const appPath = path.join(root, 'data', 'webapps', 'web');
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.js'), 'v1');
    const store = new RollbackStore(root);
    await store.capture('web', appPath);
    const manifest = gitManifestPath(gitManifestDir(path.join(root, 'data')), 'web');
    await fs.mkdir(path.dirname(manifest), { recursive: true });
    await fs.writeFile(manifest, '{"version":2,"files":{"x":"y"}}');

    await store.restoreInto('web', appPath);

    await expect(fs.lstat(manifest)).rejects.toThrow();
  });

  it('a restore filters a .git from an older snapshot', async () => {
    const appPath = path.join(root, 'data', 'webapps', 'web');
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.js'), 'v1');
    const store = new RollbackStore(root);
    await store.capture('web', appPath);
    // A snapshot from before snapshots excluded .git.
    const tree = path.join(root, 'data', 'rollback', 'web', 'tree');
    await fs.mkdir(path.join(tree, '.git'), { recursive: true });
    await fs.writeFile(path.join(tree, '.git', 'config'), '[core]');

    await store.restoreInto('web', appPath);

    expect(await fs.readFile(path.join(appPath, 'index.js'), 'utf-8')).toBe('v1');
    await expect(fs.lstat(path.join(appPath, '.git'))).rejects.toThrow();
  });
});
