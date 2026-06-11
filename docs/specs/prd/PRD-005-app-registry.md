# PRD-005: App Registry

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-005 |
| Feature | App Registry |
| Status | Not Started |
| Phase | 1 - Core Foundation |
| Priority | P0 |
| Version | v0.1.0 (MVP) |
| Owner | TBD |
| Created | 2024-12-30 |
| Updated | 2024-12-30 |

---

## 1. Overview

### 1.1 Summary
The App Registry maintains the central database of all deployed applications, their configurations, status, and metadata. It uses **PostgreSQL** for persistent storage and provides the single source of truth for application state across the platform.

> **Note**: DROP's internal database is PostgreSQL. Applications deployed on DROP can choose their own database (PostgreSQL, SQLite, MySQL via plugins).

### 1.2 Goals
- [ ] Store and retrieve application configurations
- [ ] Track application status and history
- [ ] Support atomic transactions for state changes
- [ ] Provide efficient queries for dashboard/API
- [ ] Handle connection pooling for performance

### 1.3 Non-Goals
- Not managing application databases (Database Manager responsibility)
- Not managing secrets (Secret Manager responsibility)

---

## 2. Background

### 2.1 Why PostgreSQL (not SQLite)?
1. **Concurrent Access**: Multiple DROP processes can access safely
2. **Replication Ready**: Supports streaming replication for HA (v0.5.0)
3. **JSON Support**: Native JSONB for flexible configuration storage
4. **Full-Text Search**: Better log and config searching
5. **Scalability**: Handles larger deployments better

### 2.2 User Stories
```
As a developer
I want my app configurations persisted reliably
So that my apps survive platform restarts

As a platform operator
I want to query application state efficiently
So that the dashboard responds quickly

As a developer
I want atomic state updates
So that partial failures don't corrupt state
```

### 2.3 Reference
- Specification: `docs/specs/DROP-PAAS-SPECIFICATION.md` Section 2
- Related PRDs: PRD-007 (Database Manager for app databases)

---

## 3. Technical Design

### 3.1 Database Schema

```sql
-- DROP internal database: drop_internal

-- Applications table
CREATE TABLE apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL UNIQUE,
  type VARCHAR(50) NOT NULL,
  framework VARCHAR(100),
  status VARCHAR(50) DEFAULT 'stopped',
  port INTEGER,
  hostname VARCHAR(255),
  path TEXT NOT NULL,
  config JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_apps_name ON apps(name);
CREATE INDEX idx_apps_status ON apps(status);
CREATE INDEX idx_apps_hostname ON apps(hostname);

-- Domains table
CREATE TABLE domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hostname VARCHAR(255) NOT NULL UNIQUE,
  app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
  ssl_enabled BOOLEAN DEFAULT true,
  ssl_certificate TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_domains_app_id ON domains(app_id);

-- Environment variables (encrypted values)
CREATE TABLE env_vars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
  key VARCHAR(255) NOT NULL,
  value TEXT NOT NULL,  -- Encrypted
  encrypted BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(app_id, key)
);

CREATE INDEX idx_env_vars_app_id ON env_vars(app_id);

-- Deployments history
CREATE TABLE deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id UUID REFERENCES apps(id) ON DELETE CASCADE,
  version VARCHAR(100),
  status VARCHAR(50) DEFAULT 'pending',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  build_logs TEXT,
  error TEXT
);

CREATE INDEX idx_deployments_app_id ON deployments(app_id);
CREATE INDEX idx_deployments_status ON deployments(status);

-- Platform configuration
CREATE TABLE platform_config (
  key VARCHAR(255) PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER apps_updated_at
  BEFORE UPDATE ON apps
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

### 3.2 Interfaces

```typescript
interface AppRecord {
  id: string;
  name: string;
  type: AppType;
  framework: string | null;
  status: AppStatus;
  port: number | null;
  hostname: string | null;
  path: string;
  config: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

type AppStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'errored' | 'building';

interface CreateAppInput {
  name: string;
  type: AppType;
  framework?: string;
  path: string;
  hostname?: string;
  config?: Record<string, unknown>;
}

interface UpdateAppInput {
  status?: AppStatus;
  port?: number;
  hostname?: string;
  config?: Record<string, unknown>;
}

interface AppFilter {
  status?: AppStatus;
  type?: AppType;
  hostname?: string;
  search?: string;  // Full-text search
}

interface AppRegistry {
  // CRUD operations
  create(app: CreateAppInput): Promise<AppRecord>;
  get(appId: string): Promise<AppRecord | null>;
  getByName(name: string): Promise<AppRecord | null>;
  list(filter?: AppFilter, pagination?: Pagination): Promise<PaginatedResult<AppRecord>>;
  update(appId: string, updates: UpdateAppInput): Promise<AppRecord>;
  delete(appId: string): Promise<void>;

  // Deployment tracking
  recordDeploymentStart(appId: string): Promise<string>;  // Returns deployment ID
  recordDeploymentComplete(deploymentId: string, success: boolean, error?: string): Promise<void>;
  getDeploymentHistory(appId: string, limit?: number): Promise<DeploymentRecord[]>;

  // Environment variables
  setEnvVar(appId: string, key: string, value: string): Promise<void>;
  getEnvVars(appId: string): Promise<Record<string, string>>;
  deleteEnvVar(appId: string, key: string): Promise<void>;
}
```

### 3.3 Connection Management

```typescript
interface DatabaseConfig {
  host: string;           // Default: localhost
  port: number;           // Default: 5432
  database: string;       // Default: drop_internal
  user: string;           // Default: drop
  password: string;       // From environment
  maxConnections: number; // Default: 20
  idleTimeout: number;    // Default: 30000ms
  ssl: boolean;           // Default: false for local
}
```

### 3.4 Dependencies
- Internal: Event Bus, Logger
- External: `pg` (node-postgres), `@types/pg`

---

## 4. Implementation Plan

### 4.1 File Structure
```
src/
├── managers/app/
│   ├── index.ts              # Public exports
│   ├── app-registry.ts       # Main AppRegistry class
│   ├── app-registry.types.ts # Type definitions
│   ├── database.ts           # PostgreSQL connection pool
│   ├── migrations/
│   │   ├── index.ts          # Migration runner
│   │   ├── 001_initial.sql   # Initial schema
│   │   └── 002_indexes.sql   # Additional indexes
│   └── app-registry.test.ts  # Unit tests
```

### 4.2 PostgreSQL Setup for DROP

DROP requires a PostgreSQL instance for its internal database:

```bash
# Option 1: Use existing PostgreSQL
export DROP_DB_HOST=localhost
export DROP_DB_PORT=5432
export DROP_DB_NAME=drop_internal
export DROP_DB_USER=drop
export DROP_DB_PASSWORD=secure_password

# Option 2: DROP provisions its own (recommended)
# DROP will initialize PostgreSQL in /var/drop/data/drop-svc/postgresql/
```

---

## 5. Testing Strategy

### 5.1 Unit Tests
- [ ] CRUD operations
- [ ] Filtering and pagination
- [ ] Environment variable encryption
- [ ] Deployment tracking
- [ ] Error handling

### 5.2 Integration Tests
- [ ] Full PostgreSQL integration
- [ ] Concurrent access
- [ ] Transaction rollback
- [ ] Migration execution

### 5.3 Performance Tests
- [ ] Query performance with 1000+ apps
- [ ] Connection pool behavior
- [ ] Index effectiveness

---

## 6. Security Considerations

- [ ] Parameterized queries (SQL injection prevention)
- [ ] Connection string not logged
- [ ] Environment variables encrypted at rest
- [ ] Database user has minimal required permissions
- [ ] SSL for non-local connections

---

## 7. Migration from SQLite (if applicable)

For users upgrading from a hypothetical SQLite version:
```typescript
interface MigrationService {
  exportFromSqlite(sqlitePath: string): Promise<ExportData>;
  importToPostgres(data: ExportData): Promise<void>;
}
```

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2024-12-30 | Claude | Initial draft |
| 2024-12-30 | Claude | Changed from SQLite to PostgreSQL |
