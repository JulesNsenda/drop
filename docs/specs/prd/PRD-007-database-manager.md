# PRD-007: Database Manager

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-007 |
| Feature | Database Manager |
| Status | Not Started |
| Phase | 2 - Essential Features |
| Priority | P1 |
| Owner | TBD |
| Created | 2024-12-30 |
| Updated | 2024-12-30 |

---

## 1. Overview

### 1.1 Summary
The Database Manager handles provisioning, lifecycle management, and operations for per-application databases. It supports SQLite for simple apps and PostgreSQL for production workloads, with automatic provisioning based on application requirements.

### 1.2 Goals
- [ ] Auto-provision PostgreSQL databases on demand
- [ ] Manage database lifecycle (create, backup, restore, delete)
- [ ] Provide connection strings to applications
- [ ] Support automated backups with configurable retention

---

## 2. Technical Design

### 2.1 Interfaces

```typescript
interface DatabaseConfig {
  type: 'sqlite' | 'postgresql';
  version?: string;  // PostgreSQL version
  extensions?: string[];
  maxConnections?: number;
}

interface DatabaseManager {
  provision(appName: string, config: DatabaseConfig): Promise<DatabaseInfo>;
  getConnectionString(appName: string): Promise<string>;
  backup(appName: string): Promise<BackupResult>;
  restore(appName: string, backupId: string): Promise<void>;
  delete(appName: string): Promise<void>;
}
```

### 2.2 PostgreSQL Provisioning
```
1. Create data directory: /var/drop/data/db/{app-name}/
2. Initialize cluster: initdb
3. Configure pg_hba.conf and postgresql.conf
4. Start PostgreSQL process
5. Create database and user
6. Return connection string
```

---

## 3. Implementation Plan

### 3.1 File Structure
```
src/
├── managers/database/
│   ├── index.ts
│   ├── database-manager.ts
│   ├── database-manager.types.ts
│   ├── postgresql/
│   │   ├── provisioner.ts
│   │   └── backup.ts
│   ├── sqlite/
│   │   └── provisioner.ts
│   └── database-manager.test.ts
```

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2024-12-30 | Claude | Initial draft |
