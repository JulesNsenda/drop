/**
 * ReleaseStore (#298 step 3), against the real filesystem.
 *
 * What matters: a release holds the source MINUS what the build reinstalls
 * (and minus VCS metadata), with build output and links kept; and nothing
 * outside `data/releases/<app>/<one segment>` is ever accepted as a release,
 * because a release path becomes a runtime's working directory.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ReleaseStore, wantsReleases } from './release-store';

describe('ReleaseStore', () => {
  let root: string;
  let source: string;
  let store: ReleaseStore;

  const exists = (p: string) => fs.access(p).then(() => true, () => false);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-releases-'));
    source = path.join(root, 'data', 'webapps', 'web');
    await fs.mkdir(path.join(source, 'dist'), { recursive: true });
    await fs.mkdir(path.join(source, 'node_modules', 'x'), { recursive: true });
    await fs.mkdir(path.join(source, 'packages', 'a', 'node_modules'), { recursive: true });
    await fs.mkdir(path.join(source, '.git'), { recursive: true });
    await fs.mkdir(path.join(source, '.venv'), { recursive: true });
    await fs.writeFile(path.join(source, 'index.js'), 'v1');
    await fs.writeFile(path.join(source, 'dist', 'index.html'), 'built');
    await fs.writeFile(path.join(source, 'node_modules', 'x', 'i.js'), 'dep');
    await fs.writeFile(path.join(source, '.git', 'HEAD'), 'ref');
    await fs.symlink('index.js', path.join(source, 'link.js'));
    store = new ReleaseStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  describe('stage', () => {
    it('copies the source minus .git, node_modules (any depth) and .venv; keeps build output and links', async () => {
      const release = await store.stage('web', source, 'd1');

      expect(release).toBe(path.join(root, 'data', 'releases', 'web', 'd1'));
      expect(await fs.readFile(path.join(release, 'index.js'), 'utf-8')).toBe('v1');
      // Shipped build output is the app's to ship.
      expect(await fs.readFile(path.join(release, 'dist', 'index.html'), 'utf-8')).toBe('built');
      expect(await exists(path.join(release, 'node_modules'))).toBe(false);
      expect(await exists(path.join(release, 'packages', 'a', 'node_modules'))).toBe(false);
      expect(await exists(path.join(release, 'packages', 'a'))).toBe(true);
      expect(await exists(path.join(release, '.git'))).toBe(false);
      expect(await exists(path.join(release, '.venv'))).toBe(false);
      const link = path.join(release, 'link.js');
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(link)).toBe('index.js');
    });

    it('never alters the source', async () => {
      await store.stage('web', source, 'd1');
      expect(await exists(path.join(source, 'node_modules', 'x', 'i.js'))).toBe(true);
      expect(await exists(path.join(source, '.git', 'HEAD'))).toBe(true);
    });

    it('rejects a release id that could escape its directory', async () => {
      await expect(store.stage('web', source, '../evil')).rejects.toThrow('Invalid release id');
    });
  });

  describe('isReleasePathOf', () => {
    it('accepts exactly one directory directly under the app root', () => {
      const releases = path.join(root, 'data', 'releases');
      expect(store.isReleasePathOf('web', path.join(releases, 'web', 'd1'))).toBe(true);

      expect(store.isReleasePathOf('web', undefined)).toBe(false);
      expect(store.isReleasePathOf('web', path.join(releases, 'web'))).toBe(false);
      expect(store.isReleasePathOf('web', path.join(releases, 'web', 'd1', 'nested'))).toBe(false);
      expect(store.isReleasePathOf('web', path.join(releases, 'other', 'd1'))).toBe(false);
      expect(store.isReleasePathOf('web', path.join(releases, 'web', '..', 'other', 'd1'))).toBe(false);
      expect(store.isReleasePathOf('web', '/etc')).toBe(false);
      expect(store.isReleasePathOf('web', source)).toBe(false);
      expect(store.isReleasePathOf('../x', path.join(releases, 'web', 'd1'))).toBe(false);
    });
  });

  it('prune keeps only the listed releases', async () => {
    const a = await store.stage('web', source, 'a');
    const b = await store.stage('web', source, 'b');
    const c = await store.stage('web', source, 'c');

    await store.prune('web', [b, undefined, c]);

    expect(await exists(a)).toBe(false);
    expect(await exists(b)).toBe(true);
    expect(await exists(c)).toBe(true);
  });

  it('discard refuses anything that is not one of the app\'s releases', async () => {
    const outside = path.join(root, 'keep-me');
    await fs.mkdir(outside);

    await store.discard('web', outside);
    await store.discard('web', source);

    expect(await exists(outside)).toBe(true);
    expect(await exists(source)).toBe(true);
  });
});

describe('wantsReleases', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-wants-releases-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('is true only for deploy.strategy: zero-downtime', async () => {
    expect(await wantsReleases(dir)).toBe(false);

    await fs.writeFile(path.join(dir, 'drop.yaml'), 'deploy:\n  strategy: in-place\n');
    expect(await wantsReleases(dir)).toBe(false);

    await fs.writeFile(path.join(dir, 'drop.yaml'), 'deploy:\n  strategy: zero-downtime\n');
    expect(await wantsReleases(dir)).toBe(true);
  });

  it('is false (never throws) for an invalid manifest', async () => {
    await fs.writeFile(path.join(dir, 'drop.yaml'), 'deploy:\n  strategy: yolo\n');
    expect(await wantsReleases(dir)).toBe(false);
  });
});
