# Changelog

All notable changes to DROP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
  - Load balancing options
  - Automatic Caddy reload via admin API

#### CLI Commands
- `drop serve` - Start the DROP platform
- `drop list` (alias: `ls`) - List all deployed applications
- `drop status <app>` - Show detailed app status
- `drop logs <app>` - View application logs (-n, -f, -e options)
- `drop start <app>` - Start an application
- `drop stop <app>` - Stop an application (--force)
- `drop restart <app>` - Restart an application
- `drop deploy <path>` - Deploy app from path (--name, --port, --env)
- `drop remove <app>` (alias: `rm`) - Remove an application (--force, --keep-data)

#### Infrastructure
- Cross-platform support (Windows and Linux/macOS)
- Configurable via environment variables (DROP_ROOT, DROP_APPS_DIR, DROP_LOG_LEVEL)
- Structured logging system with file and console output
- Directory auto-creation on startup

### Known Limitations

- **Database integration incomplete**: App Registry code exists but is not wired into the platform startup. App metadata is not persisted between restarts.
- **Static server not implemented**: Static site detection works, but serving requires external HTTP server.
- **Test coverage below target**: Overall coverage is ~52% (target: 80%). Process Manager and database operations have minimal coverage.
- **No authentication**: Local access only, no security layer (planned for v0.2.0).
- **HTTP only**: No automatic HTTPS (planned for v0.3.0).
- **Single host only**: No clustering or replication (planned for v0.5.0).

### Technical Notes

- Built with TypeScript 5.7, targeting Node.js 20+
- Uses PM2 for process management
- Uses Caddy for reverse proxy
- PostgreSQL required for future database features (not used in this alpha)

## Version History

- **0.1.0-alpha.1**: Initial alpha release with core deployment pipeline

[Unreleased]: https://github.com/JulesNsenda/drop/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/JulesNsenda/drop/releases/tag/v0.1.0-alpha.1
