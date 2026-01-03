/**
 * Migration Runner
 *
 * Handles database migrations for DROP's internal PostgreSQL database.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Database } from '../database';

interface Migration {
  id: number;
  name: string;
  sql: string;
}

export class MigrationRunner {
  private readonly db: Database;
  private readonly migrationsDir: string;

  constructor(db: Database, migrationsDir?: string) {
    this.db = db;
    this.migrationsDir = migrationsDir || path.join(__dirname);
  }

  /**
   * Run all pending migrations
   */
  async migrate(): Promise<string[]> {
    await this.ensureMigrationsTable();

    const applied = await this.getAppliedMigrations();
    const pending = await this.getPendingMigrations(applied);

    const results: string[] = [];

    for (const migration of pending) {
      console.log(`Running migration: ${migration.name}`);
      await this.runMigration(migration);
      results.push(migration.name);
      console.log(`Migration ${migration.name} completed`);
    }

    if (results.length === 0) {
      console.log('No pending migrations');
    }

    return results;
  }

  /**
   * Get list of applied migrations
   */
  async getAppliedMigrations(): Promise<string[]> {
    const result = await this.db.query<{ name: string }>(
      'SELECT name FROM migrations ORDER BY id'
    );
    return result.rows.map(row => row.name);
  }

  /**
   * Get pending migrations
   */
  private async getPendingMigrations(applied: string[]): Promise<Migration[]> {
    const files = fs.readdirSync(this.migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    const migrations: Migration[] = [];

    for (const file of files) {
      const name = path.basename(file, '.sql');
      if (!applied.includes(name)) {
        const sql = fs.readFileSync(path.join(this.migrationsDir, file), 'utf-8');
        const idMatch = name.match(/^(\d+)/);
        const id = idMatch ? parseInt(idMatch[1], 10) : 0;
        migrations.push({ id, name, sql });
      }
    }

    return migrations.sort((a, b) => a.id - b.id);
  }

  /**
   * Run a single migration within a transaction
   */
  private async runMigration(migration: Migration): Promise<void> {
    await this.db.transaction(async client => {
      // Run the migration SQL
      await client.query(migration.sql);

      // Record the migration
      await client.query(
        'INSERT INTO migrations (name) VALUES ($1)',
        [migration.name]
      );
    });
  }

  /**
   * Ensure migrations table exists
   */
  private async ensureMigrationsTable(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
  }

  /**
   * Get migration status
   */
  async status(): Promise<{ applied: string[]; pending: string[] }> {
    await this.ensureMigrationsTable();
    const applied = await this.getAppliedMigrations();
    const pending = await this.getPendingMigrations(applied);

    return {
      applied,
      pending: pending.map(m => m.name),
    };
  }
}

// CLI runner
async function main(): Promise<void> {
  const { Database } = await import('../database');
  const db = new Database();

  try {
    await db.connect();
    console.log('Connected to database');

    const runner = new MigrationRunner(db);

    const command = process.argv[2] || 'migrate';

    switch (command) {
      case 'migrate':
        await runner.migrate();
        break;
      case 'status': {
        const status = await runner.status();
        console.log('Applied migrations:', status.applied);
        console.log('Pending migrations:', status.pending);
        break;
      }
      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  } finally {
    await db.close();
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}
