# Object storage (#301)

DROP can give an app its own S3 bucket, reached with a key that can touch **that
bucket and nothing else**. The buckets live in the operator's own AWS account;
DROP creates and destroys them with one admin credential the operator supplies,
and never hands that credential to an app.

Object storage is **attach-only**. There is no `drop.yaml` key and DROP never
infers it, because every bucket bills the operator's account. An app gets one
only because its owner asked for it.

## Requirements

Object storage holds your AWS admin key, so it is available **only** when:

- the platform runs with **container isolation** (`DROP_ISOLATION=docker`).
  Under `isolation: none`, tenant apps run on the same host as that key, and a
  PM2 app inherits the platform's environment; and
- **API authentication is on**. With it off, every route that can create
  buckets on your bill is open.

Either condition missing makes it unavailable (`isolation` / `auth-disabled` in
the admin settings) however well it is configured. Removing what already
exists still works. As defence in depth, a PM2 app no longer inherits the
platform's `DROP_`, `AWS_` or `CF_` environment (the admin key can live there),
unless it is given a variable explicitly.

## What an app gets

For each app, DROP creates:

| Resource | Name | Notes |
|---|---|---|
| S3 bucket | `<prefix>-<app>-<8 hex>` | Public access blocked, ACLs disabled (bucket-owner-enforced). The random suffix keeps names unique across AWS's global bucket namespace. |
| IAM user | `drop-<prefix>-<app>-<8 hex>`, path `/drop/` (same suffix as its bucket) | One inline policy, `drop-bucket-access`: list the bucket, get/put/delete its objects, manage its multipart uploads. Nothing else — no ACLs, no bucket policy, no other bucket. |
| Access key | — | Stored encrypted in `data/drop-svc/object-storage.json` (0600). The record also notes the owner and the app's creation time: a record belongs to one app, not to whoever holds the name later. |

The app receives the standard `AWS_REGION`, `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`, which every AWS SDK picks up with no code, plus
`S3_BUCKET`.

## Attaching and detaching

An app owner attaches object storage from the app's **Database** tab, or with
`POST /api/v1/apps/<app>/services/object-storage`. DROP creates the bucket,
user and key, waits (up to 30 seconds, backing off) until the app's new key
is actually accepted by S3 — a new IAM key takes a moment to propagate — then
restarts the app with the four variables. The row is disabled ("not set up on this platform") until the operator has finished the
setup below.

Attach is refused when:

- the app is ephemeral (it is torn down on a timer);
- the app is part of a monorepo group (group apps cannot detach a service);
- a previous detach has not finished (see below), or the name holds storage
  that belongs to a previous app of the same name, which an admin must resolve;
- the app already sets any variable an AWS SDK takes credentials, a region or
  an endpoint from — `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
  `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_REGION`, `AWS_ENDPOINT_URL`,
  `AWS_ENDPOINT_URL_S3` or `S3_BUCKET` — as a secret or in `drop.yaml` `env:`.
  The injected values would replace them and point the app at an empty bucket;
- the owner already holds `DROP_MAX_OBJECT_STORAGE_PER_USER` buckets (default
  3; `0` means unlimited). Live buckets, buckets still being deleted and
  buckets kept by a `keepData` delete all count, since all of them bill you.
  Apps deployed by the operator (with no owning user) are not counted.

**Detaching destroys the data.** `DELETE
/api/v1/apps/<app>/services/object-storage?confirm=<app>` records the intent,
revokes the app's key and deletes its IAM user, restarts the app without the
variables, and then deletes every object and object version, aborts pending
uploads, and deletes the bucket **in the background** (the request does not wait
for a large bucket). There is no backup.

The request is refused unless it comes from an **interactive session** (the
dashboard — never an API key, OAuth token or agent token) **and** names the app
in `?confirm=`. The dashboard's confirm dialog sends it.

A detach that did not finish shows as "Detach incomplete" with a retry button,
and **attaching is refused until it is finished** (retry the detach; it is
idempotent): attaching in between would hand the app a bucket that is about to
be emptied. The background step only touches a bucket while the owner's intent
is still `detached` and no attach, detach or delete is holding the app,
re-checked immediately before it deletes anything. If AWS refused to revoke the
key during the detach, the same background step revokes it first, so a failed
detach converges without a manual retry.

## When an app is deleted

Deleting an app deletes its bucket the same way, with no backup, and needs the
same `?confirm=<app>` when the app holds a bucket (a monorepo group delete is
confirmed with the group name), **from the dashboard only**: an interactive
session. The dashboard's delete dialog says so and sends the confirmation.
**Destroying a bucket cannot be done from the CLI, an API key, an OAuth token or
an agent token**, however privileged; they are refused with a 403.
`drop remove <app>` on an app that holds a bucket is refused with advice: use
`--keep-data` to delete the app and keep the bucket, or delete it from the
dashboard to destroy the bucket.

If the allocation store is unreadable, DROP cannot tell whether the app holds a
bucket: the delete answers 503 and says so (`keepData` still works) instead of
asking for a confirmation that would mean nothing.

The record is **moved off the app's name first**, before any AWS call, and the
bucket is torn down from that retired record; a large bucket is drained by a
background sweep, not while the request waits. A new app with the same name
always gets a new bucket, never the old one — and a record that somehow still
sits on a name is refused for any app whose owner and creation time do not
match it.

Two cases do not finish the job in one step:

- **`keepData=true`**: the bucket is kept, as the owner's data — but its IAM
  key is revoked and its user deleted, so nothing can keep writing to it. An
  admin lists these with `GET /api/v1/admin/object-storage/retired` and
  destroys one with `DELETE /api/v1/admin/object-storage/retired/<id>?confirm=<id>`,
  which, like detaching, needs an interactive session (not an API key) and is
  logged as `object-storage-bucket-destroyed`. A record quarantined because it
  was found on a name whose current app is not the one it was made for shows
  `quarantined: true`. They
  keep counting against their owner's `DROP_MAX_OBJECT_STORAGE_PER_USER`.
- **AWS refuses the teardown**: DROP retries it every 15 minutes until it
  succeeds. The sweep never runs twice at once, and shutting the platform down
  waits for one in progress (up to 30 seconds).

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
enabled and available, why not when it is not (`isolation`, `auth-disabled`,
`disabled`, `not-configured`, `no-credential`), whether a credential is configured (never the credential
itself), and how many apps have storage.

## Backup and restore

`drop backup` includes `object-storage.json` (which bucket and IAM user each app
has, and each app's encrypted key), encrypted under `encryption.key`, which is in
the same backup; `drop restore` puts it back. It does **not** include
`object-storage-credential.json`, your AWS admin key: encrypted under that same
`encryption.key`, it would put the key to your AWS account and the key that
opens it in one archive. After a restore, re-enter the credential (step 3
above, or `DROP_S3_ADMIN_*` in the service environment); `drop restore` says so.
At boot, DROP logs a warning for
every app whose owner attached object storage but which has no allocation on
record — what a restore from a backup that predates these files looks like. The
bucket still exists in AWS in that case; look for the `drop-` IAM users under
the `/drop/` path.

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
