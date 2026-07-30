/**
 * Database Provisioner
 *
 * Handles creating and managing databases for DROP and deployed apps.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { writeJsonAtomic } from '../../utils/atomic-write';
import { PostgresServer } from './postgres-server';
import { runPgDump, createRoleSql } from './pg-dump';
import { buildConnectionString } from './connection-string';

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

/** Defense-in-depth: sanitized DB/role identifiers must match before touching a path or SQL statement. */
const DB_NAME_ALLOWLIST = /^[a-z0-9_]+$/;

export class DatabaseProvisioner {
  private readonly server: PostgresServer;
  private readonly dropRoot: string;
  private readonly credentialsPath: string;
  private provisionedDatabases: Map<string, ProvisionedDatabase> = new Map();

  constructor(server: PostgresServer, dropRoot: string) {
    this.server = server;
    this.dropRoot = dropRoot;
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
   * Dump-then-drop an app's database on a deliberate app delete.
   *
   * Fail-closed at every step: if the dump can't be produced and verified,
   * the database (and its credentials-registry entry) are KEPT — a retained,
   * undeleted database is always the safe outcome. Only once a verified dump
   * (plus a role-recreation script) is safely committed to disk do we touch
   * `DROP DATABASE`/`DROP USER`. The registry entry is removed only if BOTH
   * drops succeed, so a partial failure never produces an untracked orphan.
   *
   * See docs/plans/2026-07-07-dump-then-drop-on-delete.md.
   */
  async backupAndDeleteAppDatabase(
    appName: string,
    /**
     * Skip the pre-delete dump.
     *
     * For an EPHEMERAL app only: its data is throwaway by construction, and
     * dumping every scratch database on the way out would fill the box with
     * backups nobody will ever read. Never set for an ordinary app — the dump
     * is the only thing standing between a mistaken delete and data loss.
     */
    opts: { skipBackup?: boolean } = {}
  ): Promise<{ dropped: boolean; reason?: string; dumpPath?: string }> {
    const provisioned = this.provisionedDatabases.get(appName);
    if (!provisioned) {
      return { dropped: false, reason: 'no database provisioned' };
    }

    const { database, user, password } = provisioned.credentials;

    // Defense-in-depth: these become a filesystem path component and an
    // interpolated SQL identifier below. sanitizeName() should already
    // guarantee this shape, but never trust that transitively for a
    // destructive operation.
    if (!DB_NAME_ALLOWLIST.test(database) || !DB_NAME_ALLOWLIST.test(user)) {
      return { dropped: false, reason: 'refusing: unexpected identifier' };
    }

    // Hardened pre-delete dump directory. mode-on-mkdir only applies at
    // creation time, so an already-existing (possibly looser) directory must
    // be re-hardened unconditionally. No process.umask() here — this runs
    // inside the long-lived server process, and a global umask mutation
    // would race every other concurrent file write.
    const preDeleteDir = path.join(this.dropRoot, 'data', 'backup', 'pre-delete');
    await fs.mkdir(preDeleteDir, { recursive: true, mode: 0o700 });
    await fs.chmod(preDeleteDir, 0o700);

    const ext = process.platform === 'win32' ? '.exe' : '';
    const pgDumpPath = path.join(this.dropRoot, 'apps', 'drop-svc', 'pgsql', 'bin', `pg_dump${ext}`);
    if (!opts.skipBackup && !fssync.existsSync(pgDumpPath)) {
      return { dropped: false, reason: 'pg_dump binary not found' };
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const partial = path.join(preDeleteDir, `${database}-${stamp}.dump.partial`);
    const finalDump = partial.replace(/\.partial$/, '');

    // An ephemeral skips the dump ENTIRELY — including the verification gate
    // below, which would otherwise abort the drop when there is no dump to
    // verify and leave the scratch database behind forever.
    let finalDumpPath: string | undefined;
    if (!opts.skipBackup) {
      const result = await runPgDump(pgDumpPath, {
        port: this.server.getPort(),
        user: 'postgres',
        dbName: database,
        outFile: partial,
        password: this.server.getSuperuserPassword(),
      });

      if (!result.ok) {
        await fs.rm(partial, { force: true });
        return { dropped: false, reason: `dump failed: ${result.error}` };
      }

      // Verify before touching the database: exists, non-empty, and begins
      // with the pg_dump custom-format magic header ("PGDMP"). A corrupt or
      // truncated dump must never be trusted as the safety net for a drop.
      const verified = await this.verifyDumpFile(partial);
      if (!verified) {
        await fs.rm(partial, { force: true });
        return { dropped: false, reason: 'dump verification failed (not a valid pg_dump archive)' };
      }

      // Dump is proven good — commit the artifacts BEFORE any drop. -Fc does
      // not capture roles, so the owning role must be recreated separately at
      // restore time.
      const restoreRoleSqlPath = path.join(preDeleteDir, `${database}-${stamp}.restore-role.sql`);
      await fs.writeFile(restoreRoleSqlPath, createRoleSql(user, password) + '\n', { mode: 0o600 });
      await fs.rename(partial, finalDump);
      await fs.chmod(finalDump, 0o600);
      finalDumpPath = finalDump;
    }

    // Only now — drop. Uses the shared admin pool; never .end() it.
    const pool = await this.server.getPool();

    let dbDropped = false;
    let roleDropped = false;

    try {
      // WITH (FORCE) terminates active connections and drops in one
      // statement (PG13+; the bundled server is v16). The allowlist check
      // above makes this interpolation safe.
      await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      dbDropped = true;
    } catch (error) {
      console.warn(`Failed to drop database for ${appName}:`, error);
    }

    try {
      await pool.query(`DROP USER IF EXISTS "${user}"`);
      roleDropped = true;
    } catch (error) {
      console.warn(`Failed to drop role for ${appName}:`, error);
    }

    let reason: string | undefined;
    if (dbDropped && roleDropped) {
      // Only remove the registry entry once BOTH drops succeeded — otherwise
      // a partially-dropped database/role would become an untracked orphan.
      this.provisionedDatabases.delete(appName);
      await this.saveCredentials();
    } else {
      reason = `database drop ${dbDropped ? 'ok' : 'FAILED'}, role drop ${roleDropped ? 'ok' : 'FAILED'}`;
    }

    await this.prunePreDeleteBackups(preDeleteDir);

    return { dropped: dbDropped && roleDropped, reason, dumpPath: finalDumpPath };
  }

  /** True if `file` exists, is non-empty, and begins with the pg_dump custom-format magic header. */
  private async verifyDumpFile(file: string): Promise<boolean> {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size === 0) {
        return false;
      }
      const handle = await fs.open(file, 'r');
      try {
        const buf = Buffer.alloc(5);
        const { bytesRead } = await handle.read(buf, 0, 5, 0);
        return bytesRead === 5 && buf.toString('latin1') === 'PGDMP';
      } finally {
        await handle.close();
      }
    } catch {
      return false;
    }
  }

  /**
   * Best-effort age-based retention for pre-delete dumps. Never throws — a
   * pruning failure must never be mistaken for (or cause) a drop failure.
   * Age-based (not keep-last-N) so pruning never evicts a different app's
   * only surviving copy. `DROP_PREDELETE_RETENTION_DAYS <= 0` disables
   * pruning entirely (keep forever). Default: 3 days.
   */
  private async prunePreDeleteBackups(preDeleteDir: string): Promise<void> {
    try {
      const raw = process.env.DROP_PREDELETE_RETENTION_DAYS;
      const days = raw !== undefined && raw !== '' ? Number(raw) : 3;
      if (!Number.isFinite(days) || days <= 0) {
        return;
      }

      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const entries = await fs.readdir(preDeleteDir);
      for (const entry of entries) {
        // Also sweep `.dump.partial` files orphaned by a crash/SIGKILL between
        // pg_dump completing and the rename — age-based, so a fresh in-flight
        // one is never touched.
        if (
          !entry.endsWith('.dump') &&
          !entry.endsWith('.restore-role.sql') &&
          !entry.endsWith('.dump.partial')
        ) {
          continue;
        }
        const filePath = path.join(preDeleteDir, entry);
        try {
          const stat = await fs.stat(filePath);
          if (stat.mtimeMs < cutoff) {
            await fs.rm(filePath, { force: true });
          }
        } catch {
          // Best-effort — skip files we can't stat/remove.
        }
      }
    } catch {
      // Best-effort — pruning failures must never surface as a drop failure.
    }
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
      // URL form + DROP-066 rationale: buildConnectionString.
      const connectionString = buildConnectionString(creds, { kind: 'socket', dir: socketDir });
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
      ? buildConnectionString(creds, { kind: 'tcp', host: opts.pgHost })
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

  /**
   * Whether a database exists on the server for this app despite no stored
   * credentials — e.g. `db-credentials.json` was quarantined after failing to
   * parse (see `quarantineCorruptCredentials`), which clears the in-memory
   * registry but leaves the actual databases behind on disk. This is a
   * control-plane *metadata existence* check (does a database with this name
   * exist), not tenant data access, which is why it is allowed to use the
   * server's admin pool while the app-db-inspector itself never may.
   *
   * Returns `false` on any error — this is a diagnostic used to decide whether
   * to raise a louder warning, and it must never turn a working panel into a
   * failing one.
   */
  async orphanDatabaseExists(appName: string): Promise<boolean> {
    try {
      const safeName = this.sanitizeName(appName);
      const dbName = `${APP_DB_PREFIX}${safeName}`;
      return await this.server.databaseExists(dbName);
    } catch {
      return false;
    }
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
    let data: string;
    try {
      data = await fs.readFile(this.credentialsPath, 'utf-8');
    } catch {
      // No credentials file yet — first run. Start with an empty registry.
      this.provisionedDatabases.clear();
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      // Corrupt file. It maps every app to its database + role + password;
      // losing it strands every app (the collision guard in
      // provisionAppDatabase then refuses to re-provision over the existing
      // database, so redeploys fail loudly). Quarantine it for recovery
      // instead of silently overwriting it on the next save.
      await this.quarantineCorruptCredentials(err);
      this.provisionedDatabases.clear();
      return;
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as { databases?: unknown }).databases)
    ) {
      // Parsed but wrong shape (truncated-yet-valid JSON / hand-edited) — treat
      // as corrupt: preserve, don't overwrite.
      await this.quarantineCorruptCredentials(new Error('db-credentials.json has an unexpected shape'));
      this.provisionedDatabases.clear();
      return;
    }

    this.provisionedDatabases.clear();
    const databases = (parsed as { databases: Array<Record<string, unknown>> }).databases;
    for (const db of databases) {
      if (!db || typeof db.appName !== 'string' || !db.credentials) {
        continue; // skip malformed entries rather than crashing the load
      }
      this.provisionedDatabases.set(db.appName, {
        appName: db.appName,
        credentials: db.credentials as DatabaseCredentials,
        createdAt: new Date(db.createdAt as string),
      });
    }
  }

  /** Preserve a corrupt db-credentials.json (rename to `.corrupt-<ts>`) for recovery. */
  private async quarantineCorruptCredentials(err: unknown): Promise<void> {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const quarantinePath = `${this.credentialsPath}.corrupt-${ts}`;
      await fs.rename(this.credentialsPath, quarantinePath);
      console.error(
        `[db-provisioner] Corrupt db-credentials.json quarantined to ${quarantinePath}:`,
        err instanceof Error ? err.message : err
      );
    } catch (renameErr) {
      console.error('[db-provisioner] Failed to quarantine corrupt db-credentials.json:', renameErr);
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
