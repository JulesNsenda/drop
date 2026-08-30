# Deploy and rollback

Every push to `develop` deploys production. The deploy stops the service, ships
the artifact, re-applies provisioning, and gates on health — and since Landing C
it can put the previous release back on its own when that gate fails.

## What a deploy does

1. CI verifies (lint, shellcheck, typecheck, test, build) and packages
   `drop-dist.tar.gz`, hashing it in the job that built it.
2. The deploy job re-hashes the copy that came back through the artifact hop and
   refuses to ship on a mismatch.
3. It scp's the tarball to `/opt/drop/staging/` — a drop-owned `0700` directory,
   not `/tmp`.
4. It unpacks `scripts/deploy/remote-deploy.sh` **from that tarball** and runs
   it over ssh with two arguments: the runner-computed `install.sh` digest, and
   the staged tarball path.

`remote-deploy.sh` then:

- validates both arguments before touching anything;
- takes a `flock` so a manual rollback cannot interleave with it;
- **snapshots** `dist/` and `package-lock.json` to `/opt/drop/rollback.tar.gz`;
- stops the service, replaces `dist/` and `install.sh`, and runs `npm ci` only
  when the lockfile actually changed;
- re-applies provisioning, warns on provisioning drift;
- probes `/api/v1/health/live` for 60s.

## Exit codes

The job fails on anything but `0`, but the code says which failure it was:

| Code | Meaning | What to do |
|---|---|---|
| `0` | deployed and healthy | nothing |
| `10` | failed its health gate and **rolled back**; the previous release is serving | diagnose the bad build; production is up |
| `1` | failed, and the box state is **unknown** | check the box now |

`1` covers a rollback that itself failed, a first deploy with no previous
release to restore, and a refused precondition (which happens before anything is
touched, so the box is untouched in that case).

## Automatic rollback

Fires only when the health gate fails, and makes **exactly one attempt**:

1. stop the service;
2. restore `dist/` and `package-lock.json` from the snapshot;
3. reinstall dependencies **from the restored lockfile**, if its hash differs
   from what is installed — restoring code without its dependencies is what
   makes a rollback as likely to fail as the deploy it is undoing;
4. start, and gate on health again.

It never re-runs `--provision`. That rewrites the systemd unit, Caddy and the
apex route — infra, not code — and rolling code back through it is the wrong
order.

A slow boot can fail the gate for a **good** build, in which case the rollback's
own gate fails identically and you get `1`. That is a real outcome rather than
an oversight: the honest answer at that point is "state unknown".

## Manual rollback

For the failure the automatic path does not cover: a deploy that passed the gate
and is found bad afterwards.

```bash
ssh <deploy-user>@<host>
bash /opt/drop/staging/rollback.sh
```

It takes the same lock, so it refuses to run while a deploy is in flight, and it
holds no privileged verb beyond the closed sudoers list (stop / start / restart
/ status / `--provision`).

## What rollback does NOT undo

**It restores code and dependencies. It does not undo what a bad release already
did to tenant apps.**

Under `Restart=on-failure` with `RestartSec=5`, a release that boots far enough
to start the watcher and then dies re-runs boot reconciliation on every cycle —
Caddyfile regeneration, per-app config writes, container recreation. Those
survive the rollback.

So a rollback needs a fleet sanity check, not just a green gate:

```bash
drop list --all           # every app in the state you expect?
curl -fsS localhost:3000/api/v1/health
```

How much of this applies depends on `DROP_BOOT_RECONCILE` in `/etc/drop/drop.env`
— the code default is `off`. **Check the box** rather than assuming; it was last
measured on 2026-07-26 and the platform has restarted many times since.

## The snapshot

One deep, at `/opt/drop/rollback.tar.gz`, overwritten by each successful deploy.
It is not a backup: it holds `dist/` and `package-lock.json`, nothing else. For
platform state — secrets, app config, databases — that is `drop backup`, which
is a separate mechanism with its own retention.

## Testing the deploy script

`scripts/deploy/remote-deploy.sh` is the one thing on the path to production
with no unit test and no way to have one. `scripts/deploy/smoke-test.sh` runs it
in a Debian container against a fake `/opt/drop` with `systemctl`, `sudo`,
`curl` and `npm` stubbed, and asserts the **end state**: that the service was
stopped before the untar, that the rollback restores the old build and exits
`10`, that a second identical run is idempotent and skips `npm ci`, and that a
bad argument is refused before anything is touched.

CI runs it on every PR. Locally:

```bash
docker run --rm -v "$PWD":/repo -w /repo debian:12-slim \
  bash scripts/deploy/smoke-test.sh
```
