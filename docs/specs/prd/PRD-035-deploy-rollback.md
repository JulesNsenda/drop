# PRD-035: Deploy Rollback

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-035 |
| Feature | Deploy Rollback |
| Status | Planned |
| Priority | P2 |
| Created | 2026-03-19 |

---

## Overview

Keep the last N deployments per app and allow instant rollback to a previous
version via API or dashboard.

## Changes

1. **Deployment history** - Record each deploy with git SHA or content hash, timestamp, and status
2. **Snapshot retention** - Keep last 3 deployments per app (configurable)
3. **Rollback API** - `POST /api/v1/apps/:name/rollback` reverts to the previous deployment
4. **Git rollback** - For git apps, `git checkout <sha>` then rebuild and restart
5. **Folder rollback** - For folder apps, restore snapshot from `data/build-cache/<appname>/snapshots/`
6. **Dashboard button** - Rollback button on app detail page with deployment history dropdown
