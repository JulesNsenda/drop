# TASKS-037: App Backups

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-037 |
| PRD | PRD-037 |
| Branch | `feature/DROP-037-app-backups` |
| Created | 2026-03-19 |

---

## Tasks

### 1. Backup Service
- [ ] Create `src/managers/backup/backup-service.ts`
- [ ] `createBackup(appName)` method orchestrating the full backup
- [ ] Create backup directory: `data/backups/<appname>/<ISO-date>/`
- [ ] Archive app source directory as `source.tar.gz`
- [ ] Export app config and env vars as `config.json`

### 2. Database Backup
- [ ] Run `pg_dump` for the app's database, output to `database.sql` in backup directory
- [ ] Skip database backup if app has no provisioned database
- [ ] Handle pg_dump errors gracefully (log warning, continue with other backup steps)

### 3. Scheduled Backups
- [ ] Add backup scheduler using `node-cron` or `setInterval`
- [ ] Default schedule: daily at 02:00 (configurable via platform config)
- [ ] Iterate all running apps and create backup for each
- [ ] Log backup results (success/failure per app)

### 4. Backup API
- [ ] Add `POST /api/v1/apps/:name/backup` - trigger manual backup
- [ ] Add `GET /api/v1/apps/:name/backups` - list backups with date and size
- [ ] Add `POST /api/v1/apps/:name/restore/:backupId` - restore from backup
- [ ] Restore flow: stop app → extract source → restore DB → rebuild → start

### 5. Retention
- [ ] After each backup, count existing backups for the app
- [ ] Delete oldest backups beyond retention limit (default: 7)
- [ ] Make retention configurable via platform config

### 6. Dashboard UI
- [ ] Add backups section to app detail page
- [ ] List backups with date, size, and restore/download buttons
- [ ] Manual backup trigger button
- [ ] Confirmation dialog before restore

### 7. Build & Test
- [ ] Unit test: backup creates expected files in correct directory
- [ ] Unit test: retention deletes oldest backups
- [ ] Unit test: restore flow executes steps in order
- [ ] API test: endpoints return correct responses
- [ ] TypeScript compiles
