# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DROP (Deploy, Run, Operate, Publish) is a self-hosted PaaS for "drop folder and deploy" workflows. Drop a folder into the webapps directory and get a running application with zero configuration.

**Philosophy**: Drop a folder, get a URL. Zero configuration for 80% of use cases.

The platform itself is a long-running Node.js service (`drop serve`) that runs a file watcher, a deployment pipeline, an app runtime (PM2 processes *or* Docker containers — see the runtime seam below), a bundled PostgreSQL, an optional bundled Redis, an optional Caddy reverse proxy, a Hono REST API + hosted MCP server, and a React dashboard — all in one process.

**Isolation mode is the single biggest behavioural switch.** `config.isolation` is `'none'` (default) or `'docker'` (`DROP_ISOLATION` env / `--isolation` flag), and it decides whether tenant code runs as a host process under PM2 or in a container — which in turn changes builds, `DATABASE_URL` shape, `DROP_API_URL`, health probing (PM2 uses a poller; Docker uses `HEALTHCHECK`), and whether multi-user mode is even allowed. Both modes are exercised in real deployments — a Docker host and a `none`-isolation dev box behave differently for the same code path. Always check which mode a code path is reasoning about.

## Commands

```bash
# Development
npm run dev              # Start platform with ts-node (src/index.ts)
npm run build            # Compile TS (tsc) AND build the dashboard + public site (Vite, both configs)
npm run build:server     # tsc + scripts/copy-assets.js — skips the dashboard/site builds
npm run build:dashboard  # Build only the React admin dashboard (cd src/dashboard && vite build)
npm run build:site       # Build only the public marketing/docs/reference site (cd src/dashboard && vite build --config vite.site.config.ts)
npm run build:watch      # tsc --watch (server only)
npm start                # Run compiled dist/index.js

# Testing
npm test                 # Run all Jest tests (jest --forceExit — the suite leaks handles)
npm test -- --watch      # Watch mode
npm test -- path/to/file.test.ts   # Single test file
npm test -- -t "describe or it name"  # Single test by name
npm run test:coverage    # Coverage report (thresholds: 35% branches / 45% fns / 50% lines+stmts)

# Quality
npm run lint             # ESLint check (src only)
npm run lint:fix         # Auto-fix lint issues
npm run format           # Prettier format (src/**/*.ts)
npm run format:check     # Check formatting

# CLI (after npm run build + npm link, or via npm run dev)
drop serve               # Start DROP platform (also: -d daemon, -r <root>, --https, --domain)
drop list [--all]        # List running (or all) apps
drop status <app>        # App status
drop logs <app> [-n N]   # View captured stdout/stderr
drop deploy <path>       # Deploy from a path (--name, --port)
drop start|stop|restart|remove <app>
drop backup|restore      # Platform backup / restore
drop mfa                 # TOTP enrolment / management for a user
drop migrate-runtime     # Move apps between the PM2 and Docker runtimes
drop version
```

**Building gotcha**: `npm run build` invokes both frontend builds — the admin dashboard AND the public site (DROP-070: one `src/dashboard` npm package, two Vite configs/entry points — `vite.config.ts` for `/dashboard`, `vite.site.config.ts` for `/`, `/docs`, `/reference` — not two packages). Both require the same `src/dashboard` deps. Run `cd src/dashboard && npm install` once first, or use `npm run build:server` when you only changed backend code. If you only changed frontend code, `npm run build:dashboard` / `npm run build:site` build just one side; a change under `src/dashboard/src/components/landing/`, `src/dashboard/src/pages/{Landing,Docs,Reference}Page.tsx`, `src/dashboard/src/{SiteApp,site-main}.tsx`, or `src/dashboard/src/styles/{landing,tokens,site-reset}.css` needs `build:site`, not `build:dashboard`.

**Testing note**: `jose` (used for JWT) is mocked in tests via `src/__mocks__/jose.ts` (wired through `jest.config.js` `moduleNameMapper`). Tests run on `ts-jest` against `src/**/*.test.ts` — tests are colocated next to the code they cover, with shared helpers in `src/core/__testutils__/` and `src/api/__testutils__/`.

**Formatting note**: neither `.github/workflows/ci.yml` nor `deploy.yml` runs `format:check` (they run `lint`, `build:server`, `npm test`, then both frontend builds). The tree is therefore *not* uniformly Prettier-clean. Never run `npm run format` / `prettier --write` over a file you are editing — it produces a large unrelated diff that buries the actual change. Match the surrounding style by hand instead.

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
AppRuntime (PM2/Docker) → app:started event
    ↓
Router (Caddy config)  → Route configured
```

`app:update` (file change on a running app) triggers a hot-reload path that stops, rebuilds, and restarts on the **same port**. An `appsInProgress` set in `platform.ts` prevents re-entrancy, and an **adaptive post-deploy cooldown** prevents rebuild loops: `getEffectiveCooldownMs()` returns `clamp(lastBuildDuration * 2, 5s, 120s)`, so a slow Docker build can't be re-triggered by its own output while a fast build still hot-reloads quickly.

### Core Components

- **DropPlatform** (`src/core/platform.ts`): Main orchestrator. Initializes all services in dependency order (`initializeServices()`), wires event handlers, manages directory/file scaffolding, port allocation, and the deployment lifecycle. This is the file to read first to understand control flow.
- **EventBus** (`src/core/event-bus/`): Typed pub/sub with history. Singleton `eventBus`. Events are discriminated unions (`EventPayloadMap` in `event-bus.types.ts`).
- **WatcherService** (`src/core/watcher/`): chokidar watcher over the webapps directory; ignores `node_modules`/`.git`/`dist`/`build`; depth defaults to `DEFAULT_MAX_DEPTH = 3` (`watcher.config.ts`), overridable with `DROP_WATCHER_DEPTH`.
- **DetectorService** (`src/core/detector/`): Auto-detects app type (Node.js, Python, Go, static/SPA, Docker) via a priority detector chain.
- **BuilderService** (`src/core/builder/`): Runs install/build using per-type strategy classes.
- **AppRuntime** (`src/managers/runtime/`): **the seam between the platform and whatever executes tenant apps** — see below. `Pm2Runtime` and `ContainerManager` (Docker) both implement it; `ProcessManager` (`src/managers/process/`) is now the low-level PM2 wrapper *behind* `Pm2Runtime`, not something callers use directly.
- **RouterService** (`src/core/router/`) + **CaddyServer** (`src/managers/router/caddy-server.ts`): Generate Caddy config and manage the Caddy process for hostname routing + HTTPS. Singletons `getRouterService()` / `getCaddyServer()`.
- **AppStateManager** (`src/managers/app/state-manager.ts`): App status tracking. Singleton `getStateManager()`.
- **AppConfigService** (`src/managers/app/app-config.ts`): Per-app config files. **Source of truth for port assignments** across restarts. Singleton `getAppConfigService()`.
- **PostgresServer** + **DatabaseProvisioner** (`src/managers/database/`): Bundled PostgreSQL; auto-provisions a per-app database and injects `DATABASE_URL` when an app needs one. Singletons `getPostgresServer()`.
- **SecretManager** (`src/managers/secret/`): Encrypted per-app secrets, injected as env vars at start. Singleton `getSecretManager()`.
- **WebhookManager** (`src/core/webhooks/`) + **GitDeployService** (`src/core/git-deploy/`): Webhook-driven and git-clone-based deploys. Singletons `getWebhookManager()` / `getGitDeployService()`.
- **ActivityLog** (`src/managers/activity/`): Audit/activity trail. Singleton `getActivityLog()`.
- **UploadDeployService** (`src/core/upload-deploy/`): tar-upload deploy path (`POST /api/v1/apps/:name/source`) — extraction is hardened separately in `tar-extract.ts` (path traversal, symlinks, size).
- **DeployTracker + DeployDetailStore** (`src/managers/deploy-tracker/`): per-deploy history and structured failure detail (`deploys.json` / `deploy-details.json`), served by `/api/v1/deploys`. Both subscribe to the EventBus and are flushed in `platform.stop()`.
- **Guardrails** (`src/managers/guardrail/`) — the agent-deploy safety layer, see below.
- **ApiServer** (`src/api/server.ts`): Hono REST API + hosted MCP + dashboard/site static serving (see below).
- Smaller managers, each `data/`-file backed: `settings/` (runtime-settable platform settings, `settings.json` — loaded *before* `ApiServer` is constructed, which reads `getStoredPublicUrl()` synchronously), `redis/` (bundled Redis server + per-app provisioner, only started when enabled), `build-log/` (per-deploy build stdout/stderr under `data/logs/builds/`), `log-retention/` (prunes captured app logs).

Most managers follow the singleton pattern: `get*(config?)` returns/creates the instance, `reset*()` tears it down (used in `platform.stop()` and tests).

### The runtime seam (`src/managers/runtime/`)

`AppRuntime` (`app-runtime.ts`) is the interface every consumer talks to — the platform, API routes, and CLI must never reach for PM2 or Docker directly. The platform picks the implementation **once**, from `config.isolation`:

```ts
this.runtime = getAppRuntime(this.config.isolation === 'docker' ? 'docker' : 'pm2');
```

**Rule for every other caller: `getAppRuntime()` with no argument.** Passing a type from a route or CLI command throws when an instance of a different type already exists — i.e. it works on a dev box (`pm2`) and blows up in production (`docker`).

Implementor contract (from the interface's own header — honour it when touching either adapter):
- emit the same EventBus events either way — `app:starting`/`app:started`, `app:stopping`/`app:stopped`, `app:error`;
- `start()` resolves only once the app is actually up, and rejects on timeout/error — callers treat resolution as "it's running";
- write stdout/stderr to the spec's `outFile`/`errorFile` so the logs API/CLI/dashboard are runtime-agnostic;
- map native status strings to `AppRuntimeState` — they're an implementation detail.

`container-config.ts` builds the container spec, `runtime-migrator.ts` backs `drop migrate-runtime` (moving existing apps between runtimes).

### Guardrails (`src/managers/guardrail/`)

The layer that makes agent/API-driven deploys safe to expose. Independent limiters — do not collapse them, the distinctions are deliberate:

- **`deploy-breaker.ts`** — circuit breaker on a *failing* loop; resets on the first success.
- **`principal-quota.ts`** — deploys per principal per window, regardless of outcome. Explicitly distinct from the breaker: a caller alternating success and failure is never throttled by the breaker, but still burns build capacity. Per principal *and* per owning user, never global (a global cap is a DoS any tenant can trigger).
- **`ephemeral.ts`** — throwaway TTL'd apps (default 60min, max 1440min, ≤3 live per principal) plus name/hostname constraints.
- **`idle-reaper.ts`**, **`disk-ceiling.ts`**, **`promotion.ts`** — idle cleanup, disk headroom, and ephemeral→permanent promotion.

Exceeding a limit returns a **structured refusal**, never a silent kill.

### REST API (`src/api/`)

Hono-based, served by `ApiServer` (`src/api/server.ts`) on `apiPort` (default 3000). Routes are mounted under **`/api/v1`** (`health`, `auth`, `apps`, `usage`, `logs`, `certs`, `deploys`, `secrets`, `db`, `webhooks`, `git`, `admin`, `oauth`, `mcp-gateway`, plus `POST /mcp`). `ApiServer` also serves both frontend bundles directly at the root level: `/`, `/docs`, `/reference` (the public site, DROP-070) and `/dashboard` (the admin SPA), each behind an explicit-routes-only registration — no bare `/*` catch-all, since that would swallow the `/.well-known/oauth-*` discovery routes below. `/dashboard/docs` and `/dashboard/reference` 301-redirect to their new `/docs` / `/reference` homes.

Middleware stack (applied in `setupMiddleware`): security headers → CORS → body-size limit → rate limiting (`/api/*`, stricter on `/auth/login`) → request logger → audit logging → error handler. Auth middleware is applied per-route-group only when auth is enabled, with role tiers **`readonly` / `user` / `admin`** (`authMiddleware(role)`).

**Route order matters.** Hono resolves routes in **registration order**, so a broad pattern registered before a specific one silently shadows it (`get('/:domain')` before `get('/health')` once killed `GET /certs/health`). Register specific paths first, and prefer explicit routes over catch-alls.

**Auth** (`src/api/middleware/auth.ts`): JWT (via `jose`) + API keys + TOTP MFA (`src/utils/totp.ts`). Users and API keys are persisted to a **file** (`api-credentials.json`), not the internal DB. Auth is **on by default** (`enableApiAuth`); disable with `DROP_DISABLE_AUTH=true` / `DROP_ENABLE_API_AUTH=false`. Adding endpoints means: add a route file under `src/api/routes/`, mount it in `server.ts`, and (if protected) add an `authMiddleware(role)` line in `setupRoutes`.

Credential-minting and guessing surfaces get their **own** stricter rate-limit buckets registered *unconditionally* (i.e. even when auth is disabled): `/auth/login`, `/auth/signup`, `/auth/mfa/*`, `/auth/password`, `/auth/agent-tokens`, `POST /auth/users`, `/apps/*/source` (uploads), `/mcp`, `/oauth/*`, `/db/*`. These stack with the general `/api/*` limiter rather than replacing it — keep new credential/expensive routes in the same pattern.

### Agent surfaces: MCP + OAuth (`src/api/mcp/`, `src/api/oauth/`, `mcp-gateway.ts`)

Three separate things that are easy to confuse:

1. **Hosted MCP server** (`src/api/mcp/`, PRD-040) — DROP's *own* tools (deploy, logs, status) for Claude/Cursor/agents. Stateless Streamable HTTP: **`POST /api/v1/mcp` only**; GET/DELETE answer a JSON-RPC-shaped 405 (no sessions or streams exist in stateless mode). Tools live in `tools.ts`; `untrusted.ts` fences tenant-controlled text before it reaches a model; scope enforcement in `src/api/agent-scopes.ts`.
2. **OAuth 2.1 + PKCE** (`src/api/oauth/`, PRD-041) — the authorization path claude.ai's web connector requires. RFC 8414/9728 mandate discovery metadata at **fixed root paths**, so `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/api/v1/mcp`, `/.well-known/protected-resource/api/v1/mcp` and `/.well-known/oauth-authorization-server` are registered on the app itself, *before* `/api/v1`. **This is exactly why the dashboard/site static serving uses explicit routes and no bare `/*` catch-all** — a catch-all would swallow discovery and break the connector handshake. They fail closed (404) when no public URL is configured.
3. **MCP gateway** (`src/api/routes/mcp-gateway.ts`) — Caddy's `forward_auth` target for *tenant apps'* own MCP endpoints. Deliberately **not** behind `authMiddleware`: it verifies an app-audienced bearer itself and must reject every other credential class, which a general auth gate would instead admit. Don't "fix" it by adding a middleware.

### Web Dashboard + public site (`src/dashboard/`)

A **separate npm package** (React 18 + Vite + Tailwind + react-router-dom) — but **two Vite surfaces** sharing one `src/` tree (DROP-070): `vite.config.ts` builds the admin dashboard (`base: /dashboard/`, entry `index.html` → `dist/dashboard/`), and `vite.site.config.ts` builds the public marketing/docs/reference site (`base: /`, entry `site/index.html` → `dist/site/`). Same `package.json`/`node_modules`/`tsconfig.json` for both — not a second package. `ApiServer` prefers the built `dist/dashboard` / `dist/site` over the raw `src/dashboard` (dashboard only; the site build has no source fallback — see `server.ts`). Treat `src/dashboard` as its own frontend project — run `npm` commands from inside it (`npm run build` / `build:site`, `npm run dev` / `dev:site`).

**Invariant the split depends on:** the site bundle (`src/dashboard/src/{SiteApp,site-main}.tsx`, `pages/{Landing,Docs,Reference,SiteNotFound}Page.tsx`, `components/landing/*`) must never import `hooks/useAuth`, `api/client`, `components/Layout`, `Toast`, or `ConfirmDialog` — that's the admin-only code the split exists to keep out of a marketing visitor's download (CI enforces this with a `grep` over the built `dist/site` JS, `deploy.yml`). Cross-bundle navigation (e.g. a "Sign in" link, or the dashboard's logout redirect) is a plain `window.location.href` / `<a href>`, never react-router's `Link`/`navigate()` — each bundle has its own `BrowserRouter` with no shared history.

### Persistence Model (two file-based layers — important)

DROP keeps its own state in flat files; PostgreSQL is provisioned only as a service *for deployed apps*, not for platform state:

1. **App runtime state** → `AppStateManager`, JSON file at `data/drop-svc/apps.json`. Zero-config status tracking (`pending`/`building`/`running`/`stopped`/`errored`, port, pid).
2. **Per-app config** → `AppConfigService`, files under `data/appconf/webapps/`. **Source of truth for ports** and persisted deploy metadata. On startup `platform.ts` reconciles: config files > running runtime processes/containers > apps.json.

Other file-backed stores under `data/drop-svc/` (the directory is created `0700` and re-`chmod`ed every boot — it holds plaintext secrets): `secrets.json` (encrypted), `settings.json`, `webhooks.json`, `activity-log.json`, `deploys.json`, `deploy-details.json`, `principal-quotas.json`, `api-credentials.json`, `encryption.key` + `local.key` (auto-generated, `0600`).

Writes go through `writeJsonAtomic` (`src/utils/atomic-write.ts`) — use it for any new store rather than a bare `fs.writeFile`.

**Bundled PostgreSQL** (`src/managers/database/`) is a *runtime dependency for apps*: `DatabaseProvisioner` creates a per-app database and injects `DATABASE_URL` when an app needs one. It does **not** store platform state.

> Historical note: an internal relational registry (`AppRegistry` + a `drop_internal` schema + `MigrationRunner` + `db:migrate` scripts) once existed but was never wired into `platform.ts` — it was removed as dead code (the two file layers above are the real system of record). Code comments / `PRD-005` / `PRD-033-sqlite-state.md` may still reference the old registry or a future `drop.db` SQLite store; neither exists in the runtime.

### Path Aliases

Configured in `tsconfig.json` and mirrored in `jest.config.js`:
- `@/*` → `src/*`
- `@core/*` → `src/core/*`
- `@managers/*` → `src/managers/*`
- `@api/*` → `src/api/*`
- `@cli/*` → `src/cli/*`
- `@utils/*` → `src/utils/*`

(`tsconfig.json`/`jest.config.js` also carry a `@types/*` → `src/types/*` mapping, but `src/types/` does not exist and nothing imports from it — it's dead config. Per-module types live next to their code as `*.types.ts`.)

### Runtime Directory Layout

Root is `C:\drop\` (Windows) or `/var/drop/` (Linux), overridable via `DROP_ROOT`. `platform.ts` scaffolds it on start:

```
<root>/
├── apps/drop-svc/                 # Platform files (reserved)
└── data/
    ├── webapps/                   # Deployed apps (watched)
    ├── appdata/<app>/             # Per-app persistent data (DROP_DATA_DIR) — survives upgrades
    ├── drop-svc/                  # Platform state (0700): apps.json, settings.json, secrets.json,
    │   │                          #   webhooks.json, activity-log.json, deploys.json,
    │   │                          #   deploy-details.json, principal-quotas.json,
    │   │                          #   api-credentials.json, encryption.key, local.key
    │   └── pm2/                   # PM2 config
    ├── db/                        # PostgreSQL data
    ├── logs/{drop-svc,webapps,caddy,builds}/  # All logs (per-app stdout/stderr auto-captured, dated;
    │                              #   builds/ = per-deploy build output, BuildLogService)
    ├── backup/                    # Automated backups (drop backup/restore)
    ├── temp/                      # Build work dirs (data/temp/<app>) + upload staging
    └── appconf/                   # Caddyfile, drop.yaml, caddy/{webapps,hosts}/, webapps/ (per-app config)
```

### Env vars injected into deployed apps

`PORT` (assigned port), `DROP_DATA_DIR` (persistent data dir), `DATABASE_URL` (if a DB was provisioned), `REDIS_URL` (if the app opted into managed Redis in `drop.yaml` and the bundled server is enabled), `DROP_API_URL` (base URL for DROP's own REST API — `http://drop-host:<apiPort>` under docker isolation, `http://127.0.0.1:<apiPort>` otherwise), `DROP_API_KEY` (a least-privilege, scoped API key for calling DROP's own API — injected **only** for apps an admin has granted control-plane capabilities via `PUT /api/v1/apps/<name>/capabilities`; scoped to those capabilities, e.g. `users:create`, never a full admin key), plus any per-app secrets and `depends_on`-resolved URLs from the app's `drop.yaml`.

**`drop.yaml` is the tenant-facing manifest** — parsed and validated in `src/core/detector/drop-yaml-parser.ts` (the single source of truth for which fields exist: runtime, build/start commands, domains, `env:`, `secrets:` preflight, `database`/`redis`, `depends_on`, monorepo `services:`). Any sample `drop.yaml` in the docs or on the marketing site must round-trip through that parser — there's a test pinning the published samples to it, because a sample the parser rejects shipped live once.

Two traps worth knowing before debugging env problems:
- **Precedence**: `dbEnvVars` (`DATABASE_URL`) is spread *after* both `secretEnvVars` and `drop.yaml` `env:` in the start env, so it overrides both.
- **Provisioning only happens on the deploy path.** `handleStartApp` is the only place that calls `provisionAppDatabase`; `restartApp` → `buildFreshStartSpec` merely re-reads an existing allocation. An app that newly *needs* a database gets one on a redeploy, not on a restart.

## Development Workflow

### Before Implementing Features

1. Read the PRD: `docs/specs/prd/PRD-XXX-feature-name.md` (51 PRDs exist; index by number — `docs/specs/FEATURE-INDEX.md`).
2. Read the tasks: `docs/specs/tasks/TASKS-XXX-feature-name.md`.
3. Create a feature branch from `develop`: `feature/DROP-XXX-description`.
4. Mark tasks complete in the task file after implementation.

Roadmap and conventions live in `docs/VERSION-ROADMAP.md`, `docs/GIT-BRANCHING-MODEL.md`, and `docs/CLEAN-CODE-GUIDELINES.md`.

### Git Conventions

- Never commit directly to `main` or `develop`.
- **A push to `develop` deploys production.** `.github/workflows/deploy.yml` triggers on `main`, `develop` and `feature/DROP-v2*`, and its `deploy` job is *not* branch-gated — it ssh's into the `hetzner` environment host (`secrets.DEPLOY_HOST`), runs `sudo systemctl stop drop-platform`, ships the artifact, and brings the service back. Treat any push to `develop` — including a zero-content back-merge — as a production deploy and get explicit consent for it, not just for the push.
- Branch naming: `feature/`, `bugfix/`, `hotfix/`, `release/`.
- Conventional commits: `feat(scope): description`, `fix(scope): description`.
- `deploy.yml` also enforces two guards worth knowing before editing it: the remote deploy script must contain **exactly two apostrophes** (the `ssh` argument delimiters — a stray apostrophe, even in a comment, silently truncates the script mid-execution), and the built `dist/site` JS must not reference admin-only code (the DROP-070 bundle split).

## Key Patterns

- **Singletons**: managers expose `get*()` / `reset*()`; `reset*()` is called in `platform.stop()` and tests to avoid cross-test leakage.
- **Builder strategies**: `src/core/builder/strategies/` (nodejs, python, static, docker) — add a strategy here for a new app type.
- **Detector chain**: `src/core/detector/detectors/` run in priority order (manifest → nodejs → python → docker → static); add a detector to support new types.
- **Zod validation**: runtime validation uses zod schemas; follow existing patterns.
- **Typed events**: events use discriminated unions (`EventPayloadMap`); add new event types there for type safety end-to-end.
- **Two-phase config reconciliation**: app config files are authoritative for ports; state and the runtime are reconciled against them on startup (`syncStateWithConfigs`, `syncStateWithProcesses`, `loadUsedPorts`).
- **Runtime-agnostic code paths**: anything touching start/stop/restart/logs goes through `getAppRuntime()` (no argument). If a change only works under one isolation mode, that's a bug — see the `platform.build-exec-parity` / `platform.restart` tests for the shape of the parity checks.
- **Atomic file writes**: new platform state goes through `writeJsonAtomic`; boot-time reconciliation assumes stores are never half-written.
- **Security helpers have callers**: several past incidents came from a helper that was correct in isolation while a caller bypassed it (build env sanitization, group-name path containment). When touching one, read every call site — and prefer a type-level invariant over a test asserting "every caller passes X". Search for an existing validation/sanitization utility before writing new logic inline — several already exist in the codebase for URL, hostname and path safety.
