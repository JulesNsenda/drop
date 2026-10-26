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
| Source download | `GET /api/v1/apps/:name/source` (dashboard: **Source** button) returns the app's source as a `.tar.gz` in the shape the upload takes, minus `node_modules`, `.venv` and `.git`; symlinks are archived as links, never followed. Owner or admin, session or API key; not agent credentials, not with auth disabled |
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
| Object storage (operator side) | Admin-configured S3 in the operator's AWS account (`/api/v1/admin/settings/object-storage`, encrypted write-only credential, connection test). Per-app private bucket + bucket-scoped IAM user, created and destroyed by the provisioner; attaching it to apps is not wired yet. See `docs/OBJECT-STORAGE.md` |
| Custom-domain verification | `PUT`/`GET /api/v1/apps/:name/domain`, `POST /apps/:name/domain/verify`, the `custom_domain` MCP tool and the dashboard Domains tab: the DNS record to create, a DNS check against the platform's own addresses (`DROP_PUBLIC_IPS` behind NAT), and routing + certificate once verified. `drop.yaml` `domains` are routed without verification, as before |
| Backup / restore | `drop backup` and `drop restore` cover the platform's own state |

## Interfaces

| Capability | Notes |
|---|---|
| REST API | Hono-based, under `/api/v1` |
| CLI | `drop serve`, `list`, `status`, `logs`, `deploy`, `start/stop/restart/remove`, `backup`, `restore`, `mfa`, `migrate-runtime` |
| Web dashboard | Apps, logs, deploys, metrics, secrets, database browser, settings |
| Public site | Marketing, docs and API reference, served from a separate bundle |
| OpenAPI description | `GET /api/v1/openapi.json` — OpenAPI 3.1, generated from the mounted route table with per-operation role floors |
| Hosted MCP server | `POST /api/v1/mcp` — deploy, logs, status and `verify_deployment` tools for coding agents; refused deploys carry a structured `error_code` + `retry_after_seconds` |
| OAuth 2.1 + PKCE | The authorization path web-based MCP connectors require |

## Access control and safety

| Capability | Notes |
|---|---|
| Authentication | On by default: JWT sessions, API keys, optional TOTP two-factor |
| Roles | `readonly` / `user` / `admin`, with per-route enforcement |
| Multi-user | Per-user app ownership and limits; invitation-based signup |
| Scoped agent tokens | Least-privilege keys scoped to named capabilities, never full admin |
| Zero-downtime redeploys | On by default for an app that declares a `healthCheck` (opt out: `deploy: { strategy: in-place }`, or `DROP_ZERO_DOWNTIME_DEFAULT=false` platform-wide); opt in explicitly with `deploy: { strategy: zero-downtime }`. Each deploy builds into `data/releases/<app>/<id>/`, starts beside the old instance on a second port, must answer HTTP < 500, then Caddy switches and the old instance is drained and removed; a failed new version leaves the old one serving (`READINESS_FAILED`) |
| Per-app rollback | `POST /api/v1/apps/:name/rollback` goes back to what served before the last deploy, without rebuilding: a zero-downtime app cuts over to its previous release; any other app gets the last-good tree captured before an upload/git redeploy and restarts; code only, never the database |
| Deploy guardrails | Circuit breaker on failing deploy loops, per-principal quotas, ephemeral TTL'd apps, idle reaping, disk ceilings; the caller's own headroom is readable up front via `GET /api/v1/limits` |
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
- **Rollback goes back one deploy only.** `POST /apps/:name/rollback` restores
  the previous deploy's code (never its database); anything older means
  redeploying from source.
