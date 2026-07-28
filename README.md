# DROP

**Deploy, Run, Operate, Publish** | v2.0.0-rc.3

A lightweight, self-hosted Platform as a Service (PaaS) engineered for the "drop folder and deploy" workflow. Zero-configuration deployment for Node.js, Python, static sites, and containerized applications.

## Philosophy

> **Drop a folder, get a URL. Zero configuration for 80% of use cases.**

## Features

- **Zero-Config Deployment** - Auto-detects app type, builds, and starts automatically
- **Hostname Routing** - Access apps at `myapp.localhost` (requires Caddy)
- **Automatic HTTPS** - Let's Encrypt certificates with zero configuration
- **Hot Reload** - Edit files and your app rebuilds/restarts automatically
- **PostgreSQL Auto-Provisioning** - Apps get their own database with `DATABASE_URL` injected
- **Port Persistence** - Apps keep the same port across restarts
- **Multi-Runtime Support** - Node.js, Python, Go, Docker, static sites
- **Framework Detection** - Recognizes Next.js, Nuxt, SvelteKit, Astro, Express, FastAPI, Flask, and more
- **Required Secrets** - Declare them in `drop.yaml`; DROP generates or prompts instead of crash-looping
- **Monorepos** - Several services from one repo, sharing a hostname with same-origin `/api` routing
- **MCP Server** - Deploy and manage apps from Claude, Claude Code, Cursor and other agents
- **Process Management** - Built on PM2 for reliable process management with auto-restart
- **REST API** - Full API with JWT and API key authentication
- **Web Dashboard** - Real-time monitoring UI at `/dashboard`
- **Auto-Capture Logging** - Stdout/stderr captured to dated log files automatically
- **Persistent Data Directories** - App data survives upgrades (`DROP_DATA_DIR`)
- **Custom Domains** - Per-app domain configuration via `drop.yaml`
- **Cross-Platform** - Works on Windows, Linux, and macOS
- **CLI Interface** - Full-featured command-line tool for management

## Requirements

- Node.js 20+
- npm 9+
- Caddy 2.0+ (optional, for hostname routing)

## Quick Start

### 1. Install

> The repository is **private**, so the old public `curl … | sudo bash`
> one-liner no longer works (the raw URL 404s without auth). Use the owner
> bootstrap below instead.

**Server bootstrap (owner / operator)**

A freshly-provisioned box is brought up in two parts: a one-time `--bootstrap`
that installs the system dependencies, and the GitHub Actions pipeline
(`.github/workflows/deploy.yml`) that ships and runs the built code on every push.

```bash
# From your laptop (you have the repo checked out — no GitHub token needed):
scp install.sh root@<NEW_IP>:/tmp/install.sh
ssh root@<NEW_IP> "bash /tmp/install.sh --bootstrap --domain=dropkit.sh \
    --deploy-pubkey='$(cat drop-deploy.pub)'"
#   add --https --acme-email=you@example.com on a later run, once HTTP works
```

`--bootstrap` installs Node.js 20, PostgreSQL, Caddy, a C toolchain (for native
deps), creates the `drop` user + `/opt/drop`, seeds the CI deploy key into
`authorized_keys`, and registers the `drop-platform` systemd service **without**
fetching or starting any code. Then set the `hetzner`-environment secrets
(`DEPLOY_HOST`, `DEPLOY_USER=drop`, `DEPLOY_KEY_B64`) and push — CI builds the
server + dashboard, scps the artifact, and starts the service.

Full step-by-step (DNS, firewall, deploy keypair, HTTPS) lives in
`docs/plans/2026-06-19-one-command-bootstrap.md`.

> **Windows** (`install.bat`) does not yet support the private repo — clone with
> your own credentials and run a manual/dev install for now.

**Development / manual install**

```bash
git clone https://github.com/JulesNsenda/drop.git
cd drop
npm install
# The dashboard is a separate package — install its deps once:
(cd src/dashboard && npm install)
npm run build        # compiles the server AND builds the dashboard
npm link             # makes the 'drop' command available globally
```

> If you only changed backend code, `npm run build:server` skips the dashboard
> build.

On first start, DROP prints a one-time random admin password to the console.
Change it immediately.

### 2. Start DROP

```bash
drop serve
```

You'll see:
```
[DROP] Starting DROP platform...
[DROP]   Apps directory: C:\drop\data\webapps
[DROP] DROP platform started successfully
```

### 3. Deploy an App

Copy any app folder to the webapps directory:

```bash
# Windows
xcopy my-app C:\drop\data\webapps\my-app\ /E /I

# Linux/macOS
cp -r my-app /var/drop/data/webapps/
```

DROP automatically:
1. Detects the app type (Node.js, Python, static, etc.)
2. Installs dependencies
3. Builds the app
4. Provisions a PostgreSQL database (if needed)
5. Starts the app on an assigned port

### 4. Access Your App

```
http://localhost:3001
```

Or with Caddy installed, access via hostname:
```
http://my-app.localhost
```

### 5. Edit and Hot-Reload

Edit any file in your app - DROP detects changes and automatically rebuilds/restarts.

## CLI Commands

```bash
# Platform
drop serve                # Start DROP platform
drop serve -d             # Start as background daemon
drop serve -r /custom     # Custom root directory
drop server status        # Background service status
drop server logs -f       # Stream background service logs
drop server restart       # Restart the background service
drop server stop          # Stop the background service

# Applications
drop list                 # List running apps
drop list --all           # Include stopped apps
drop status my-app        # Check app status
drop logs my-app          # View logs
drop logs my-app -n 50    # Last 50 lines

# Management
drop stop my-app          # Stop app
drop start my-app         # Start app
drop restart my-app       # Restart app
drop remove my-app        # Remove app

# Deploy
drop deploy ./my-app                    # Deploy from path
drop deploy ./my-app --name custom      # Custom name
drop deploy ./my-app --port 4000        # Specific port
drop deploy --git <url> --branch main   # Deploy from a GitHub repo

# Maintenance
drop backup                             # Snapshot state + database
drop backup --keep 14                   # Retain the last 14 backups
drop restore <backup-dir>               # Preview a restore (writes nothing)
drop restore <backup-dir> --confirm     # Restore from a backup (stop the platform first)
drop migrate-runtime my-app --to docker # Move an app between PM2 and Docker
drop mfa disable <username>             # Admin recovery for a lost TOTP device
drop version                            # Show the CLI version
```

Every command and flag is listed at `/reference` on a running DROP.

## Supported App Types

| Type | Detection | What DROP Does |
|------|-----------|----------------|
| **Node.js** | `package.json` | `npm install` + runs start script |
| **Next.js** | `next.config.*` | `npm install` + `npm run build` + starts |
| **Express/Fastify/Hono** | Dependencies | `npm install` + runs start script |
| **Python** | `requirements.txt`, `pyproject.toml`, `setup.py`, or `Pipfile` | Installs into an in-app `.venv` + runs app |
| **Go** | `go.mod` | `go build` + runs the binary (gin, fiber, echo, chi, gorilla recognized) |
| **Docker** | `Dockerfile` | `docker build` + `docker run` |
| **Static Site** | `index.html` | Serves with built-in static server |
| **SPA** | `index.html` + framework | Serves with SPA routing support |

## Database Auto-Provisioning

Apps that need a database get one automatically. DROP provisions and injects
`DATABASE_URL` when any of these is true:

1. `drop.yaml` says `database: postgres` — the explicit form, and the only way
   to ask from a non-Node app
2. A Postgres client or ORM is in `package.json` (`pg`, `pg-promise`,
   `postgres`, `slonik`, `@prisma/client`, `prisma`, `drizzle-orm`, `knex`,
   `sequelize`, `typeorm`, `objection`, `@mikro-orm/postgresql`)
3. An ORM config file is present (`prisma/schema.prisma`, `drizzle.config.*`,
   `knexfile.*`, `ormconfig.json`, `typeorm.config.ts`, `sequelize.config.js`,
   `.sequelizerc`)

A MySQL, MongoDB or SQLite driver does **not** trigger provisioning — DROP only
runs PostgreSQL, and handing such an app a `postgres://` URL it cannot use is
worse than handing it nothing. And if you supply your own `DATABASE_URL` — as a
secret or in the `drop.yaml` `env:` block — DROP steps aside rather than
overriding it (an explicit `database: postgres` still wins).

Provisioning happens on **deploy**, not on a plain restart, and a full per-user
database quota means the app starts without a `DATABASE_URL` (with a warning in
the platform log).

Your app just connects:
```javascript
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
```

## REST API

DROP includes a REST API for programmatic control:

All routes are mounted under `/api/v1`, and auth is on by default:

```bash
# List apps
curl http://localhost:3000/api/v1/apps \
  -H "X-API-Key: <api-key>"

# Get app status
curl http://localhost:3000/api/v1/apps/my-app \
  -H "X-API-Key: <api-key>"

# Deploy
curl -X POST http://localhost:3000/api/v1/apps \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "path": "/path/to/app"}'
```

Every endpoint, with the role each one requires, is catalogued at
`/reference` on a running DROP.

## Deploy From an AI Agent (MCP)

DROP hosts a Model Context Protocol server at `/api/v1/mcp`, so Claude,
Claude Code, Cursor and other MCP clients can deploy and manage apps as
native tools — `deploy_files`, `deploy_from_git`, `list_apps`,
`app_status`, `app_logs`, `get_deploy_logs`, `restart_app`. There is no
tool for reading secrets or deleting an app.

Clients that send headers authenticate with a `user`-role API key:

```bash
claude mcp add --transport http dropkit \
  https://drop.example.com/api/v1/mcp \
  --header "Authorization: Bearer <user-api-key>"
```

The claude.ai web connector uses OAuth instead, so nobody pastes a key
into a browser — it needs `DROP_PUBLIC_URL` set to a public HTTPS
origin. Full setup is at `/docs` on a running DROP.

## Web Dashboard

Access the dashboard at `http://localhost:3000/dashboard`, with a public
site at `/`, docs at `/docs`, and the CLI/API reference at `/reference`:

- **Apps List** - View all deployed apps with status indicators
- **App Detail** - Start/stop/restart apps, secrets, custom domain, deploy history
- **Deploy** - Deploy from a path or a GitHub repo
- **Logs Viewer** - Real-time log display with download option
- **Users** - User management (admin)
- **Settings** - Platform configuration, including the Claude (MCP) connector details

## Logging

DROP automatically captures all console output (stdout/stderr) to dated log files:

```
C:\drop\data\logs\webapps\my-app\
├── my-app-2026-01-18-out.log    # stdout
└── my-app-2026-01-18-err.log    # stderr
```

View logs via CLI:
```bash
drop logs my-app          # View recent logs
drop logs my-app -n 100   # Last 100 lines
```

Or view/download in the dashboard.

For custom structured logging, use the `DROP_DATA_DIR` environment variable:
```javascript
const logDir = process.env.DROP_DATA_DIR || './data';
fs.appendFileSync(`${logDir}/logs/app.json`, JSON.stringify(logEntry) + '\n');
```

## Persistent Data Directories

Apps get a persistent data directory that survives source code upgrades:

```
C:\drop\data\appdata\my-app\
├── uploads/     # User-uploaded files
├── logs/        # Custom app logs
└── cache/       # Cache files
```

Access via `DROP_DATA_DIR` environment variable:
```javascript
const dataDir = process.env.DROP_DATA_DIR;
const uploadsPath = path.join(dataDir, 'uploads', filename);
```

## Directory Structure

```
C:\drop\                     # Windows (or /var/drop on Linux)
├── data/
│   ├── webapps/             # Your deployed apps (watched)
│   ├── appdata/             # Persistent data per app
│   ├── drop-svc/            # Platform state
│   ├── appconf/
│   │   └── webapps/         # Per-app config files
│   └── logs/
│       ├── drop-svc/        # Platform logs
│       └── webapps/         # App logs (auto-captured)
```

## Configuration (Optional)

For explicit configuration, create `drop.yaml` in your app:

```yaml
name: my-app
type: nodejs
domains:
  - app.example.com
database: postgres
redis: true

build: npm run build
start: node dist/server.js

env:
  NODE_ENV: production

secrets:
  JWT_SECRET: generate
```

`build` and `start` are plain strings, not nested objects. Unknown
top-level keys are rejected outright, so a typo fails the deploy instead
of being silently ignored.

Declaring `secrets:` makes DROP resolve them *before* the app starts —
auto-generating what it can, and parking the app in a `needs-config`
status naming the missing keys instead of letting it crash-loop.

A repo holding several services deploys as one unit via `group:` and
`services:`, which share a hostname so a frontend can call its backend
same-origin at `/api`. See `/docs` on a running DROP for the full field
list and examples.

## Environment Variables

### Platform Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `DROP_ROOT` | `C:\drop` or `/var/drop` | Base directory |
| `DROP_APPS_DIR` | `{root}/data/webapps` | Apps directory |
| `DROP_API_PORT` | `3000` | Port for the REST API and dashboard |
| `DROP_LOG_LEVEL` | `info` | Log level: debug, info, warn, error |
| `DROP_PUBLIC_URL` | *(unset)* | Public HTTPS origin. Required for the claude.ai connector — OAuth fails closed without it |
| `DROP_DISABLE_AUTH` | `false` | Turn API auth off entirely. Auth is **on** by default |
| `DROP_ISOLATION` | `none` | `none` runs apps under PM2, `docker` runs each in a container |
| `DROP_ENABLE_REDIS` | `true` | Run the bundled managed Redis |
| `DROP_MAX_APPS_PER_USER` | `5` | Default per-user app quota (a per-user override wins; admins are unlimited) |

### Variables Injected Into Apps
| Variable | Description |
|----------|-------------|
| `PORT` | Assigned port for the app to listen on |
| `DROP_DATA_DIR` | Persistent data directory path |
| `DATABASE_URL` | PostgreSQL connection string (if database provisioned) |
| `REDIS_URL` | Managed Redis connection string (if `redis: true` in `drop.yaml`) |
| `DROP_API_URL` | Base URL for DROP's own REST API (`http://drop-host:<apiPort>` under docker isolation, `http://127.0.0.1:<apiPort>` otherwise) |
| `DROP_API_KEY` | Least-privilege scoped key for calling DROP's own API — only for apps an admin granted capabilities to |

## Hostname Routing (Caddy)

When Caddy is installed, DROP automatically configures hostname-based routing:

```
my-app.localhost  →  localhost:3001
api.localhost     →  localhost:3002
```

### Install Caddy

```bash
# Windows (with Chocolatey)
choco install caddy

# macOS (with Homebrew)
brew install caddy

# Linux (Debian/Ubuntu)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

### How It Works

- DROP detects Caddy on startup and manages it automatically
- Each deployed app gets a `.localhost` hostname
- Modern browsers resolve `.localhost` automatically (no `/etc/hosts` editing)
- If Caddy isn't installed, apps are still accessible via direct ports

### Graceful Degradation

| Scenario | Behavior |
|----------|----------|
| Caddy installed | Apps accessible at `myapp.localhost` |
| Caddy not installed | Apps accessible at `localhost:PORT` |
| Port 80 in use | Warning logged, direct port access works |

## HTTPS & SSL

DROP supports automatic HTTPS with Let's Encrypt certificates.

### Quick Start (HTTPS)

```bash
drop serve --domain example.com --https --acme-email admin@example.com
```

Apps are now accessible at `https://myapp.example.com` with valid certificates.

### Wildcard Certificates

For wildcard certificates (`*.example.com`), use DNS-01 challenge:

```bash
export CF_API_TOKEN=your-cloudflare-token
drop serve --domain example.com --https --wildcard --dns-provider cloudflare
```

Supported DNS providers: `cloudflare`, `route53`, `digitalocean`, `godaddy`

### Per-App Custom Domains

Configure custom domains in your app's `drop.yaml`:

```yaml
name: my-app
domains:
  - myapp.com
  - www.myapp.com
```

See [HTTPS Setup Guide](docs/HTTPS-SETUP.md) for complete documentation.

## Security & Trust Model

**Read this before exposing DROP to anyone you don't fully trust.**

DROP v2.0 ships two explicit isolation modes with different trust guarantees:

### `isolation: none` (default) — single-user / trusted deployments

Deploying an app means running its code (install/build scripts and the app
process) on the host as the DROP process user. A deployed app — or its build
script — can read other apps' data and the platform's own files.

**Use this when:** it's your machine or a machine you control, and everyone
with deploy access is trusted. Treat deploy access like shell access.

- Never enable `allowSignup` in this mode — DROP refuses at startup.
- Disable auth only on a trusted local machine (`DROP_DISABLE_AUTH=true`).
- Windows is fully supported in this mode.

### `isolation: docker` — multi-user / invited users

Apps build and run in Docker containers with strict resource limits
(`--cap-drop=ALL`, `--security-opt no-new-privileges`, memory/CPU caps,
`--pids-limit`). Build containers have no access to platform secrets and
cannot reach the LAN or cloud-metadata endpoints.

**Honest residual risks** (documented, not hidden):

- **Shared kernel**: containers are not VMs. A kernel exploit grants full host
  access. This is documented here, not mitigated.
- **Egress**: containers can reach the internet (package installs need it).
  Container→LAN/metadata is blocked; full egress policy is v2.1.
- **Shared-domain cookies**: subdomains of one registrable domain share the
  same-site context. Apps at `a.yourdomain.com` and `b.yourdomain.com` can
  read each other's cookies. Use a dedicated `baseDomain` for multi-tenant use,
  or submit it to the Public Suffix List.
- **Open signup** (`allowSignup: true`) enables self-service registration.
  Abuse tooling, takedown runbooks, and egress enforcement for hostile public
  access are v2.1 territory. Treat open-internet signup as documented residual
  risk until then.
- **Deps must land in the app dir.** Build and run happen in separate ephemeral
  containers sharing only the `/app` bind mount (no image commit), so only
  dependencies written *into the app dir* reach the runtime. Node
  (`node_modules`), Go (compiled binary) and Python (an `/app`-local `.venv`,
  whose `bin/` is put on the runtime `PATH`) all land there. Anything a custom
  build command installs into system site-packages or a global prefix is
  discarded with the build container — the build "succeeds" and the app then
  fails to import at boot.

Requires Docker Engine on Linux (Docker Desktop on Windows/macOS is
dev/best-effort only for this mode).

Build containers run as the **platform's own (non-root) user** so they can write
the app source without needing `CAP_DAC_OVERRIDE`. Apps deployed through DROP
(git deploy, webhook, `drop deploy`) are owned by that user automatically. If
you instead **place a folder into `data/webapps/` by hand**, own it as the
platform user (e.g. `chown -R drop:drop`) — a folder owned by a different user
(a `sudo cp` as root) will fail the build with `EACCES` (fail-closed by design;
DROP will not run an untrusted build as root to work around it).

### What's hardened in both modes

- API auth (JWT + API keys), role tiers (`readonly`/`user`/`admin`)
- Rate limiting keyed on socket peer address (not spoofable `x-forwarded-for`)
- Path traversal and containment checks on all file I/O and deploy paths
- SSRF guard on webhook and git-clone URLs (private range + DNS-resolution check)
- Strict `drop.yaml` schema (unknown keys rejected; TLS paths confined to app dir)
- `drop.yaml` values never reach `docker run` args or mount specs directly
- Audit log for all deploy/build/start/secret/suspend operations
- Bundled PostgreSQL locked to scram-sha-256; unix socket restricted to peer auth

See `.env.example` for all security-relevant settings and
`docs/MIGRATION-v1-to-v2.md` if you are upgrading from v1.0.

## Backup & Restore

DROP keeps critical state in the file stores under `data/drop-svc/`
(credentials, encrypted secrets, the encryption key, webhooks, app state) and
in PostgreSQL — both the internal `drop_internal` database and **every
provisioned per-app database**. Snapshot all of it with:

```bash
drop backup            # writes data/backup/backup-<timestamp>/
drop backup --keep 14  # keep the newest 14, prune the rest
```

A backup contains the JSON/YAML stores, `encryption.key`, a `pg_dump` of
`drop_internal`, and a `pg_dump -Fc` of **each per-app database** under
`databases/` (plus a generated `databases/restore-roles.sql` that recreates
the app DB roles). **Schedule it yourself** (cron / Task Scheduler) — DROP
does not run backups automatically. The backup command exits non-zero if any
dump — per-app, internal, or the database enumeration itself — fails, so a
cron job that only checks the exit code will still catch a partial backup.

**Caveat: backups are same-platform only.** A backup taken on Windows will
not restore on Linux (and vice versa) — the bundled PostgreSQL binaries and
data layout are platform-specific.

### Restore

`drop restore` reverses a backup. It is **destructive** — it overwrites the
current file stores and databases — so it refuses to run while the platform is
up, requires `--confirm`, and prints its plan first:

```bash
drop restore data/backup/backup-<timestamp>/            # prints the plan, writes nothing
drop restore data/backup/backup-<timestamp>/ --confirm  # actually restores
```

- **Stop the platform first.** A running `drop serve` holds state in memory and
  would stomp the restore; `drop restore` refuses if it detects a daemon *or* a
  foreground platform still answering on the API port.
- **File stores** (`data/drop-svc/`, `data/appconf/webapps/`) are copied back
  with their modes preserved (secrets stay `0600`).
- **Databases** are replayed with the bundled `psql`/`pg_restore` — but note
  that `drop server stop` also stops the bundled PostgreSQL, so in the normal
  flow `drop restore` finds it unreachable, **prints the exact per-database
  commands, and skips the automatic DB step**. To restore databases
  automatically, start PostgreSQL standalone first and re-run:

  ```bash
  "<dropRoot>/apps/drop-svc/pgsql/bin/pg_ctl" -D "<dropRoot>/data/db" start
  drop restore data/backup/backup-<timestamp>/ --confirm
  ```

The DB step authenticates against the **currently running** server's
`data/drop-svc/.pg-superuser` (read before any file is overwritten), not the
backup's copy. After a restore the running server's password and the restored
file may diverge until the next platform restart.

**Doing it by hand** (equivalent to what `drop restore` runs, and what it
prints when it skips the DB step):

```bash
BIN=<dropRoot>/apps/drop-svc/pgsql/bin ; export PGPASSWORD="$(cat data/drop-svc/.pg-superuser)"
# 1. Recreate app roles (clean server runs clean; on a re-run, "role already exists" is expected/benign)
"$BIN/psql" -h 127.0.0.1 -p 5433 -U postgres -d postgres -f databases/restore-roles.sql
# 2. Recreate + restore each database, drop_internal included (--create makes the DB AND restores REVOKE CONNECT)
"$BIN/pg_restore" -h 127.0.0.1 -p 5433 -U postgres --create -d postgres databases/drop_<app>.dump
#    (re-run over existing DBs: add --clean --if-exists ; check exit codes, don't ignore stderr)
```

Use the bundled `pg_restore`/`psql` under `apps/drop-svc/pgsql/bin` — not a
system Postgres client, since major-version mismatches can corrupt the restore.
Backups are **same-platform only** (a Windows backup won't restore on Linux),
and the DB restore round-trip is **not covered by automated tests** — validate
on a non-production box first.

### Pre-delete database dumps

Deleting an app (`drop remove <app>` / `DELETE /api/v1/apps/:name`) now
dump-then-drops its provisioned database: before the database is dropped,
DROP `pg_dump`s it to `data/backup/pre-delete/<db>-<timestamp>.dump` plus a
companion `<db>-<timestamp>.restore-role.sql` (recreates the role, since
`-Fc` doesn't capture it). The drop only happens if the dump verifies; if
`pg_dump` fails or Postgres is down, the database is left intact instead of
being lost. Pre-delete dumps are retained for `DROP_PREDELETE_RETENTION_DAYS`
days (default **3**) and pruned automatically on each subsequent delete —
copy any you want to keep permanently off-box before then.

Run `drop remove --keep-data <app>` to skip dump-then-drop entirely and leave
the database in place.

To restore a pre-delete dump, use the same procedure as the [Restore](#restore)
section above: run its `.restore-role.sql` with `psql`, then
`pg_restore --create` the `.dump` file.

## Upgrading

DROP keeps PM2-managed app processes running across a platform restart, but the
bundled PostgreSQL and Caddy are stopped and restarted with the platform, so
expect a brief blip in database connectivity and routing during an upgrade.

- Back up first (`drop backup`).
- If you run the daemon, `drop server stop` then `drop serve -d` after upgrading
  — a plain `pm2 restart` keeps the old args/path from the PM2 dump.
- **Note:** as of v1.0, `drop serve -d` honors `--root/--domain/--https/...`
  flags that were previously ignored. If you have been passing flags that had no
  effect, they now take effect — review them before upgrading (e.g. a stray
  `--https` will actually enable HTTPS and validate your domain config).

## Development

```bash
npm run dev          # Start in development mode
npm run build        # Build for production
npm test             # Run tests
npm run lint         # Lint code
npm run format       # Format code
```

## Roadmap

- [x] ~~Web dashboard UI~~ (v0.1.0)
- [x] ~~PostgreSQL auto-provisioning~~ (v0.1.0)
- [x] ~~Hot reload~~ (v0.1.0)
- [x] ~~REST API with authentication~~ (v0.1.0)
- [x] ~~Caddy reverse proxy integration~~ (v0.2.0)
- [x] ~~Automatic HTTPS with Let's Encrypt~~ (v0.3.0)
- [x] ~~Custom domains per app~~ (v0.3.0)
- [ ] Log aggregation and search
- [ ] Multi-node clustering

## License

MIT License - see [LICENSE](LICENSE) for details.
