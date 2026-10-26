/**
 * RollbackStore (#296) against the real filesystem.
 *
 * The properties that matter: a restore reproduces the captured tree exactly,
 * symlinks included (node_modules/.bin is nothing but links); it never writes
 * THROUGH a link planted in the tree being replaced; a snapshot that would not
 * fit under the disk ceiling is dropped rather than kept stale; and nothing
 * here ever throws on the deploy path.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  RollbackStore,
  NoRollbackSnapshotError,
  initRollbackStore,
  resetRollbackStore,
  captureBeforeRedeploy,
} from './rollback-store';
import { getStateManager, resetStateManager } from '../app/state-manager';
import * as diskUtils from '../../utils/disk';

describe('RollbackStore', () => {
  let root: string;
  let appPath: string;
  let store: RollbackStore;

  const read = (p: string) => fs.readFile(p, 'utf-8');

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-rollback-'));
    appPath = path.join(root, 'data', 'webapps', 'web');
    await fs.mkdir(path.join(appPath, 'node_modules', '.bin'), { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.js'), 'v1');
    await fs.writeFile(path.join(appPath, 'node_modules', 'tool.js'), 'tool');
    await fs.symlink('../tool.js', path.join(appPath, 'node_modules', '.bin', 'tool'));
    store = new RollbackStore(root);
    jest.spyOn(diskUtils, 'hasEnoughDisk').mockResolvedValue({ ok: true, freeMb: 999999 });
  });

  afterEach(async () => {
    delete process.env.DROP_MAX_APP_DISK_MB;
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('restores the captured tree exactly, symlinks as symlinks', async () => {
    const captured = await store.capture('web', appPath, { outputDirectory: 'dist' });
    expect(captured.captured).toBe(true);

    // The bad deploy: changed, added and removed files.
    await fs.writeFile(path.join(appPath, 'index.js'), 'v2-broken');
    await fs.writeFile(path.join(appPath, 'new.js'), 'only in v2');
    await fs.rm(path.join(appPath, 'node_modules'), { recursive: true });

    const meta = await store.restoreInto('web', appPath);

    expect(meta.outputDirectory).toBe('dist');
    expect(await read(path.join(appPath, 'index.js'))).toBe('v1');
    await expect(fs.access(path.join(appPath, 'new.js'))).rejects.toThrow();
    const link = path.join(appPath, 'node_modules', '.bin', 'tool');
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(link)).toBe('../tool.js');
    expect(await read(link)).toBe('tool');
  });

  it('keeps the snapshot, so a second rollback is a no-op rather than an error', async () => {
    await store.capture('web', appPath);
    await store.restoreInto('web', appPath);
    await fs.writeFile(path.join(appPath, 'index.js'), 'drifted');

    await store.restoreInto('web', appPath);

    expect(await read(path.join(appPath, 'index.js'))).toBe('v1');
  });

  it('never writes through a symlink planted in the tree it replaces', async () => {
    await fs.mkdir(path.join(appPath, 'dist'));
    await fs.writeFile(path.join(appPath, 'dist', 'index.html'), 'good');
    await store.capture('web', appPath);

    // The bad deploy turns `dist` into a link pointing outside the app.
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'index.html'), 'untouched');
    await fs.rm(path.join(appPath, 'dist'), { recursive: true });
    await fs.symlink(outside, path.join(appPath, 'dist'));

    await store.restoreInto('web', appPath);

    expect(await read(path.join(outside, 'index.html'))).toBe('untouched');
    expect((await fs.lstat(path.join(appPath, 'dist'))).isDirectory()).toBe(true);
    expect(await read(path.join(appPath, 'dist', 'index.html'))).toBe('good');
  });

  it('refuses to restore when nothing was captured', async () => {
    await expect(store.restoreInto('web', appPath)).rejects.toBeInstanceOf(NoRollbackSnapshotError);
    expect(await store.get('web')).toBeNull();
  });

  it('drops (never keeps stale) a snapshot that would not fit under the ceiling', async () => {
    await store.capture('web', appPath);
    expect(await store.get('web')).not.toBeNull();

    await fs.writeFile(path.join(appPath, 'big.bin'), Buffer.alloc(700 * 1024));
    process.env.DROP_MAX_APP_DISK_MB = '1'; // tree ~700 KB: tree x2 > 1 MB

    const result = await store.capture('web', appPath);

    expect(result).toEqual({ captured: false, reason: expect.stringContaining('disk ceiling') });
    expect(await store.get('web')).toBeNull();
  });

  it('charges the app data dir against the ceiling too', async () => {
    const data = path.join(root, 'data', 'appdata', 'web');
    await fs.mkdir(data, { recursive: true });
    // Tree 40 KB, data 960 KB: either alone fits in 1 MB, and so does tree +
    // data, but tree + data + the snapshot's copy of the tree does not.
    await fs.writeFile(path.join(appPath, 'bundle.js'), Buffer.alloc(40 * 1024));
    await fs.writeFile(path.join(data, 'db.sqlite'), Buffer.alloc(960 * 1024));

    expect((await store.capture('web', appPath, { maxDiskMb: 1 })).captured).toBe(false);
    // The same tree with no data does fit — so the refusal above was the data.
    await fs.rm(data, { recursive: true });
    expect((await store.capture('web', appPath, { maxDiskMb: 1 })).captured).toBe(true);
  });

  it('does not snapshot when the host is low on disk', async () => {
    jest.spyOn(diskUtils, 'hasEnoughDisk').mockResolvedValue({ ok: false, freeMb: 10 });

    const result = await store.capture('web', appPath);

    expect(result).toEqual({ captured: false, reason: 'the host is low on free disk' });
  });

  it('rejects an app name that could escape the snapshot root', () => {
    expect(() => store.dirFor('../etc')).toThrow('Invalid app name');
  });

  it('serializes a capture and a restore of the same app', async () => {
    await store.capture('web', appPath);
    await fs.writeFile(path.join(appPath, 'index.js'), 'v2');

    // Queued behind the capture, so the restore sees the NEW snapshot (v2).
    const capture = store.capture('web', appPath);
    const restore = store.restoreInto('web', appPath);
    await Promise.all([capture, restore]);

    expect(await read(path.join(appPath, 'index.js'))).toBe('v2');
  });

  it('remove() forgets the snapshot', async () => {
    await store.capture('web', appPath);
    await store.remove('web');
    expect(await store.get('web')).toBeNull();
  });
});

describe('captureBeforeRedeploy', () => {
  let root: string;
  let appPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-rollback-hook-'));
    appPath = path.join(root, 'data', 'webapps', 'web');
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.js'), 'v1');
    jest.spyOn(diskUtils, 'hasEnoughDisk').mockResolvedValue({ ok: true, freeMb: 999999 });
    resetStateManager();
    getStateManager({ stateFilePath: path.join(root, 'apps.json') });
    await getStateManager().registerApp('web', appPath);
  });

  afterEach(async () => {
    resetRollbackStore();
    await getStateManager().close();
    resetStateManager();
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('is a quiet no-op when no store is configured', async () => {
    expect(await captureBeforeRedeploy('web')).toEqual({
      captured: false,
      reason: 'rollback is not configured',
    });
  });

  it('captures only the tree that is SERVING', async () => {
    const store = initRollbackStore(root);

    await getStateManager().updateApp('web', { status: 'errored' });
    expect((await captureBeforeRedeploy('web')).captured).toBe(false);
    expect(await store.get('web')).toBeNull();

    await getStateManager().updateApp('web', { status: 'running' });
    expect((await captureBeforeRedeploy('web')).captured).toBe(true);
    expect(await store.get('web')).toEqual(expect.objectContaining({ appName: 'web' }));
  });

  it('never throws, even for an unknown app', async () => {
    initRollbackStore(root);
    await expect(captureBeforeRedeploy('nope')).resolves.toEqual({
      captured: false,
      reason: 'unknown app',
    });
  });
});
