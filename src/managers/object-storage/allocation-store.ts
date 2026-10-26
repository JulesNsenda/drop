/**
 * Per-app object-storage allocations (#301): which bucket and IAM user each
 * app has, and the app's key — its secret encrypted under the platform
 * `encryption.key`, in a 0600 file in the 0700 `data/drop-svc/`.
 *
 * FAILS CLOSED on a corrupt file: every read then throws rather than
 * reporting "no allocation". An empty read would let the next attach
 * provision a SECOND bucket for an app that already has one, orphaning the
 * first — and its data — with nothing left pointing at it.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { writeJsonAtomic } from '../../utils/atomic-write';
import { encrypt, decrypt, loadPlatformMasterKey, EncryptedData } from '../secret/encryption';
import type { AppStorageAllocation, AppStorageCredentials } from './types';

interface StoredAllocation extends AppStorageAllocation {
  secretAccessKey: EncryptedData;
}

type StoreFile = Record<string, StoredAllocation>;

export class AllocationStoreCorruptError extends Error {
  constructor(filePath: string) {
    super(`${path.basename(filePath)} is unreadable; refusing to act on object storage until it is repaired`);
    this.name = 'AllocationStoreCorruptError';
  }
}

export class AllocationStore {
  /** Serialises writes; reads go to disk so a restart never sees stale state. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly keyFilePath: string
  ) {}

  /** The app's allocation without its secret, or null. */
  async get(appName: string): Promise<AppStorageAllocation | null> {
    const stored = (await this.load())[appName];
    if (!stored) return null;
    const { secretAccessKey: _secret, ...allocation } = stored;
    return allocation;
  }

  /** Every allocation, without secrets. */
  async list(): Promise<AppStorageAllocation[]> {
    return Object.values(await this.load()).map(({ secretAccessKey: _secret, ...a }) => a);
  }

  /** The app's allocation WITH its decrypted secret — for env injection only. */
  async getCredentials(appName: string): Promise<AppStorageCredentials | null> {
    const stored = (await this.load())[appName];
    if (!stored) return null;
    const key = await loadPlatformMasterKey(this.keyFilePath);
    if (!key) throw new Error('encryption.key is absent or not 32 bytes — cannot read storage credentials');
    return { ...stored, secretAccessKey: decrypt(stored.secretAccessKey, key) };
  }

  async put(credentials: AppStorageCredentials): Promise<void> {
    await this.write(async (file) => {
      const key = await loadPlatformMasterKey(this.keyFilePath);
      if (!key) throw new Error('encryption.key is absent or not 32 bytes — refusing to store storage credentials');
      file[credentials.appName] = { ...credentials, secretAccessKey: encrypt(credentials.secretAccessKey, key) };
    });
  }

  async remove(appName: string): Promise<void> {
    await this.write(async (file) => {
      delete file[appName];
    });
  }

  private write(mutate: (file: StoreFile) => Promise<void>): Promise<void> {
    const run = this.chain.catch(() => undefined).then(async () => {
      const file = await this.load();
      await mutate(file);
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await writeJsonAtomic(this.filePath, file, { mode: 0o600 });
    });
    this.chain = run;
    return run;
  }

  private async load(): Promise<StoreFile> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new AllocationStoreCorruptError(this.filePath);
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as StoreFile;
    } catch {
      // fall through
    }
    throw new AllocationStoreCorruptError(this.filePath);
  }
}
