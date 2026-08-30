/**
 * Database Provisioner
 *
 * Handles creating and managing databases for DROP and deployed apps.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as path from 'path';
import { Pool, escapeIdentifier, escapeLiteral } from 'pg';
import { writeJsonAtomic } from '../../utils/atomic-write';
import { parsePositiveIntEnv } from '../../utils/env-int';
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

export interface BackupAndDeleteResult {
  /** True iff BOTH the database and its role were dropped. Existing callers keep reading only this. */
  dropped: boolean;
  /** True iff the database no longer exists on the server after this call (freshly dropped, or already gone). */
  databaseDropped: boolean;
  /** True iff the role no longer exists on the server after this call. */
  roleDropped: boolean;
  reason?: string;
  /** Present only when a dump was actually written this call — absent on the cleanup arm and on skipBackup. */
  dumpPath?: string;
}

const DROP_INTERNAL_DB = 'drop_internal';
const DROP_INTERNAL_USER = 'drop_admin';
const APP_DB_PREFIX = 'drop_';
const APP_USER_PREFIX = 'drop_';

/** Defense-in-depth: sanitized DB/role identifiers must match before touching a path or SQL statement. */
const DB_NAME_ALLOWLIST = /^[a-z0-9_]+$/;

/**
 * Lowercase, collapse non-alphanumerics to `_`, trim, cap at 32 chars.
 * Shared by the (lossy, by design) DB/role-name derivation below and by
 * `ownerDumpDirName()`'s pre-delete dump owner-key encoding — one transform,
 * reused rather than re-implemented, per the file's existing sanitizeName().
 */
function sanitizeIdentifier(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 32);
}

/** Pre-delete dump owner-subdirectory for an app with no owning userId (see `ownerDumpDirName`). */
export const OWNERLESS_DUMP_DIR = '_ownerless';

/**
 * Recognized pre-delete dump artifact suffixes: a completed `.dump`, its
 * `.restore-role.sql` sibling (pg_dump's custom format doesn't capture
 * roles, so the role-recreation script ships alongside it), or a
 * `.dump.partial` orphaned by a crash/SIGKILL between pg_dump completing
 * and the rename. Shared by the age-based sweep below
 * (`prunePreDeleteFileIfExpired`) and detach-limits.ts's per-owner byte
 * budget, so the two scanners never disagree about what's actually on disk.
 */
const PRE_DELETE_ARTIFACT_SUFFIXES = ['.dump', '.restore-role.sql', '.dump.partial'] as const;

/** True if `name` is a recognized pre-delete dump artifact — see `PRE_DELETE_ARTIFACT_SUFFIXES`. */
export function isPreDeleteDumpArtifact(name: string): boolean {
  return PRE_DELETE_ARTIFACT_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * The `.restore-role.sql` sibling path for a `.dump` path — dumps and their
 * role-recreation scripts are written and pruned as a pair (see
 * `backupAndDeleteAppDatabase`).
 */
export function restoreRoleSqlPathFor(dumpPath: string): string {
  return dumpPath.replace(/\.dump$/, '.restore-role.sql');
}

/**
 * Filesystem-safe pre-delete dump owner-subdirectory name for `userId` —
 * `data/backup/pre-delete/<ownerDumpDirName(userId)>/...`.
 *
 * WHY per-owner (DROP-151 Phase 3, three findings from one root cause):
 * dump ownership used to be RE-DERIVED from the live app list via
 * `dbNameForApp()` prefixes at read time, instead of recorded once at write
 * time. That let (1) a create->attach->fill->delete loop with a fresh app
 * name each time write dumps attributable to nobody the moment the app that
 * wrote them was deleted — never counted, never pruned (evadable metering);
 * (2) `pruneOwnerDumpsToFit` sort ALL of an owner's *name-matching* dumps
 * oldest-first, so deleting app A could evict app B's only surviving
 * pre-drop dump (cross-app eviction); and (3) `sanitizeName`'s lossy
 * lowercase/collapse/truncate meant a tenant could register an app whose
 * sanitized NAME collides with a victim's database name and prune the
 * victim's dumps via their own unrelated delete (collision). Keying the
 * directory on the OWNING USER instead means attribution is fixed at write
 * time and survives the app itself being deleted.
 *
 * Reuses `sanitizeIdentifier()` — the same lossy transform already trusted
 * for database/role names — which is safe here for a reason that doesn't
 * apply to app names: `userId` is a server-generated `crypto.randomUUID()`,
 * never attacker-chosen, so a tenant cannot pick their own userId to
 * engineer a collision onto another owner's directory the way they can pick
 * an app name.
 *
 * `undefined`/`null` (no owning user — CLI/admin-created apps, and group
 * children until group detach is wired) and a userId that
 * sanitizes to the empty string both fall back to the fixed `_ownerless`
 * bucket, shared the same way ownerless apps already share one dump-budget
 * bucket (see `detach-limits.ts`'s module doc).
 */
export function ownerDumpDirName(userId?: string | null): string {
  if (!userId) return OWNERLESS_DUMP_DIR;
  const safe = sanitizeIdentifier(userId);
  return safe.length > 0 ? safe : OWNERLESS_DUMP_DIR;
}

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
        // ALTER USER doesn't accept a bind parameter for a role name or for
        // its PASSWORD clause, so pool.query(sql, [values]) can't be used
        // here — escape the identifier and the literal explicitly instead of
        // relying on generatePassword() never producing a quote character.
        await pool.query(
          `ALTER USER ${escapeIdentifier(userName)} WITH PASSWORD ${escapeLiteral(password)}`
        );
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

      // Bound how much this role can spill to disk (DROP-163, the database
      // panel's query console). Disk is GLOBAL on this box: a query that fills
      // it takes down PostgreSQL, Caddy and every app, so this is a
      // whole-platform availability control, not a per-tenant nicety.
      //
      // It has to be set HERE, as a role default by the superuser, and cannot
      // be a `SET LOCAL` in the query path: `temp_file_limit`'s
      // `pg_settings.context` is `superuser`, so an unprivileged role setting
      // it gets `42501 permission denied to set parameter` — which refuses the
      // whole statement rather than being ignored.
      //
      // Non-fatal: a provisioning run that fails only here has still produced a
      // working database, and the query console is bounded by
      // `statement_timeout` and `work_mem` regardless. Roles provisioned BEFORE
      // this shipped do not have it until they are reprovisioned.
      await appPool
        .query(`ALTER ROLE "${userName}" SET temp_file_limit = '128MB'`)
        .catch((err: unknown) => {
          console.warn(
            `[db-provisioner] could not set temp_file_limit for "${userName}": ` +
              `${err instanceof Error ? err.message : String(err)}`
          );
        });
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
   * Dump-then-drop an app's database on a deliberate app delete (or a
   * user-initiated Postgres detach).
   *
   * Fail-closed at every step: if the dump can't be produced and verified,
   * the database (and its credentials-registry entry) are KEPT — a retained,
   * undeleted database is always the safe outcome. Only once a verified dump
   * (plus a role-recreation script) is safely committed to disk do we touch
   * `DROP DATABASE`/`DROP USER`.
   *
   * The registry entry is removed iff `databaseDropped` — a credentials
   * record pointing at a database that no longer exists protects nothing and
   * would otherwise permanently burn a quota slot. A role that survives a
   * successful database drop is the tracked orphan (logged loudly); the
   * cleanup arm below picks it up on the next retry, because this app no
   * longer has a registry entry pointing at a live database.
   *
   * CLEANUP ARM: a registry entry can outlive its database — a previous call
   * dropped the database but failed to drop the role, or the database was
   * dropped out-of-band. Retrying the dump against a database that no longer
   * exists would fail every time and wedge the entry forever, so this checks
   * existence first and, if the database is already gone, skips straight to
   * dropping the surviving role. This is what makes a partial-detach retry
   * converge instead of repeating the same failure. The existence probe
   * itself is wrapped: a probe FAILURE (e.g. Postgres unreachable) must never
   * be read as "the database is gone" — see the early return below.
   *
   * PRE-DELETE DUMP LAYOUT: dumps land under
   * `data/backup/pre-delete/<ownerDumpDirName(opts.ownerUserId)>/...` — see
   * `ownerDumpDirName()`'s doc for why attribution is keyed on the owning
   * user rather than re-derived from app names at read time.
   *
   * See docs/plans/2026-07-07-dump-then-drop-on-delete.md and
   * docs/plans/2026-08-16-extension-catalog.md ("Phase 3 — detach").
   */
  async backupAndDeleteAppDatabase(
    appName: string,
    opts: {
      /**
       * Skip the pre-delete dump.
       *
       * For an EPHEMERAL app only: its data is throwaway by construction, and
       * dumping every scratch database on the way out would fill the box with
       * backups nobody will ever read. Never set for an ordinary app — the dump
       * is the only thing standing between a mistaken delete and data loss.
       */
      skipBackup?: boolean;
      /**
       * The app's owning userId (AppState/AppConfig `userId`), used to place
       * the pre-delete dump in its owner's subdirectory — see
       * `ownerDumpDirName()`. REQUIRED, not optional: pass `null` explicitly
       * for an app with no owning user. Optional-with-a-safe-default is
       * precisely what let a caller silently mis-attribute a dump to the
       * shared `_ownerless` bucket while the byte budget kept measuring the
       * real owner's (perpetually empty) directory — an unbounded caller
       * mistake, not a compile error.
       */
      ownerUserId: string | null;
    }
  ): Promise<BackupAndDeleteResult> {
    const provisioned = this.provisionedDatabases.get(appName);
    if (!provisioned) {
      return this.failResult('no database provisioned');
    }

    const { database, user, password } = provisioned.credentials;

    // Defense-in-depth: these become a filesystem path component and an
    // interpolated SQL identifier below. sanitizeName() should already
    // guarantee this shape, but never trust that transitively for a
    // destructive operation.
    if (!DB_NAME_ALLOWLIST.test(database) || !DB_NAME_ALLOWLIST.test(user)) {
      return this.failResult('refusing: unexpected identifier');
    }

    // `preDeleteDir` is the BASE directory — prunePreDeleteBackups walks it
    // (and one level of per-owner subdirectories) for age-based retention.
    // `ownerDir` is where THIS call's dump actually lands.
    const preDeleteDir = this.preDeleteRootDir();
    const ownerDir = this.ownerDumpDir(opts.ownerUserId);

    // CLEANUP ARM — see the method doc. No database means nothing to dump and
    // nothing to drop but the role. The probe is wrapped: every OTHER
    // failure in this method returns a structured result rather than
    // throwing (see orphanDatabaseExists for the same pattern) — this was
    // the one call not wrapped, so a Postgres-unreachable probe failure used
    // to throw out of a method whose contract is "never throw, always
    // return a reason".
    let databaseStillExists: boolean;
    try {
      databaseStillExists = await this.server.databaseExists(database);
    } catch (error) {
      console.warn(`Failed to check database existence for ${appName} before detach:`, error);
      return this.failResult('existence probe failed — unable to determine whether the database still exists');
    }

    if (!databaseStillExists) {
      const pool = await this.server.getPool();
      let roleDropped = false;
      try {
        await pool.query(`DROP USER IF EXISTS "${user}"`);
        roleDropped = true;
      } catch (error) {
        console.warn(`Failed to drop orphaned role for ${appName}:`, error);
      }

      let reason: string | undefined;
      if (roleDropped) {
        this.provisionedDatabases.delete(appName);
        await this.saveCredentials();
      } else {
        reason = `database already gone; role "${user}" drop FAILED (orphaned)`;
        console.warn(
          `[db-provisioner] Cleanup retry for ${appName}: database already gone but role "${user}" ` +
            `survived a DROP USER attempt — remains a tracked orphan until the next retry.`
        );
      }

      await this.prunePreDeleteBackups(preDeleteDir);
      return { dropped: roleDropped, databaseDropped: true, roleDropped, reason };
    }

    // Hardened per-owner pre-delete dump directory. mode-on-mkdir only
    // applies at creation time, so an already-existing (possibly looser)
    // directory must be re-hardened unconditionally. No process.umask() here
    // — this runs inside the long-lived server process, and a global umask
    // mutation would race every other concurrent file write.
    await fs.mkdir(ownerDir, { recursive: true, mode: 0o700 });
    await fs.chmod(ownerDir, 0o700);

    const ext = process.platform === 'win32' ? '.exe' : '';
    const pgDumpPath = path.join(this.dropRoot, 'apps', 'drop-svc', 'pgsql', 'bin', `pg_dump${ext}`);
    if (!opts.skipBackup && !fssync.existsSync(pgDumpPath)) {
      return this.failResult('pg_dump binary not found');
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const partial = path.join(ownerDir, `${database}-${stamp}.dump.partial`);
    const finalDump = partial.replace(/\.partial$/, '');

    // An ephemeral skips the dump ENTIRELY — including the verification gate
    // below, which would otherwise abort the drop when there is no dump to
    // verify and leave the scratch database behind forever.
    let finalDumpPath: string | undefined;
    let restoreRoleSqlPath: string | undefined;
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
        return this.failResult(`dump failed: ${result.error}`);
      }

      // Verify before touching the database: exists, non-empty, and begins
      // with the pg_dump custom-format magic header ("PGDMP"). A corrupt or
      // truncated dump must never be trusted as the safety net for a drop.
      const verified = await this.verifyDumpFile(partial);
      if (!verified) {
        await fs.rm(partial, { force: true });
        return this.failResult('dump verification failed (not a valid pg_dump archive)');
      }

      // Dump is proven good — commit the artifacts BEFORE any drop. -Fc does
      // not capture roles, so the owning role must be recreated separately at
      // restore time.
      restoreRoleSqlPath = path.join(ownerDir, `${database}-${stamp}.restore-role.sql`);
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
    if (dbDropped) {
      // Removed iff the DATABASE is gone, regardless of the role — a
      // registry entry pointing at a dropped database protects nothing and
      // would otherwise permanently burn a quota slot. A role that survives
      // is the tracked orphan; the cleanup arm above picks it up on retry.
      this.provisionedDatabases.delete(appName);
      await this.saveCredentials();
      if (!roleDropped) {
        reason = `database drop ok, role drop FAILED (role "${user}" orphaned)`;
        console.warn(
          `[db-provisioner] Role "${user}" for ${appName} orphaned after a successful database drop.`
        );
      }
    } else {
      reason = `database drop FAILED, role drop ${roleDropped ? 'ok' : 'FAILED'}`;
    }

    // The role survived with its plaintext password still live — the
    // restore script is now a live credential, not a restore artifact.
    // Unlink it best-effort; a failure here must never be mistaken for a
    // drop failure.
    if (!roleDropped && restoreRoleSqlPath) {
      await fs.rm(restoreRoleSqlPath, { force: true }).catch((err) => {
        console.warn(`Failed to unlink restore-role.sql for ${appName} (role still live):`, err);
      });
    }

    await this.prunePreDeleteBackups(preDeleteDir);

    return {
      dropped: dbDropped && roleDropped,
      databaseDropped: dbDropped,
      roleDropped,
      reason,
      dumpPath: finalDumpPath,
    };
  }

  /**
   * Shared shape for every early-bail failure path in `backupAndDeleteAppDatabase`
   * above (nothing dropped, only a reason) — a seventh bail-out can't forget a
   * field it never has to write out by hand.
   */
  private failResult(reason: string): BackupAndDeleteResult {
    return { dropped: false, databaseDropped: false, roleDropped: false, reason };
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
   * only surviving copy.
   *
   * `DROP_PREDELETE_RETENTION_DAYS=0` or `=off` is a DELIBERATE opt-out —
   * keep forever. Anything else that isn't a valid positive integer (a typo
   * like `'3d'`, a negative value, blank) falls back to the 3-day default
   * instead: this used to fail OPEN (any non-finite/non-positive value, typo
   * included, silently meant "keep forever" — an operator's misconfiguration
   * would grow `data/backup/pre-delete/` without bound). Only the two literal
   * opt-out spellings get the old "disable" behaviour; every other invalid
   * shape is fail-closed via the shared `parsePositiveIntEnv`.
   *
   * Walks TWO levels: `preDeleteDir` itself (a dump written before the
   * per-owner-subdirectory layout landed — never migrated, but still swept
   * by age so it isn't left unbounded just because it predates this change)
   * and, one level deeper, each per-owner subdirectory (the current
   * layout — see `ownerDumpDirName`). Never recurses further than that: an
   * owner subdirectory is flat by construction, same as the old top-level
   * layout was.
   */
  private async prunePreDeleteBackups(preDeleteDir: string): Promise<void> {
    try {
      const raw = process.env.DROP_PREDELETE_RETENTION_DAYS;
      if (raw !== undefined && (raw.trim() === '0' || raw.trim().toLowerCase() === 'off')) {
        return;
      }
      const days = parsePositiveIntEnv(raw, 3);
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

      let entries: fssync.Dirent[];
      try {
        entries = await fs.readdir(preDeleteDir, { withFileTypes: true });
      } catch {
        return; // no pre-delete directory yet — nothing to prune
      }

      for (const entry of entries) {
        const entryPath = path.join(preDeleteDir, entry.name);
        if (entry.isDirectory()) {
          await this.prunePreDeleteFilesIn(entryPath, cutoff);
          continue;
        }
        await this.prunePreDeleteFileIfExpired(entryPath, entry.name, cutoff);
      }
    } catch {
      // Best-effort — pruning failures must never surface as a drop failure.
    }
  }

  /** Age-sweep every recognized dump artifact directly inside `dir` (one level, non-recursive). */
  private async prunePreDeleteFilesIn(dir: string, cutoff: number): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return; // vanished (a concurrent prune) — nothing to do
    }
    for (const name of names) {
      await this.prunePreDeleteFileIfExpired(path.join(dir, name), name, cutoff);
    }
  }

  /** Remove `filePath` if its name is a recognized dump artifact older than `cutoff`. Best-effort. */
  private async prunePreDeleteFileIfExpired(filePath: string, name: string, cutoff: number): Promise<void> {
    // Includes `.dump.partial` — orphaned by a crash/SIGKILL between pg_dump
    // completing and the rename — but this is age-based, so a fresh in-flight
    // one is never touched.
    if (!isPreDeleteDumpArtifact(name)) {
      return;
    }
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoff) {
        await fs.rm(filePath, { force: true });
      }
    } catch {
      // Best-effort — skip files we can't stat/remove.
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
   * The database name `provisionAppDatabase` would derive (or already has)
   * for `appName` — exposed so callers that need to reason about dump-file
   * naming don't duplicate `sanitizeName`'s lossy lowercasing/collapsing/
   * truncation. The detach per-owner byte budget stopped using name
   * prefixes once dump attribution moved to per-owner directories (see
   * `ownerDumpDirName()`); this method's only production caller now is the
   * delete route's `dbNamePrefix` prune scoping, which still needs the
   * exact db name so a delete never evicts a sibling app's dumps.
   */
  dbNameForApp(appName: string): string {
    return `${APP_DB_PREFIX}${this.sanitizeName(appName)}`;
  }

  /**
   * Base directory pre-delete dumps live under:
   * `<dropRoot>/data/backup/pre-delete`. `DatabaseProvisioner` is the only
   * object holding `dropRoot`, so this is the single source of truth for the
   * layout — other modules that need this path go through here (or through
   * `ownerDumpDir()` below) instead of re-deriving it from their own config.
   */
  preDeleteRootDir(): string {
    return path.join(this.dropRoot, 'data', 'backup', 'pre-delete');
  }

  /**
   * This owner's pre-delete dump subdirectory —
   * `preDeleteRootDir()/<ownerDumpDirName(userId)>` — see `ownerDumpDirName()`
   * for why attribution is keyed on the owning user rather than re-derived
   * from app names.
   */
  ownerDumpDir(userId?: string | null): string {
    return path.join(this.preDeleteRootDir(), ownerDumpDirName(userId));
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
    return sanitizeIdentifier(name);
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
