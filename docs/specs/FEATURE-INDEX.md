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
| v0.6.0 | Connect | 2 features | Planned |
| v1.0.0 | Production | Stable | Planned |

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
| 2 | [PRD-015](prd/PRD-015-monitoring.md) | Monitoring | - | Not Started |
| 3 | - | Health Checks | - | Not Started |
| 4 | - | Log Aggregation | - | Not Started |

### v0.4.0 New Capabilities
- ✅ React web dashboard (login, dark mode, deploy UI, search/filter, env vars, toasts, error boundaries)
- Real-time monitoring - Not Started
- Prometheus metrics - Not Started
- Centralized logging - Not Started

---

## v0.5.0 - Enterprise

**Goal**: Plugins and high availability

**Command**: `/work-version v0.5.0`

| Order | PRD | Feature | Tasks | Status |
|-------|-----|---------|-------|--------|
| 1 | [PRD-013](prd/PRD-013-plugins.md) | Plugin Architecture | - | Not Started |
| 2 | [PRD-014](prd/PRD-014-replication.md) | Replication & HA | - | Not Started |
| 3 | - | Multi-tenancy | - | Not Started |
| 4 | - | Backup Automation | - | Not Started |

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
| 1 | [PRD-016](prd/PRD-016-git-deploy.md) | Git Deploy (GitHub) | [TASKS-016](tasks/TASKS-016-git-deploy.md) | Not Started |
| 2 | - | Auto-Redeploy (Webhooks) | - | Not Started |

### v0.6.0 New Capabilities
- Deploy apps from GitHub repos (public + private)
- Personal Access Token management for private repos
- Auto-redeploy on push via GitHub webhooks
- Dashboard UI: paste URL, pick branch, deploy
- CLI: `drop deploy --git <url>`
- Git metadata tracking (repo URL, branch, commit SHA)

---

## v1.0.0 - Production

**Goal**: Stable, production-ready release

**Requirements**:
- All v0.x features stable
- No critical bugs
- Complete documentation
- Performance benchmarks met
- Security audit passed

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
