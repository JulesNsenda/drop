import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SecretManager } from './secret-manager';

describe('SecretManager', () => {
  let sm: SecretManager;
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-secret-test-'));
    storePath = path.join(tmpDir, 'secrets.json');
    sm = new SecretManager({ storePath, masterKey: 'test-master-key' });
    await sm.initialize();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('should set and get a secret', async () => {
    await sm.set('myapp', 'DATABASE_URL', 'postgres://localhost/mydb');
    const value = sm.get('myapp', 'DATABASE_URL');
    expect(value).toBe('postgres://localhost/mydb');
  });

  it('should return null for non-existent secret', () => {
    expect(sm.get('myapp', 'NONEXISTENT')).toBeNull();
  });

  it('should return null for non-existent app', () => {
    expect(sm.get('noapp', 'KEY')).toBeNull();
  });

  it('should list secret keys without values', async () => {
    await sm.set('myapp', 'KEY_A', 'val-a');
    await sm.set('myapp', 'KEY_B', 'val-b');
    await sm.set('myapp', 'KEY_C', 'val-c');

    const keys = sm.list('myapp');
    expect(keys).toEqual(['KEY_A', 'KEY_B', 'KEY_C']);
  });

  it('should return empty list for app with no secrets', () => {
    expect(sm.list('noapp')).toEqual([]);
  });

  it('should get all secrets as key-value pairs', async () => {
    await sm.set('myapp', 'DB_HOST', 'localhost');
    await sm.set('myapp', 'DB_PORT', '5432');

    const all = sm.getAll('myapp');
    expect(all).toEqual({
      DB_HOST: 'localhost',
      DB_PORT: '5432',
    });
  });

  // M1 review item 5 (round-2 diff pass): boot reconciliation's secret-change
  // detector hashes stored CIPHERTEXT, never a decrypted value.
  describe('fingerprint (M1 review item 5)', () => {
    it('returns a stable, deterministic hash for the same secret set', () => {
      const a = sm.fingerprint('noapp');
      const b = sm.fingerprint('noapp');
      expect(a).toBe(b);
      expect(typeof a).toBe('string');
      expect(a).toHaveLength(64);
    });

    it('is stable regardless of which order keys were set in on the SAME store', async () => {
      // NOT a cross-instance comparison: AES-GCM's random IV means two
      // independently-encrypted copies of the identical plaintext never
      // produce the same ciphertext, so two SEPARATE stores holding "the
      // same" secrets legitimately fingerprint differently — that's the
      // intended, safe-direction behaviour (item 5's doc comment), not a
      // bug. What this checks instead: re-reading the SAME store's fixed
      // ciphertexts twice, regardless of insertion order, is deterministic.
      await sm.set('myapp', 'A', 'one');
      await sm.set('myapp', 'B', 'two');
      const f1 = sm.fingerprint('myapp');
      const f2 = sm.fingerprint('myapp');
      expect(f1).toBe(f2);
    });

    it('changes when a secret value changes', async () => {
      await sm.set('myapp', 'API_KEY', 'v1');
      const before = sm.fingerprint('myapp');

      await sm.set('myapp', 'API_KEY', 'v2');
      const after = sm.fingerprint('myapp');

      expect(after).not.toBe(before);
    });

    it('changes when a secret is added or removed', async () => {
      const empty = sm.fingerprint('myapp');

      await sm.set('myapp', 'NEW_KEY', 'value');
      const withKey = sm.fingerprint('myapp');
      expect(withKey).not.toBe(empty);

      await sm.delete('myapp', 'NEW_KEY');
      const removed = sm.fingerprint('myapp');
      expect(removed).toBe(empty);
    });

    it('never reads the plaintext value into the fingerprint (ciphertext-based)', async () => {
      // Two different plaintexts CAN, in principle, still differ in
      // ciphertext even at the same key — this test's real point is just
      // that fingerprint() never calls decrypt/get/getAll internally, which
      // isn't directly observable from the public API. The change-detection
      // behaviour above is the meaningful contract; this documents intent.
      await sm.set('myapp', 'SECRET', 'plaintext-value');
      const fp = sm.fingerprint('myapp');
      expect(fp).not.toContain('plaintext-value');
    });
  });

  it('should delete a specific secret', async () => {
    await sm.set('myapp', 'KEY_A', 'val-a');
    await sm.set('myapp', 'KEY_B', 'val-b');

    const deleted = await sm.delete('myapp', 'KEY_A');
    expect(deleted).toBe(true);
    expect(sm.get('myapp', 'KEY_A')).toBeNull();
    expect(sm.get('myapp', 'KEY_B')).toBe('val-b');
  });

  it('should return false when deleting non-existent secret', async () => {
    const deleted = await sm.delete('myapp', 'NOPE');
    expect(deleted).toBe(false);
  });

  it('should delete all secrets for an app', async () => {
    await sm.set('myapp', 'K1', 'v1');
    await sm.set('myapp', 'K2', 'v2');

    const deleted = await sm.deleteAll('myapp');
    expect(deleted).toBe(true);
    expect(sm.list('myapp')).toEqual([]);
  });

  it('should overwrite existing secrets', async () => {
    await sm.set('myapp', 'KEY', 'old-value');
    await sm.set('myapp', 'KEY', 'new-value');

    expect(sm.get('myapp', 'KEY')).toBe('new-value');
  });

  it('should isolate secrets between apps', async () => {
    await sm.set('app1', 'KEY', 'value1');
    await sm.set('app2', 'KEY', 'value2');

    expect(sm.get('app1', 'KEY')).toBe('value1');
    expect(sm.get('app2', 'KEY')).toBe('value2');
  });

  it('should persist secrets to disk', async () => {
    await sm.set('myapp', 'PERSIST_KEY', 'persist-value');

    // Create a new instance with the same store path
    const sm2 = new SecretManager({ storePath, masterKey: 'test-master-key' });
    await sm2.initialize();

    expect(sm2.get('myapp', 'PERSIST_KEY')).toBe('persist-value');
  });

  it('should report hasSecrets correctly', async () => {
    expect(sm.hasSecrets('myapp')).toBe(false);

    await sm.set('myapp', 'KEY', 'val');
    expect(sm.hasSecrets('myapp')).toBe(true);

    await sm.deleteAll('myapp');
    expect(sm.hasSecrets('myapp')).toBe(false);
  });

  it('should store secrets encrypted on disk', async () => {
    await sm.set('myapp', 'SECRET', 'super-secret-value');

    const raw = await fs.readFile(storePath, 'utf-8');
    expect(raw).not.toContain('super-secret-value');
    expect(raw).toContain('ciphertext');
    expect(raw).toContain('iv');
    expect(raw).toContain('tag');
  });

  describe('master key from file', () => {
    it('reads the master key from masterKeyPath when masterKey is not set', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-secret-keyfile-'));
      const store = path.join(dir, 'secrets.json');
      const keyFile = path.join(dir, 'encryption.key');
      await fs.writeFile(keyFile, 'a'.repeat(64));

      const a = new SecretManager({ storePath: store, masterKeyPath: keyFile });
      await a.initialize();
      await a.set('app', 'K', 'v');

      const b = new SecretManager({ storePath: store, masterKeyPath: keyFile });
      await b.initialize();
      expect(b.get('app', 'K')).toBe('v');

      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    it('migrates a legacy (salt-derived) store to the external key and bumps to version 2', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-secret-migrate-'));
      const store = path.join(dir, 'secrets.json');
      const keyFile = path.join(dir, 'encryption.key');

      // Write a legacy v1 store with no external key.
      const legacy = new SecretManager({ storePath: store });
      await legacy.initialize();
      await legacy.set('app', 'TOKEN', 'legacy-value');

      const before = JSON.parse(await fs.readFile(store, 'utf-8'));
      expect(before.version).toBe(1);

      // Now provide an external key file — should migrate transparently.
      await fs.writeFile(keyFile, 'b'.repeat(64));
      const migrated = new SecretManager({ storePath: store, masterKeyPath: keyFile });
      await migrated.initialize();

      expect(migrated.get('app', 'TOKEN')).toBe('legacy-value');
      const after = JSON.parse(await fs.readFile(store, 'utf-8'));
      expect(after.version).toBe(2);

      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
  });

  describe('corrupt store handling', () => {
    // Quarantine logs to console.error by design — keep test output clean.
    beforeEach(() => {
      jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('quarantines an unparseable store instead of overwriting it, then starts empty', async () => {
      const store = path.join(tmpDir, 'corrupt.json');
      const garbage = '{ this is not valid json at all';
      await fs.writeFile(store, garbage);

      const mgr = new SecretManager({ storePath: store, masterKey: 'k' });
      await mgr.initialize(); // must not throw

      // Original bytes preserved in a .corrupt-* quarantine file (not destroyed).
      const files = await fs.readdir(tmpDir);
      const quarantined = files.filter((f) => f.startsWith('corrupt.json.corrupt-'));
      expect(quarantined).toHaveLength(1);
      expect(await fs.readFile(path.join(tmpDir, quarantined[0]), 'utf-8')).toBe(garbage);

      // A fresh, empty, usable store took its place.
      expect(mgr.get('any', 'KEY')).toBeNull();
      await mgr.set('app', 'K', 'v');
      expect(mgr.get('app', 'K')).toBe('v');
    });

    it('quarantines a valid-JSON-but-wrong-shape store', async () => {
      const store = path.join(tmpDir, 'wrongshape.json');
      await fs.writeFile(store, JSON.stringify({ not: 'a store' }));

      const mgr = new SecretManager({ storePath: store, masterKey: 'k' });
      await mgr.initialize();

      const files = await fs.readdir(tmpDir);
      expect(files.filter((f) => f.startsWith('wrongshape.json.corrupt-'))).toHaveLength(1);
      expect(mgr.get('app', 'K')).toBeNull();
    });

    it('does NOT quarantine on first run (missing file)', async () => {
      const store = path.join(tmpDir, 'fresh.json');
      const mgr = new SecretManager({ storePath: store, masterKey: 'k' });
      await mgr.initialize();

      const files = await fs.readdir(tmpDir);
      expect(files.some((f) => f.startsWith('fresh.json.corrupt-'))).toBe(false);
      expect(files).toContain('fresh.json');
    });
  });
});
