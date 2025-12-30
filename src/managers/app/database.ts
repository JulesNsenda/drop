/**
 * PostgreSQL Database Connection Pool
 *
 * Manages the connection pool for DROP's internal database.
 */

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { DatabaseConfig } from './app-registry.types';

const DEFAULT_CONFIG: DatabaseConfig = {
  host: process.env.DROP_DB_HOST || 'localhost',
  port: parseInt(process.env.DROP_DB_PORT || '5432', 10),
  database: process.env.DROP_DB_NAME || 'drop_internal',
  user: process.env.DROP_DB_USER || 'drop',
  password: process.env.DROP_DB_PASSWORD || '',
  maxConnections: parseInt(process.env.DROP_DB_MAX_CONNECTIONS || '20', 10),
  idleTimeoutMs: parseInt(process.env.DROP_DB_IDLE_TIMEOUT || '30000', 10),
  ssl: process.env.DROP_DB_SSL === 'true',
};

export class Database {
  private pool: Pool | null = null;
  private readonly config: DatabaseConfig;

  constructor(config?: Partial<DatabaseConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async connect(): Promise<void> {
    if (this.pool) {
      return;
    }

    this.pool = new Pool({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      max: this.config.maxConnections,
      idleTimeoutMillis: this.config.idleTimeoutMs,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
    });

    // Test connection
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    if (!this.pool) {
      throw new Error('Database not connected. Call connect() first.');
    }
    return this.pool.query<T>(text, params);
  }

  async getClient(): Promise<PoolClient> {
    if (!this.pool) {
      throw new Error('Database not connected. Call connect() first.');
    }
    return this.pool.connect();
  }

  /**
   * Execute multiple queries within a transaction
   */
  async transaction<T>(
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.getClient();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  getConfig(): DatabaseConfig {
    return { ...this.config };
  }

  isConnected(): boolean {
    return this.pool !== null;
  }
}

// Singleton instance for the application
let databaseInstance: Database | null = null;

export function getDatabase(config?: Partial<DatabaseConfig>): Database {
  if (!databaseInstance) {
    databaseInstance = new Database(config);
  }
  return databaseInstance;
}

export function resetDatabase(): void {
  if (databaseInstance) {
    databaseInstance.close();
    databaseInstance = null;
  }
}
