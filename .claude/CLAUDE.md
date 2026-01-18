# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DROP (Deploy, Run, Operate, Publish) is a self-hosted PaaS for "drop folder and deploy" workflows. Drop a folder into the webapps directory and get a running application with zero configuration.

**Philosophy**: Drop a folder, get a URL. Zero configuration for 80% of use cases.

## Commands

```bash
# Development
npm run dev              # Start with ts-node
npm run build            # Compile TypeScript
npm run build:watch      # Watch mode compilation

# Testing
npm test                 # Run all tests
npm test -- --watch      # Watch mode
npm test -- path/to/file.test.ts  # Single test file
npm run test:coverage    # Coverage report (80% threshold)

# Quality
npm run lint             # ESLint check
npm run lint:fix         # Auto-fix lint issues
npm run format           # Prettier format
npm run format:check     # Check formatting

# Database
npm run db:migrate       # Run migrations
npm run db:migrate:create <name>  # Create new migration

# CLI (after npm link or npm run build)
drop serve               # Start DROP platform
drop list                # List running apps
drop status <app>        # App status
drop logs <app>          # View logs
drop deploy <path>       # Deploy from path
```

## Architecture

### Event-Driven Pipeline

The platform uses a central EventBus (`src/core/event-bus/`) for loose coupling. The main flow:

```
Watcher (chokidar)     → watcher:change event
    ↓
Detector               → app:detected event
    ↓
Builder                → build:completed event
    ↓
ProcessManager (PM2)   → app:started event
    ↓
Router (Caddy config)  → Route configured
```

### Core Components

- **DropPlatform** (`src/core/platform.ts`): Main orchestrator that initializes services, wires up event handlers, and manages the deployment lifecycle
- **EventBus** (`src/core/event-bus/`): Typed pub/sub system with history tracking. Singleton at `eventBus`
- **WatcherService** (`src/core/watcher/`): Monitors webapps directory for new folders using chokidar
- **DetectorService** (`src/core/detector/`): Auto-detects app type (Node.js, Python, static, Docker) from file signatures
- **BuilderService** (`src/core/builder/`): Runs install/build commands. Uses strategy pattern for different app types
- **ProcessManager** (`src/managers/process/`): PM2 wrapper for process lifecycle. Singleton at `getProcessManager()`
- **RouterService** (`src/core/router/`): Generates Caddy configuration for reverse proxy
- **CaddyServer** (`src/managers/router/caddy-server.ts`): Manages Caddy process for hostname-based routing. Singleton at `getCaddyServer()`
- **AppStateManager** (`src/managers/app/state-manager.ts`): Tracks app status in `apps.json`. Singleton at `getStateManager()`
- **PostgresServer** (`src/managers/database/postgres-server.ts`): Bundled PostgreSQL with auto-provisioning. Singleton at `getPostgresServer()`
- **DatabaseProvisioner** (`src/managers/database/database-provisioner.ts`): Auto-provisions per-app PostgreSQL databases

### Path Aliases

Configured in `tsconfig.json` and `jest.config.js`:
- `@/*` → `src/*`
- `@core/*` → `src/core/*`
- `@managers/*` → `src/managers/*`
- `@api/*` → `src/api/*`
- `@cli/*` → `src/cli/*`
- `@utils/*` → `src/utils/*`
- `@types/*` → `src/types/*`

### Directory Structure (Runtime)

```
/var/drop/ (Linux) or C:\drop\ (Windows)
├── apps/drop-svc/           # Platform files
└── data/
    ├── webapps/             # Deployed applications (watched)
    ├── drop-svc/            # Platform state (drop.db, pm2/)
    ├── logs/                # All logs (drop-svc/, webapps/, caddy/)
    └── appconf/             # Config files (Caddyfile, caddy/)
```

## Development Workflow

### Before Implementing Features

1. Read PRD: `docs/specs/prd/PRD-XXX-feature-name.md`
2. Read Tasks: `docs/specs/tasks/TASKS-XXX-feature-name.md`
3. Create feature branch from `develop`: `feature/DROP-XXX-description`
4. Mark tasks complete in task file after implementation

### Git Conventions

- Never commit directly to `main` or `develop`
- Branch naming: `feature/`, `bugfix/`, `hotfix/`, `release/`
- Conventional commits: `feat(scope): description`, `fix(scope): description`

## Key Patterns

- **Singletons**: EventBus, ProcessManager, RouterService use singleton pattern with `get*()` and `reset*()` functions
- **Builder Strategies**: `src/core/builder/strategies/` contains per-app-type build logic (nodejs.ts, python.ts, static.ts, docker.ts)
- **Detector Chain**: Multiple detectors in `src/core/detector/detectors/` run in priority order (manifest.ts, nodejs.ts, python.ts, docker.ts, static.ts)
- **Zod Validation**: Use zod for runtime type validation (see existing schemas)
- **Typed Events**: Events use TypeScript discriminated unions for type safety (`EventPayloadMap` in `event-bus.types.ts`)
