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
import { StorageCredentialStore, getStorageCredentialStore } from './credential-store';
import { AllocationStore } from './allocation-store';
import { AwsObjectStorageProvider, createAwsClients, type AwsProviderConfig } from './aws-provider';
import { BUCKET_PREFIX_RE, bucketNameFor, iamUserNameFor } from './naming';
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
    const bucket = bucketNameFor(availability.bucketPrefix, appName);
    const userName = iamUserNameFor(availability.bucketPrefix, appName);
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
