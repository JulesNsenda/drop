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

    // Check if already provisioned for THIS app.
    const existing = this.provisionedDatabases.get(appName);
    const dbAlreadyExists = await this.server.databaseExists(dbName);

    if (existing && dbAlreadyExists) {
      return existing.credentials;
    }

    // The database exists but this app has no registry entry for it. sanitizeName()
    // is lossy — 'my-app' and 'my_app' both map to the same dbName, and names are
    // truncated to 32 chars — so a *different* app's name can collide onto this
    // dbName. Falling through would hit the "user already exists" branch below and
    // ALTER that tenant's password, handing this app their live database
    // (cross-tenant takeover + DoS). Refuse loudly. NOTE: this also fails a
    // legitimate re-provision whose registry entry was lost (corrupt/cleared
    // db-credentials.json, or a crash before saveCredentials); that used to
    // self-heal by re-adopting its own DB, but that path is indistinguishable
    // from the attack, so failing closed is the correct security call — the error
    // tells the operator how to recover.
    if (dbAlreadyExists) {
      throw new Error(
        `Database "${dbName}" already exists but is not registered to app "${appName}". ` +
          `This is usually a name collision after sanitization (e.g. "a-b" and "a_b" both ` +
          `map to "${dbName}", or two names sharing the first 32 characters). Refusing to ` +
          `reuse it to avoid taking over another app's database. If no other app owns this ` +
          `database, drop the orphan DB (or restore its db-credentials.json entry) and ` +
          `redeploy; otherwise rename this app to a distinct name.`
      );
    }

    // Fresh provision — the database does not exist yet.
    const password = this.generatePassword();
    await this.server.createDatabase(dbName);

    // Create user and grant privileges
    try {
      await this.server.createUser(userName, password);
    } catch (error) {
      // User might already exist - update password. (Residual: if a DB was
      // dropped but its role lingered, a colliding name could reach here and
      // rotate that orphan role's password. Low-risk — the collision guard above
      // already rejects any *existing* database, so there is no live DB to adopt.)
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
      // Revoke default PUBLIC privileges so only the provisioned app user can
      // connect or act on the schema — prevents cross-tenant data access if a
      // second DB user were somehow created.
      await appPool.query(`REVOKE CONNECT ON DATABASE "${dbName}" FROM PUBLIC`);
      await appPool.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
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
   * Get environment variables for an app's database connection.
   *
   * - Default (no opts): loopback TCP connection — for PM2 mode.
   * - `pgSocketDir`: unix-socket connection via a bind-mounted socket directory
   *   — for Docker isolation mode.  libpq treats a PGHOST value containing '/'
   *   as a socket directory rather than a hostname.
   * - `pgHost` (legacy): substitute a different hostname in the TCP URL.
   */
  getEnvVars(
    appName: string,
    opts?: { pgHost?: string; pgSocketDir?: string }
  ): Record<string, string> | null {
    const creds = this.getAppCredentials(appName);
    if (!creds) {
      return null;
    }

    if (opts?.pgSocketDir) {
      const socketDir = opts.pgSocketDir;
      // libpq socket URL: postgresql://user:pw/dbname?host=<socketDir>&port=<port>
      const pw = encodeURIComponent(creds.password);
      const connectionString =
        `postgresql://${creds.user}:${pw}/${creds.database}` +
        `?host=${encodeURIComponent(socketDir)}&port=${creds.port}`;
      return {
        DATABASE_URL: connectionString,
        PGHOST: socketDir,
        PGPORT: creds.port.toString(),
        PGDATABASE: creds.database,
        PGUSER: creds.user,
        PGPASSWORD: creds.password,
        DB_HOST: socketDir,
        DB_PORT: creds.port.toString(),
        DB_NAME: creds.database,
        DB_USER: creds.user,
        DB_PASSWORD: creds.password,
      };
    }

    const host = opts?.pgHost ?? creds.host;
    const connectionString = opts?.pgHost
      ? `postgresql://${creds.user}:${creds.password}@${opts.pgHost}:${creds.port}/${creds.database}`
      : creds.connectionString;

    return {
      DATABASE_URL: connectionString,
      PGHOST: host,
      PGPORT: creds.port.toString(),
      PGDATABASE: creds.database,
      PGUSER: creds.user,
      PGPASSWORD: creds.password,
      DB_HOST: host,
      DB_PORT: creds.port.toString(),
      DB_NAME: creds.database,
      DB_USER: creds.user,
      DB_PASSWORD: creds.password,
    };
  }

  /** True if a database has already been provisioned for this app name. */
  isProvisioned(appName: string): boolean {
    return this.provisionedDatabases.has(appName);
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
