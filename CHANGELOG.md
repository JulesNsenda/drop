# Changelog

All notable changes to DROP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Work toward the **v1.0.0** production release. Tracked in
`docs/plans/2026-06-11-production-release-plan.md`. Scope: self-hosted with
trusted/semi-trusted tenants; container isolation and SQLite state remain on
the v2.0 roadmap (see the README "Security & Trust Model" section).

### Security

- **Access control:** `PUT /apps/:name` and the log endpoints now enforce
  ownership (fixes IDOR — a user could previously take over or read any app),
  and `PUT` accepts only a safe field allowlist (no more `userId`/`path`
  overwrites). `POST /apps` contains the deploy path inside the webapps dir
  (realpath, defeats symlink/junction/.. escapes).
- **Webhooks:** GitHub webhook verification no longer skips when the signature
  header is omitted, guards `JSON.parse`, and length-checks before
  `timingSafeEqual`. Missing-secret deliveries warn now and will be rejected in
  a future release. Outbound webhook URLs reject localhost/private/link-local
  targets (SSRF).
- **Auth:** authentication is on by default (set `DROP_DISABLE_AUTH=true` to
  disable); JWT verification pinned to HS256; legacy password hashes compared
  in constant time and upgraded to scrypt on login; `/auth/signup` rate-limited.
- **Secrets:** app secrets are encrypted with the standalone `encryption.key`
  (or `DROP_MASTER_KEY`) instead of a key derived from the store itself;
  existing stores migrate transparently.
- **Misc:** CORS defaults to same-origin (`DROP_CORS_ORIGINS` to allowlist);
  added a Content-Security-Policy; git branch names validated; build
  subprocesses no longer inherit platform secrets; `webhooks.json` is `0600`;
  500 responses no longer leak internal error text.

### Added

- Continuous integration (GitHub Actions): lint, server build, tests, and
  dashboard build on every PR to `main`/`develop`.
- `drop backup` command: snapshots the file stores + a `pg_dump` of the
  internal database, with retention.
- Atomic, crash-safe writes (temp + fsync + rename) for every JSON/YAML state
  store; corrupt `apps.json` is quarantined instead of silently wiped.
- Dashboard v1.0 UX: session-expiry handling with redirect (PRD-024), 404 page
  (PRD-025), logout redirect + toast (PRD-026), app-limit indicator and
  `GET /api/v1/usage` (PRD-027), signup-success notice (PRD-028); app links and
  the API endpoint derive from the current host instead of `localhost`.
- `.env.example`, a LICENSE file, and a `files`/`prepublishOnly` package config.
- `scripts/create-migration.ts` restored; `.sql` migrations are copied into
  `dist` so a built deployment can run them.

### Changed

- Version set to `1.0.0-rc.0`.
- `drop serve -d` now applies the `--root/--domain/--https/...` flags it
  forwards (previously ignored). **Review forwarded flags before upgrading.**
- Boot recovery: apps whose process died while marked `running` are set to
  `pending` (and restarted by the startup scan) instead of `stopped`.
- `/health`, the CLI, and `drop version` read the version from `package.json`.
- Dashboard assets served with immutable cache headers; `index.html` is
  `no-cache`.
- Git redeploy (API + webhook) now always triggers a rebuild+restart after a
  successful pull, including no-change pulls, instead of relying on the
  watcher to notice file changes.

### Fixed

- Resolved all ESLint errors; activity logging consolidated behind a
  best-effort `tryLogActivity` helper.
- Deploy pipeline: `build:completed` carries a `success` flag and the platform
  no longer starts an app after a failed build; the `appsInProgress` guard no
  longer leaks (which had permanently dead-ended hot reload).
- Process safety: `unhandledRejection`/`uncaughtException` handlers and a
  bounded, guarded shutdown; `waitForStatus` throws on timeout; build commands
  hard-timeout and kill the process tree; app logs are tail-read (no OOM on
  multi-GB files); `certExpiryTimer` is `unref()`'d.
- Caddy stderr/unexpected exit logged at warn and surfaced via `platform:error`
  instead of being swallowed at debug.

## [0.1.0] - 2026-01-18

First stable release of DROP with full deployment pipeline, hot-reload, and database auto-provisioning.

### Added

- **Hot Reload** - Automatic rebuild/restart when app files change
  - Detects changes to .ts, .js, .tsx, .jsx, .py, .go, .rs files
  - Detects changes to package.json, requirements.txt, Dockerfile, etc.
  - 2-second debounce to batch rapid changes
  - 5-second cooldown after deploys to prevent loops

- **PostgreSQL Auto-Provisioning**
  - Bundled PostgreSQL server with auto-start
  - Per-app database creation
  - Automatic `DATABASE_URL` injection
  - Secure credential generation

- **Port Persistence**
  - Per-app YAML config files in `appconf/webapps/`
  - Apps keep the same port across restarts
  - Port ownership tracking to prevent conflicts

- **REST API** (PRD-009)
  - JWT authentication
  - API key authentication
  - Endpoints: GET/POST /api/apps, GET /api/apps/:name
  - App management via API

- **Daemon Mode**
  - `drop serve -d` runs platform in background
  - Proper process detachment

- **App Config Service**
  - Per-app YAML configuration files
  - Stores: type, port, hostname, path, timestamps
  - Source of truth for port assignments

### Changed

- Router now updates existing routes instead of throwing errors (upsert behavior)
- File watcher uses polling by default on Windows for reliability
- State manager preserves port on app re-registration

### Fixed

- Port allocation now tracks ownership (Map instead of Set)
- Apps reuse their assigned port from config on restart
- No more "Route already exists" errors on hot-reload

### Technical

- 390 passing tests
- ESLint v9 flat config
- TypeScript strict mode

---

## [0.1.0-alpha.1] - 2026-01-03

### Added

#### Core Platform
- **Event Bus** (PRD-006): Typed pub/sub system for loose coupling between services
  - Event history tracking
  - Subscription management with unsubscribe support
  - Debug logging for event flow

- **Watcher Service** (PRD-001): File system monitoring for automatic app detection
  - Monitors `webapps` directory for new folders
  - Debounced change detection to prevent rapid rebuilds
  - Emits `watcher:change` events for detected apps

- **Detector Service** (PRD-002): Automatic application type detection
  - Node.js detection (package.json, npm/yarn/pnpm)
  - Python detection (requirements.txt, pyproject.toml, Pipfile)
  - Docker detection (Dockerfile, docker-compose.yml)
  - Static site detection (index.html, HTML files)
  - Framework detection (Express, NestJS, Next.js, Hono, Flask, FastAPI, Django)

- **Builder Service** (PRD-003): Application build pipeline
  - Strategy pattern for different app types
  - Node.js builder (npm/yarn/pnpm install + build)
  - Python builder (pip/poetry/pipenv install)
  - Docker builder (docker build)
  - Static site builder (copy files)
  - Build event emission for pipeline coordination

- **Process Manager** (PRD-004): PM2-based process lifecycle management
  - Start/stop/restart applications
  - Log streaming with follow mode
  - Process status monitoring
  - Automatic restart on crash

- **Router Service** (PRD-008): Caddy reverse proxy integration
  - Dynamic Caddyfile generation
  - Route management (add/remove/update)
  - TLS/SSL configuration support

#### CLI Commands
- `drop serve` - Start the DROP platform
- `drop list` - List all deployed applications
- `drop status <app>` - Show detailed app status
- `drop logs <app>` - View application logs
- `drop start <app>` - Start an application
- `drop stop <app>` - Stop an application
- `drop restart <app>` - Restart an application
- `drop deploy <path>` - Deploy app from path
- `drop remove <app>` - Remove an application

#### Infrastructure
- Cross-platform support (Windows and Linux/macOS)
- Configurable via environment variables
- Structured logging system
- Directory auto-creation on startup

---

## Roadmap

### 0.2.0 (Planned)
- Caddy reverse proxy integration
- Hostname routing (myapp.localhost)
- Automatic HTTPS with Let's Encrypt

### 0.3.0 (Planned)
- Web dashboard UI
- Real-time log streaming
- App metrics and monitoring

[Unreleased]: https://github.com/techamat/drop/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/techamat/drop/compare/v0.1.0-alpha.1...v0.1.0
[0.1.0-alpha.1]: https://github.com/techamat/drop/releases/tag/v0.1.0-alpha.1
