# DROP Version Roadmap

This document defines the version roadmap for DROP using Semantic Versioning (SemVer).

---

## Versioning Strategy

### Semantic Versioning
```
MAJOR.MINOR.PATCH

MAJOR: Breaking changes (1.0.0, 2.0.0)
MINOR: New features, backward compatible (0.1.0, 0.2.0)
PATCH: Bug fixes, backward compatible (0.1.1, 0.1.2)
```

### Pre-release Versions
```
0.1.0-alpha.1  - Early development, unstable
0.1.0-beta.1   - Feature complete, testing
0.1.0-rc.1     - Release candidate
0.1.0          - Stable release
```

---

## Version Overview

| Version | Codename | Focus | Status |
|---------|----------|-------|--------|
| **v0.1.0** | MVP++ | Deployment pipeline + dashboard + database provisioning | **Released** 2026-01-18 |
| **v1.0.0** | Production | Docker isolation, hosted MCP + OAuth agent access, guardrails, monorepo, managed Redis, public docs site | **Released** 2026-08-07 — current |
| Post-1.0 | — | Continued hardening plus a short list of unbuilt ideas (see below) | Planned, not committed — no version or date assigned |

---

## v0.1.0 - MVP++ (Released 2026-01-18)

**Goal**: Full deployment pipeline with dashboard and database support

### Features Delivered

| PRD | Feature | Status |
|-----|---------|--------|
| PRD-006 | Event Bus | ✅ Complete |
| PRD-001 | Watcher Service | ✅ Complete |
| PRD-002 | Detector Service (Node.js, Python, Static, Docker) | ✅ Complete |
| PRD-003 | Builder Service (all types) | ✅ Complete |
| PRD-004 | Process Manager (PM2) | ✅ Complete |
| PRD-007 | PostgreSQL Auto-Provisioning | ✅ Complete |
| PRD-009 | REST API with JWT/API Key Auth | ✅ Complete |
| PRD-010 | CLI (complete) | ✅ Complete |
| PRD-011 | Web Dashboard | ✅ Complete |
| - | App state tracking (`apps.json`) + per-app config files | ✅ Complete |
| - | Hot Reload | ✅ Complete |
| - | Port Persistence | ✅ Complete |
| - | Auto-Capture Logging | ✅ Complete |
| - | Persistent Data Directories | ✅ Complete |

### Capabilities
- **Multi-runtime**: Node.js, Python, Static sites, Docker
- **Framework detection**: Next.js, Nuxt, Express, FastAPI, Flask, and more
- **Database provisioning**: Automatic PostgreSQL with DATABASE_URL injection
- **Web dashboard**: Real-time monitoring at /dashboard
- **REST API**: Full API with JWT and API key authentication
- **Hot reload**: Automatic rebuild/restart on file changes
- **Auto-logging**: Console output captured to dated log files
- **Data persistence**: DROP_DATA_DIR for app data that survives upgrades
- **Cross-platform**: Windows, Linux, macOS

### Success Criteria ✅
```bash
# User can deploy by dropping folder
cp -r my-node-app /var/drop/data/webapps/

# App is automatically detected, built, and running
curl http://localhost:3001  # App responds

# Dashboard available
open http://localhost:3000/dashboard

# Full management works
drop list
drop logs my-node-app
drop restart my-node-app
```

### Deliverables
- [x] Working deployment pipeline
- [x] Complete CLI commands
- [x] App state management (apps.json)
- [x] PM2 process management
- [x] Web dashboard (React + Vite + Tailwind)
- [x] REST API with authentication
- [x] PostgreSQL auto-provisioning
- [x] Auto-capture logging
- [x] Persistent data directories
- [x] Basic documentation

---

## v1.0.0 - Production (Released 2026-08-07)

**Goal**: First public release. Everything shipped and hardened since 0.1.0 but
never previously published in a versioned release — Docker isolation alongside
PM2, hosted MCP + OAuth agent access, agent-deploy guardrails, monorepo support,
and a broad security hardening pass. See `CHANGELOG.md`'s `[1.0.0]` section for
the full, authoritative list this summarizes.

### Features Delivered

| PRD | Feature | Status |
|-----|---------|--------|
| PRD-039 | Agent-native deploy tooling (tarball upload deploy, scoped agent tokens, structured deploy results) | ✅ Complete |
| PRD-040 | Hosted MCP server (`POST /api/v1/mcp`) | ✅ Complete |
| PRD-041 | OAuth 2.1 + PKCE for the MCP server (including claude.ai's web connector) | ✅ Complete |
| PRD-043 | Public docs site (`/docs`) | ✅ Complete |
| PRD-044 | API/CLI reference site (`/reference`) | ✅ Complete |
| PRD-050 | Managed Redis | ✅ Complete |
| PRD-051 | Required secrets preflight (`needs-config` status) | ✅ Complete |
| - | Docker isolation mode (`AppRuntime` seam: PM2 or containers; `drop migrate-runtime`) | ✅ Complete |
| - | Go app support (detector + builder strategy) | ✅ Complete |
| - | Agent-deploy guardrails (circuit breaker, per-principal/per-owning-user quotas, ephemeral TTL'd apps, idle reaper, disk ceiling) | ✅ Complete |
| - | Monorepo / multi-service deploys (`services:` in `drop.yaml`) | ✅ Complete |
| - | Database panel (dashboard) | ✅ Complete |
| - | Multi-user MCP connectors | ✅ Complete |
| - | Boot reconciliation (no full-fleet rebuild on restart) | ✅ Complete |
| - | `DROP_API_URL` + scoped `DROP_API_KEY` for capability-granted apps | ✅ Complete |
| - | TOTP two-factor auth, forced password change on first login | ✅ Complete |
| - | Dashboard redesign (log viewer, settings tabs, deploy timeline, per-app metrics tab) | ✅ Complete |

### Capabilities
- **Runtime isolation**: tenant apps run under PM2 (`isolation: none`, the
  default) or Docker containers (`isolation: docker`), chosen once at boot;
  existing apps move between the two with `drop migrate-runtime`.
- **Agent access**: a hosted MCP server exposes DROP's own deploy/status/logs
  tools to Claude and other MCP clients, authorized via OAuth 2.1 + PKCE or
  scoped agent tokens.
- **Agent-deploy guardrails**: a circuit breaker, per-principal *and*
  per-owning-user deploy quotas, ephemeral TTL'd scratch apps, an idle reaper,
  and a per-app disk ceiling — every limit returns a structured refusal
  instead of a silent kill.
- **Monorepo / multi-service deploys**: a `services:` block in `drop.yaml`
  expands one repository into multiple apps sharing a hostname, with
  same-origin `/api` routing and group-aware start/stop/redeploy.
- **Managed Redis**: an app can opt into a bundled, per-app Redis logical
  database via `drop.yaml`.
- **Public site split from the dashboard**: `/`, `/docs`, and `/reference`
  build as a separate bundle from the authenticated `/dashboard` SPA.
- **Database panel**: the dashboard can browse an app's provisioned database,
  reading it as the app's own database role.
- **Multi-user connectors**: non-admin users can set up their own claude.ai
  connector, gated by an admin-controlled setting.
- **Boot reconciliation**: a platform restart reconciles already-running apps
  against their config instead of rebuilding the whole fleet.
- **Auth**: opt-in TOTP two-factor authentication, forced password change on
  first login, admin-manageable GitHub webhook secret.

### Security Hardening

This release also folds in a broad hardening pass across areas that were
built incrementally but never previously published (condensed by category —
see `CHANGELOG.md`'s `[1.0.0]` → Security section for the full list):

- **Access control & multi-tenant isolation** — ownership enforcement on app
  mutation and log endpoints; every deploy path is contained inside the
  webapps directory; a tenant-authored name can no longer collide with,
  delete, or route-hijack another owner's app, database, or domain.
- **Auth & API keys** — authentication on by default; JWT verification pinned
  to HS256; legacy password hashes compared in constant time and upgraded to
  scrypt on login; an API key's standing derives from its owner rather than
  the key being its own principal.
- **Agent & MCP surfaces** — the untrusted-output fence around tenant text can
  no longer be forged or bypassed; the MCP `forward_auth` guard rejects every
  credential class except an app-audienced bearer; per-app OAuth audiences;
  scoped agent tokens with an explicit grammar.
- **Guardrails** — closed several bypasses a dedicated security review found
  on the code path an autonomous deploy loop rides.
- **Build isolation** — tenant build commands no longer inherit platform
  secrets, on either the host or containerized build path.
- **Webhooks** — signature verification no longer skips on a missing header;
  outbound webhook URLs reject localhost/private/link-local targets (SSRF).
- **Secrets** — app secrets are encrypted with a standalone key instead of one
  derived from the store itself.
- **Misc** — CORS defaults to same-origin, a Content-Security-Policy is set,
  and 500 responses no longer leak internal error text.

### Deliverables
- [x] Docker isolation mode alongside PM2, with `drop migrate-runtime`
- [x] Hosted MCP server + OAuth 2.1 agent access
- [x] Agent-deploy guardrails (breaker, quotas, ephemeral apps, idle reaper,
      disk ceiling)
- [x] Monorepo / multi-service deploys
- [x] Managed Redis
- [x] Public site, docs, and reference (split from the authenticated dashboard)
- [x] Database panel
- [x] Multi-user MCP connectors
- [x] Required secrets preflight
- [x] Boot reconciliation
- [x] Scoped `DROP_API_KEY` + `DROP_API_URL`
- [x] TOTP MFA, forced password change, webhook secret UI
- [x] `drop restore`, expanded `drop backup` (captures per-app databases)
- [x] Dashboard redesign (log viewer, settings tabs, deploy timeline, metrics)
- [x] CI on every PR (lint, server build, tests, both dashboard builds)
- [x] Broad security hardening across access control, auth, agent/MCP
      surfaces, guardrails, build isolation, webhooks, and secrets

---

## Post-1.0 — Planned, Not Committed

Nothing below has a version number, a target date, or committed scope. It is
either work identified during the 1.0.0 launch review as worth continuing, or
a feature with a written PRD that has not been built. Treat this as direction,
not a promise.

### Continued hardening

- Continued authentication hardening (rate-limiting granularity, password
  policy).
- Hardening of the legacy secret-store format.
- Further isolation hardening for the default non-container (`isolation: none`)
  mode.
- Dependency update automation.
- CI/deploy pipeline hardening.

### Ideas with a written PRD, not yet built

- **Plugin architecture** — extending the platform beyond its built-in app
  types. No plugin system exists today.
- **Replication / high availability** — DROP runs single-node today; there is
  no built-in clustering, replication, or failover.
- **Deeper monitoring & observability** — beyond the current per-app
  CPU/memory/uptime metrics tab, there is no metrics-export endpoint,
  alerting, or historical retention.

---

## Quick Reference: What's in Each Version

```
v0.1.0 (released 2026-01-18)
├── Drop folder → app runs (Node.js, Python, Static, Docker)
├── CLI, REST API (JWT/API key), web dashboard
├── PostgreSQL auto-provisioning
├── Hot reload, auto-capture logging
└── Persistent data directories

v1.0.0 (released 2026-08-07, current)
├── + Go app support
├── + Docker isolation mode alongside PM2, drop migrate-runtime
├── + Hosted MCP server + OAuth 2.1 (agent / Claude access)
├── + Agent-deploy guardrails (breaker, quotas, ephemeral apps, idle reaper, disk ceiling)
├── + Monorepo / multi-service deploys
├── + Managed Redis
├── + Public site, docs, and reference (split from the dashboard)
├── + Database panel, multi-user MCP connectors
├── + TOTP two-factor auth
├── + Dashboard redesign (log viewer, settings tabs, deploy timeline, metrics)
└── + Broad security hardening across auth, agent/MCP, build isolation, webhooks, secrets
```

---

## Contributing

Branch naming, commit conventions, and the release process are documented in
`docs/GIT-BRANCHING-MODEL.md`. In short: never commit directly to `main` or
`develop`; branch from `develop` (`feature/`, `bugfix/`, `hotfix/`); commit
messages follow [Conventional Commits](https://www.conventionalcommits.org/).
