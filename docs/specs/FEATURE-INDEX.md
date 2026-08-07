# DROP feature index

What DROP does as of **1.0.0**. This is a capability list, not a roadmap — if
something is listed here it exists in the shipped code. Planned work lives in
[VERSION-ROADMAP.md](../VERSION-ROADMAP.md); the change history is in
[CHANGELOG.md](../../CHANGELOG.md).

> The per-feature PRD and task documents that used to be indexed here are
> internal planning material and are not part of the public repository. Their
> statuses were maintained inconsistently, so linking them would have been
> worse than omitting them. The source of truth for behaviour is the code and
> the CHANGELOG.

---

## Deploying

| Capability | Notes |
|---|---|
| Drop-folder deploy | Copy a folder into the webapps directory; a watcher detects, builds, and starts it |
| Runtime auto-detection | Node.js, Python, Go, static/SPA, and Docker, via a priority detector chain |
| Framework detection | Next.js, Nuxt, Express, FastAPI, Flask and others get sensible build/start defaults |
| `drop.yaml` manifest | Optional per-app config: build/start commands, domains, env, secrets, database, Redis, dependencies |
| Monorepo / multi-service | A `services:` block deploys several apps from one repository under a shared hostname |
| Git deploys | Clone-and-deploy from a repository, including private repos |
| Webhook deploys | Push-triggered redeploys with signature verification |
| Tarball upload deploys | `POST /api/v1/apps/:name/source`, with hardened extraction |
| Hot reload | A file change rebuilds and restarts on the same port |
| Deploy history | Per-deploy records and structured failure detail, via `/api/v1/deploys` and the dashboard |

## Running

| Capability | Notes |
|---|---|
| Two isolation modes | `docker` runs tenant apps in containers; `none` runs them as host processes under PM2 |
| Runtime migration | `drop migrate-runtime` moves existing apps between the two |
| Readiness gating | An app is only marked running once it actually serves; slow starters are not killed early |
| Resource limits | CPU and memory ceilings per app (container mode) |
| Persistent data | `DROP_DATA_DIR` survives redeploys and upgrades |
| Log capture | stdout/stderr captured to dated files, with retention pruning |
| Build logs | Per-deploy build output, retained and viewable separately from runtime logs |

## Platform services

| Capability | Notes |
|---|---|
| Bundled PostgreSQL | Per-app database provisioned automatically, `DATABASE_URL` injected |
| Managed Redis | Opt-in per app via `drop.yaml`; `REDIS_URL` injected |
| Encrypted secrets | Per-app secrets encrypted at rest, injected as env vars at start |
| Required-secret preflight | A deploy missing a declared secret stops in `needs-config` instead of crash-looping |
| Reverse proxy + HTTPS | Caddy-managed routing, automatic certificates, wildcard and custom domains |
| Backup / restore | `drop backup` and `drop restore` cover the platform's own state |

## Interfaces

| Capability | Notes |
|---|---|
| REST API | Hono-based, under `/api/v1` |
| CLI | `drop serve`, `list`, `status`, `logs`, `deploy`, `start/stop/restart/remove`, `backup`, `restore`, `mfa`, `migrate-runtime` |
| Web dashboard | Apps, logs, deploys, metrics, secrets, database browser, settings |
| Public site | Marketing, docs and API reference, served from a separate bundle |
| Hosted MCP server | `POST /api/v1/mcp` — deploy, logs and status tools for coding agents |
| OAuth 2.1 + PKCE | The authorization path web-based MCP connectors require |

## Access control and safety

| Capability | Notes |
|---|---|
| Authentication | On by default: JWT sessions, API keys, optional TOTP two-factor |
| Roles | `readonly` / `user` / `admin`, with per-route enforcement |
| Multi-user | Per-user app ownership and limits; invitation-based signup |
| Scoped agent tokens | Least-privilege keys scoped to named capabilities, never full admin |
| Deploy guardrails | Circuit breaker on failing deploy loops, per-principal quotas, ephemeral TTL'd apps, idle reaping, disk ceilings |
| Rate limiting | Stricter buckets on credential-minting and expensive endpoints |
| Activity log | Audit trail of platform actions |

---

## Not built

Named here because other documents have claimed otherwise at various points:

- **No SQLite platform store.** Platform state is flat files — an `apps.json`
  state file plus per-app config files. An internal relational registry was
  written, never wired in, and removed as dead code.
- **No clustering, replication or failover.** Single-node only.
- **No metrics export, alerting or historical retention.** The dashboard shows
  current CPU/memory/uptime; there is no Prometheus endpoint or time series.
- **No plugin system.**
- **No deploy rollback.** Deploy history is recorded, but there is no command
  or endpoint that restores a previous deploy; redeploy from source instead.
