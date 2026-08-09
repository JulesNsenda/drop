# DROP

**Deploy, Run, Operate, Publish**

![Release](https://img.shields.io/github/v/release/JulesNsenda/drop)

A lightweight, self-hosted Platform as a Service (PaaS) engineered for the "drop folder and deploy" workflow. Zero-configuration deployment for Node.js, Python, Go, static sites, and containerized applications.

> **Drop a folder, get a URL. Zero configuration for 80% of use cases.**

## Features

- **Zero-config deployment** — auto-detects app type, builds, and starts
- **Multi-runtime** — Node.js, Python, Go, Docker, static sites and SPAs, with framework detection for Next.js, Nuxt, SvelteKit, Astro, Express, FastAPI, Flask and more
- **Hostname routing and automatic HTTPS** — Let's Encrypt certificates, per-app custom domains
- **PostgreSQL auto-provisioning** — apps get their own database with `DATABASE_URL` injected
- **Managed Redis** — opt in from `drop.yaml`
- **Hot reload** — edit files and the app rebuilds and restarts
- **Monorepos** — several services from one repo, sharing a hostname with same-origin `/api` routing
- **MCP server** — deploy and manage apps from Claude, Claude Code, Cursor and other agents
- **Docker isolation** — run tenant apps in containers with resource limits, for multi-user setups
- **REST API and web dashboard** — full API with JWT and API key auth, real-time monitoring UI
- **Persistent data** — app data survives upgrades via `DROP_DATA_DIR`
- **Cross-platform** — Windows, Linux and macOS

## Documentation

Full documentation lives at **[dropkit.sh/docs](https://dropkit.sh/docs)**, and every CLI command and API endpoint is catalogued in the **[reference](https://dropkit.sh/docs/api)**. This README covers installing DROP, the trust model you should read before exposing it, and disaster recovery.

| Topic | Where |
|---|---|
| `drop.yaml` fields, monorepos, required secrets | [docs → drop.yaml](https://dropkit.sh/docs#drop-yaml) |
| Environment variables (platform and injected) | [docs → Environment variables](https://dropkit.sh/docs#environment-variables) |
| Persistent data directories | [docs → Persistent data](https://dropkit.sh/docs#persistent-data) |
| Supported runtimes and how detection works | [docs → Runtimes & detection](https://dropkit.sh/docs#runtimes) |
| Caddy routing, HTTPS, wildcard certs, custom domains | [docs → Routing & HTTPS](https://dropkit.sh/docs#routing-https) |
| Database auto-provisioning and what triggers it | [docs → Databases](https://dropkit.sh/docs#databases) |
| Log capture and retention | [docs → Logs](https://dropkit.sh/docs#logs) |
| Connecting Claude, Cursor and other agents | [docs → Integrations](https://dropkit.sh/docs#claude-web) |
| Every CLI command and REST endpoint | [reference](https://dropkit.sh/docs/api) |

Also in this repo: [HTTPS setup](docs/HTTPS-SETUP.md), [git redeploy and custom domains](docs/GIT-REDEPLOY-AND-CUSTOM-DOMAINS.md), [agent deploys](docs/AGENT-DEPLOY.md).

## Requirements

**Release install (recommended, Linux):** a fresh Debian/Ubuntu box with root access. `install.sh` provisions Node.js, PostgreSQL, Caddy, and (if you choose `--isolation=docker`) Docker Engine for you — no toolchain to install yourself.

**Build from source:** Node.js 20+, npm 9+, and optionally Caddy 2.0+ for hostname routing.

## Install

`install.sh` refuses to run piped straight from `curl` — it needs an on-disk copy of itself to work from — so save it first, then run it:

```bash
curl -fsSL https://github.com/JulesNsenda/drop/releases/latest/download/install.sh -o install.sh && sudo bash install.sh --from-release --isolation=docker
```

`--from-release` installs the latest published release: no `git clone`, and no TypeScript or Vite build on your machine. (Node.js is still required and the installer sets it up for you. `npm` may log a failed optional build for `cpu-features` — that is harmless; it is an optional native accelerator for `ssh2` and the install completes without it.)

It requires you to pick an isolation mode explicitly on a first install:

- **`--isolation=docker`** (recommended) — tenant apps build and run in Docker containers with resource limits and no access to the platform's secrets.
- **`--isolation=none`** — tenant apps run as the `drop` system user, the same user that owns the platform's encryption key and JWT/OAuth secrets. Only choose this on a single machine where every deployer is fully trusted; see [Security & Trust Model](#security--trust-model).

Add `--domain=example.com --https --acme-email=you@example.com` once DNS points at the box, or pin a specific version with `--from-release=v1.0.0` instead of the latest.

Once the service is up, retrieve the one-time admin password from the platform log and change it immediately:

```bash
journalctl -u drop-platform -b --no-pager | grep -A1 'Default Admin Credentials'
```

> **Windows**: `install.sh` targets systemd/apt Linux boxes. On Windows, run `install.bat` (or build from source) and start with `drop serve` directly — Windows is fully supported under `isolation: none`.

### Verifying what you are about to run as root

`install.sh` verifies the downloaded tarball's SHA-256 checksum itself before installing anything. To also verify it was built by this repo's own GitHub Actions, check the build provenance attestation:

```bash
gh release download --repo JulesNsenda/drop -p drop-dist.tar.gz
gh attestation verify drop-dist.tar.gz --repo JulesNsenda/drop
```

> Attestations are attached by the release workflow on every release built after this repository became public. If `gh attestation verify` reports no attestation for a given release, that release predates it — fall back to the published `drop-dist.tar.gz.sha256`, which `install.sh` checks automatically.

Every release also attaches [`drop-dist.tar.gz`](https://github.com/JulesNsenda/drop/releases/latest/download/drop-dist.tar.gz) (compiled server, CLI and dashboard), its `.sha256`, and [`install.sh`](https://github.com/JulesNsenda/drop/releases/latest/download/install.sh), so you can fetch and inspect them by hand on an air-gapped box. All releases are listed [here](https://github.com/JulesNsenda/drop/releases).

### Build from source

For contributors, or to run from a branch instead of a release:

```bash
git clone https://github.com/JulesNsenda/drop.git
cd drop
npm install
(cd src/dashboard && npm install)   # the dashboard is a separate package
npm run build                       # compiles the server AND builds the dashboard
npm link                            # makes the 'drop' command available globally
```

> If you only changed backend code, `npm run build:server` skips the dashboard build.

On first start, `drop serve` prints the one-time admin password to the console. Change it immediately.

## Quick Start

```bash
drop serve                               # start the platform
cp -r my-app /var/drop/data/webapps/     # drop a folder in (Windows: xcopy to C:\drop\data\webapps\)
```

DROP detects the app type, installs dependencies, builds, provisions a PostgreSQL database if the app needs one, and starts it on an assigned port. Your app is then at `http://localhost:<port>`, or at `http://my-app.localhost` with Caddy installed. Edit any file and it rebuilds and restarts.

The dashboard is at `http://localhost:3000/dashboard` — apps list, per-app start/stop/restart, secrets, custom domains, deploy history, logs, user management, and the Claude connector details.

For the CLI and REST API, see the [reference](https://dropkit.sh/docs/api). A running DROP redirects `/dashboard/docs` and `/dashboard/reference` there.

## Security & Trust Model

**Read this before exposing DROP to anyone you don't fully trust.**

DROP ships two explicit isolation modes with different trust guarantees.

### `isolation: none` (default) — single-user / trusted deployments

Deploying an app means running its code (install/build scripts and the app process) on the host as the DROP process user. A deployed app — or its build script — can read other apps' data and the platform's own files.

**Use this when:** it's your machine or a machine you control, and everyone with deploy access is trusted. Treat deploy access like shell access.

- Never enable `allowSignup` in this mode — DROP refuses at startup.
- Disable auth only on a trusted local machine (`DROP_DISABLE_AUTH=true`).
- Windows is fully supported in this mode.

### `isolation: docker` — multi-user / invited users

Apps build and run in Docker containers with strict resource limits (`--cap-drop=ALL`, `--security-opt no-new-privileges`, memory/CPU caps, `--pids-limit`). Build containers have no access to platform secrets and cannot reach the LAN or cloud-metadata endpoints.

**Honest residual risks** (documented, not hidden):

- **Shared kernel**: containers are not VMs. A kernel exploit grants full host access. This is documented here, not mitigated.
- **Egress**: containers can reach the internet (package installs need it). Container→LAN/metadata is blocked; full egress policy is a future release.
- **Shared-domain cookies**: subdomains of one registrable domain share the same-site context. Apps at `a.yourdomain.com` and `b.yourdomain.com` can read each other's cookies. Use a dedicated `baseDomain` for multi-tenant use, or submit it to the Public Suffix List.
- **Open signup** (`allowSignup: true`) enables self-service registration. Abuse tooling, takedown runbooks, and egress enforcement for hostile public access are future work. Treat open-internet signup as documented residual risk until then.
- **Deps must land in the app dir.** Build and run happen in separate ephemeral containers sharing only the `/app` bind mount (no image commit), so only dependencies written *into the app dir* reach the runtime. Node (`node_modules`), Go (compiled binary) and Python (an `/app`-local `.venv`, whose `bin/` is put on the runtime `PATH`) all land there. Anything a custom build command installs into system site-packages or a global prefix is discarded with the build container — the build "succeeds" and the app then fails to import at boot.

Requires Docker Engine on Linux (Docker Desktop on Windows/macOS is dev/best-effort only for this mode).

Build containers run as the **platform's own (non-root) user** so they can write the app source without needing `CAP_DAC_OVERRIDE`. Apps deployed through DROP (git deploy, webhook, `drop deploy`) are owned by that user automatically. If you instead **place a folder into `data/webapps/` by hand**, own it as the platform user (e.g. `chown -R drop:drop`) — a folder owned by a different user (a `sudo cp` as root) will fail the build with `EACCES` (fail-closed by design; DROP will not run an untrusted build as root to work around it).

### What's hardened in both modes

- API auth (JWT + API keys), role tiers (`readonly`/`user`/`admin`)
- Rate limiting keyed on socket peer address (not spoofable `x-forwarded-for`)
- Path traversal and containment checks on all file I/O and deploy paths
- SSRF guard on webhook and git-clone URLs (private range + DNS-resolution check)
- Strict `drop.yaml` schema (unknown keys rejected; TLS paths confined to app dir)
- `drop.yaml` values never reach `docker run` args or mount specs directly
- Uploaded archives carrying `.git` metadata are refused outright
- Git credentials are passed to git through the environment, never written to `.git/config` or visible in `ps`
- Audit log for all deploy/build/start/secret/suspend operations
- Bundled PostgreSQL locked to scram-sha-256; unix socket restricted to peer auth

See `.env.example` for all security-relevant settings.

## Backup & Restore

DROP keeps critical state in the file stores under `data/drop-svc/` (credentials, encrypted secrets, the encryption key, webhooks, app state) and in PostgreSQL — both the internal `drop_internal` database and **every provisioned per-app database**. Snapshot all of it with:

```bash
drop backup            # writes data/backup/backup-<timestamp>/
drop backup --keep 14  # keep the newest 14, prune the rest
```

A backup contains the JSON/YAML stores, `encryption.key`, a `pg_dump` of `drop_internal`, and a `pg_dump -Fc` of **each per-app database** under `databases/` (plus a generated `databases/restore-roles.sql` that recreates the app DB roles). **Schedule it yourself** (cron / Task Scheduler) — DROP does not run backups automatically. The backup command exits non-zero if any dump — per-app, internal, or the database enumeration itself — fails, so a cron job that only checks the exit code will still catch a partial backup.

**Caveat: backups are same-platform only.** A backup taken on Windows will not restore on Linux (and vice versa) — the bundled PostgreSQL binaries and data layout are platform-specific.

### Restore

`drop restore` reverses a backup. It is **destructive** — it overwrites the current file stores and databases — so it refuses to run while the platform is up, requires `--confirm`, and prints its plan first:

```bash
drop restore data/backup/backup-<timestamp>/            # prints the plan, writes nothing
drop restore data/backup/backup-<timestamp>/ --confirm  # actually restores
```

- **Stop the platform first.** A running `drop serve` holds state in memory and would stomp the restore; `drop restore` refuses if it detects a daemon *or* a foreground platform still answering on the API port.
- **File stores** (`data/drop-svc/`, `data/appconf/webapps/`) are copied back with their modes preserved (secrets stay `0600`).
- **Databases** are replayed with the bundled `psql`/`pg_restore` — but note that `drop server stop` also stops the bundled PostgreSQL, so in the normal flow `drop restore` finds it unreachable, **prints the exact per-database commands, and skips the automatic DB step**. To restore databases automatically, start PostgreSQL standalone first and re-run:

  ```bash
  "<dropRoot>/apps/drop-svc/pgsql/bin/pg_ctl" -D "<dropRoot>/data/db" start
  drop restore data/backup/backup-<timestamp>/ --confirm
  ```

The DB step authenticates against the **currently running** server's `data/drop-svc/.pg-superuser` (read before any file is overwritten), not the backup's copy. After a restore the running server's password and the restored file may diverge until the next platform restart.

**Doing it by hand** (equivalent to what `drop restore` runs, and what it prints when it skips the DB step):

```bash
BIN=<dropRoot>/apps/drop-svc/pgsql/bin ; export PGPASSWORD="$(cat data/drop-svc/.pg-superuser)"
# 1. Recreate app roles (clean server runs clean; on a re-run, "role already exists" is expected/benign)
"$BIN/psql" -h 127.0.0.1 -p 5433 -U postgres -d postgres -f databases/restore-roles.sql
# 2. Recreate + restore each database, drop_internal included (--create makes the DB AND restores REVOKE CONNECT)
"$BIN/pg_restore" -h 127.0.0.1 -p 5433 -U postgres --create -d postgres databases/drop_<app>.dump
#    (re-run over existing DBs: add --clean --if-exists ; check exit codes, don't ignore stderr)
```

Use the bundled `pg_restore`/`psql` under `apps/drop-svc/pgsql/bin` — not a system Postgres client, since major-version mismatches can corrupt the restore. Backups are **same-platform only** (a Windows backup won't restore on Linux), and the DB restore round-trip is **not covered by automated tests** — validate on a non-production box first.

### Pre-delete database dumps

Deleting an app (`drop remove <app>` / `DELETE /api/v1/apps/:name`) dump-then-drops its provisioned database: before the database is dropped, DROP `pg_dump`s it to `data/backup/pre-delete/<db>-<timestamp>.dump` plus a companion `<db>-<timestamp>.restore-role.sql` (recreates the role, since `-Fc` doesn't capture it). The drop only happens if the dump verifies; if `pg_dump` fails or Postgres is down, the database is left intact instead of being lost. Pre-delete dumps are retained for `DROP_PREDELETE_RETENTION_DAYS` days (default **3**) and pruned automatically on each subsequent delete — copy any you want to keep permanently off-box before then.

Run `drop remove --keep-data <app>` to skip dump-then-drop entirely and leave the database in place.

To restore a pre-delete dump, use the same procedure as the [Restore](#restore) section above: run its `.restore-role.sql` with `psql`, then `pg_restore --create` the `.dump` file.

## Upgrading

DROP keeps PM2-managed app processes running across a platform restart, but the bundled PostgreSQL and Caddy are stopped and restarted with the platform, so expect a brief blip in database connectivity and routing during an upgrade.

- Back up first (`drop backup`).
- If you run the daemon, `drop server stop` then `drop serve -d` after upgrading — a plain `pm2 restart` keeps the old args/path from the PM2 dump.
- **Note:** as of v1.0, `drop serve -d` honors `--root/--domain/--https/...` flags that were previously ignored. If you have been passing flags that had no effect, they now take effect — review them before upgrading (e.g. a stray `--https` will actually enable HTTPS and validate your domain config).

Breaking changes are listed at the top of each release's notes in the [CHANGELOG](CHANGELOG.md).

## Development

```bash
npm run dev          # start in development mode
npm run build        # build server + dashboard
npm test             # run tests
npm run lint         # lint
```

Branching model and conventions: [docs/GIT-BRANCHING-MODEL.md](docs/GIT-BRANCHING-MODEL.md). Roadmap detail: [docs/VERSION-ROADMAP.md](docs/VERSION-ROADMAP.md).

## Roadmap

- [x] ~~Zero-config deploy, hot reload, PostgreSQL auto-provisioning, REST API + web dashboard, Caddy reverse proxy, automatic HTTPS~~ (0.1.0–0.3.0)
- [x] ~~Docker isolation, hosted MCP server + OAuth 2.1, monorepo/multi-service deploys, managed Redis, custom domains~~ (1.0.0)
- [ ] Log aggregation and search
- [ ] Multi-node clustering

## License

MIT License - see [LICENSE](LICENSE) for details.
