# DROP

**Deploy, Run, Operate, Publish** | v2.0.0-rc.1

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
- **Multi-Runtime Support** - Node.js, Python, Docker, static sites
- **Framework Detection** - Recognizes Next.js, Nuxt, Express, FastAPI, Flask, and more
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

```bash
git clone https://github.com/techamat/drop.git
cd drop
npm install
# The dashboard is a separate package — install its deps once before building:
(cd src/dashboard && npm install)
npm run build        # compiles the server AND builds the dashboard
npm link             # makes the 'drop' command available globally
```

> If you only changed backend code, `npm run build:server` skips the dashboard
> build. The full `npm run build` requires the dashboard deps above.

On first start with auth enabled, DROP prints a one-time random admin password
to the console (and, in daemon mode, to the PM2 log). Change it immediately.

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

# Maintenance
drop backup                             # Snapshot state + database
drop backup --keep 14                   # Retain the last 14 backups
```

## Supported App Types

| Type | Detection | What DROP Does |
|------|-----------|----------------|
| **Node.js** | `package.json` | `npm install` + runs start script |
| **Next.js** | `next.config.*` | `npm install` + `npm run build` + starts |
| **Express/Fastify/Hono** | Dependencies | `npm install` + runs start script |
| **Static Site** | `index.html` | Serves with built-in static server |
| **SPA** | `index.html` + framework | Serves with SPA routing support |
| **Python** | `requirements.txt` | `pip install` + runs app |
| **Docker** | `Dockerfile` | `docker build` + `docker run` |

## Database Auto-Provisioning

Apps that need a database get one automatically. DROP:
1. Detects database dependencies (pg, mysql, prisma, etc.)
2. Provisions a PostgreSQL database
3. Injects `DATABASE_URL` environment variable

Your app just connects:
```javascript
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
```

## REST API

DROP includes a REST API for programmatic control:

```bash
# List apps
curl http://localhost:3000/api/apps

# Get app status
curl http://localhost:3000/api/apps/my-app

# Deploy (with API key)
curl -X POST http://localhost:3000/api/apps \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-app", "path": "/path/to/app"}'
```

## Web Dashboard

Access the dashboard at `http://localhost:3000/dashboard`:

- **Apps List** - View all deployed apps with status indicators
- **App Detail** - Start/stop/restart apps, view configuration
- **Logs Viewer** - Real-time log display with download option
- **Settings** - Platform configuration

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

build:
  command: npm run build

start:
  command: node dist/server.js

env:
  NODE_ENV: production
```

## Environment Variables

### Platform Variables
| Variable | Default | Description |
|----------|---------|-------------|
| `DROP_ROOT` | `C:\drop` or `/var/drop` | Base directory |
| `DROP_APPS_DIR` | `{root}/data/webapps` | Apps directory |
| `DROP_LOG_LEVEL` | `info` | Log level: debug, info, warn, error |

### Variables Injected Into Apps
| Variable | Description |
|----------|-------------|
| `PORT` | Assigned port for the app to listen on |
| `DROP_DATA_DIR` | Persistent data directory path |
| `DATABASE_URL` | PostgreSQL connection string (if database provisioned) |

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

Requires Docker Engine on Linux (Docker Desktop on Windows/macOS is
dev/best-effort only for this mode).

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
in the internal PostgreSQL database. Snapshot all of it with:

```bash
drop backup            # writes data/backup/backup-<timestamp>/
drop backup --keep 14  # keep the newest 14, prune the rest
```

A backup contains the JSON/YAML stores, `encryption.key`, and a `pg_dump` of
the internal database. **Schedule it yourself** (cron / Task Scheduler) — DROP
does not run backups automatically. To restore, stop DROP, copy the files back
into `data/drop-svc/` (and `data/appconf/webapps/`), and `pg_restore` the dump.

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
