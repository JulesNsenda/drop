# DROP v1.0 → v2.0 Migration Guide

**Audience:** operators upgrading an existing v1.0 DROP instance.

> v2.0 is backwards-compatible for single-user installs: the default
> `isolation: none` mode is unchanged from v1.0. Most operators can upgrade
> in place with zero config changes and still get the security improvements
> on the platform-facing surface (stricter drop.yaml, SSRF guard, real-IP
> rate limiting).

---

## Quick upgrade checklist

1. `git pull` / install the new package.
2. `npm run build` (or restart the daemon binary).
3. DROP starts, runs `db:migrate` automatically, and regenerates the
   Caddyfile if it detects the old format (see "Caddyfile regeneration" below).
4. Check the startup log for warnings — especially around the signup gate and
   Caddy availability if you use custom domains.
5. Read the breaking changes table below. Most only apply if you were using
   the features listed.

---

## Isolation mode (new in v2.0)

DROP now has two explicit modes:

| Mode | Config | Who it's for |
|---|---|---|
| `isolation: none` | Default; no change needed | Single-user, trusted deploys |
| `isolation: docker` | `DROP_ISOLATION=docker` or `isolation: docker` in config | Multi-user, invited users |

**If you don't set `DROP_ISOLATION`**, you get `isolation: none` — the v1.0
behavior. Your existing PM2-managed apps continue to work without changes.

### Switching to docker mode

Docker mode requires:
- Linux host with Docker Engine (Docker Desktop on Windows/macOS is
  dev/best-effort only).
- Caddy available in `PATH` (clear startup error if missing).
- Auth enabled (the default; `DROP_DISABLE_AUTH` must not be `true`).

Set `DROP_ISOLATION=docker` (or `isolation: docker` in your config), then
start DROP. On first boot in docker mode:

1. DROP stops all PM2-managed apps and migrates them to containers one by one
   (`drop migrate-runtime <app>` can also do this per-app).
2. Each app is rebuilt in an ephemeral build container, then started in a
   runtime container on the same port as before.
3. If a migration fails, the app rolls back to PM2 and is flagged with a
   warning — your service stays up.

Per-app rollback is handled automatically; you don't need to do anything
special unless a specific app fails its container migration.

---

## Breaking changes

| Area | v1.0 behaviour | v2.0 behaviour | Action needed |
|---|---|---|---|
| **Signup** | `POST /auth/signup` always enabled | Off by default; requires `allowSignup: true` + docker mode | Set `DROP_ALLOW_SIGNUP=true` if you relied on open signup; also requires `DROP_ISOLATION=docker` |
| **`drop.yaml` unknown keys** | Silently ignored | Rejected with a validation error | Remove any custom/unknown keys from your `drop.yaml` files |
| **`drop.yaml` TLS paths** | Any host path accepted | Must be inside the app directory | Move cert/key files into the app dir, or use absolute paths that resolve within it |
| **Caddy (docker mode)** | Optional | Required in docker mode | Install Caddy or switch back to `isolation: none` |
| **PostgreSQL `pg_hba`** | App containers connected via unix socket (trust) | scram-sha-256 over TCP; unix socket restricted to platform process | No action for app code using `DATABASE_URL` — the env var is automatically updated |
| **Webhook URLs** | Any URL accepted | Private-range and cloud-metadata URLs blocked | Update webhooks that point to `192.168.*`, `10.*`, `169.254.169.254`, etc. |
| **Rate limiting** | Keyed on `x-forwarded-for` | Keyed on socket peer address; XFF trusted only from loopback Caddy | No action needed; protects against header spoofing |

---

## Caddyfile regeneration

v2.0 adds a version header (`# DROP Caddyfile v2`) to the managed Caddyfile.
On startup, if the existing Caddyfile lacks this header, DROP regenerates it
from the current app configs.

**What this means:** if you have hand-edited the Caddyfile, your edits will be
**overwritten** on first v2.0 boot. Back up any manual changes before upgrading:

```bash
cp data/appconf/Caddyfile data/appconf/Caddyfile.v1-backup
```

Custom Caddy directives that aren't managed by DROP (TLS options, custom
matchers, etc.) should be put in a separate file and included with an
`import` directive that DROP won't overwrite.

---

## PM2 → container per-app migration

If you switched to `isolation: docker`, the first-boot migrator handles this
automatically. To migrate a single app manually:

```bash
drop migrate-runtime <appname>
```

This stops the PM2 process, rebuilds in a container, starts the container on
the same port, and updates the app's runtime record. If the build or container
start fails, the PM2 process is restarted.

---

## Signup gate

In v1.0, `POST /auth/signup` was always mounted with no off-switch. In v2.0
it is **off by default**. To enable:

1. Set `DROP_ISOLATION=docker` (required — signup is forbidden in PM2 mode).
2. Set `DROP_ALLOW_SIGNUP=true`.
3. Keep auth enabled (default).

Without all three conditions, startup fails with a clear error message.

---

## Backup changes

`drop backup` now includes a `pg_dump` of the internal database in addition to
the file stores. No change to the command syntax; the dump appears in the
backup directory as `drop_internal.dump`.

To restore a v2.0 backup:
```bash
# Stop DROP
# Restore file stores:
cp backup-<timestamp>/{apps.json,secrets.json,...} data/drop-svc/
cp -r backup-<timestamp>/webapps/ data/appconf/webapps/
# Restore internal DB:
pg_restore -h 127.0.0.1 -p 5433 -U postgres -d drop_internal \
  backup-<timestamp>/drop_internal.dump
# Start DROP
```

---

## New features in v2.0 (no migration needed)

- **Build logs**: every deploy captures stdout/stderr to
  `data/logs/builds/<app>/`. View via `GET /api/v1/logs/<app>/build` or the
  dashboard build-log panel (shown automatically on failure).
- **Faster installs**: the Node.js builder uses `npm ci` when a lockfile is
  present, and skips install entirely when the lockfile hasn't changed.
- **Zero-downtime hot-reload**: the old process keeps serving during a
  rebuild; it's only stopped after the new build succeeds. Build failures
  leave the live version running.
- **Health checks**: set `healthCheck: /health` in `drop.yaml`. Docker mode
  injects a container `HEALTHCHECK`; PM2 mode starts a prober that restarts
  the process after 3 consecutive failures.
- **CPU/memory stats**: `GET /api/v1/apps/:name` now returns live `memory`
  and `cpu` fields for running apps. Dashboard app cards show these values.
- **Shareable URLs**: `GET /api/v1/apps` returns a `url` field for every app
  with a hostname configured.

---

## Questions?

Open an issue at the project repository, or check the plan doc at
`docs/plans/2026-06-11-v2-plan.md` for the full design rationale.
