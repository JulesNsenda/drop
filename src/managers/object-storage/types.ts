/**
 * Object storage (#301): an S3 bucket per app, reached with a key that can
 * touch that bucket and nothing else. The operator supplies ONE admin
 * credential for their own AWS account; DROP never hands it to an app.
 */

/** What DROP records about one app's bucket. The secret is encrypted at rest. */
export interface AppStorageAllocation {
  appName: string;
  provider: 'aws';
  region: string;
  bucket: string;
  /** The IAM user whose only permissions are this bucket. */
  userName: string;
  accessKeyId: string;
  createdAt: string;
  /**
   * Set when the app this belonged to was deleted and its resources were NOT
   * destroyed — the record is moved off the app's name so a new app of the
   * same name can never inherit the bucket. `teardown-failed` is retried by
   * the sweep; `kept` (a `keepData` delete) is left for the operator.
   */
  retired?: { at: string; reason: 'teardown-failed' | 'kept' };
}

/** The allocation plus its secret, as injected into the app's environment. */
export interface AppStorageCredentials extends AppStorageAllocation {
  secretAccessKey: string;
}

/** What tearing an app's storage down actually did. */
export interface StorageDeprovisionResult {
  /** Objects (and object versions) deleted before the bucket could be. */
  objectsDeleted: number;
  bucketDeleted: boolean;
  userDeleted: boolean;
}

/**
 * The provider seam. AWS (S3 + IAM) is the only implementation; another
 * provider must give the same guarantee: a per-app bucket and a key scoped
 * to exactly that bucket, or it does not belong here.
 */
export interface ObjectStorageProvider {
  /**
   * Create the bucket, the scoped user and its key. On failure, removes
   * whatever it created before throwing, so a failed attach leaves nothing
   * behind to pay for.
   */
  provision(input: { appName: string; bucket: string; userName: string }): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
  }>;
  /** Delete the key(s), the user, every object and the bucket. Idempotent. */
  deprovision(input: { bucket: string; userName: string }): Promise<StorageDeprovisionResult>;
  /** Confirm the admin credential works; returns the account it belongs to. */
  whoAmI(): Promise<{ account: string }>;
}
