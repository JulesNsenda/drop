/**
 * The operator's AWS admin credential for object storage (#301), at rest.
 *
 * Same posture as the SMTP password (`mailer/mail-credential.ts`): its own
 * 0600 file, AES-256-GCM under the platform `encryption.key`, never read back
 * by any route (status reports a boolean), never cached in memory, and a
 * refusal — never a plaintext fallback — when the key is absent.
 *
 * `DROP_S3_ADMIN_ACCESS_KEY_ID` + `DROP_S3_ADMIN_SECRET_ACCESS_KEY` in the
 * environment take precedence and are never persisted. Unlike the SMTP
 * password they need no host binding: the provider is AWS-only, so there is
 * no admin-settable endpoint an env credential could be pulled toward.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { writeJsonAtomic } from '../../utils/atomic-write';
import { encrypt, decrypt, loadPlatformMasterKey, EncryptedData } from '../secret/encryption';

const isWindows = process.platform === 'win32';
const DEFAULT_DROP_ROOT = isWindows ? 'C:\\drop' : '/var/drop';

function dropSvcDir(): string {
  return path.join(process.env.DROP_ROOT || DEFAULT_DROP_ROOT, 'data', 'drop-svc');
}

export interface StorageAdminCredential {
  accessKeyId: string;
  secretAccessKey: string;
}

interface CredentialFile {
  accessKeyId: EncryptedData;
  secretAccessKey: EncryptedData;
}

function isEncrypted(value: unknown): value is EncryptedData {
  const v = value as Record<string, unknown> | null;
  return !!v && typeof v.ciphertext === 'string' && typeof v.iv === 'string' && typeof v.tag === 'string';
}

export interface StorageCredentialStoreConfig {
  credentialFilePath?: string;
  keyFilePath?: string;
}

export class StorageCredentialStore {
  private readonly credentialFilePath: string;
  private readonly keyFilePath: string;

  constructor(config?: StorageCredentialStoreConfig) {
    this.credentialFilePath =
      config?.credentialFilePath || path.join(dropSvcDir(), 'object-storage-credential.json');
    this.keyFilePath = config?.keyFilePath || path.join(dropSvcDir(), 'encryption.key');
  }

  /** Persist the admin key pair, encrypted. Throws when the platform key is unusable. */
  async set(credential: StorageAdminCredential): Promise<void> {
    const key = await loadPlatformMasterKey(this.keyFilePath);
    if (!key) {
      throw new Error('encryption.key is absent or not 32 bytes — refusing to store the storage credential');
    }
    const file: CredentialFile = {
      accessKeyId: encrypt(credential.accessKeyId, key),
      secretAccessKey: encrypt(credential.secretAccessKey, key),
    };
    await fs.mkdir(path.dirname(this.credentialFilePath), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(this.credentialFilePath, file, { mode: 0o600 });
  }

  /**
   * The credential to act with: the env pair when both halves are set, else
   * the stored one. Null (never throws) when there is none or it cannot be
   * decrypted. NEVER put the result in a response.
   */
  async resolve(): Promise<StorageAdminCredential | null> {
    const envId = process.env.DROP_S3_ADMIN_ACCESS_KEY_ID;
    const envSecret = process.env.DROP_S3_ADMIN_SECRET_ACCESS_KEY;
    if (envId && envSecret) return { accessKeyId: envId, secretAccessKey: envSecret };

    const file = await this.read();
    if (!file) return null;
    const key = await loadPlatformMasterKey(this.keyFilePath);
    if (!key) return null;
    try {
      return { accessKeyId: decrypt(file.accessKeyId, key), secretAccessKey: decrypt(file.secretAccessKey, key) };
    } catch {
      console.error('[object-storage] Failed to decrypt the stored storage credential — treating as absent');
      return null;
    }
  }

  /** Whether a credential is configured, without decrypting anything. */
  async isConfigured(): Promise<boolean> {
    if (process.env.DROP_S3_ADMIN_ACCESS_KEY_ID && process.env.DROP_S3_ADMIN_SECRET_ACCESS_KEY) return true;
    return !!(await this.read());
  }

  async clear(): Promise<void> {
    await fs.unlink(this.credentialFilePath).catch((err: NodeJS.ErrnoException) => {
      if (err?.code !== 'ENOENT') throw err;
    });
  }

  private async read(): Promise<CredentialFile | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.credentialFilePath, 'utf-8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (isEncrypted(parsed?.accessKeyId) && isEncrypted(parsed?.secretAccessKey)) {
        return parsed as unknown as CredentialFile;
      }
    } catch {
      // fall through
    }
    console.error('[object-storage] object-storage-credential.json is unreadable — treating as absent');
    return null;
  }
}

let instance: StorageCredentialStore | null = null;

export function getStorageCredentialStore(config?: StorageCredentialStoreConfig): StorageCredentialStore {
  if (!instance) instance = new StorageCredentialStore(config);
  return instance;
}

export function resetStorageCredentialStore(): void {
  instance = null;
}
