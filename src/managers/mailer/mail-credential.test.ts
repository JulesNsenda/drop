import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  MailCredentialStore,
  getMailCredentialStore,
  resetMailCredentialStore,
  clearMailCredential,
} from './mail-credential';

const itPosix = process.platform === 'win32' ? it.skip : it;

describe('MailCredentialStore', () => {
  let tmpDir: string;
  let credentialFilePath: string;
  let keyFilePath: string;
  let store: MailCredentialStore;
  const originalEnvPassword = process.env.DROP_SMTP_PASSWORD;

  async function writeValidKey(): Promise<void> {
    await fs.writeFile(keyFilePath, crypto.randomBytes(32).toString('hex'));
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-mail-credential-test-'));
    credentialFilePath = path.join(tmpDir, 'mail-credential.json');
    keyFilePath = path.join(tmpDir, 'encryption.key');
    store = new MailCredentialStore({ credentialFilePath, keyFilePath });
    delete process.env.DROP_SMTP_PASSWORD;
  });

  afterEach(async () => {
    if (originalEnvPassword === undefined) {
      delete process.env.DROP_SMTP_PASSWORD;
    } else {
      process.env.DROP_SMTP_PASSWORD = originalEnvPassword;
    }
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('round-trips a password through encryption with a valid key', async () => {
    await writeValidKey();

    await store.setMailPassword('super-secret-smtp-pass');
    const resolved = await store.resolveMailPassword();

    expect(resolved).toBe('super-secret-smtp-pass');
  });

  it('stores the password unreadable without the key (raw file is not the plaintext)', async () => {
    await writeValidKey();
    await store.setMailPassword('super-secret-smtp-pass');

    const raw = await fs.readFile(credentialFilePath, 'utf-8');
    expect(raw).not.toContain('super-secret-smtp-pass');

    const parsed = JSON.parse(raw);
    expect(parsed.password.ciphertext).toBeDefined();
    expect(parsed.password.iv).toBeDefined();
    expect(parsed.password.tag).toBeDefined();
  });

  it('refuses to store when the key file is absent', async () => {
    await expect(store.setMailPassword('whatever')).rejects.toThrow(/encryption\.key/);
  });

  it('refuses to store when the key is not 32 bytes', async () => {
    await fs.writeFile(keyFilePath, 'deadbeef'); // 4 bytes, too short
    await expect(store.setMailPassword('whatever')).rejects.toThrow(/encryption\.key/);
  });

  it('resolveMailPassword returns null when nothing is configured', async () => {
    expect(await store.resolveMailPassword()).toBeNull();
  });

  it('resolveMailPassword returns null when the key is absent (stored credential unreadable)', async () => {
    await writeValidKey();
    await store.setMailPassword('super-secret-smtp-pass');

    // Simulate the key going missing after the credential was stored.
    await fs.unlink(keyFilePath);

    expect(await store.resolveMailPassword()).toBeNull();
  });

  it('resolveMailPassword returns null when the key is the wrong length', async () => {
    await writeValidKey();
    await store.setMailPassword('super-secret-smtp-pass');

    await fs.writeFile(keyFilePath, 'deadbeef');

    expect(await store.resolveMailPassword()).toBeNull();
  });

  it('resolveMailPassword returns null (never throws) on a corrupt store file', async () => {
    await writeValidKey();
    await fs.mkdir(path.dirname(credentialFilePath), { recursive: true });
    await fs.writeFile(credentialFilePath, 'not valid json');

    expect(await store.resolveMailPassword()).toBeNull();
  });

  it('resolveMailPassword returns null (never throws) on an unexpected file shape', async () => {
    await writeValidKey();
    await fs.mkdir(path.dirname(credentialFilePath), { recursive: true });
    await fs.writeFile(credentialFilePath, JSON.stringify({ notPassword: 'oops' }));

    expect(await store.resolveMailPassword()).toBeNull();
  });

  it('resolveMailPassword returns null when decryption fails (wrong key)', async () => {
    await writeValidKey();
    await store.setMailPassword('super-secret-smtp-pass');

    // Overwrite the key with a different valid-length key — same length, wrong bytes.
    await fs.writeFile(keyFilePath, crypto.randomBytes(32).toString('hex'));

    expect(await store.resolveMailPassword()).toBeNull();
  });

  it('DROP_SMTP_PASSWORD env wins over a stored credential', async () => {
    await writeValidKey();
    await store.setMailPassword('stored-password');
    process.env.DROP_SMTP_PASSWORD = 'env-password';

    expect(await store.resolveMailPassword()).toBe('env-password');
  });

  it('DROP_SMTP_PASSWORD env works even with no key file at all', async () => {
    process.env.DROP_SMTP_PASSWORD = 'env-password';
    expect(await store.resolveMailPassword()).toBe('env-password');
  });

  it('DROP_SMTP_PASSWORD env is never persisted to disk', async () => {
    process.env.DROP_SMTP_PASSWORD = 'env-password';
    await store.resolveMailPassword();

    await expect(fs.access(credentialFilePath)).rejects.toThrow();
  });

  it('clear() removes a stored credential', async () => {
    await writeValidKey();
    await store.setMailPassword('super-secret-smtp-pass');

    await store.clear();

    expect(await store.resolveMailPassword()).toBeNull();
    await expect(fs.access(credentialFilePath)).rejects.toThrow();
  });

  it('clear() is a no-op (does not throw) when nothing is stored', async () => {
    await expect(store.clear()).resolves.toBeUndefined();
  });

  itPosix('writes mail-credential.json with mode 0600', async () => {
    await writeValidKey();
    await store.setMailPassword('super-secret-smtp-pass');

    const stats = await fs.stat(credentialFilePath);
    expect(stats.mode & 0o777).toBe(0o600);
  });
});

// Exercises the actual exported wrapper `settings-manager.ts`'s
// `setMailSettings()` calls (`clearMailCredential()`), through the singleton
// (`getMailCredentialStore()`) rather than a directly-constructed instance —
// the class-level tests above never touch either.
describe('clearMailCredential (singleton wrapper)', () => {
  let tmpDir: string;
  let credentialFilePath: string;
  let keyFilePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-mail-credential-singleton-test-'));
    credentialFilePath = path.join(tmpDir, 'mail-credential.json');
    keyFilePath = path.join(tmpDir, 'encryption.key');
    resetMailCredentialStore();
    getMailCredentialStore({ credentialFilePath, keyFilePath });
  });

  afterEach(async () => {
    resetMailCredentialStore();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('clears the credential the singleton is holding', async () => {
    await fs.writeFile(keyFilePath, crypto.randomBytes(32).toString('hex'));
    await getMailCredentialStore().setMailPassword('super-secret-smtp-pass');
    expect(await getMailCredentialStore().resolveMailPassword()).toBe('super-secret-smtp-pass');

    await clearMailCredential();

    expect(await getMailCredentialStore().resolveMailPassword()).toBeNull();
    await expect(fs.access(credentialFilePath)).rejects.toThrow();
  });

  it('is a no-op (does not throw) when nothing is stored', async () => {
    await expect(clearMailCredential()).resolves.toBeUndefined();
  });
});
