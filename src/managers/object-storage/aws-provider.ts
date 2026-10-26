/**
 * The AWS implementation of ObjectStorageProvider (#301): S3 for the bucket,
 * IAM for a user whose only permissions are that bucket.
 *
 * AWS-only on purpose. A settable S3 endpoint would let an admin (or a
 * hijacked admin session) point it at a host they control and receive the
 * operator's admin key on the next call — the same exfiltration shape the
 * SMTP host/credential binding exists to close. Another provider is a new
 * implementation of this seam, not a URL field.
 *
 * ORDER, on the way in: bucket (with public access blocked and ACLs
 * disabled), then user, policy, key — and anything created is removed again
 * if a later step fails. On the way out: revoke first (keys, policy, user),
 * then empty and delete the bucket, so nothing can write while it drains.
 * Every step treats "already gone" as done, so a retried teardown finishes.
 */

import {
  S3Client,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
  DeleteBucketCommand,
  type BucketLocationConstraint,
} from '@aws-sdk/client-s3';
import {
  IAMClient,
  CreateUserCommand,
  PutUserPolicyCommand,
  CreateAccessKeyCommand,
  ListAccessKeysCommand,
  DeleteAccessKeyCommand,
  DeleteUserPolicyCommand,
  DeleteUserCommand,
} from '@aws-sdk/client-iam';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { IAM_USER_PATH, bucketOnlyPolicy } from './naming';
import type { ObjectStorageProvider, StorageDeprovisionResult } from './types';

/** The one method DROP uses on each SDK client — injectable for tests. */
export interface Sender {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each SDK command has its own output type
  send(command: unknown): Promise<any>;
}

export interface AwsClients {
  s3: Sender;
  iam: Sender;
  sts: Sender;
}

export const USER_POLICY_NAME = 'drop-bucket-access';

export interface AwsProviderConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function createAwsClients(config: AwsProviderConfig): AwsClients {
  const credentials = { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey };
  return {
    s3: new S3Client({ region: config.region, credentials }),
    // IAM is a global service; its endpoint lives in us-east-1.
    iam: new IAMClient({ region: 'us-east-1', credentials }),
    sts: new STSClient({ region: config.region, credentials }),
  };
}

function isGone(err: unknown): boolean {
  const name = (err as { name?: string; Code?: string })?.name ?? (err as { Code?: string })?.Code;
  return name === 'NoSuchEntity' || name === 'NoSuchEntityException' || name === 'NoSuchBucket';
}

async function ignoreGone<T>(op: Promise<T>): Promise<T | undefined> {
  try {
    return await op;
  } catch (err) {
    if (isGone(err)) return undefined;
    throw err;
  }
}

export class AwsObjectStorageProvider implements ObjectStorageProvider {
  constructor(
    private readonly region: string,
    private readonly clients: AwsClients
  ) {}

  async provision(input: { appName: string; bucket: string; userName: string }): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
  }> {
    const { bucket, userName, appName } = input;
    let bucketCreated = false;
    let userCreated = false;
    try {
      await this.clients.s3.send(
        new CreateBucketCommand({
          Bucket: bucket,
          // us-east-1 is the default and REJECTS an explicit constraint.
          ...(this.region === 'us-east-1'
            ? {}
            : { CreateBucketConfiguration: { LocationConstraint: this.region as BucketLocationConstraint } }),
          ObjectOwnership: 'BucketOwnerEnforced',
        })
      );
      bucketCreated = true;
      await this.clients.s3.send(
        new PutPublicAccessBlockCommand({
          Bucket: bucket,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        })
      );

      await this.clients.iam.send(
        new CreateUserCommand({
          UserName: userName,
          Path: IAM_USER_PATH,
          Tags: [{ Key: 'drop:app', Value: appName }],
        })
      );
      userCreated = true;
      await this.clients.iam.send(
        new PutUserPolicyCommand({
          UserName: userName,
          PolicyName: USER_POLICY_NAME,
          PolicyDocument: bucketOnlyPolicy(bucket),
        })
      );
      const created = await this.clients.iam.send(new CreateAccessKeyCommand({ UserName: userName }));
      const accessKeyId = created?.AccessKey?.AccessKeyId;
      const secretAccessKey = created?.AccessKey?.SecretAccessKey;
      if (!accessKeyId || !secretAccessKey) {
        throw new Error('AWS returned no access key for the new user');
      }
      return { accessKeyId, secretAccessKey };
    } catch (err) {
      // Best-effort rollback of what THIS call created; the original error is
      // what the caller needs to see.
      if (userCreated) await this.removeUser(userName).catch(() => undefined);
      if (bucketCreated) await this.removeBucket(bucket).catch(() => undefined);
      throw err;
    }
  }

  async deprovision(input: { bucket: string; userName: string }): Promise<StorageDeprovisionResult> {
    const userDeleted = await this.removeUser(input.userName);
    const { objectsDeleted, bucketDeleted } = await this.removeBucket(input.bucket);
    return { objectsDeleted, bucketDeleted, userDeleted };
  }

  async whoAmI(): Promise<{ account: string }> {
    const identity = await this.clients.sts.send(new GetCallerIdentityCommand({}));
    return { account: String(identity?.Account ?? '') };
  }

  /** Keys, then the inline policy, then the user. True when the user existed. */
  private async removeUser(userName: string): Promise<boolean> {
    const keys = await ignoreGone(this.clients.iam.send(new ListAccessKeysCommand({ UserName: userName })));
    if (keys === undefined) return false;
    for (const key of keys?.AccessKeyMetadata ?? []) {
      await ignoreGone(
        this.clients.iam.send(new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: key.AccessKeyId }))
      );
    }
    await ignoreGone(
      this.clients.iam.send(new DeleteUserPolicyCommand({ UserName: userName, PolicyName: USER_POLICY_NAME }))
    );
    await ignoreGone(this.clients.iam.send(new DeleteUserCommand({ UserName: userName })));
    return true;
  }

  /** Every object version, delete marker and pending upload, then the bucket. */
  private async removeBucket(bucket: string): Promise<{ objectsDeleted: number; bucketDeleted: boolean }> {
    let objectsDeleted = 0;
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    for (;;) {
      const page = await ignoreGone(
        this.clients.s3.send(
          new ListObjectVersionsCommand({ Bucket: bucket, KeyMarker: keyMarker, VersionIdMarker: versionMarker })
        )
      );
      if (page === undefined) return { objectsDeleted, bucketDeleted: false };
      const targets = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map(
        (v: { Key?: string; VersionId?: string }) => ({ Key: v.Key, VersionId: v.VersionId })
      );
      for (let i = 0; i < targets.length; i += 1000) {
        const batch = targets.slice(i, i + 1000);
        await this.clients.s3.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch, Quiet: true } })
        );
        objectsDeleted += batch.length;
      }
      if (!page.IsTruncated) break;
      keyMarker = page.NextKeyMarker;
      versionMarker = page.NextVersionIdMarker;
    }

    const uploads = await ignoreGone(this.clients.s3.send(new ListMultipartUploadsCommand({ Bucket: bucket })));
    for (const upload of uploads?.Uploads ?? []) {
      await ignoreGone(
        this.clients.s3.send(
          new AbortMultipartUploadCommand({ Bucket: bucket, Key: upload.Key, UploadId: upload.UploadId })
        )
      );
    }

    const deleted = await ignoreGone(this.clients.s3.send(new DeleteBucketCommand({ Bucket: bucket })));
    return { objectsDeleted, bucketDeleted: deleted !== undefined };
  }
}
