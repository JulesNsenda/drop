/**
 * Secret Manager
 *
 * Manages encrypted environment variables/secrets for DROP apps.
 * Secrets are stored encrypted at rest using AES-256-GCM.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { encrypt, decrypt, deriveKey, generateSalt, EncryptedData } from './encryption';

interface SecretStore {
  /** 1 = key derived from the store's own salt (legacy, weak). 2 = key derived from an external master key. */
  version: 1 | 2;
  salt: string;
  secrets: Record<string, Record<string, EncryptedData>>;
}

export interface SecretManagerConfig {
  /** Path to the secrets store file */
  storePath: string;
  /** Master passphrase for encryption (e.g. from DROP_MASTER_KEY) */
  masterKey?: string;
  /**
   * Path to a file holding the master key (e.g. the auto-generated
   * encryption.key). Used when masterKey is not provided. This keeps the key
   * material out of secrets.json so the store is not self-decrypting.
   */
  masterKeyPath?: string;
}

export class SecretManager {
  private readonly config: SecretManagerConfig;
  private store: SecretStore | null = null;
  private encryptionKey: Buffer | null = null;
  private initialized = false;

  constructor(config: SecretManagerConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await fs.mkdir(path.dirname(this.config.storePath), { recursive: true });

    this.store = await this.loadStore();

    const salt = Buffer.from(this.store.salt, 'base64');
    const externalKey = await this.resolveExternalMasterKey();

    if (externalKey) {
      const newKey = deriveKey(externalKey, salt);

      // Migrate a legacy (salt-derived) store to the external key in place.
      if (this.store.version === 1) {
        const legacyKey = deriveKey(this.store.salt, salt);
        this.reencryptAll(legacyKey, newKey);
        this.store.version = 2;
        this.encryptionKey = newKey;
        await this.saveStore(this.store);
      } else {
        this.encryptionKey = newKey;
      }
    } else {
      // No external key available — fall back to the legacy self-derived key.
      // This provides no confidentiality against anyone who can read the store
      // file; warn so operators wire up an encryption key / DROP_MASTER_KEY.
      if (this.store.version === 1) {
        console.warn(
          '[secret-manager] No master key configured — secrets are encrypted with a key derived ' +
            'from the store itself and are NOT protected against disk-read access. ' +
            'Set DROP_MASTER_KEY or provide an encryption.key file.'
        );
      }
      this.encryptionKey = deriveKey(this.store.salt, salt);
    }

    this.initialized = true;
  }

  /** Master key from explicit config, else the contents of masterKeyPath, else none. */
  private async resolveExternalMasterKey(): Promise<string | null> {
    if (this.config.masterKey) return this.config.masterKey;
    if (this.config.masterKeyPath) {
      try {
        const key = (await fs.readFile(this.config.masterKeyPath, 'utf-8')).trim();
        if (key.length > 0) return key;
      } catch {
        // File missing/unreadable — fall through to legacy mode.
      }
    }
    return null;
  }

  /** Re-encrypt every stored secret from one key to another (used for v1→v2 migration). */
  private reencryptAll(oldKey: Buffer, newKey: Buffer): void {
    if (!this.store) return;
    for (const appSecrets of Object.values(this.store.secrets)) {
      for (const [key, encrypted] of Object.entries(appSecrets)) {
        const plaintext = decrypt(encrypted, oldKey);
        appSecrets[key] = encrypt(plaintext, newKey);
      }
    }
  }

  private async loadStore(): Promise<SecretStore> {
    try {
      const data = await fs.readFile(this.config.storePath, 'utf-8');
      return JSON.parse(data);
    } catch {
      const salt = generateSalt();
      const store: SecretStore = {
        version: 1,
        salt: salt.toString('base64'),
        secrets: {},
      };
      await this.saveStore(store);
      return store;
    }
  }

  private async saveStore(store: SecretStore): Promise<void> {
    await fs.writeFile(
      this.config.storePath,
      JSON.stringify(store, null, 2),
      { mode: 0o600 }
    );
  }

  /**
   * Set a secret for an app
   */
  async set(appName: string, key: string, value: string): Promise<void> {
    this.ensureInitialized();

    if (!this.store!.secrets[appName]) {
      this.store!.secrets[appName] = {};
    }

    this.store!.secrets[appName][key] = encrypt(value, this.encryptionKey!);
    await this.saveStore(this.store!);
  }

  /**
   * Get a decrypted secret for an app
   */
  get(appName: string, key: string): string | null {
    this.ensureInitialized();

    const appSecrets = this.store!.secrets[appName];
    if (!appSecrets || !appSecrets[key]) return null;

    return decrypt(appSecrets[key], this.encryptionKey!);
  }

  /**
   * Get all decrypted secrets for an app as env vars
   */
  getAll(appName: string): Record<string, string> {
    this.ensureInitialized();

    const appSecrets = this.store!.secrets[appName];
    if (!appSecrets) return {};

    const result: Record<string, string> = {};
    for (const [key, encrypted] of Object.entries(appSecrets)) {
      result[key] = decrypt(encrypted, this.encryptionKey!);
    }
    return result;
  }

  /**
   * List secret keys for an app (values are not returned)
   */
  list(appName: string): string[] {
    this.ensureInitialized();

    const appSecrets = this.store!.secrets[appName];
    if (!appSecrets) return [];

    return Object.keys(appSecrets);
  }

  /**
   * Delete a secret for an app
   */
  async delete(appName: string, key: string): Promise<boolean> {
    this.ensureInitialized();

    const appSecrets = this.store!.secrets[appName];
    if (!appSecrets || !appSecrets[key]) return false;

    delete appSecrets[key];

    // Clean up empty app entries
    if (Object.keys(appSecrets).length === 0) {
      delete this.store!.secrets[appName];
    }

    await this.saveStore(this.store!);
    return true;
  }

  /**
   * Delete all secrets for an app
   */
  async deleteAll(appName: string): Promise<boolean> {
    this.ensureInitialized();

    if (!this.store!.secrets[appName]) return false;

    delete this.store!.secrets[appName];
    await this.saveStore(this.store!);
    return true;
  }

  /**
   * Check if an app has any secrets
   */
  hasSecrets(appName: string): boolean {
    this.ensureInitialized();
    return !!this.store!.secrets[appName] && Object.keys(this.store!.secrets[appName]).length > 0;
  }

  private ensureInitialized(): void {
    if (!this.initialized || !this.store || !this.encryptionKey) {
      throw new Error('SecretManager not initialized. Call initialize() first.');
    }
  }
}

// Singleton
let instance: SecretManager | null = null;

export function getSecretManager(config?: SecretManagerConfig): SecretManager {
  if (!instance) {
    if (!config) {
      throw new Error('SecretManager config required on first call');
    }
    instance = new SecretManager(config);
  }
  return instance;
}

export function resetSecretManager(): void {
  instance = null;
}
