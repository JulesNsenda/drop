# PRD-037: App Backups

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-037 |
| Feature | App Backups |
| Status | Planned |
| Priority | P2 |
| Created | 2026-03-19 |

---

## Overview

Automated and manual backup of app data, database, and config. Backups are
stored locally with configurable retention. Restore recreates the app from
a backup snapshot.

## Changes

1. **Backup contents** - App source/artifacts, PostgreSQL database dump (pg_dump), app config/env vars
2. **Scheduled backups** - Daily backup of all apps (cron-style scheduler, configurable interval)
3. **Manual backup** - `POST /api/v1/apps/:name/backup` triggers immediate backup
4. **Backup storage** - `data/backups/<appname>/<date>/` containing source archive, db dump, config JSON
5. **Restore** - `POST /api/v1/apps/:name/restore/:backupId` stops app, restores files and database, restarts
6. **Retention** - Keep last 7 backups per app, auto-delete older ones
