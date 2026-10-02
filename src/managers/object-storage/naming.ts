/**
 * Bucket and IAM user names for an app (#301).
 *
 * S3 bucket names are GLOBAL across every AWS account and allow only
 * lowercase letters, digits, '-' and '.', 3-63 characters, starting and
 * ending alphanumeric. DROP app names allow '_' and capitals, so the app part
 * is normalised, and a random suffix keeps two DROP installs (or an app
 * deleted and recreated) from colliding with a name someone else holds.
 * '.' is never produced: dotted bucket names break virtual-hosted TLS.
 *
 * IAM user names allow [A-Za-z0-9+=,.@_-], at most 64 characters; they live
 * under the `/drop/` path so an operator can find (and scope policy to)
 * everything DROP created.
 */

import { randomBytes } from 'crypto';

export const IAM_USER_PATH = '/drop/';

/** Operator-chosen prefix: lowercase alphanumerics and '-', 1-20 chars, alphanumeric at both ends. */
export const BUCKET_PREFIX_RE = /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/;

function slug(value: string, max: number): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned.slice(0, max).replace(/-$/, '') || 'app';
}

/** `<prefix>-<app>-<8 hex>`, always a valid S3 bucket name. */
export function bucketNameFor(prefix: string, appName: string, suffix = randomBytes(4).toString('hex')): string {
  const budget = 63 - prefix.length - suffix.length - 2;
  return `${prefix}-${slug(appName, budget)}-${suffix}`;
}

/**
 * `drop-<prefix>-<app>-<suffix>` — the same random suffix as the bucket.
 * Without it, deleting an app whose teardown failed (its user retired, not
 * yet removed) would make a recreated app of the same name collide with the
 * old user on `CreateUser` and fail to attach until the retry sweep caught up.
 */
export function iamUserNameFor(prefix: string, appName: string, suffix: string): string {
  const budget = 64 - prefix.length - suffix.length - 'drop---'.length;
  const app = appName.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, budget);
  return `drop-${prefix}-${app}-${suffix}`;
}

/** A fresh random suffix, shared by an allocation's bucket and IAM user. */
export function newResourceSuffix(): string {
  return randomBytes(4).toString('hex');
}

/** A policy granting object read/write/list on one bucket, and nothing else. */
export function bucketOnlyPolicy(bucket: string): string {
  return JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ListThisBucket',
        Effect: 'Allow',
        Action: ['s3:ListBucket', 's3:GetBucketLocation', 's3:ListBucketMultipartUploads'],
        Resource: `arn:aws:s3:::${bucket}`,
      },
      {
        Sid: 'ObjectsInThisBucket',
        Effect: 'Allow',
        Action: [
          's3:GetObject',
          's3:PutObject',
          's3:DeleteObject',
          's3:AbortMultipartUpload',
          's3:ListMultipartUploadParts',
        ],
        Resource: `arn:aws:s3:::${bucket}/*`,
      },
    ],
  });
}
