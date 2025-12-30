---
name: db-migrate
description: Database migration management. Use for creating, running, or rolling back database migrations.
allowed-tools: Bash, Read, Edit, Glob
---

# Database Migration Skill

Manage DROP database migrations.

## Commands

```bash
# Run pending migrations
npm run db:migrate

# Rollback last migration
npm run db:rollback

# Rollback all migrations
npm run db:rollback:all

# Create new migration
npm run db:migrate:create <name>

# Show migration status
npm run db:migrate:status

# Seed database
npm run db:seed
```

## Migration File Structure

```
src/database/migrations/
├── 001_create_apps.ts
├── 002_create_domains.ts
├── 003_add_env_vars.ts
└── index.ts
```

## Migration Template

```typescript
// src/database/migrations/XXX_description.ts
import { Database } from 'better-sqlite3';

export const migration = {
  version: 1,
  name: 'description',

  up(db: Database): void {
    db.exec(`
      CREATE TABLE table_name (
        id TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
  },

  down(db: Database): void {
    db.exec('DROP TABLE IF EXISTS table_name');
  }
};
```

## Best Practices

1. **Atomic Changes** - One logical change per migration
2. **Reversible** - Always implement `down()` method
3. **No Data Loss** - Be careful with `DROP` statements
4. **Test First** - Test migrations on development database
5. **Sequential** - Never modify existing migrations

## Common Operations

### Add Column
```typescript
up(db) {
  db.exec('ALTER TABLE apps ADD COLUMN description TEXT');
}
down(db) {
  // SQLite doesn't support DROP COLUMN easily
  // May need to recreate table
}
```

### Add Index
```typescript
up(db) {
  db.exec('CREATE INDEX idx_apps_status ON apps(status)');
}
down(db) {
  db.exec('DROP INDEX idx_apps_status');
}
```

### Add Foreign Key
```typescript
up(db) {
  db.exec(`
    CREATE TABLE domains (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      FOREIGN KEY (app_id) REFERENCES apps(id)
    )
  `);
}
```
