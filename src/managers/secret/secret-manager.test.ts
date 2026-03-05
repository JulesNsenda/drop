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
    await fs.rm(tmpDir, { recursive: true, force: true });
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
});
