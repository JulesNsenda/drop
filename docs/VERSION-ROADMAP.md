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
| **v0.1.0** | **MVP++** | Deployment + Dashboard + Databases | **Released** |
| v0.2.0 | Foundation | Reverse Proxy & HTTPS | In Progress |
| v0.3.0 | Interfaces | Full API & CLI | Planned |
| v0.4.0 | Experience | Monitoring & Observability | Planned |
| v0.5.0 | Enterprise | Plugins & Replication | Planned |
| v1.0.0 | Production | Stable release | Planned |

---

## v0.1.0 - MVP++ (Released 2026-01-18)

**Goal**: Full deployment pipeline with dashboard and database support

**Branch**: `main` (released)

### Features Delivered

| PRD | Feature | Status |
|-----|---------|--------|
| PRD-005 | App Registry (SQLite/JSON) | ✅ Complete |
| PRD-006 | Event Bus | ✅ Complete |
| PRD-001 | Watcher Service | ✅ Complete |
| PRD-002 | Detector Service (Node.js, Python, Static, Docker) | ✅ Complete |
| PRD-003 | Builder Service (all types) | ✅ Complete |
| PRD-004 | Process Manager (PM2) | ✅ Complete |
| PRD-007 | PostgreSQL Auto-Provisioning | ✅ Complete |
| PRD-009 | REST API with JWT/API Key Auth | ✅ Complete |
| PRD-010 | CLI (complete) | ✅ Complete |
| PRD-011 | Web Dashboard | ✅ Complete |
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

## v0.2.0 - Foundation

**Goal**: Caddy reverse proxy with automatic HTTPS

**Branch**: `release/v0.2.0`

### Features Planned

| PRD | Feature | Priority | Status |
|-----|---------|----------|--------|
| PRD-008 | Caddy Reverse Proxy | P0 | Not Started |
| - | Automatic HTTPS | P1 | Not Started |
| - | Custom domain support | P1 | Not Started |
| - | SSL certificate management | P1 | Not Started |

### New Capabilities
- Apps accessible via hostnames (myapp.localhost)
- Automatic HTTPS with Let's Encrypt
- Caddy configuration generation
- Custom domain binding
- SSL certificate auto-renewal

### Deliverables
- [ ] Caddy integration
- [ ] Automatic Caddyfile generation
- [ ] Hostname routing
- [ ] HTTPS automation
- [ ] Domain configuration CLI commands

---

## v0.3.0 - Interfaces

**Goal**: Full API and CLI experience

**Branch**: `release/v0.3.0`

### Features Included

| PRD | Feature | Priority | Effort |
|-----|---------|----------|--------|
| PRD-009 | REST API (complete) | P0 | High |
| PRD-010 | CLI (complete) | P0 | High |
| PRD-008 | HTTPS & TLS | P1 | Medium |
| - | Go app support | P2 | Medium |

### New Capabilities
- Full REST API with OpenAPI docs
- Complete CLI with all commands
- Automatic HTTPS via Let's Encrypt
- Hot TLS certificate reload
- Go application support
- Webhook notifications

### Deliverables
- [ ] Complete REST API
- [ ] OpenAPI documentation
- [ ] Full CLI implementation
- [ ] HTTPS automation
- [ ] Go build strategies

---

## v0.4.0 - Experience

**Goal**: Web dashboard and monitoring

**Branch**: `release/v0.4.0`

### Features Included

| PRD | Feature | Priority | Effort |
|-----|---------|----------|--------|
| PRD-011 | Web Dashboard | P1 | High |
| PRD-015 | Monitoring & Observability | P1 | High |
| - | Log aggregation | P1 | Medium |
| - | Health checks | P1 | Medium |

### New Capabilities
- React-based web dashboard
- Real-time log viewing
- Application health monitoring
- Prometheus metrics
- Resource usage graphs
- Deployment history

### Deliverables
- [ ] Web dashboard
- [ ] Real-time updates
- [ ] Metrics endpoint
- [ ] Health check system
- [ ] Log aggregation

---

## v0.5.0 - Enterprise

**Goal**: Plugins and high availability

**Branch**: `release/v0.5.0`

### Features Included

| PRD | Feature | Priority | Effort |
|-----|---------|----------|--------|
| PRD-013 | Plugin Architecture | P2 | High |
| PRD-014 | Replication & HA | P2 | Very High |
| - | Multi-tenancy | P2 | High |
| - | Backup automation | P2 | Medium |

### New Capabilities
- Plugin system for extensions
- PRIMARY/REPLICA clustering
- Automatic failover
- Multi-tenant support
- Automated backups
- MySQL plugin
- Redis plugin

### Deliverables
- [ ] Plugin system
- [ ] Replication protocol
- [ ] Failover mechanism
- [ ] Tenant isolation
- [ ] Backup scheduling

---

## v1.0.0 - Production

**Goal**: Stable, production-ready release

**Branch**: `release/v1.0.0`

### Requirements for 1.0
- All v0.x features stable
- No critical bugs
- Complete documentation
- Performance benchmarks met
- Security audit passed
- Migration guides from v0.x

### Stability Guarantees
- API backward compatibility
- Configuration compatibility
- Database migration support
- Deprecation warnings (minimum 2 minor versions)

---

## Development Workflow Per Version

### Starting a Version
```bash
# Create release branch from develop
git checkout develop
git pull origin develop
git checkout -b release/v0.1.0

# Update version in package.json
npm version 0.1.0-alpha.1 --no-git-tag-version
```

### During Development
```bash
# Work on features in feature branches
git checkout -b feature/DROP-001-watcher-service
# ... implement ...
git checkout release/v0.1.0
git merge feature/DROP-001-watcher-service
```

### Releasing a Version
```bash
# Finalize version
npm version 0.1.0 --no-git-tag-version

# Update CHANGELOG.md
# Merge to main
git checkout main
git merge --no-ff release/v0.1.0
git tag -a v0.1.0 -m "Release v0.1.0 - MVP"
git push origin main --tags

# Merge back to develop
git checkout develop
git merge --no-ff release/v0.1.0
git push origin develop
```

---

## Quick Reference: What's in Each Version

```
v0.1.0 (MVP++) ✅ RELEASED
├── Drop folder → App runs
├── Multi-runtime (Node.js, Python, Static, Docker)
├── Complete CLI
├── REST API with JWT/API key auth
├── Web Dashboard
├── PostgreSQL auto-provisioning
├── Hot reload
├── Auto-capture logging
└── Persistent data directories

v0.2.0 (Foundation) 🚧 IN PROGRESS
├── + Caddy reverse proxy
├── + Hostname routing (myapp.localhost)
├── + Automatic HTTPS
└── + Let's Encrypt integration

v0.3.0 (Interfaces)
├── + OpenAPI documentation
├── + Webhooks
├── + Go support
└── + CLI enhancements

v0.4.0 (Experience)
├── + Prometheus metrics
├── + Health checks
├── + Log search/aggregation
└── + Resource monitoring

v0.5.0 (Enterprise)
├── + Plugin system
├── + Replication/HA
├── + Multi-tenancy
├── + Backup automation
└── + MySQL/Redis plugins

v1.0.0 (Production)
└── Stable, production-ready
```

---

## Working on a Version

To work on a specific version, use:
```
/work-version v0.1.0
```

This will:
1. Checkout/create the release branch
2. Show all features for that version
3. Guide you through implementation
4. Track progress automatically
