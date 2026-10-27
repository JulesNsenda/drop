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
import {
  BUCKET_PREFIX_RE,
  assertGeneratedResourcePair,
  bucketNameFor,
  iamUserNameFor,
  newResourceSuffix,
} from './naming';
import { getLogger } from '../../utils/logger';
import type {
  AppStorageAllocation,
  ObjectStorageProvider,
  RetiredReason,
  StorageDeprovisionResult,
} from './types';

/** AWS region codes: `us-east-1`, `eu-central-1`, `ap-southeast-2`, `us-gov-west-1`… */
export const AWS_REGION_RE = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;

export type StorageUnavailableReason =
  | 'disabled'
  | 'not-configured'
  | 'no-credential'
  /** Tenant code runs on the host, beside the platform that holds the AWS admin key. */
  | 'isolation'
  /** No API auth: every route that can spend the operator's money would be open. */
  | 'auth-disabled';

/** What the platform is running as — facts the provisioner cannot know for itself. */
export interface StorageEnvironment {
  isolation: 'none' | 'docker';
  authEnabled: boolean;
}

export type StorageAvailability =
  | { available: true; region: string; bucketPrefix: string }
  | { available: false; reason: StorageUnavailableReason; detail: string };

/**
 * The provisioner was built without an allocation store. Production code gets
 * one from `configureObjectStorage(dropRoot, ...)`, which binds it to THIS
 * platform's root. A provisioner that quietly fell back to `DROP_ROOT` from
 * the environment would read and write a different store from the platform's
 * (a `--root` boot does not set it), which is how the admin routes and the
 * platform once disagreed about where the buckets were.
 */
export class ObjectStorageNotConfiguredError extends Error {
  constructor() {
    super('Object storage has no allocation store: it was not bound to a platform root (configureObjectStorage)');
    this.name = 'ObjectStorageNotConfiguredError';
  }
}

export class ObjectStorageUnavailableError extends Error {
  constructor(readonly reason: StorageUnavailableReason, detail: string) {
    super(detail);
    this.name = 'ObjectStorageUnavailableError';
  }
}

/** Which app a record belongs to: the owner and the app's own creation stamp. */
export interface AppIncarnation {
  ownerUserId?: string;
  appCreatedAt?: string;
}

/**
 * The name holds a record that belongs to a DIFFERENT app — one that had the
 * name before and whose storage was never settled. Handing it over would give
 * the new registrant the previous tenant's bucket and key.
 */
export class ObjectStorageIncarnationError extends Error {
  constructor(appName: string) {
    super(
      `'${appName}' has object storage on record that belongs to a previous app of the same name, ` +
        'so it was not reused. An admin must resolve it before storage can be attached.'
    );
    this.name = 'ObjectStorageIncarnationError';
  }
}

/**
 * The app's storage was half-detached: its key is revoked but the bucket has
 * not been drained yet. Attaching now would either hand it a bucket the sweep
 * is about to empty, or mint a new key whose writes the sweep would delete —
 * so the owner must finish the detach first (retrying it is idempotent).
 */
export class ObjectStorageDetachIncompleteError extends Error {
  constructor(appName: string) {
    super(
      `A previous detach of object storage on '${appName}' did not finish — retry the detach, ` +
        'then attach again once it completes.'
    );
    this.name = 'ObjectStorageDetachIncompleteError';
  }
}

function sameIncarnation(record: AppStorageAllocation, incarnation: AppIncarnation): boolean {
  return (
    (record.ownerUserId ?? null) === (incarnation.ownerUserId ?? null) &&
    (record.appCreatedAt ?? null) === (incarnation.appCreatedAt ?? null)
  );
}

export interface ObjectStorageProvisionerOptions {
  allocations?: AllocationStore;
  credentials?: StorageCredentialStore;
  /**
   * The platform's isolation mode and auth state, read at call time. Absent
   * means unknown, which is treated as the unsafe answer (no isolation, no
   * auth): a provisioner nobody told about its environment refuses to create
   * anything.
   */
  environment?: () => StorageEnvironment;
  /** Injected in tests; AWS in production. */
  providerFactory?: (config: AwsProviderConfig) => ObjectStorageProvider;
}

export class ObjectStorageProvisioner {
  private readonly allocationStore: AllocationStore | null;
  private readonly credentials: StorageCredentialStore;
  private readonly providerFactory: (config: AwsProviderConfig) => ObjectStorageProvider;
  private readonly environment: () => StorageEnvironment;

  constructor(options: ObjectStorageProvisionerOptions = {}) {
    this.allocationStore = options.allocations ?? null;
    this.environment = options.environment ?? (() => ({ isolation: 'none', authEnabled: false }));
    this.credentials = options.credentials ?? getStorageCredentialStore();
    this.providerFactory =
      options.providerFactory ??
      ((config) => new AwsObjectStorageProvider(config.region, createAwsClients(config)));
  }

  /**
   * The allocation store, or ObjectStorageNotConfiguredError. Thrown at the
   * first use rather than at construction, so a standalone ApiServer (tests)
   * that merely asks `availability()` still gets its answer.
   */
  private get allocations(): AllocationStore {
    if (!this.allocationStore) throw new ObjectStorageNotConfiguredError();
    return this.allocationStore;
  }

  /** Whether an app could be given storage right now, and if not, why. */
  async availability(): Promise<StorageAvailability> {
    // Platform facts first: they are not the operator's to fix from the
    // settings page, and they outrank every setting.
    const environment = this.environment();
    if (environment.isolation !== 'docker') {
      return {
        available: false,
        reason: 'isolation',
        detail:
          'Object storage needs container isolation (DROP_ISOLATION=docker). Without it, tenant apps run on the same host as the AWS admin key this feature holds.',
      };
    }
    if (!environment.authEnabled) {
      return {
        available: false,
        reason: 'auth-disabled',
        detail: 'Object storage is unavailable while API authentication is disabled.',
      };
    }
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
  async getAllocation(appName: string): Promise<AppStorageAllocation | null> {
    return this.allocations.get(appName);
  }

  async listAllocations(): Promise<AppStorageAllocation[]> {
    return this.allocations.list();
  }

  /**
   * Create the app's bucket and scoped key — or return the existing ones:
   * idempotent, so a retried attach recovers instead of creating a second
   * bucket. Throws ObjectStorageUnavailableError when not configured, and
   * ObjectStorageIncarnationError when the name holds a record that belongs to
   * a different app than `incarnation` describes.
   */
  async provisionAppStorage(appName: string, incarnation: AppIncarnation = {}): Promise<AppStorageAllocation> {
    const existing = await this.allocations.get(appName);
    if (existing) {
      if (existing.accessRevoked) throw new ObjectStorageDetachIncompleteError(appName);
      if (!sameIncarnation(existing, incarnation)) throw new ObjectStorageIncarnationError(appName);
      return existing;
    }

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
      ...(incarnation.ownerUserId ? { ownerUserId: incarnation.ownerUserId } : {}),
      ...(incarnation.appCreatedAt ? { appCreatedAt: incarnation.appCreatedAt } : {}),
    };
    try {
      await this.allocations.put({ ...allocation, secretAccessKey: key.secretAccessKey });
    } catch (err) {
      // Unrecorded resources would be invisible to every later teardown:
      // remove them rather than leave a bucket nothing points at.
      await provider.deprovision({ bucket, userName }).catch((undoErr) => {
        // The record could not be written either, so there is nothing for the
        // sweep to retry: the names are the only trail an operator gets.
        getLogger().error(
          `Object storage for '${appName}' could not be recorded AND the undo failed — bucket '${bucket}' and IAM user '${userName}' are orphaned in AWS and must be removed by hand`,
          'STORAGE',
          undoErr
        );
      });
      throw err;
    }
    return allocation;
  }

  /**
   * Undo a provision whose attach could not be completed (the app lost its
   * config in between). Never throws for AWS: a failed undo is logged and
   * recorded as a `teardown-failed` retired record, so the sweep keeps trying
   * instead of the bucket silently billing the operator with nothing pointing
   * at it. Only call this for an allocation the caller itself just created.
   */
  async undoProvision(appName: string): Promise<void> {
    try {
      await this.deprovisionAppStorage(appName);
    } catch (err) {
      getLogger().error(
        `Undoing the object storage just provisioned for '${appName}' failed — retired for the sweep to retry`,
        'STORAGE',
        err
      );
      await this.allocations.retire(appName, 'teardown-failed');
    }
  }

  /**
   * Wait until the app's NEW key is actually honoured: a freshly created IAM
   * key is eventually consistent, and an app restarted straight after attach
   * can boot into `InvalidAccessKeyId` and crash-loop on first use. Polls an
   * S3 HeadBucket made with the app's own key, backing off (250ms doubling to
   * 4s) for at most `timeoutMs` (default 30s). True once it works; false on
   * timeout — the caller proceeds anyway, since the key usually lands while
   * the app boots, and an app that retries recovers.
   */
  async awaitKeyPropagation(
    appName: string,
    opts: { timeoutMs?: number; sleep?: (ms: number) => Promise<void> } = {}
  ): Promise<boolean> {
    const creds = await this.allocations.getCredentials(appName);
    if (!creds) return false;
    const provider = await this.providerFor(creds.region);
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const timeoutMs = opts.timeoutMs ?? 30_000;
    let waited = 0;
    let delay = 250;
    for (;;) {
      if (await provider.probeAccess(creds)) return true;
      if (waited >= timeoutMs) return false;
      const step = Math.min(delay, timeoutMs - waited);
      await sleep(step);
      waited += step;
      delay = Math.min(delay * 2, 4000);
    }
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
   * The first half of a detach: revoke the app's IAM key and delete its user,
   * and RECORD that on the allocation (dropping the stored secret with it).
   * The bucket stays, to be drained by the sweep once the owner's intent is
   * confirmed `detached`. Idempotent, so a retried detach just picks up where
   * the last one stopped. Null when the app has no storage — or when the
   * record on the name belongs to a different app (see `ownedBy`).
   */
  async revokeAppAccess(appName: string, incarnation?: AppIncarnation): Promise<AppStorageAllocation | null> {
    const allocation = await this.allocations.get(appName);
    if (!allocation) return null;
    if (!(await this.ownedBy(appName, allocation, incarnation))) return null;
    if (allocation.accessRevoked) return allocation;
    assertGeneratedResourcePair(allocation.bucket, allocation.userName);
    const provider = await this.providerFor(allocation.region);
    await provider.revokeAccess({ userName: allocation.userName });
    await this.allocations.amend(appName, { accessRevoked: true, dropSecret: true });
    return { ...allocation, accessRevoked: true };
  }

  /**
   * DESTROY the app's storage: key, user, every object and the bucket. The
   * allocation record is removed only once the provider reports it done, so
   * a failed teardown can be retried. Null when the app had none.
   */
  async deprovisionAppStorage(
    appName: string,
    incarnation?: AppIncarnation
  ): Promise<StorageDeprovisionResult | null> {
    const allocation = await this.allocations.get(appName);
    if (!allocation) return null;
    if (!(await this.ownedBy(appName, allocation, incarnation))) return null;
    assertGeneratedResourcePair(allocation.bucket, allocation.userName);
    const provider = await this.providerFor(allocation.region);
    const result = await provider.deprovision({ bucket: allocation.bucket, userName: allocation.userName });
    await this.allocations.remove(appName);
    return result;
  }

  /**
   * Whether the record on `appName` belongs to the app the caller is acting
   * for. Every destructive path asks BEFORE it calls AWS: app names are
   * reusable, and a record that outlived its app (a crash, a store restored
   * from a backup) must never be revoked or drained on behalf of whoever holds
   * the name now. On a mismatch nothing is touched: the record is retired as
   * `kept` (off the name, bucket and all, for an admin to resolve) and the
   * mismatch is logged. `incarnation` undefined means the caller cannot say
   * (the app's state is already gone) and the check is skipped.
   */
  private async ownedBy(
    appName: string,
    allocation: AppStorageAllocation,
    incarnation: AppIncarnation | undefined
  ): Promise<boolean> {
    if (!incarnation || sameIncarnation(allocation, incarnation)) return true;
    getLogger().error(
      `Object storage on '${appName}' belongs to a different app than the one acting on it - refusing to revoke or delete it; retired as kept for an admin to resolve`,
      'STORAGE'
    );
    const key = await this.allocations.retire(appName, 'kept');
    if (key) await this.allocations.amend(key, { quarantined: true });
    return false;
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
   * The deleted-app path. RETIRES the record first — a synchronous write that
   * moves it off the app's name before any AWS call, so the name is genuinely
   * free (and a crash anywhere after this leaves a tracked record, not an
   * orphan) — then revokes the IAM key and user by the retired record. The
   * bucket is NOT drained here: a large bucket would hold the DELETE response
   * open for minutes. A `kept` record (keepData) keeps its bucket for an admin
   * to destroy; any other is `deleting`, and the sweep drains it.
   *
   * Never throws for an AWS failure; does throw `AllocationStoreCorruptError`,
   * because "unreadable" must never be read as "nothing to clean up".
   */
  async teardownForDeletedApp(
    appName: string,
    opts: { keepData?: boolean } = {},
    incarnation?: AppIncarnation
  ): Promise<{ outcome: 'none' } | { outcome: 'retired'; reason: RetiredReason; key: string }> {
    const allocation = await this.allocations.get(appName);
    if (!allocation) return { outcome: 'none' };
    // A record that is not this app's is retired as kept and left alone.
    if (!(await this.ownedBy(appName, allocation, incarnation))) return { outcome: 'none' };
    const reason: RetiredReason = opts.keepData ? 'kept' : 'deleting';
    const key = await this.allocations.retire(appName, reason);
    if (!key) return { outcome: 'none' };
    // A failure here is not final: the sweep revokes (and, unless kept,
    // drains) every retired record it finds.
    await this.revokeRetiredAccess(key, allocation).catch((err) => {
      getLogger().warn(`Could not revoke the IAM key of deleted app '${appName}' yet — the sweep will retry`, 'STORAGE', err);
    });
    return { outcome: 'retired', reason, key };
  }

  /**
   * Finish what earlier operations left behind. Each record is forgotten only
   * once its provider reports the resources gone.
   *
   *  - Retired records (`deleting`, `teardown-failed`): drained and removed.
   *  - Retired `kept` records: only their IAM access is finished off; the
   *    bucket is the owner's, and only an admin destroys it.
   *  - LIVE allocations the owner asked to detach (`shouldDrain`): their key
   *    is revoked first if the detach itself could not (so a failed revoke is
   *    finished here, not left to a manual retry), then the bucket is drained.
   *    `shouldDrain` is asked again after each step and before anything is
   *    deleted, because the sweep is the one actor that deletes data without
   *    a person present. The provisioner does not know intents; the platform
   *    does.
   *
   * A missing credential skips the whole pass rather than failing every record.
   */
  async sweepRetired(
    opts: {
      /** The incarnation of the app that wants its storage detached, or false for "leave it". */
      shouldDrain?: (appName: string) => AppIncarnation | false;
      /** True once the platform is shutting down: finish the record in hand, start no other. */
      stopping?: () => boolean;
    } = {}
  ): Promise<{ destroyed: number; failed: number }> {
    // Asked again after each step. A record whose marker is not the CURRENT
    // app's is someone else's bucket under a reused name: skipped, not acted on.
    const wants = (a: AppStorageAllocation): AppIncarnation | false => {
      const inc = opts.shouldDrain?.(a.appName);
      return inc && sameIncarnation(a, inc) ? inc : false;
    };
    const retired = (await this.allocations.listRetired()).filter(
      ({ allocation }) =>
        allocation.retired?.reason === 'teardown-failed' ||
        allocation.retired?.reason === 'deleting' ||
        // A kept bucket whose key could not be revoked at delete time: finish
        // that half. Its bucket is still never touched.
        (allocation.retired?.reason === 'kept' && !allocation.accessRevoked && !allocation.quarantined)
    );
    const detached = (await this.allocations.list()).filter((allocation) => wants(allocation));
    if ((retired.length === 0 && detached.length === 0) || !(await this.credentials.isConfigured())) {
      return { destroyed: 0, failed: 0 };
    }
    let destroyed = 0;
    let failed = 0;
    for (const { key, allocation } of retired) {
      if (opts.stopping?.()) break;
      try {
        assertGeneratedResourcePair(allocation.bucket, allocation.userName);
        if (allocation.retired?.reason === 'kept') {
          await this.revokeRetiredAccess(key, allocation);
          continue;
        }
        const provider = await this.providerFor(allocation.region);
        await provider.deprovision({ bucket: allocation.bucket, userName: allocation.userName });
        await this.allocations.removeRetired(key);
        destroyed += 1;
      } catch {
        // A failed destroy is a teardown failure, whatever the record was
        // called before the attempt.
        if (allocation.retired?.reason === 'deleting') {
          await this.allocations.amend(key, { retiredReason: 'teardown-failed' }).catch(() => undefined);
        }
        failed += 1;
      }
    }
    for (const allocation of detached) {
      if (opts.stopping?.()) break;
      try {
        assertGeneratedResourcePair(allocation.bucket, allocation.userName);
        const inc = wants(allocation);
        if (!inc) continue;
        if (!allocation.accessRevoked) {
          // The detach recorded its intent but could not revoke the key.
          await this.revokeAppAccess(allocation.appName, inc);
          if (!wants(allocation)) continue;
        }
        const provider = await this.providerFor(allocation.region);
        // The last look before data is deleted: the owner may have changed
        // their mind (or the app may have gone) since the list above.
        if (!wants(allocation)) continue;
        await provider.deprovision({ bucket: allocation.bucket, userName: allocation.userName });
        // Forget it only if the name still holds THIS record.
        if ((await this.allocations.get(allocation.appName))?.bucket === allocation.bucket) {
          await this.allocations.remove(allocation.appName);
        }
        destroyed += 1;
      } catch {
        failed += 1;
      }
    }
    return { destroyed, failed };
  }

  /** Revoke a retired record's IAM key and user, and remember that it is done. */
  private async revokeRetiredAccess(key: string, allocation: AppStorageAllocation): Promise<void> {
    assertGeneratedResourcePair(allocation.bucket, allocation.userName);
    const provider = await this.providerFor(allocation.region);
    await provider.revokeAccess({ userName: allocation.userName });
    await this.allocations.amend(key, { accessRevoked: true });
  }

  /** Retired allocations, for the operator's view. */
  async listRetired(): Promise<AppStorageAllocation[]> {
    return (await this.allocations.listRetired()).map(({ allocation }) => allocation);
  }

  /** Retired allocations with the id `destroyRetired` takes — the admin view. */
  async listRetiredRecords(): Promise<Array<{ id: string; allocation: AppStorageAllocation }>> {
    return (await this.allocations.listRetired()).map(({ key, allocation }) => ({ id: key, allocation }));
  }

  /**
   * DESTROY a retired bucket on an admin's say-so (a `kept` one is otherwise
   * never touched). The record is forgotten only once AWS reports it gone.
   * Null when there is no such retired record.
   */
  async destroyRetired(id: string): Promise<StorageDeprovisionResult | null> {
    const allocation = await this.allocations.getRetired(id);
    if (!allocation) return null;
    assertGeneratedResourcePair(allocation.bucket, allocation.userName);
    const provider = await this.providerFor(allocation.region);
    const result = await provider.deprovision({ bucket: allocation.bucket, userName: allocation.userName });
    await this.allocations.removeRetired(id);
    return result;
  }

  /**
   * How many buckets this user holds in the operator's AWS account: live
   * allocations AND retired ones (a kept bucket bills exactly like a live
   * one). The ONE count both the attach enforcer and the dashboard display
   * use. A corrupt store throws — it must never read as "none used".
   */
  async countForOwner(ownerUserId: string): Promise<number> {
    const live = await this.allocations.list();
    const retired = await this.allocations.listRetired();
    return (
      live.filter((a) => a.ownerUserId === ownerUserId).length +
      retired.filter(({ allocation }) => allocation.ownerUserId === ownerUserId).length
    );
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
export function configureObjectStorage(
  dropRoot: string,
  environment: () => StorageEnvironment
): ObjectStorageProvisioner {
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
    environment,
    allocations: new AllocationStore(path.join(dir, 'object-storage.json'), keyFilePath),
  });
}
