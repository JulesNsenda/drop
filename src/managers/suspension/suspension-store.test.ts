import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  SuspensionStore,
  SuspensionStoreCorruptError,
  getSuspensionStore,
  resetSuspensionStore,
} from './suspension-store';

describe('SuspensionStore', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-suspension-'));
    file = path.join(dir, 'data', 'drop-svc', 'suspensions.json');
  });

  afterEach(async () => {
    resetSuspensionStore();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('starts empty when the file does not exist', async () => {
    const store = new SuspensionStore(file);
    await store.load();
    expect(store.isCorrupt()).toBe(false);
    expect(store.isSuspended('shop')).toBe(false);
  });

  it('persists a suspension and reloads it', async () => {
    const store = new SuspensionStore(file);
    await store.load();
    const record = await store.suspend('shop', 'admin-1', 'abuse');
    expect(record).toMatchObject({ by: 'admin-1', reason: 'abuse' });
    expect(store.isSuspended('shop')).toBe(true);

    const reloaded = new SuspensionStore(file);
    await reloaded.load();
    expect(reloaded.isSuspended('shop')).toBe(true);
    expect(reloaded.get('shop')).toMatchObject({ by: 'admin-1', reason: 'abuse' });
    expect(reloaded.isSuspended('other')).toBe(false);
  });

  it('lifts a suspension on disk and in memory', async () => {
    const store = new SuspensionStore(file);
    await store.load();
    await store.suspend('shop', 'admin-1');
    expect(await store.unsuspend('shop')).toBe(true);
    expect(store.isSuspended('shop')).toBe(false);
    expect(await store.unsuspend('shop')).toBe(false);

    const reloaded = new SuspensionStore(file);
    await reloaded.load();
    expect(reloaded.isSuspended('shop')).toBe(false);
  });

  it('does not treat inherited object members as suspended names', async () => {
    const store = new SuspensionStore(file);
    await store.load();
    await store.suspend('shop', 'admin-1');
    expect(store.isSuspended('constructor')).toBe(false);
    expect(store.isSuspended('__proto__')).toBe(false);
    expect(store.isSuspended('toString')).toBe(false);
  });

  it('fails closed on a corrupt file: every app is suspended and writes refuse', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ not json');

    const store = new SuspensionStore(file);
    await store.load();
    expect(store.isCorrupt()).toBe(true);
    expect(store.isSuspended('anything')).toBe(true);
    await expect(store.suspend('shop', 'admin-1')).rejects.toBeInstanceOf(SuspensionStoreCorruptError);
    await expect(store.unsuspend('shop')).rejects.toBeInstanceOf(SuspensionStoreCorruptError);
    // The unreadable bytes are left alone.
    expect(await fs.readFile(file, 'utf-8')).toBe('{ not json');
  });

  it('fails closed on a malformed row rather than dropping it', async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ shop: { at: 'x', by: 'a' }, bad: { at: 1 } }));

    const store = new SuspensionStore(file);
    await store.load();
    expect(store.isCorrupt()).toBe(true);
    expect(store.isSuspended('shop')).toBe(true);
    expect(store.isSuspended('unrelated')).toBe(true);
  });

  it('fails closed when the path is unreadable for a reason other than absence', async () => {
    // A directory where the file should be: readFile fails with EISDIR, not ENOENT.
    await fs.mkdir(file, { recursive: true });
    const store = new SuspensionStore(file);
    await store.load();
    expect(store.isCorrupt()).toBe(true);
    expect(store.isSuspended('anything')).toBe(true);
  });

  it('keeps the app suspended in memory when the write fails, and keeps it suspended on a failed unsuspend', async () => {
    const store = new SuspensionStore(file);
    await store.load();
    await store.suspend('shop', 'admin-1');

    // Replace the file with a directory so the atomic rename fails.
    await fs.rm(file);
    await fs.mkdir(file);
    await expect(store.unsuspend('shop')).rejects.toBeDefined();
    expect(store.isSuspended('shop')).toBe(true);

    await expect(store.suspend('other', 'admin-1')).rejects.toBeDefined();
    expect(store.isSuspended('other')).toBe(true);
  });

  it('singleton binds on first use and resets', async () => {
    const a = getSuspensionStore(file);
    expect(getSuspensionStore()).toBe(a);
    resetSuspensionStore();
    expect(getSuspensionStore(file)).not.toBe(a);
  });
});
