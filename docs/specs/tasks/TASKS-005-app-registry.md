# TASKS-005: App Registry

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-005 |
| Feature | App Registry |
| PRD | PRD-005 |
| Status | In Progress |
| Version | v0.1.0 (MVP) |
| Branch | `feature/DROP-005-app-registry` |
| Assignee | Claude |
| Created | 2024-12-30 |
| Updated | 2025-01-17 |

---

## Progress Summary

| Category | Total | Completed | Remaining |
|----------|-------|-----------|-----------|
| Setup | 4 | 4 | 0 |
| Implementation | 10 | 6 | 4 |
| Testing | 5 | 2 | 3 |
| Documentation | 3 | 0 | 3 |
| **Total** | **22** | **12** | **10** |

---

## Current Status

The App Registry has a **partial implementation**:
- `AppStateManager` (`src/managers/app/state-manager.ts`) - JSON file-based state tracking
- `AppRegistry` (`src/managers/app/app-registry.ts`) - Basic registry with types
- `DatabaseProvisioner` (`src/managers/database/database-provisioner.ts`) - PostgreSQL database provisioning for apps
- `PostgresServer` (`src/managers/database/postgres-server.ts`) - Bundled PostgreSQL server

**What's missing**: Migration from JSON-based `AppStateManager` to full PostgreSQL-backed `AppRegistry` with deployment history and environment variable storage.

---

## Pre-Implementation Checklist

- [x] Read PRD-005 thoroughly
- [x] Read DROP-PAAS-SPECIFICATION.md relevant sections
- [x] Create feature branch: `git checkout -b feature/DROP-005-app-registry`
- [x] Ensure PostgreSQL is available for development
- [x] Review pg (node-postgres) documentation

---

## Tasks

### 1. Setup Tasks

#### 1.1 Create Directory Structure
- [x] Create `src/managers/app/` directory
- [x] Create `src/managers/app/migrations/` directory
- [x] Create `src/managers/app/index.ts`
- [x] Create `src/managers/app/app-registry.types.ts`

**Completion**: Done

#### 1.2 Install Dependencies
- [x] `npm install pg`
- [x] `npm install -D @types/pg`

**Completion**: Done - pg ^8.13.0 in package.json

#### 1.3 Create Type Definitions
- [x] Define `AppRecord` interface
- [x] Define `AppStatus` type
- [x] Define `CreateAppInput` interface
- [x] Define `UpdateAppInput` interface
- [x] Define `AppFilter` interface
- [x] Define `DatabaseConfig` interface

**Completion**: Done - `app-registry.types.ts`

#### 1.4 Create Database Configuration
- [x] Create `database.ts` with connection pool
- [x] Support environment variable configuration
- [x] Handle connection errors gracefully

**Completion**: Done - `database.ts` exists

---

### 2. Implementation Tasks

#### 2.1 Implement PostgreSQL Connection Pool
- [x] Create pool with pg.Pool
- [x] Configure connection limits
- [x] Handle idle timeout
- [x] Implement graceful shutdown

**Completion**: Done - `database.ts` and `postgres-server.ts`

#### 2.2 Implement Migration System
- [x] Create migration runner
- [ ] Create 001_initial.sql with schema
- [x] Track applied migrations
- [ ] Support rollback

**Completion**: Partial - runner exists at `migrations/runner.ts`

#### 2.3 Implement create() Method
- [x] Generate UUID for new apps
- [x] Validate required fields
- [x] Insert into database
- [x] Return created record

**Completion**: Done - basic implementation in `app-registry.ts`

#### 2.4 Implement get()/getByName() Methods
- [x] Query by ID (UUID)
- [x] Query by name
- [x] Return null if not found
- [x] Map database row to AppRecord

**Completion**: Done

#### 2.5 Implement list() Method
- [x] Support filtering by status
- [x] Support filtering by type
- [ ] Support search (ILIKE)
- [ ] Support pagination
- [ ] Support sorting

**Completion**: Partial

#### 2.6 Implement update() Method
- [x] Validate updates
- [x] Use RETURNING clause
- [x] Handle not found
- [x] Return updated record

**Completion**: Done

#### 2.7 Implement delete() Method
- [x] Delete by ID
- [ ] Cascade to related tables (ON DELETE CASCADE)
- [x] Return void

**Completion**: Partial

#### 2.8 Implement Deployment Tracking
- [ ] Implement recordDeploymentStart()
- [ ] Implement recordDeploymentComplete()
- [ ] Implement getDeploymentHistory()
- [ ] Calculate duration

**Completion**: Not implemented

#### 2.9 Implement Environment Variables
- [ ] Implement setEnvVar()
- [ ] Implement getEnvVars()
- [ ] Implement deleteEnvVar()
- [ ] Encrypt values before storing

**Completion**: Not implemented

#### 2.10 Implement Transaction Support
- [ ] Wrap multi-operation methods in transactions
- [ ] Handle rollback on error
- [ ] Use client.query within transactions

**Completion**: Not implemented

---

### 3. Integration Tasks

#### 3.1 Wire Up to Core Engine
- [x] Export AppRegistry from index.ts
- [x] Create factory function
- [x] Handle initialization on startup

**Completion**: Done - integrated via AppStateManager

---

### 4. Testing Tasks

#### 4.1 Unit Tests - Database Layer
- [x] Test connection pool creation
- [x] Test migration runner
- [ ] Mock pg.Pool for unit tests

**Completion**: Partial - `app-registry.test.ts`

#### 4.2 Unit Tests - CRUD Operations
- [x] Test create()
- [x] Test get() and getByName()
- [ ] Test list() with filters
- [x] Test update()
- [x] Test delete()

**Completion**: Partial

#### 4.3 Unit Tests - Deployment Tracking
- [ ] Test deployment start/complete
- [ ] Test history retrieval

**Completion**: Not done

#### 4.4 Integration Tests
- [ ] Test with real PostgreSQL
- [ ] Test concurrent operations
- [ ] Test transaction rollback

**Completion**: Not done

#### 4.5 Coverage Verification
- [ ] Run coverage report
- [ ] Ensure 80%+ coverage
- [ ] Add tests for uncovered paths

**Completion**: Pending

---

### 5. Documentation Tasks

#### 5.1 Code Documentation
- [ ] Add JSDoc to AppRegistry class
- [ ] Add JSDoc to all public methods
- [ ] Document database schema

**Completion**: Not done

#### 5.2 Create README
- [ ] Create `src/managers/app/README.md`
- [ ] Document PostgreSQL setup
- [ ] Document environment variables

**Completion**: Not done

#### 5.3 Update Project Docs
- [ ] Update PRD-005 status to "Completed"
- [ ] Update FEATURE-INDEX.md
- [ ] Add to CHANGELOG.md

**Completion**: Pending

---

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| DROP_DB_HOST | PostgreSQL host | localhost |
| DROP_DB_PORT | PostgreSQL port | 5432 |
| DROP_DB_NAME | Database name | drop_internal |
| DROP_DB_USER | Database user | drop |
| DROP_DB_PASSWORD | Database password | (required) |

---

## Blockers & Dependencies

| Blocker | Status | Resolution |
|---------|--------|------------|
| PostgreSQL installation | Resolved | Bundled PostgreSQL implemented |
| Event Bus (PRD-006) | Resolved | Event Bus implemented |

---

## Code Review Checklist

Before marking as complete:
- [x] Core tasks checked off
- [x] Tests passing (`npm run test`)
- [x] Linting passing (`npm run lint`)
- [x] Build successful (`npm run build`)
- [x] Parameterized queries (no SQL injection)
- [x] Connection pool properly configured
- [x] Error handling complete
- [ ] Code reviewed by peer
- [ ] PR merged to release/v0.1.0

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2024-12-30 | Claude | Initial task breakdown |
| 2024-12-30 | Claude | Updated for PostgreSQL |
| 2025-01-17 | Claude | Updated to reflect actual implementation status |
