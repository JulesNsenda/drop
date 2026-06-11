# PRD-033: SQLite State

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-033 |
| Feature | SQLite State |
| Status | Planned |
| Priority | P1 |
| Created | 2026-03-19 |

---

## Overview

Migrate platform state from JSON files to SQLite using better-sqlite3.
Eliminates concurrent write corruption and enables atomic transactions
for all state mutations.

## Changes

1. **SQLite database** - Single `drop.db` file in `data/drop-svc/` replaces `apps.json` and other JSON state files
2. **Schema** - Tables: `apps`, `users`, `activity_log`, `api_keys`, `secrets_metadata`
3. **Atomic transactions** - All state writes wrapped in SQLite transactions
4. **Migration system** - Versioned schema migrations in `src/managers/state/migrations/`
5. **JSON migration script** - One-time import of existing JSON data into SQLite on first run
6. **Synchronous API** - Use better-sqlite3 for synchronous reads/writes (no async overhead for state ops)
