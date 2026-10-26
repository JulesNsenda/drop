# Object storage (#301)

DROP can give an app its own S3 bucket, reached with a key that can touch **that
bucket and nothing else**. The buckets live in the operator's own AWS account;
DROP creates and destroys them with one admin credential the operator supplies,
and never hands that credential to an app.

> Status: this is the **operator half** — settings, the encrypted credential,
> and the provisioner. Attaching storage to an app (and the `AWS_*` / `S3_BUCKET`
> variables it injects) is the next change.

## What an app gets

For each app, DROP creates:

| Resource | Name | Notes |
|---|---|---|
| S3 bucket | `<prefix>-<app>-<8 hex>` | Public access blocked, ACLs disabled (bucket-owner-enforced). The random suffix keeps names unique across AWS's global bucket namespace. |
| IAM user | `drop-<prefix>-<app>`, path `/drop/` | One inline policy, `drop-bucket-access`: list the bucket, get/put/delete its objects, manage its multipart uploads. Nothing else — no ACLs, no bucket policy, no other bucket. |
| Access key | — | Stored encrypted in `data/drop-svc/object-storage.json` (0600). |

The app will receive the standard `AWS_REGION`, `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` — which every AWS SDK picks up with no code — plus
`S3_BUCKET`.

**Tearing an app's storage down destroys its data**: DROP revokes the key,
deletes the user, deletes every object and object version, aborts pending
uploads, and deletes the bucket. There is no backup.

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
