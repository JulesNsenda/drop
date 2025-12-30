/**
 * App Registry Implementation
 *
 * Central registry for all deployed applications on DROP.
 * Uses PostgreSQL for persistent storage.
 */

import { randomUUID } from 'crypto';
import { Database, getDatabase } from './database';
import { MigrationRunner } from './migrations/runner';
import { eventBus } from '../../core/event-bus';
import {
  AppRecord,
  AppStatus,
  AppType,
  CreateAppInput,
  UpdateAppInput,
  AppFilter,
  Pagination,
  PaginatedResult,
  DeploymentRecord,
  DomainRecord,
  IAppRegistry,
  DatabaseConfig,
} from './app-registry.types';

// Database row types
interface AppRow {
  id: string;
  name: string;
  type: string;
  framework: string | null;
  status: string;
  port: number | null;
  hostname: string | null;
  path: string;
  config: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

interface DeploymentRow {
  id: string;
  app_id: string;
  version: string | null;
  status: string;
  started_at: Date;
  completed_at: Date | null;
  duration_ms: number | null;
  build_logs: string | null;
  error: string | null;
}

interface DomainRow {
  id: string;
  hostname: string;
  app_id: string;
  ssl_enabled: boolean;
  ssl_certificate: string | null;
  created_at: Date;
}

interface EnvVarRow {
  key: string;
  value: string;
}

interface CountRow {
  count: string;
}

export class AppRegistry implements IAppRegistry {
  private readonly db: Database;
  private initialized = false;

  constructor(config?: Partial<DatabaseConfig>) {
    this.db = getDatabase(config);
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.db.connect();

    // Run migrations
    const runner = new MigrationRunner(this.db);
    await runner.migrate();

    this.initialized = true;
  }

  async close(): Promise<void> {
    await this.db.close();
    this.initialized = false;
  }

  // CRUD Operations

  async create(input: CreateAppInput): Promise<AppRecord> {
    this.ensureInitialized();

    const result = await this.db.query<AppRow>(
      `INSERT INTO apps (name, type, framework, path, hostname, config)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        input.name,
        input.type,
        input.framework || null,
        input.path,
        input.hostname || null,
        JSON.stringify(input.config || {}),
      ]
    );

    const app = this.mapRowToRecord(result.rows[0]);

    eventBus.publish('app:created', {
      appId: app.id,
      name: app.name,
      type: app.type,
    });

    return app;
  }

  async get(appId: string): Promise<AppRecord | null> {
    this.ensureInitialized();

    const result = await this.db.query<AppRow>(
      'SELECT * FROM apps WHERE id = $1',
      [appId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToRecord(result.rows[0]);
  }

  async getByName(name: string): Promise<AppRecord | null> {
    this.ensureInitialized();

    const result = await this.db.query<AppRow>(
      'SELECT * FROM apps WHERE name = $1',
      [name]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToRecord(result.rows[0]);
  }

  async getByHostname(hostname: string): Promise<AppRecord | null> {
    this.ensureInitialized();

    // Check direct hostname first
    let result = await this.db.query<AppRow>(
      'SELECT * FROM apps WHERE hostname = $1',
      [hostname]
    );

    if (result.rows.length > 0) {
      return this.mapRowToRecord(result.rows[0]);
    }

    // Check domains table
    result = await this.db.query<AppRow>(
      `SELECT a.* FROM apps a
       JOIN domains d ON d.app_id = a.id
       WHERE d.hostname = $1`,
      [hostname]
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToRecord(result.rows[0]);
  }

  async list(
    filter?: AppFilter,
    pagination?: Pagination
  ): Promise<PaginatedResult<AppRecord>> {
    this.ensureInitialized();

    const page = pagination?.page || 1;
    const limit = pagination?.limit || 20;
    const offset = (page - 1) * limit;
    const sortBy = pagination?.sortBy || 'createdAt';
    const sortOrder = pagination?.sortOrder || 'desc';

    // Map sortBy to database column
    const sortColumn = this.mapFieldToColumn(sortBy);

    // Build WHERE clause
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (filter?.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(filter.status);
    }

    if (filter?.type) {
      conditions.push(`type = $${paramIndex++}`);
      params.push(filter.type);
    }

    if (filter?.hostname) {
      conditions.push(`hostname = $${paramIndex++}`);
      params.push(filter.hostname);
    }

    if (filter?.search) {
      conditions.push(`(name ILIKE $${paramIndex} OR path ILIKE $${paramIndex})`);
      params.push(`%${filter.search}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0
      ? `WHERE ${conditions.join(' AND ')}`
      : '';

    // Get total count
    const countResult = await this.db.query<CountRow>(
      `SELECT COUNT(*) as count FROM apps ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get data
    const dataResult = await this.db.query<AppRow>(
      `SELECT * FROM apps ${whereClause}
       ORDER BY ${sortColumn} ${sortOrder.toUpperCase()}
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      [...params, limit, offset]
    );

    return {
      data: dataResult.rows.map(row => this.mapRowToRecord(row)),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async update(appId: string, updates: UpdateAppInput): Promise<AppRecord> {
    this.ensureInitialized();

    // Build SET clause dynamically
    const setClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      params.push(updates.status);
    }

    if (updates.port !== undefined) {
      setClauses.push(`port = $${paramIndex++}`);
      params.push(updates.port);
    }

    if (updates.hostname !== undefined) {
      setClauses.push(`hostname = $${paramIndex++}`);
      params.push(updates.hostname);
    }

    if (updates.config !== undefined) {
      setClauses.push(`config = $${paramIndex++}`);
      params.push(JSON.stringify(updates.config));
    }

    if (updates.framework !== undefined) {
      setClauses.push(`framework = $${paramIndex++}`);
      params.push(updates.framework);
    }

    if (updates.type !== undefined) {
      setClauses.push(`type = $${paramIndex++}`);
      params.push(updates.type);
    }

    if (setClauses.length === 0) {
      const existing = await this.get(appId);
      if (!existing) {
        throw new Error(`App not found: ${appId}`);
      }
      return existing;
    }

    params.push(appId);

    const result = await this.db.query<AppRow>(
      `UPDATE apps SET ${setClauses.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      params
    );

    if (result.rows.length === 0) {
      throw new Error(`App not found: ${appId}`);
    }

    const app = this.mapRowToRecord(result.rows[0]);

    eventBus.publish('app:updated', {
      appId: app.id,
      changes: { ...updates } as Record<string, unknown>,
    });

    return app;
  }

  async delete(appId: string): Promise<void> {
    this.ensureInitialized();

    // Get app name before deletion for event
    const app = await this.get(appId);
    if (!app) {
      return;
    }

    await this.db.query('DELETE FROM apps WHERE id = $1', [appId]);

    eventBus.publish('app:removed', {
      appId,
      name: app.name,
    });
  }

  // Deployment Tracking

  async recordDeploymentStart(appId: string, version?: string): Promise<string> {
    this.ensureInitialized();

    const deploymentId = randomUUID();

    await this.db.query(
      `INSERT INTO deployments (id, app_id, version, status)
       VALUES ($1, $2, $3, 'running')`,
      [deploymentId, appId, version || null]
    );

    eventBus.publish('deployment:started', {
      appId,
      deploymentId,
      version,
    });

    return deploymentId;
  }

  async recordDeploymentComplete(
    deploymentId: string,
    success: boolean,
    error?: string
  ): Promise<void> {
    this.ensureInitialized();

    const status = success ? 'completed' : 'failed';

    const result = await this.db.query<DeploymentRow>(
      `UPDATE deployments
       SET status = $1,
           completed_at = NOW(),
           duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000,
           error = $2
       WHERE id = $3
       RETURNING *`,
      [status, error || null, deploymentId]
    );

    if (result.rows.length > 0) {
      const deployment = result.rows[0];

      if (success) {
        eventBus.publish('deployment:completed', {
          appId: deployment.app_id,
          deploymentId,
          durationMs: deployment.duration_ms || 0,
        });
      } else {
        eventBus.publish('deployment:failed', {
          appId: deployment.app_id,
          deploymentId,
          error: new Error(error || 'Unknown error'),
        });
      }
    }
  }

  async getDeploymentHistory(appId: string, limit = 10): Promise<DeploymentRecord[]> {
    this.ensureInitialized();

    const result = await this.db.query<DeploymentRow>(
      `SELECT * FROM deployments
       WHERE app_id = $1
       ORDER BY started_at DESC
       LIMIT $2`,
      [appId, limit]
    );

    return result.rows.map(row => this.mapDeploymentRowToRecord(row));
  }

  // Environment Variables

  async setEnvVar(appId: string, key: string, value: string): Promise<void> {
    this.ensureInitialized();

    await this.db.query(
      `INSERT INTO env_vars (app_id, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (app_id, key)
       DO UPDATE SET value = $3`,
      [appId, key, value]
    );
  }

  async getEnvVars(appId: string): Promise<Record<string, string>> {
    this.ensureInitialized();

    const result = await this.db.query<EnvVarRow>(
      'SELECT key, value FROM env_vars WHERE app_id = $1',
      [appId]
    );

    const envVars: Record<string, string> = {};
    for (const row of result.rows) {
      envVars[row.key] = row.value;
    }
    return envVars;
  }

  async deleteEnvVar(appId: string, key: string): Promise<void> {
    this.ensureInitialized();

    await this.db.query(
      'DELETE FROM env_vars WHERE app_id = $1 AND key = $2',
      [appId, key]
    );
  }

  // Domains

  async addDomain(appId: string, hostname: string): Promise<DomainRecord> {
    this.ensureInitialized();

    const result = await this.db.query<DomainRow>(
      `INSERT INTO domains (app_id, hostname)
       VALUES ($1, $2)
       RETURNING *`,
      [appId, hostname]
    );

    return this.mapDomainRowToRecord(result.rows[0]);
  }

  async getDomains(appId: string): Promise<DomainRecord[]> {
    this.ensureInitialized();

    const result = await this.db.query<DomainRow>(
      'SELECT * FROM domains WHERE app_id = $1 ORDER BY created_at',
      [appId]
    );

    return result.rows.map(row => this.mapDomainRowToRecord(row));
  }

  async removeDomain(domainId: string): Promise<void> {
    this.ensureInitialized();

    await this.db.query('DELETE FROM domains WHERE id = $1', [domainId]);
  }

  // Helper methods

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('AppRegistry not initialized. Call initialize() first.');
    }
  }

  private mapRowToRecord(row: AppRow): AppRecord {
    return {
      id: row.id,
      name: row.name,
      type: row.type as AppType,
      framework: row.framework,
      status: row.status as AppStatus,
      port: row.port,
      hostname: row.hostname,
      path: row.path,
      config: row.config,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapDeploymentRowToRecord(row: DeploymentRow): DeploymentRecord {
    return {
      id: row.id,
      appId: row.app_id,
      version: row.version,
      status: row.status as DeploymentRecord['status'],
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      buildLogs: row.build_logs,
      error: row.error,
    };
  }

  private mapDomainRowToRecord(row: DomainRow): DomainRecord {
    return {
      id: row.id,
      hostname: row.hostname,
      appId: row.app_id,
      sslEnabled: row.ssl_enabled,
      sslCertificate: row.ssl_certificate,
      createdAt: row.created_at,
    };
  }

  private mapFieldToColumn(field: keyof AppRecord): string {
    const mapping: Record<keyof AppRecord, string> = {
      id: 'id',
      name: 'name',
      type: 'type',
      framework: 'framework',
      status: 'status',
      port: 'port',
      hostname: 'hostname',
      path: 'path',
      config: 'config',
      createdAt: 'created_at',
      updatedAt: 'updated_at',
    };
    return mapping[field] || 'created_at';
  }
}

// Factory function
export function createAppRegistry(config?: Partial<DatabaseConfig>): AppRegistry {
  return new AppRegistry(config);
}
