/**
 * Database Provisioner
 *
 * Handles creating and managing databases for DROP and deployed apps.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Pool } from 'pg';
import { writeJsonAtomic } from '../../utils/atomic-write';
import { PostgresServer } from './postgres-server';

export interface DatabaseCredentials {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionString: string;
}

export interface ProvisionedDatabase {
  appName: string;
  credentials: DatabaseCredentials;
  createdAt: Date;
}

const DROP_INTERNAL_DB = 'drop_internal';
const DROP_INTERNAL_USER = 'drop_admin';
const APP_DB_PREFIX = 'drop_';
const APP_USER_PREFIX = 'drop_';

export class DatabaseProvisioner {
  private readonly server: PostgresServer;
  private readonly credentialsPath: string;
  private provisionedDatabases: Map<string, ProvisionedDatabase> = new Map();

  constructor(server: PostgresServer, dropRoot: string) {
    this.server = server;
    this.credentialsPath = path.join(dropRoot, 'data', 'drop-svc', 'db-credentials.json');
  }

  /**
   * Initialize the provisioner - load existing credentials
   */
  async initialize(): Promise<void> {
    await this.loadCredentials();
  }

  /**
   * Ensure DROP's internal database exists
   */
  async ensureInternalDatabase(): Promise<DatabaseCredentials> {
    const dbName = DROP_INTERNAL_DB;
    const userName = DROP_INTERNAL_USER;

    // Check if database exists
    if (!(await this.server.databaseExists(dbName))) {
      // Generate password for internal user
      const password = this.generatePassword();

      // Create database and user
      await this.server.createDatabase(dbName);

      try {
        await this.server.createUser(userName, password);
      } catch (error) {
        // User might already exist
        if (!String(error).includes('already exists')) {
          throw error;
        }
      }

      await this.server.grantPrivileges(dbName, userName);

      // Store credentials
      const credentials: DatabaseCredentials = {
        host: 'localhost',
        port: this.server.getPort(),
        database: dbName,
        user: userName,
        password,
        connectionString: `postgresql://${userName}:${password}@localhost:${this.server.getPort()}/${dbName}`,
      };

      this.provisionedDatabases.set('_internal', {
        appName: '_internal',
        credentials,
        createdAt: new Date(),
      });

      await this.saveCredentials();

      return credentials;
    }

    // Database exists, return stored or default credentials
    const existing = this.provisionedDatabases.get('_internal');
    if (existing) {
      return existing.credentials;
    }

    // Fallback - use the (secured) postgres superuser.
    const superuserPassword = this.server.getSuperuserPassword();
    const auth = `postgres:${encodeURIComponent(superuserPassword)}`;
    return {
      host: 'localhost',
      port: this.server.getPort(),
      database: dbName,
      user: 'postgres',
      password: superuserPassword,
      connectionString: `postgresql://${auth}@localhost:${this.server.getPort()}/${dbName}`,
    };
  }

  /**
   * Provision a database for an app
   */
  async provisionAppDatabase(appName: string): Promise<DatabaseCredentials> {
    const safeName = this.sanitizeName(appName);
    const dbName = `${APP_DB_PREFIX}${safeName}`;
    const userName = `${APP_USER_PREFIX}${safeName}_user`;

    // Check if already provisioned
    const existing = this.provisionedDatabases.get(appName);
    if (existing && (await this.server.databaseExists(dbName))) {
      return existing.credentials;
    }

    // Generate password
    const password = this.generatePassword();

    // Create database if it doesn't exist
    if (!(await this.server.databaseExists(dbName))) {
      await this.server.createDatabase(dbName);
    }

    // Create user and grant privileges
    try {
      await this.server.createUser(userName, password);
    } catch (error) {
      // User might already exist - update password
      if (String(error).includes('already exists')) {
        const pool = await this.server.getPool();
        await pool.query(`ALTER USER "${userName}" WITH PASSWORD '${password}'`);
      } else {
        throw error;
      }
    }

    await this.server.grantPrivileges(dbName, userName);

    // Also grant on public schema for new databases
    const appPool = new Pool(this.server.getSuperuserPoolConfig(dbName));

    try {
      await appPool.query(`GRANT ALL ON SCHEMA public TO "${userName}"`);
      await appPool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${userName}"`);
      await appPool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${userName}"`);
    } finally {
      await appPool.end();
    }

    // Store credentials
    const credentials: DatabaseCredentials = {
      host: 'localhost',
      port: this.server.getPort(),
      database: dbName,
      user: userName,
      password,
      connectionString: `postgresql://${userName}:${password}@localhost:${this.server.getPort()}/${dbName}`,
    };

    this.provisionedDatabases.set(appName, {
      appName,
      credentials,
      createdAt: new Date(),
    });

    await this.saveCredentials();

    return credentials;
  }

  /**
   * Get credentials for an app's database
   */
  getAppCredentials(appName: string): DatabaseCredentials | null {
    const provisioned = this.provisionedDatabases.get(appName);
    return provisioned?.credentials || null;
  }

  /**
   * Check if an app has a provisioned database
   */
  hasAppDatabase(appName: string): boolean {
    return this.provisionedDatabases.has(appName);
  }

  /**
   * List all provisioned databases
   */
  listDatabases(): ProvisionedDatabase[] {
    return Array.from(this.provisionedDatabases.values());
  }

  /**
   * Delete an app's database
   */
  async deleteAppDatabase(appName: string): Promise<void> {
    const provisioned = this.provisionedDatabases.get(appName);
    if (!provisioned) {
      return;
    }

    const { database, user } = provisioned.credentials;

    // Terminate connections and drop database
    const pool = await this.server.getPool();

    try {
      // Terminate active connections
      await pool.query(`
        SELECT pg_terminate_backend(pg_stat_activity.pid)
        FROM pg_stat_activity
        WHERE pg_stat_activity.datname = $1
        AND pid <> pg_backend_pid()
      `, [database]);

      // Drop database
      await pool.query(`DROP DATABASE IF EXISTS "${database}"`);

      // Drop user
      await pool.query(`DROP USER IF EXISTS "${user}"`);
    } catch (error) {
      // Log but don't fail
      console.warn(`Failed to fully clean up database for ${appName}:`, error);
    }

    this.provisionedDatabases.delete(appName);
    await this.saveCredentials();
  }

  /**
   * Get environment variables for an app's database connection
   */
  getEnvVars(appName: string): Record<string, string> | null {
    const creds = this.getAppCredentials(appName);
    if (!creds) {
      return null;
    }

    return {
      DATABASE_URL: creds.connectionString,
      PGHOST: creds.host,
      PGPORT: creds.port.toString(),
      PGDATABASE: creds.database,
      PGUSER: creds.user,
      PGPASSWORD: creds.password,
      DB_HOST: creds.host,
      DB_PORT: creds.port.toString(),
      DB_NAME: creds.database,
      DB_USER: creds.user,
      DB_PASSWORD: creds.password,
    };
  }

  // ============ Private Methods ============

  private sanitizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .substring(0, 32);
  }

  private generatePassword(): string {
    return crypto.randomBytes(24).toString('base64').replace(/[/+=]/g, 'x');
  }

  private async loadCredentials(): Promise<void> {
    try {
      const data = await fs.readFile(this.credentialsPath, 'utf-8');
      const parsed = JSON.parse(data);

      if (parsed.databases && Array.isArray(parsed.databases)) {
        for (const db of parsed.databases) {
          this.provisionedDatabases.set(db.appName, {
            appName: db.appName,
            credentials: db.credentials,
            createdAt: new Date(db.createdAt),
          });
        }
      }
    } catch {
      // File doesn't exist or is corrupted - start fresh
      this.provisionedDatabases.clear();
    }
  }

  private async saveCredentials(): Promise<void> {
    const data = {
      version: 1,
      updatedAt: new Date().toISOString(),
      databases: Array.from(this.provisionedDatabases.values()).map((db) => ({
        appName: db.appName,
        credentials: db.credentials,
        createdAt: db.createdAt.toISOString(),
      })),
    };

    await fs.mkdir(path.dirname(this.credentialsPath), { recursive: true });
    await writeJsonAtomic(this.credentialsPath, data, { mode: 0o600 });
  }
}
