# Object storage (#301)

DROP can give an app its own S3 bucket, reached with a key that can touch **that
bucket and nothing else**. The buckets live in the operator's own AWS account;
DROP creates and destroys them with one admin credential the operator supplies,
and never hands that credential to an app.

Object storage is **attach-only**. There is no `drop.yaml` key and DROP never
infers it, because every bucket bills the operator's account. An app gets one
only because its owner asked for it.

## What an app gets

For each app, DROP creates:

| Resource | Name | Notes |
|---|---|---|
| S3 bucket | `<prefix>-<app>-<8 hex>` | Public access blocked, ACLs disabled (bucket-owner-enforced). The random suffix keeps names unique across AWS's global bucket namespace. |
| IAM user | `drop-<prefix>-<app>-<8 hex>`, path `/drop/` (same suffix as its bucket) | One inline policy, `drop-bucket-access`: list the bucket, get/put/delete its objects, manage its multipart uploads. Nothing else — no ACLs, no bucket policy, no other bucket. |
| Access key | — | Stored encrypted in `data/drop-svc/object-storage.json` (0600). |

The app receives the standard `AWS_REGION`, `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`, which every AWS SDK picks up with no code, plus
`S3_BUCKET`.

## Attaching and detaching

An app owner attaches object storage from the app's **Database** tab, or with
`POST /api/v1/apps/<app>/services/object-storage`. DROP creates the bucket,
user and key, then restarts the app with the four variables. The row is
disabled ("not set up on this platform") until the operator has finished the
setup below.

Attach is refused when:

- the app is ephemeral (it is torn down on a timer);
- the app is part of a monorepo group (group apps cannot detach a service);
- the app already sets `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` or
  `S3_BUCKET` itself, as a secret or in `drop.yaml` `env:`. The injected
  values would replace them and point the app at an empty bucket;
- the owner already has `DROP_MAX_OBJECT_STORAGE_PER_USER` buckets (default
  3; `0` means unlimited). Apps deployed by the operator (with no owning user)
  are not counted.

**Detaching destroys the data.** `DELETE
/api/v1/apps/<app>/services/object-storage` revokes the key, deletes the
user, deletes every object and object version, aborts pending uploads, and
deletes the bucket. There is no backup. The app stops receiving the variables
as soon as the detach is recorded, even if AWS then refuses the teardown. A
detach that did not finish shows as "Detach incomplete" with a retry button.

## When an app is deleted

Deleting an app deletes its bucket the same way, with no backup. Two cases keep
it instead:

- **`keepData=true`**: the bucket and its key are kept, for the operator to
  deal with.
- **AWS refuses the teardown**: DROP retries it every 15 minutes until it
  succeeds.

In both cases the record is moved off the app's name. A new app with the same
name always gets a new bucket, never the old one.

Apps with object storage attached are never removed by the idle reaper, since
that would delete the bucket.

## Setting it up

1. Create an IAM user (or role) for DROP with the policy below, and an access
   key for it.
2. In `GET/PUT /api/v1/admin/settings/object-storage`, set a `region` (e.g.
   `eu-central-1`) and a `bucketPrefix` (1–20 lowercase letters, digits and
   hyphens, unique to this DROP install), and `enabled: true`.
3. `PUT /api/v1/admin/settings/object-storage/credential` with
   `{ "accessKeyId": "...", "secretAccessKey": "..." }` — or set
   `DROP_S3_ADMIN_ACCESS_KEY_ID` and `DROP_S3_ADMIN_SECRET_ACCESS_KEY` in the
   service environment, which take precedence and are never written to disk.
4. `POST /api/v1/admin/object-storage/test` — reports the AWS account the key
   belongs to, or the AWS error name.

`GET /api/v1/admin/settings` reports an `objectStorage` block: whether it is
enabled and available, why not when it is not (`disabled`, `not-configured`,
`no-credential`), whether a credential is configured (never the credential
itself), and how many apps have storage.

There is deliberately **no endpoint setting**. A settable endpoint would let an
admin — or anyone holding an admin session — point DROP at a host they control
and receive the operator's AWS key on the next call. Support for another
S3-compatible provider will be a new provider implementation, not a URL field.

## The admin credential's policy

Replace `PREFIX` with your `bucketPrefix` and `ACCOUNT` with your AWS account id.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DropBuckets",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:PutBucketPublicAccessBlock",
        "s3:PutBucketOwnershipControls",
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:ListBucketMultipartUploads",
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:AbortMultipartUpload",
        "s3:DeleteBucket"
      ],
      "Resource": ["arn:aws:s3:::PREFIX-*", "arn:aws:s3:::PREFIX-*/*"]
    },
    {
      "Sid": "DropUsers",
      "Effect": "Allow",
      "Action": [
        "iam:CreateUser",
        "iam:TagUser",
        "iam:PutUserPolicy",
        "iam:DeleteUserPolicy",
        "iam:CreateAccessKey",
        "iam:ListAccessKeys",
        "iam:DeleteAccessKey",
        "iam:DeleteUser"
      ],
      "Resource": "arn:aws:iam::ACCOUNT:user/drop/*"
    }
  ]
}
```

**Know what this credential can do.** `iam:PutUserPolicy` on `/drop/*` users
means whoever holds DROP's admin key can create a `/drop/` user and give it any
policy — including more than S3. Keep the key out of anything but DROP, prefer
the environment variables to the stored copy, and consider an IAM permissions
boundary on the `/drop/` path, or a dedicated AWS account for DROP's buckets,
so that the ceiling is the account rather than the policy.
