# TASKS-033: SQLite State

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-033 |
| PRD | PRD-033 |
| Branch | `feature/DROP-033-sqlite-state` |
| Created | 2026-03-19 |

---

## Tasks

### 1. Database Setup
- [ ] Add `better-sqlite3` dependency
- [ ] Create `src/managers/state/sqlite-db.ts` with singleton DB connection
- [ ] Open `data/drop-svc/drop.db` on platform startup
- [ ] Enable WAL mode for better concurrent read performance

### 2. Schema & Migrations
- [ ] Create `src/managers/state/migrations/` directory
- [ ] Migration 001: `apps` table (name, type, status, port, userId, config JSON, timestamps)
- [ ] Migration 002: `users` table (id, username, passwordHash, role, enabled, lastLogin)
- [ ] Migration 003: `activity_log` table (id, userId, action, appName, timestamp, details JSON)
- [ ] Migration 004: `api_keys` table (id, userId, keyHash, label, createdAt, lastUsedAt)
- [ ] Migration 005: `secrets_metadata` table (id, appName, key, createdAt)
- [ ] Migration runner that tracks applied versions in `schema_version` table

### 3. State Manager Rewrite
- [ ] Rewrite `AppStateManager` to read/write from SQLite instead of `apps.json`
- [ ] Keep same public API (`getApp`, `setApp`, `removeApp`, `getAllApps`)
- [ ] Wrap multi-step state changes in transactions
- [ ] Replace user store (JSON/PostgreSQL) with SQLite `users` table

### 4. JSON Migration Script
- [ ] On first startup, detect existing `apps.json` and import into `apps` table
- [ ] Import existing user data into `users` table
- [ ] Rename old JSON files to `.bak` after successful migration
- [ ] Log migration summary (rows imported per table)

### 5. Activity Log Integration
- [ ] Write activity events to `activity_log` table
- [ ] Update `GET /api/v1/activity` to query SQLite instead of in-memory store

### 6. Build & Test
- [ ] Unit test: CRUD operations on each table
- [ ] Unit test: migration runner applies migrations in order
- [ ] Unit test: JSON migration imports data correctly
- [ ] Verify existing API responses unchanged after migration
- [ ] TypeScript compiles
