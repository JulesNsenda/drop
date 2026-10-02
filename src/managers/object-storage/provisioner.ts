/**
 * Object storage provisioner (#301): one bucket and one bucket-scoped key per
 * app, in the operator's AWS account, injected as the standard AWS variables
 * (every AWS SDK picks them up with no code) plus `S3_BUCKET`.
 *
 * The provisioner owns the resources; attaching it to an app, the quota and
 * the loud detach are the platform's. It is available only when an admin has
 * enabled it AND set a region, a bucket prefix and a credential — and it says
 * which of those is missing rather than failing on first use.
 */

import * as path from 'path';
import { getSettingsManager } from '../settings/settings-manager';
import {
  StorageCredentialStore,
  getStorageCredentialStore,
  resetStorageCredentialStore,
} from './credential-store';
import { AllocationStore } from './allocation-store';
import { AwsObjectStorageProvider, createAwsClients, type AwsProviderConfig } from './aws-provider';
import { BUCKET_PREFIX_RE, bucketNameFor, iamUserNameFor, newResourceSuffix } from './naming';
import type {
  AppStorageAllocation,
  ObjectStorageProvider,
  StorageDeprovisionResult,
} from './types';

const isWindows = process.platform === 'win32';
const DEFAULT_DROP_ROOT = isWindows ? 'C:\\drop' : '/var/drop';

/** AWS region codes: `us-east-1`, `eu-central-1`, `ap-southeast-2`, `us-gov-west-1`… */
export const AWS_REGION_RE = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;

export type StorageUnavailableReason = 'disabled' | 'not-configured' | 'no-credential';

export type StorageAvailability =
  | { available: true; region: string; bucketPrefix: string }
  | { available: false; reason: StorageUnavailableReason; detail: string };

export class ObjectStorageUnavailableError extends Error {
  constructor(readonly reason: StorageUnavailableReason, detail: string) {
    super(detail);
    this.name = 'ObjectStorageUnavailableError';
  }
}

export interface ObjectStorageProvisionerOptions {
  allocations?: AllocationStore;
  credentials?: StorageCredentialStore;
  /** Injected in tests; AWS in production. */
  providerFactory?: (config: AwsProviderConfig) => ObjectStorageProvider;
}

export class ObjectStorageProvisioner {
  private readonly allocations: AllocationStore;
  private readonly credentials: StorageCredentialStore;
  private readonly providerFactory: (config: AwsProviderConfig) => ObjectStorageProvider;

  constructor(options: ObjectStorageProvisionerOptions = {}) {
    const dir = path.join(process.env.DROP_ROOT || DEFAULT_DROP_ROOT, 'data', 'drop-svc');
    this.allocations =
      options.allocations ??
      new AllocationStore(path.join(dir, 'object-storage.json'), path.join(dir, 'encryption.key'));
    this.credentials = options.credentials ?? getStorageCredentialStore();
    this.providerFactory =
      options.providerFactory ??
      ((config) => new AwsObjectStorageProvider(config.region, createAwsClients(config)));
  }

  /** Whether an app could be given storage right now, and if not, why. */
  async availability(): Promise<StorageAvailability> {
    const settings = getSettingsManager().getObjectStorageSettings();
    if (!settings.enabled) {
      return { available: false, reason: 'disabled', detail: 'Object storage is not enabled on this platform.' };
    }
    if (!settings.region || !AWS_REGION_RE.test(settings.region) || !settings.bucketPrefix || !BUCKET_PREFIX_RE.test(settings.bucketPrefix)) {
      return {
        available: false,
        reason: 'not-configured',
        detail: 'Object storage needs a region and a bucket prefix — an admin sets them in the platform settings.',
      };
    }
    if (!(await this.credentials.isConfigured())) {
      return {
        available: false,
        reason: 'no-credential',
        detail: 'Object storage has no AWS credential configured — an admin sets it in the platform settings.',
      };
    }
    return { available: true, region: settings.region, bucketPrefix: settings.bucketPrefix };
  }

  /** The app's allocation, without its secret. */
  getAllocation(appName: string): Promise<AppStorageAllocation | null> {
    return this.allocations.get(appName);
  }

  listAllocations(): Promise<AppStorageAllocation[]> {
    return this.allocations.list();
  }

  /**
   * Create the app's bucket and scoped key — or return the existing ones:
   * idempotent, so a retried attach recovers instead of creating a second
   * bucket. Throws ObjectStorageUnavailableError when not configured.
   */
  async provisionAppStorage(appName: string): Promise<AppStorageAllocation> {
    const existing = await this.allocations.get(appName);
    if (existing) return existing;

    const availability = await this.availability();
    if (!availability.available) {
      throw new ObjectStorageUnavailableError(availability.reason, availability.detail);
    }
    const provider = await this.providerFor(availability.region);
    const suffix = newResourceSuffix();
    const bucket = bucketNameFor(availability.bucketPrefix, appName, suffix);
    const userName = iamUserNameFor(availability.bucketPrefix, appName, suffix);
    const key = await provider.provision({ appName, bucket, userName });

    const allocation: AppStorageAllocation = {
      appName,
      provider: 'aws',
      region: availability.region,
      bucket,
      userName,
      accessKeyId: key.accessKeyId,
      createdAt: new Date().toISOString(),
    };
    try {
      await this.allocations.put({ ...allocation, secretAccessKey: key.secretAccessKey });
    } catch (err) {
      // Unrecorded resources would be invisible to every later teardown:
      // remove them rather than leave a bucket nothing points at.
      await provider.deprovision({ bucket, userName }).catch(() => undefined);
      throw err;
    }
    return allocation;
  }

  /**
   * The env vars for the app, or null when it has no storage. Standard AWS
   * names, so any AWS SDK in the app finds them unaided.
   */
  async getEnvVars(appName: string): Promise<Record<string, string> | null> {
    const creds = await this.allocations.getCredentials(appName);
    if (!creds) return null;
    return {
      AWS_REGION: creds.region,
      AWS_ACCESS_KEY_ID: creds.accessKeyId,
      AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
      S3_BUCKET: creds.bucket,
    };
  }

  /**
   * DESTROY the app's storage: key, user, every object and the bucket. The
   * allocation record is removed only once the provider reports it done, so
   * a failed teardown can be retried. Null when the app had none.
   */
  async deprovisionAppStorage(appName: string): Promise<StorageDeprovisionResult | null> {
    const allocation = await this.allocations.get(appName);
    if (!allocation) return null;
    const provider = await this.providerFor(allocation.region);
    const result = await provider.deprovision({ bucket: allocation.bucket, userName: allocation.userName });
    await this.allocations.remove(appName);
    return result;
  }

  /**
   * Whether teardown can run: only the admin credential is needed. Settings
   * are deliberately NOT consulted — an operator who disables object storage
   * must still be able to have DROP destroy what it already created.
   */
  canDeprovision(): Promise<boolean> {
    return this.credentials.isConfigured();
  }

  /**
   * The deleted-app path. Destroys the app's storage, or — when the caller
   * keeps data, or the teardown fails — RETIRES the record instead: moved off
   * the app's name, so the name is genuinely free, and the resources stay
   * tracked for the operator (`kept`) or the retry sweep (`teardown-failed`).
   * Never throws for an AWS failure; does throw `AllocationStoreCorruptError`,
   * because "unreadable" must never be read as "nothing to clean up".
   */
  async teardownForDeletedApp(
    appName: string,
    opts: { keepData?: boolean } = {}
  ): Promise<
    | { outcome: 'none' }
    | { outcome: 'destroyed'; result: StorageDeprovisionResult }
    | { outcome: 'retired'; reason: 'teardown-failed' | 'kept'; error?: unknown }
  > {
    const allocation = await this.allocations.get(appName);
    if (!allocation) return { outcome: 'none' };
    if (opts.keepData) {
      await this.allocations.retire(appName, 'kept');
      return { outcome: 'retired', reason: 'kept' };
    }
    try {
      return { outcome: 'destroyed', result: (await this.deprovisionAppStorage(appName))! };
    } catch (error) {
      await this.allocations.retire(appName, 'teardown-failed');
      return { outcome: 'retired', reason: 'teardown-failed', error };
    }
  }

  /**
   * Retry the teardown of every allocation retired by a failed delete. Each
   * record is forgotten only once its provider reports the resources gone;
   * `kept` records are the operator's and are never touched. A missing
   * credential skips the whole pass rather than failing every record.
   */
  async sweepRetired(): Promise<{ destroyed: number; failed: number }> {
    const pending = (await this.allocations.listRetired()).filter(
      ({ allocation }) => allocation.retired?.reason === 'teardown-failed'
    );
    if (pending.length === 0 || !(await this.credentials.isConfigured())) {
      return { destroyed: 0, failed: 0 };
    }
    let destroyed = 0;
    let failed = 0;
    for (const { key, allocation } of pending) {
      try {
        const provider = await this.providerFor(allocation.region);
        await provider.deprovision({ bucket: allocation.bucket, userName: allocation.userName });
        await this.allocations.removeRetired(key);
        destroyed += 1;
      } catch {
        failed += 1;
      }
    }
    return { destroyed, failed };
  }

  /** Retired allocations, for the operator's view. */
  async listRetired(): Promise<AppStorageAllocation[]> {
    return (await this.allocations.listRetired()).map(({ allocation }) => allocation);
  }

  /** Check the admin credential against AWS. Never throws; the message is AWS's error name only. */
  async testConnection(): Promise<{ ok: true; account: string } | { ok: false; error: string }> {
    const settings = getSettingsManager().getObjectStorageSettings();
    const region = settings.region && AWS_REGION_RE.test(settings.region) ? settings.region : 'us-east-1';
    try {
      const provider = await this.providerFor(region);
      return { ok: true, account: (await provider.whoAmI()).account };
    } catch (err) {
      return { ok: false, error: (err as { name?: string })?.name || 'Error' };
    }
  }

  private async providerFor(region: string): Promise<ObjectStorageProvider> {
    const credential = await this.credentials.resolve();
    if (!credential) {
      throw new ObjectStorageUnavailableError(
        'no-credential',
        'Object storage has no usable AWS credential (missing, or it cannot be decrypted).'
      );
    }
    return this.providerFactory({ region, ...credential });
  }
}

let instance: ObjectStorageProvisioner | null = null;

export function getObjectStorageProvisioner(options?: ObjectStorageProvisionerOptions): ObjectStorageProvisioner {
  if (!instance) instance = new ObjectStorageProvisioner(options);
  return instance;
}

export function resetObjectStorageProvisioner(): void {
  instance = null;
}

/**
 * Bind both object-storage singletons to THIS platform's root. Without it
 * they resolve their files from `DROP_ROOT` in the environment, which is not
 * the root a platform started with `--root` (or constructed in a test) uses —
 * the admin routes and the platform would then read two different stores.
 * Resets first, for the same reason the guest stores do: whatever bound the
 * singletons before boot held nothing worth keeping.
 */
export function configureObjectStorage(dropRoot: string): ObjectStorageProvisioner {
  const dir = path.join(dropRoot, 'data', 'drop-svc');
  const keyFilePath = path.join(dir, 'encryption.key');
  resetStorageCredentialStore();
  resetObjectStorageProvisioner();
  const credentials = getStorageCredentialStore({
    credentialFilePath: path.join(dir, 'object-storage-credential.json'),
    keyFilePath,
  });
  return getObjectStorageProvisioner({
    credentials,
    allocations: new AllocationStore(path.join(dir, 'object-storage.json'), keyFilePath),
  });
}
