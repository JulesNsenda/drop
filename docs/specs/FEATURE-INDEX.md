# DROP Feature Index

Quick reference to all PRDs and task files organized by version.

---

## Version Summary

| Version | Codename | Features | Status |
|---------|----------|----------|--------|
| **v0.1.0** | MVP | 8 features | **Completed** |
| v0.2.0 | Foundation | 4 features | **Completed** |
| v0.3.0 | Interfaces | 5 features | **Completed** |
| v0.4.0 | Experience | 4 features | **Completed** (Dashboard polish) |
| v0.5.0 | Enterprise | 4 features | Planned |
| v0.6.0 | Connect | 2 features | **Completed** |
| v0.7.0 | SaaS Ready | 11 features | **Completed** |
| v1.0.0 | Production | 5 features | **In Progress** (4/5 done) |
| v2.0.0 | Architecture | 10 features | **In Progress** (1 done, 3 partial) |

---

## v0.1.0 - MVP (Minimum Viable Product)

**Goal**: Deploy a Node.js app by dropping a folder

**Command**: `/work-version mvp` or `/work-version v0.1.0`

| Order | PRD | Feature | Tasks | Status |
|-------|-----|---------|-------|--------|
| 1 | [PRD-005](prd/PRD-005-app-registry.md) | App Registry (PostgreSQL) | [TASKS-005](tasks/TASKS-005-app-registry.md) | **Completed** |
| 2 | [PRD-006](prd/PRD-006-event-bus.md) | Event Bus | [TASKS-006](tasks/TASKS-006-event-bus.md) | **Completed** |
| 3 | [PRD-001](prd/PRD-001-watcher-service.md) | Watcher Service | [TASKS-001](tasks/TASKS-001-watcher-service.md) | **Completed** |
| 4 | [PRD-002](prd/PRD-002-detector-service.md) | Detector Service | [TASKS-002](tasks/TASKS-002-detector-service.md) | **Completed** |
| 5 | [PRD-003](prd/PRD-003-builder-service.md) | Builder Service | [TASKS-003](tasks/TASKS-003-builder-service.md) | **Completed** |
| 6 | [PRD-004](prd/PRD-004-process-manager.md) | Process Manager | [TASKS-004](tasks/TASKS-004-process-manager.md) | **Completed** |
| 7 | [PRD-008](prd/PRD-008-reverse-proxy.md) | Reverse Proxy (basic) | [TASKS-008](tasks/TASKS-008-reverse-proxy.md) | **Completed** |
| 8 | [PRD-010](prd/PRD-010-cli.md) | CLI (basic) | [TASKS-010](tasks/TASKS-010-cli.md) | **Completed** |

### MVP Capabilities
- ✅ Node.js, Python, and Static site support
- ✅ JWT and API Key authentication
- ✅ HTTPS/TLS via Caddy (Let's Encrypt)
- ✅ PostgreSQL auto-provisioning for apps
- ✅ REST API with 14 endpoints
- ✅ CLI commands: serve, list, status, logs, deploy, start/stop/restart, remove

---

## v0.2.0 - Foundation

**Goal**: Add database provisioning and security

**Command**: `/work-version v0.2.0`

| Order | PRD | Feature | Tasks | Status |
|-------|-----|---------|-------|--------|
| 1 | [PRD-007](prd/PRD-007-database-manager.md) | Database Manager | [TASKS-007](tasks/TASKS-007-database-manager.md) | **Completed** |
| 2 | [PRD-012](prd/PRD-012-security.md) | Security Model | [TASKS-012](tasks/TASKS-012-security.md) | **Completed** |
| 3 | - | Python Support | - | **Completed** |
| 4 | - | Static Site Support | - | **Completed** |

### v0.2.0 New Capabilities
- ✅ PostgreSQL/SQLite for apps (bundled PostgreSQL)
- ✅ JWT authentication (implemented in v0.1.0)
- ✅ API Key authentication (implemented in v0.1.0)
- ✅ Secret encryption (AES-256-GCM)
- ✅ Python (Flask, FastAPI) support
- ✅ Static site serving

---

## v0.3.0 - Interfaces

**Goal**: Full API and CLI experience

**Command**: `/work-version v0.3.0`

| Order | PRD | Feature | Tasks | Status |
|-------|-----|---------|-------|--------|
| 1 | [PRD-009](prd/PRD-009-rest-api.md) | REST API (complete) | [TASKS-009](tasks/TASKS-009-rest-api.md) | **Completed** |
| 2 | [PRD-010](prd/PRD-010-cli.md) | CLI (complete) | [TASKS-010](tasks/TASKS-010-cli.md) | **Completed** (basic) |
| 3 | [PRD-008](prd/PRD-008-reverse-proxy.md) | HTTPS & TLS | [TASKS-008](tasks/TASKS-008-reverse-proxy.md) | **Completed** |
| 4 | - | Go Support | - | **Completed** |
| 5 | - | Webhooks | - | **Completed** |

### v0.3.0 New Capabilities
- ✅ Full REST API (Hono framework, 14 endpoints)
- ✅ Complete CLI (basic commands)
- ✅ Automatic HTTPS via Caddy (Let's Encrypt/ACME)
- ✅ Go application support (go.mod detection, framework detection, static binary builds)
- ✅ Webhook notifications (HMAC-SHA256 signing, delivery tracking, REST API)

---

## v0.4.0 - Experience

**Goal**: Web dashboard and monitoring

**Command**: `/work-version v0.4.0`

| Order | PRD | Feature | Tasks | Status |
|-------|-----|---------|-------|--------|
| 1 | [PRD-011](prd/PRD-011-web-dashboard.md) | Web Dashboard | [TASKS-011](tasks/TASKS-011-web-dashboard.md) | **Completed** |
| 2 | [PRD-015](prd/PRD-015-monitoring.md) | Monitoring | - | In Progress (per-app CPU/mem in apps API; no Prometheus/alerting/history) |
| 3 | - | Health Checks | - | **Completed** |
| 4 | - | Log Aggregation | - | Not Started (per-app logs only) |

### v0.4.0 New Capabilities
- ✅ React web dashboard (login, dark mode, deploy UI, search/filter, env vars, toasts, error boundaries)
- ✅ Health checks: platform components, PostgreSQL, per-app HTTP pings, dashboard display
- ⚠️ Monitoring - Partial: per-app CPU/memory exposed via the apps API; no Prometheus export, alerting, or historical metrics
- Centralized logging - Not Started (per-app log access only)

---

## v0.5.0 - Enterprise

**Goal**: Plugins and high availability

**Command**: `/work-version v0.5.0`

| Order | PRD | Feature | Tasks | Status |
|-------|-----|---------|-------|--------|
| 1 | [PRD-013](prd/PRD-013-plugins.md) | Plugin Architecture | - | Not Started |
| 2 | [PRD-014](prd/PRD-014-replication.md) | Replication & HA | - | Not Started |
| 3 | - | Multi-tenancy | - | **Completed** (shipped as [PRD-018](prd/PRD-018-multi-tenant.md)) |
| 4 | - | Backup Automation | - | In Progress (manual `drop backup` CLI done; no scheduler/API) |

### v0.5.0 New Capabilities
- Plugin system
- PRIMARY/REPLICA clustering
- Automatic failover
- Multi-tenant support

---

## v0.6.0 - Connect

**Goal**: Deploy directly from GitHub repositories

**Command**: `/work-version v0.6.0`

| Order | PRD | Feature | Tasks | Status |
|-------|-----|---------|-------|--------|
| 1 | [PRD-016](prd/PRD-016-git-deploy.md) | Git Deploy (GitHub) | [TASKS-016](tasks/TASKS-016-git-deploy.md) | **Completed** |
| 2 | - | Auto-Redeploy (Webhooks) | - | **Completed** |

### v0.6.0 New Capabilities
- ✅ Deploy apps from GitHub repos (public + private)
- ✅ Personal Access Token management for private repos
- ✅ Auto-redeploy on push via GitHub webhooks
- ✅ Dashboard UI: unified deploy page with GitHub/Upload tabs
- ✅ CLI: `drop deploy --git <url>`
- ✅ Git metadata tracking (repo, branch, commit SHA) in app detail
- Git metadata tracking (repo URL, branch, commit SHA)

---

## v0.7.0 - SaaS Ready

**Goal**: Multi-tenant SaaS features for shared platform usage

| Order | PRD | Feature | Tasks | Status |
|-------|-----|---------|-------|--------|
| 1 | [PRD-018](prd/PRD-018-multi-tenant.md) | Multi-Tenant (Signup, Ownership) | - | **Completed** |
| 2 | [PRD-019](prd/PRD-019-admin-user-management.md) | Admin User Management | [TASKS-019](tasks/TASKS-019-admin-user-management.md) | **Completed** |
| 3 | [PRD-020](prd/PRD-020-per-user-app-limits.md) | Per-User App Limits | [TASKS-020](tasks/TASKS-020-per-user-app-limits.md) | **Completed** |
| 4 | [PRD-021](prd/PRD-021-change-password.md) | Change Password | [TASKS-021](tasks/TASKS-021-change-password.md) | **Completed** |
| 5 | [PRD-022](prd/PRD-022-custom-domains.md) | Custom Domains | [TASKS-022](tasks/TASKS-022-custom-domains.md) | **Completed** |
| 6 | [PRD-023](prd/PRD-023-activity-log.md) | Activity Log | [TASKS-023](tasks/TASKS-023-activity-log.md) | **Completed** |

### v0.7.0 New Capabilities
- ✅ Multi-tenant: signup, login, app ownership, role-based filtering
- ✅ Admin user management dashboard
- ✅ Per-user app limits (default: 5, per-user override)
- ✅ Change password
- ✅ Custom domains API
- ✅ Activity log for admin
- ✅ Email on signup
- ✅ Admin reset password
- ✅ Delete account
- ✅ Deploy progress indicator
- ✅ Mobile responsive sidebar
- ✅ Confirm dialog component (replaces native confirm)

---

## v1.0.0 - Production

**Goal**: Stable, production-ready release

| Order | PRD | Feature | Tasks | Status |
|-------|-----|---------|-------|--------|
| 1 | [PRD-024](prd/PRD-024-token-expiry-handling.md) | Token Expiry Handling | [TASKS-024](tasks/TASKS-024-token-expiry-handling.md) | **Completed** |
| 2 | [PRD-025](prd/PRD-025-404-page.md) | 404 Page | [TASKS-025](tasks/TASKS-025-404-page.md) | **Completed** |
| 3 | [PRD-026](prd/PRD-026-logout-redirect.md) | Logout Redirect | [TASKS-026](tasks/TASKS-026-logout-redirect.md) | **Completed** |
| 4 | [PRD-027](prd/PRD-027-app-limit-indicator.md) | App Limit Indicator | [TASKS-027](tasks/TASKS-027-app-limit-indicator.md) | In Progress (usage API + badge done; deploy-page gating missing) |
| 5 | [PRD-028](prd/PRD-028-signup-success-message.md) | Signup Success Message | [TASKS-028](tasks/TASKS-028-signup-success-message.md) | **Completed** |

**Requirements**:
- All v0.x features stable
- No critical bugs
- Complete documentation
- Performance benchmarks met
- Security audit passed

---

## v2.0.0 - Architecture

**Goal**: Production-grade architecture for real multi-tenant SaaS

| Order | PRD | Feature | Tasks | Priority | Status |
|-------|-----|---------|-------|----------|--------|
| 1 | [PRD-029](prd/PRD-029-docker-isolation.md) | Docker Isolation | [TASKS-029](tasks/TASKS-029-docker-isolation.md) | P0 | **Completed** (alternate design) |
| 2 | [PRD-030](prd/PRD-030-deploy-transaction.md) | Deploy as Transaction | [TASKS-030](tasks/TASKS-030-deploy-transaction.md) | P0 | Not Started |
| 3 | [PRD-031](prd/PRD-031-build-caching.md) | Build Caching | [TASKS-031](tasks/TASKS-031-build-caching.md) | P1 | Not Started |
| 4 | [PRD-032](prd/PRD-032-caddy-required.md) | Caddy Required (Real URLs) | [TASKS-032](tasks/TASKS-032-caddy-required.md) | P1 | In Progress (Caddy lifecycle/routing done; auto-install + base-domain URLs missing) |
| 5 | [PRD-033](prd/PRD-033-sqlite-state.md) | SQLite State Storage | [TASKS-033](tasks/TASKS-033-sqlite-state.md) | P1 | Not Started |
| 6 | [PRD-034](prd/PRD-034-build-logs.md) | Build Logs in Dashboard | [TASKS-034](tasks/TASKS-034-build-logs.md) | P1 | In Progress (writer + read API done; dashboard viewer missing) |
| 7 | [PRD-038](prd/PRD-038-ssl-all-apps.md) | SSL for All Apps | [TASKS-038](tasks/TASKS-038-ssl-all-apps.md) | P1 | In Progress (backend HTTPS/wildcard/cert API via M4; app cert-status field + dashboard UI missing) |
| 8 | [PRD-035](prd/PRD-035-deploy-rollback.md) | Deploy Rollback | [TASKS-035](tasks/TASKS-035-deploy-rollback.md) | P2 | Not Started |
| 9 | [PRD-036](prd/PRD-036-resource-limits.md) | Resource Limits | [TASKS-036](tasks/TASKS-036-resource-limits.md) | P2 | Not Started |
| 10 | [PRD-037](prd/PRD-037-app-backups.md) | App Backups | [TASKS-037](tasks/TASKS-037-app-backups.md) | P2 | Not Started |

### v2.0 Architecture Priorities
- **P0**: Docker isolation (security), deploy-as-transaction (reliability)
- **P1**: Build caching, Caddy auto-URLs, SQLite state, build logs, SSL
- **P2**: Rollback, resource limits, backups

---

## Quick Start

To work on a specific version:
```
/work-version mvp        # Start MVP development
/work-version v0.2.0     # Start Foundation development
```

---

## Templates

- [PRD Template](prd/_TEMPLATE.md)
- [Tasks Template](tasks/_TEMPLATE.md)

---

## Related Documents

- [Version Roadmap](../VERSION-ROADMAP.md) - Detailed version planning
- [Main Specification](DROP-PAAS-SPECIFICATION.md) - Complete specification
- [Clean Code Guidelines](../CLEAN-CODE-GUIDELINES.md) - Coding standards
- [Git Branching Model](../GIT-BRANCHING-MODEL.md) - Branch strategy
- [CHANGELOG](../../CHANGELOG.md) - Version history

---

## Status Legend

| Status | Description |
|--------|-------------|
| Not Started | Work has not begun |
| In Progress | Currently being implemented |
| Review | Implementation complete, pending review |
| Completed | Fully implemented and merged |
| Blocked | Waiting on dependencies |
