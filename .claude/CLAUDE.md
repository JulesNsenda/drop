# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DROP (Deploy, Run, Operate, Publish) is a self-hosted PaaS for "drop folder and deploy" workflows. Drop a folder into the webapps directory and get a running application with zero configuration.

**Philosophy**: Drop a folder, get a URL. Zero configuration for 80% of use cases.

The platform itself is a long-running Node.js service (`drop serve`) that runs a file watcher, a deployment pipeline, PM2 for process management, a bundled PostgreSQL, an optional Caddy reverse proxy, a Hono REST API, and a React dashboard — all in one process.

## Commands

```bash
# Development
npm run dev              # Start platform with ts-node (src/index.ts)
npm run build            # Compile TS (tsc) AND build the dashboard (Vite)
npm run build:server     # Compile TS only — skips the dashboard build
npm run build:dashboard  # Build only the React dashboard (cd src/dashboard && vite build)
npm run build:watch      # tsc --watch (server only)
npm start                # Run compiled dist/index.js

# Testing
npm test                 # Run all Jest tests
npm test -- --watch      # Watch mode
npm test -- path/to/file.test.ts   # Single test file
npm test -- -t "describe or it name"  # Single test by name
npm run test:coverage    # Coverage report (thresholds: 35% branches / 45% fns / 50% lines+stmts)

# Quality
npm run lint             # ESLint check (src only)
npm run lint:fix         # Auto-fix lint issues
npm run format           # Prettier format (src/**/*.ts)
npm run format:check     # Check formatting

# Database (internal PostgreSQL "drop_internal")
npm run db:migrate              # Apply pending .sql migrations
npm run db:migrate -- status    # Show applied/pending migrations
npm run db:migrate:create <name>  # Scaffold a new migration

# CLI (after npm run build + npm link, or via npm run dev)
drop serve               # Start DROP platform (also: -d daemon, -r <root>, --https, --domain)
drop list [--all]        # List running (or all) apps
drop status <app>        # App status
drop logs <app> [-n N]   # View captured stdout/stderr
drop deploy <path>       # Deploy from a path (--name, --port)
drop start|stop|restart|remove <app>
```

**Building gotcha**: `npm run build` invokes the dashboard build, which requires its own deps. Run `cd src/dashboard && npm install` once first, or use `npm run build:server` when you only changed backend code.

**Testing note**: `jose` (used for JWT) is mocked in tests via `src/__mocks__/jose.ts` (wired through `jest.config.js` `moduleNameMapper`). Tests run on `ts-jest` against `src/**/*.test.ts`.

## Architecture

### Event-Driven Pipeline

The platform uses a central EventBus (`src/core/event-bus/`) for loose coupling. `DropPlatform` (`src/core/platform.ts`) wires the handlers. The main flow:

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

`app:update` (file change on a running app) triggers a hot-reload path that stops, rebuilds, and restarts on the **same port**. A `DEPLOY_COOLDOWN_MS` (5s) guard and an `appsInProgress` set in `platform.ts` prevent rebuild loops and re-entrancy.

### Core Components

- **DropPlatform** (`src/core/platform.ts`): Main orchestrator. Initializes all services in dependency order (`initializeServices()`), wires event handlers, manages directory/file scaffolding, port allocation, and the deployment lifecycle. This is the file to read first to understand control flow.
- **EventBus** (`src/core/event-bus/`): Typed pub/sub with history. Singleton `eventBus`. Events are discriminated unions (`EventPayloadMap` in `event-bus.types.ts`).
- **WatcherService** (`src/core/watcher/`): chokidar watcher over the webapps directory; ignores `node_modules`/`.git`/`dist`/`build`; `maxDepth: 2`.
- **DetectorService** (`src/core/detector/`): Auto-detects app type (Node.js, Python, Go, static/SPA, Docker) via a priority detector chain.
- **BuilderService** (`src/core/builder/`): Runs install/build using per-type strategy classes.
- **ProcessManager** (`src/managers/process/`): PM2 wrapper. Singleton `getProcessManager()`.
- **RouterService** (`src/core/router/`) + **CaddyServer** (`src/managers/router/caddy-server.ts`): Generate Caddy config and manage the Caddy process for hostname routing + HTTPS. Singletons `getRouterService()` / `getCaddyServer()`.
- **AppStateManager** (`src/managers/app/state-manager.ts`): App status tracking. Singleton `getStateManager()`.
- **AppConfigService** (`src/managers/app/app-config.ts`): Per-app config files. **Source of truth for port assignments** across restarts. Singleton `getAppConfigService()`.
- **PostgresServer** + **DatabaseProvisioner** (`src/managers/database/`): Bundled PostgreSQL; auto-provisions a per-app database and injects `DATABASE_URL` when an app needs one. Singletons `getPostgresServer()`.
- **SecretManager** (`src/managers/secret/`): Encrypted per-app secrets, injected as env vars at start. Singleton `getSecretManager()`.
- **WebhookManager** (`src/core/webhooks/`) + **GitDeployService** (`src/core/git-deploy/`): Webhook-driven and git-clone-based deploys. Singletons `getWebhookManager()` / `getGitDeployService()`.
- **ActivityLog** (`src/managers/activity/`): Audit/activity trail. Singleton `getActivityLog()`.
- **ApiServer** (`src/api/server.ts`): Hono REST API + dashboard static serving (see below).

Most managers follow the singleton pattern: `get*(config?)` returns/creates the instance, `reset*()` tears it down (used in `platform.stop()` and tests).

### REST API (`src/api/`)

Hono-based, served by `ApiServer` (`src/api/server.ts`) on `apiPort` (default 3000). Routes are mounted under **`/api/v1`** (`health`, `auth`, `apps`, `logs`, `certs`, `secrets`, `webhooks`, `git`, `admin`).

Middleware stack (applied in `setupMiddleware`): security headers → CORS → body-size limit → rate limiting (`/api/*`, stricter on `/auth/login`) → request logger → audit logging → error handler. Auth middleware is applied per-route-group only when auth is enabled, with role tiers **`readonly` / `user` / `admin`** (`authMiddleware(role)`).

**Auth** (`src/api/middleware/auth.ts`): JWT (via `jose`) + API keys. Users and API keys are persisted to a **file** (`api-credentials.json`), not the internal DB. Auth is **on by default** (`enableApiAuth`); disable with `DROP_DISABLE_AUTH=true` / `DROP_ENABLE_API_AUTH=false`. Adding endpoints means: add a route file under `src/api/routes/`, mount it in `server.ts`, and (if protected) add an `authMiddleware(role)` line in `setupRoutes`.

### Web Dashboard (`src/dashboard/`)

A **separate npm package** (React 18 + Vite + Tailwind + react-router-dom). It has its own `package.json`, `node_modules`, and `tsconfig.json`. It is built to `dist/dashboard/` and served by `ApiServer` at `/dashboard` (SPA fallback). `ApiServer` prefers the built `dist/dashboard` over `src/dashboard`. Treat the dashboard as its own frontend project — run `npm` commands from inside `src/dashboard/`.

### Persistence Model (three layers — important)

DROP intentionally keeps lightweight state in files and uses PostgreSQL only where relational data helps:

1. **App runtime state** → `AppStateManager`, JSON file at `data/drop-svc/apps.json`. Zero-config status tracking (`pending`/`building`/`running`/`stopped`/`errored`, port, pid).
2. **Per-app config** → `AppConfigService`, files under `data/appconf/webapps/`. **Source of truth for ports** and persisted deploy metadata. On startup `platform.ts` reconciles: config files > running PM2 processes > apps.json.
3. **Internal PostgreSQL DB** (`drop_internal`) → relational tables (`apps`, `domains`, `env_vars`, `deployments`, `platform_config`) via SQL migrations in `src/managers/app/migrations/*.sql`. Accessed through the `Database` pool class (`src/managers/app/database.ts`); the `MigrationRunner` applies numbered `.sql` files in a transaction and records them in a `migrations` table.

Other file-backed stores under `data/drop-svc/`: `secrets.json` (encrypted), `webhooks.json`, `activity-log.json`, `api-credentials.json`, `encryption.key` (auto-generated, `0600`).

> Note: code comments and `PRD-033-sqlite-state.md` reference a future `drop.db` SQLite store. The current runtime uses the JSON files above — don't assume a SQLite file exists.

### Migrations

To change the internal DB schema: add a new `NNN_name.sql` file in `src/managers/app/migrations/` (numeric prefix determines order), then `npm run db:migrate`. Migrations are PostgreSQL (UUID PKs, JSONB, triggers — see `001_initial.sql`). `scripts/create-migration.ts` scaffolds new files.

### Path Aliases

Configured in `tsconfig.json` and mirrored in `jest.config.js`:
- `@/*` → `src/*`
- `@core/*` → `src/core/*`
- `@managers/*` → `src/managers/*`
- `@api/*` → `src/api/*`
- `@cli/*` → `src/cli/*`
- `@utils/*` → `src/utils/*`
- `@types/*` → `src/types/*`

### Runtime Directory Layout

Root is `C:\drop\` (Windows) or `/var/drop/` (Linux), overridable via `DROP_ROOT`. `platform.ts` scaffolds it on start:

```
<root>/
├── apps/drop-svc/                 # Platform files (reserved)
└── data/
    ├── webapps/                   # Deployed apps (watched)
    ├── appdata/<app>/             # Per-app persistent data (DROP_DATA_DIR) — survives upgrades
    ├── drop-svc/                  # Platform state: apps.json, secrets.json, webhooks.json,
    │   │                          #   activity-log.json, api-credentials.json, encryption.key
    │   └── pm2/                   # PM2 config
    ├── db/                        # PostgreSQL data
    ├── logs/{drop-svc,webapps,caddy}/   # All logs (per-app stdout/stderr auto-captured, dated)
    └── appconf/                   # Caddyfile, drop.yaml, caddy/{webapps,hosts}/, webapps/ (per-app config)
```

### Env vars injected into deployed apps

`PORT` (assigned port), `DROP_DATA_DIR` (persistent data dir), `DATABASE_URL` (if a DB was provisioned), plus any per-app secrets and `depends_on`-resolved URLs from the app's `drop.yaml`.

## Development Workflow

### Before Implementing Features

1. Read the PRD: `docs/specs/prd/PRD-XXX-feature-name.md` (38 PRDs exist; index by number).
2. Read the tasks: `docs/specs/tasks/TASKS-XXX-feature-name.md`.
3. Create a feature branch from `develop`: `feature/DROP-XXX-description`.
4. Mark tasks complete in the task file after implementation.

Roadmap and conventions live in `docs/VERSION-ROADMAP.md`, `docs/GIT-BRANCHING-MODEL.md`, and `docs/CLEAN-CODE-GUIDELINES.md`.

### Git Conventions

- Never commit directly to `main` or `develop`.
- Branch naming: `feature/`, `bugfix/`, `hotfix/`, `release/`.
- Conventional commits: `feat(scope): description`, `fix(scope): description`.

## Key Patterns

- **Singletons**: managers expose `get*()` / `reset*()`; `reset*()` is called in `platform.stop()` and tests to avoid cross-test leakage.
- **Builder strategies**: `src/core/builder/strategies/` (nodejs, python, static, docker) — add a strategy here for a new app type.
- **Detector chain**: `src/core/detector/detectors/` run in priority order (manifest → nodejs → python → docker → static); add a detector to support new types.
- **Zod validation**: runtime validation uses zod schemas; follow existing patterns.
- **Typed events**: events use discriminated unions (`EventPayloadMap`); add new event types there for type safety end-to-end.
- **Two-phase config reconciliation**: app config files are authoritative for ports; state/PM2 are reconciled against them on startup (`syncStateWithConfigs`, `syncStateWithProcesses`, `loadUsedPorts`).
