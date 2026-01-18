# Changelog

All notable changes to DROP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
