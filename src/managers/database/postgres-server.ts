/**
 * PostgreSQL Server Manager
 *
 * Manages the lifecycle of the bundled PostgreSQL server.
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Pool, PoolConfig, escapeIdentifier, escapeLiteral } from 'pg';
import { PostgresBinaries, BinaryPaths } from './postgres-binaries';
import {
  resolveSuperuserPassword,
  hbaNeedsMigration,
  toScramHbaConf,
} from './superuser-auth';

export interface PostgresServerConfig {
  /** Base directory for DROP */
  dropRoot: string;
  /** Port to run PostgreSQL on */
  port?: number;
  /** Callback for log messages */
  onLog?: (message: string) => void;
  /**
   * When true, a failure in secureSuperuser() throws instead of just logging.
   * Required in docker isolation mode — a trust pg_hba with socket-mounted
   * Postgres gives containers unauthenticated superuser access.
   */
  strictSecure?: boolean;
}

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

const DEFAULT_PORT = 5433; // Use non-standard port to avoid conflicts
const STARTUP_TIMEOUT_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 1000;

/**
 * Mode for the dedicated socket directory (DROP-072). Owner gets full rwx
 * (needed to create/remove the socket file); group and "other" both get
 * execute-only (traverse) so a bind-mounted container — whose uid is
 * typically neither the owner nor the owner's group — can still reach
 * `.s.PGSQL.<port>` by path. No read bit anywhere: the directory holds
 * nothing but the socket file, so there is nothing to list, and no write bit
 * outside the owner: a container can connect but can't create/replace files
 * in it. This is what the data directory (0700, container uid == owner) could
 * never give a DIFFERENT uid without opening it up to every other app's raw
 * database files too.
 *
 * These bits are NOT the control under a uid collision. `useradd` commonly
 * lands the DROP service user on uid 1000 and IMAGE_USERS runs nodejs/python/go
 * containers as uid 1000 too; on such a box the container IS the directory
 * owner and gets rwx. What stops it unlinking `.s.PGSQL.<port>` and planting
 * its own socket to proxy every other app's SCRAM handshake is `ReadOnly: true`
 * on the bind mount (container-manager.ts), which is pinned by a test. Treat
 * that flag as load-bearing security, not a detail.
 */
const SOCKET_DIR_MODE = 0o711;

export class PostgresServer {
  private readonly config: PostgresServerConfig;
  private readonly binaries: PostgresBinaries;
  private readonly port: number;
  private paths: BinaryPaths | null = null;
  private serverProcess: ChildProcess | null = null;
  private status: ServerStatus = 'stopped';
  private pool: Pool | null = null;
  private superuserPassword: string | null = null;
  /**
   * Socket directory of the postmaster we are actually talking to, resolved
   * from its own postmaster.pid rather than assumed from config (DROP-072
   * review item 1). Null until a server is started or adopted.
   */
  private activeSocketDir: string | null = null;

  constructor(config: PostgresServerConfig) {
    this.config = config;
    this.port = config.port || DEFAULT_PORT;
    this.binaries = new PostgresBinaries({ dropRoot: config.dropRoot });
  }

  /** The bundled superuser password (resolved on start). Throws if not started. */
  getSuperuserPassword(): string {
    if (!this.superuserPassword) {
      throw new Error('PostgreSQL superuser password not resolved (server not started)');
    }
    return this.superuserPassword;
  }

  /**
   * Absolute path to the dedicated directory where the Postgres unix-domain
   * socket file lives, or null on Windows (sockets not used there).
   *
   * DROP starts Postgres with `-k <socketDir>` so the socket file is
   * `<socketDir>/.s.PGSQL.<port>`.  Containers bind-mount this directory to
   * reach Postgres without TCP.
   *
   * DROP-072: this used to return the Postgres DATA directory, which
   * bind-mounted every app's raw database files (`base/`, `global/pg_authid`
   * scram verifiers, `pg_hba.conf`, ...) into every DB-using container —
   * `ReadOnly: true` on the mount prevents writes, not reads. The socket now
   * lives in its own directory (see SOCKET_DIR_MODE) that never contains
   * anything else.
   */
  getSocketDir(): string | null {
    if (process.platform === 'win32' || !this.paths) return null;
    // activeSocketDir is set from the RUNNING postmaster (see resolveActiveSocketDir).
    // Returning the configured path unconditionally is how an adopted server —
    // one that outlived an ungraceful platform exit and still binds the OLD
    // -k — hands every app a DATABASE_URL pointing at an empty directory.
    return this.activeSocketDir ?? this.paths.socketDir;
  }

  /**
   * Resolve the socket directory of the postmaster we are actually connected
   * to, and fail closed if it does not hold a socket (DROP-072 review item 1).
   *
   * `pg_ctl` daemonises Postgres, so a postmaster outlives any ungraceful exit
   * of this process (SIGKILL, OOM). `isServerRunning()` probes TCP, finds it,
   * and `start()` adopts it WITHOUT restarting — so it keeps whatever `-k` it
   * was launched with, which after an upgrade is the old data directory. If we
   * then advertised the configured socketDir, every docker app would be handed
   * a DATABASE_URL pointing at an empty directory, and the runtimeSpecFingerprint
   * would force the whole fleet to redeploy into that broken config in one pass
   * while the platform logged success.
   *
   * postmaster.pid is authoritative: line 5 (index 4) is the socket directory
   * of the running server. Prefer it, verify a socket is really there, and
   * throw otherwise — a platform that refuses to start is recoverable; a silent
   * fleet-wide database outage is not.
   */
  private async resolveActiveSocketDir(): Promise<void> {
    if (process.platform === 'win32' || !this.paths) return;

    let dir = this.paths.socketDir;
    try {
      const pidFile = await fs.readFile(path.join(this.paths.dataDir, 'postmaster.pid'), 'utf-8');
      const recorded = pidFile.split('\n')[4]?.trim();
      if (recorded) dir = recorded;
    } catch {
      // No/unreadable postmaster.pid — fall back to the configured dir and let
      // the socket check below be the arbiter.
    }

    const socketPath = path.join(dir, `.s.PGSQL.${this.port}`);
    try {
      await fs.access(socketPath);
    } catch {
      throw new Error(
        `PostgreSQL is running but its unix socket is not at ${socketPath}. ` +
          `This usually means a postmaster survived an ungraceful shutdown and is ` +
          `still bound to its original socket directory. Stop it (pg_ctl stop -D ` +
          `${this.paths.dataDir}) and restart the platform so it rebinds.`
      );
    }

    this.activeSocketDir = dir;
  }

  /** Pool config for a superuser connection to the given database. */
  getSuperuserPoolConfig(database = 'postgres'): PoolConfig {
    return {
      host: 'localhost',
      port: this.port,
      user: 'postgres',
      password: this.getSuperuserPassword(),
      database,
    };
  }

  /**
   * Get current server status
   */
  getStatus(): ServerStatus {
    return this.status;
  }

  /**
   * Get connection port
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get connection string for the internal database
   */
  getConnectionString(database = 'postgres'): string {
    const pw = this.superuserPassword ? `:${encodeURIComponent(this.superuserPassword)}` : '';
    return `postgresql://postgres${pw}@localhost:${this.port}/${database}`;
  }

  /**
   * Ensure PostgreSQL is installed and initialized
   */
  async ensureReady(onProgress?: (message: string) => void): Promise<void> {
    this.paths = this.binaries.getPaths();

    // Check if binaries are installed
    if (!(await this.binaries.isInstalled())) {
      const fromSystem = await this.binaries.setupFromSystemPackage();
      if (!fromSystem) {
        onProgress?.('PostgreSQL binaries not found, downloading...');
        await this.binaries.download((_percent, message) => {
          onProgress?.(message);
        });
      }
    }

    // Check if data directory is initialized
    if (!(await this.binaries.isInitialized())) {
      onProgress?.('Initializing PostgreSQL database...');
      await this.binaries.initialize(onProgress);
    }

    // Ensure log directory exists
    await fs.mkdir(path.dirname(this.paths.logFile), { recursive: true });

    // Ensure the dedicated socket directory exists with the hardened mode
    // (DROP-072). Unconditional create+chmod — not gated by isInitialized() —
    // so an existing install upgrading to this fix gets both the directory
    // and the correct permissions on its very next start, not only on a
    // fresh install.
    await this.ensureSocketDir();
  }

  /** Create (if missing) and harden the dedicated Postgres socket directory. No-op on Windows. */
  private async ensureSocketDir(): Promise<void> {
    if (process.platform === 'win32' || !this.paths) return;
    await fs.mkdir(this.paths.socketDir, { recursive: true, mode: SOCKET_DIR_MODE });
    // mkdir's `mode` only applies at creation time, so re-assert it on every
    // start (same rationale as ensureDirectories()'s drop-svc hardening).
    await fs.chmod(this.paths.socketDir, SOCKET_DIR_MODE);
  }

  /**
   * Start the PostgreSQL server
   */
  async start(): Promise<void> {
    if (this.status === 'running') {
      return;
    }

    if (!this.paths) {
      await this.ensureReady();
      this.paths = this.binaries.getPaths();
    }

    this.status = 'starting';
    this.log('Starting PostgreSQL server...');

    // Resolve the superuser password before any connection so every pool uses it.
    this.superuserPassword = await resolveSuperuserPassword(this.config.dropRoot);

    // Check if PostgreSQL is already running (from previous session)
    if (await this.isServerRunning()) {
      this.log('PostgreSQL is already running');
      // Adopted, not started by us — it keeps whatever -k it was launched with,
      // so resolve the socket dir from ITS postmaster.pid and fail closed if
      // there is no socket there. See resolveActiveSocketDir.
      await this.resolveActiveSocketDir();
      this.log(`PostgreSQL socket directory: ${this.activeSocketDir}`);
      this.status = 'running';
      await this.initializePool();
      await this.secureSuperuser();
      return;
    }

    // Clean up any stale files that might block startup
    await this.cleanupStaleFiles();

    // Start the server
    try {
      await this.startServer();
      await this.waitForStartup();
      // Same check on the path we DID start: confirms -k actually took effect
      // before any app is handed a DATABASE_URL built from it.
      await this.resolveActiveSocketDir();
      await this.initializePool();
      await this.secureSuperuser();
      this.status = 'running';
      this.log(`PostgreSQL started on port ${this.port}`);
    } catch (error) {
      this.status = 'error';
      throw error;
    }
  }

  /**
   * Give the superuser a password and migrate pg_hba from trust to
   * scram-sha-256 (both TCP and unix-socket lines).  Safe to run repeatedly
   * and on a live server: the password is set first (while trust still permits
   * the connection), then pg_hba is flipped and reloaded.
   *
   * When `strictSecure` is true (required in docker mode) this method throws
   * on failure instead of just logging — a trust pg_hba with the Postgres
   * socket bind-mounted into containers gives unauthenticated superuser access.
   */
  private async secureSuperuser(): Promise<void> {
    if (!this.paths || !this.pool || !this.superuserPassword) return;

    try {
      // Set/refresh the superuser password (scram-hashed). Works under trust.
      await this.pool.query(`SET password_encryption = 'scram-sha-256'`);
      // escapeLiteral rather than hand-doubling quotes: ''-doubling is only
      // correct while standard_conforming_strings is on, and this is the last
      // hand-escaped literal in this file after the rest moved to pg's helpers.
      await this.pool.query(`ALTER ROLE postgres PASSWORD ${escapeLiteral(this.superuserPassword)}`);

      const hbaPath = path.join(this.paths.dataDir, 'pg_hba.conf');
      const hba = await fs.readFile(hbaPath, 'utf-8');
      if (hbaNeedsMigration(hba)) {
        await fs.writeFile(hbaPath, toScramHbaConf(hba));
        // Reload pg_hba without a restart; existing connections stay open.
        execSync(`"${this.paths.pgCtl}" reload -D "${this.paths.dataDir}"`, {
          timeout: 10000,
          stdio: 'pipe',
        });
        this.log('Secured PostgreSQL superuser: password set, pg_hba migrated to scram-sha-256');
      }

      // Post-migration assert: verify no trust lines remain.
      const hbaAfter = await fs.readFile(hbaPath, 'utf-8');
      const trustLines = hbaAfter
        .split('\n')
        .filter((l) => !/^\s*#/.test(l) && /\btrust\b/.test(l));
      if (trustLines.length > 0) {
        throw new Error(
          `pg_hba.conf still contains trust lines after migration: ${trustLines.join(' | ')}`
        );
      }
    } catch (err) {
      const msg = `Failed to secure PostgreSQL superuser: ${err instanceof Error ? err.message : err}`;
      if (this.config.strictSecure) {
        throw new Error(msg);
      }
      this.log(`WARNING: ${msg}`);
    }
  }

  /**
   * Stop the PostgreSQL server
   */
  async stop(): Promise<void> {
    if (this.status === 'stopped') {
      return;
    }

    this.status = 'stopping';
    this.log('Stopping PostgreSQL server...');

    // Close connection pool
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }

    // Stop the server gracefully
    if (this.paths) {
      try {
        const pgCtl = this.paths.pgCtl;
        const dataDir = this.paths.dataDir;

        execSync(`"${pgCtl}" stop -D "${dataDir}" -m fast`, {
          timeout: 10000,
          stdio: 'pipe',
        });
      } catch {
        // Server might already be stopped
      }
    }

    // Kill the process if still running
    if (this.serverProcess) {
      this.serverProcess.kill('SIGTERM');
      this.serverProcess = null;
    }

    this.status = 'stopped';
    this.log('PostgreSQL stopped');
  }

  /**
   * Get a database connection pool
   */
  async getPool(): Promise<Pool> {
    if (!this.pool) {
      await this.initializePool();
    }
    return this.pool!;
  }

  /**
   * Execute a query
   */
  async query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]> {
    const pool = await this.getPool();
    const result = await pool.query(sql, params);
    return result.rows as T[];
  }

  /**
   * Check if a database exists
   */
  async databaseExists(name: string): Promise<boolean> {
    const result = await this.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) as exists',
      [name]
    );
    return result[0]?.exists || false;
  }

  /**
   * Create a database
   */
  async createDatabase(name: string): Promise<void> {
    // Can't use parameterized query for database names
    const safeName = name.replace(/[^a-zA-Z0-9_]/g, '_');
    const pool = await this.getPool();
    await pool.query(`CREATE DATABASE "${safeName}"`);
    this.log(`Created database: ${safeName}`);
  }

  /**
   * Create a user with password
   */
  async createUser(username: string, password: string): Promise<void> {
    const safeUsername = username.replace(/[^a-zA-Z0-9_]/g, '_');
    const pool = await this.getPool();
    // CREATE USER doesn't accept a bind parameter for a role name or for its
    // PASSWORD clause, so pool.query(sql, [values]) can't be used here —
    // escape the identifier and the literal explicitly instead of relying on
    // the caller's password never containing a quote character.
    await pool.query(
      `CREATE USER ${escapeIdentifier(safeUsername)} WITH PASSWORD ${escapeLiteral(password)}`
    );
    this.log(`Created user: ${safeUsername}`);
  }

  /**
   * Grant all privileges on a database to a user
   */
  async grantPrivileges(database: string, username: string): Promise<void> {
    const safeDb = database.replace(/[^a-zA-Z0-9_]/g, '_');
    const safeUser = username.replace(/[^a-zA-Z0-9_]/g, '_');
    const pool = await this.getPool();
    await pool.query(`GRANT ALL PRIVILEGES ON DATABASE "${safeDb}" TO "${safeUser}"`);
    this.log(`Granted privileges on ${safeDb} to ${safeUser}`);
  }

  // ============ Private Methods ============

  private async startServer(): Promise<void> {
    if (!this.paths) throw new Error('Paths not initialized');

    const dataDir = this.paths.dataDir;

    // Use pg_ctl to start postgres in the background (prevents console windows on Windows)
    // Use a dedicated socket directory (DROP-072), not the data dir or the
    // system default /var/run/postgresql (which is owned by the system
    // postgres user on Ubuntu and DROP wouldn't have write access to). A
    // directory containing only the socket can be bind-mounted into
    // containers without exposing the data dir's raw database files.
    const pgCtl = this.paths.pgCtl;
    // Quoted: pg_ctl re-splits the single -o string on whitespace, so an
    // unquoted path silently truncates if DROP_ROOT ever contains a space.
    const socketOpts = process.platform !== 'win32' ? ` -k "${this.paths.socketDir}"` : '';
    this.serverProcess = spawn(pgCtl, [
      'start',
      '-D', dataDir,
      '-o', `-p ${this.port}${socketOpts}`,
      '-w', // Wait for startup
    ], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // Handle process output
    this.serverProcess.stdout?.on('data', (data) => {
      this.log(`[PostgreSQL] ${data.toString().trim()}`);
    });

    this.serverProcess.stderr?.on('data', (data) => {
      this.log(`[PostgreSQL] ${data.toString().trim()}`);
    });

    this.serverProcess.on('error', (error) => {
      this.log(`PostgreSQL process error: ${error.message}`);
      this.status = 'error';
    });

    this.serverProcess.on('exit', (code) => {
      // pg_ctl start exits after starting postgres, so code 0 is expected
      if (code !== 0 && this.status !== 'stopping' && this.status !== 'stopped') {
        this.log(`PostgreSQL pg_ctl exited with code ${code}`);
        this.status = 'error';
      }
    });
  }

  private async waitForStartup(): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < STARTUP_TIMEOUT_MS) {
      if (await this.isServerRunning()) {
        return;
      }
      await this.sleep(HEALTH_CHECK_INTERVAL_MS);
    }

    throw new Error(`PostgreSQL failed to start within ${STARTUP_TIMEOUT_MS}ms`);
  }

  private async isServerRunning(): Promise<boolean> {
    // Under trust the password is ignored; under scram it must be the resolved
    // superuser password. Pass it so both pre- and post-migration servers are
    // detected as running. Fall back to the legacy 'postgres' literal only if
    // the password hasn't been resolved yet.
    const password = this.superuserPassword ?? 'postgres';
    try {
      const pool = new Pool({
        host: 'localhost',
        port: this.port,
        user: 'postgres',
        password,
        database: 'postgres',
        max: 1,
        connectionTimeoutMillis: 2000,
      });

      await pool.query('SELECT 1');
      await pool.end();
      return true;
    } catch {
      return false;
    }
  }

  private async initializePool(): Promise<void> {
    // This is the platform's superuser control-plane pool (provisioning,
    // health, migrations) — not a tenant workload pool. Keep it small so the
    // bulk of max_connections stays available for tenant apps. Env-tunable.
    const adminPoolMax = parseInt(process.env.DROP_PG_ADMIN_POOL_MAX || '10', 10);
    this.pool = new Pool({
      host: 'localhost',
      port: this.port,
      user: 'postgres',
      password: this.superuserPassword ?? 'postgres',
      database: 'postgres',
      max: adminPoolMax,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    // Test connection
    await this.pool.query('SELECT 1');
  }

  private log(message: string): void {
    this.config.onLog?.(message);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Clean up stale files that might block startup
   * This can happen if postgres crashed or was killed, or log files are locked
   */
  private async cleanupStaleFiles(): Promise<void> {
    if (!this.paths) return;

    // Clean up stale PID file — but ONLY if the postmaster it names is really
    // dead (DROP-072 review item 3). isServerRunning() probes TCP and returns
    // false for a LIVE server whenever auth fails (rotated superuser file,
    // pg_hba mid-migration, a timeout on a loaded box). Unlinking the pid file
    // then lets a second postmaster start on the same -D, and that file plus
    // the shmem key it records IS PostgreSQL's interlock against exactly that
    // — the documented route to data corruption. Fail loudly instead.
    const pidFile = path.join(this.paths.dataDir, 'postmaster.pid');
    try {
      const contents = await fs.readFile(pidFile, 'utf-8');
      const recordedPid = parseInt(contents.split('\n')[0]?.trim() ?? '', 10);
      if (Number.isInteger(recordedPid) && recordedPid > 0) {
        let alive = false;
        try {
          process.kill(recordedPid, 0);
          alive = true;
        } catch (err) {
          // ESRCH => no such process (stale). EPERM => it exists but is owned
          // by another user, which still means "alive" for our purposes.
          alive = (err as NodeJS.ErrnoException).code === 'EPERM';
        }
        if (alive) {
          throw new Error(
            `postmaster.pid names a live process (pid ${recordedPid}) but PostgreSQL ` +
              `did not answer a health check. Refusing to remove the pid file — doing ` +
              `so would allow a second postmaster on the same data directory and risk ` +
              `corruption. Investigate that process, or stop it with ` +
              `pg_ctl stop -D ${this.paths.dataDir}.`
          );
        }
      }
      this.log('Found stale postmaster.pid file, removing...');
      await fs.unlink(pidFile);
    } catch (err) {
      // Rethrow our own refusal; swallow "no pid file" and read races.
      if (err instanceof Error && err.message.includes('names a live process')) throw err;
    }

    // Clean up locked log file (Windows sharing violation issue)
    try {
      await fs.access(this.paths.logFile);
      // Rename old log instead of deleting (preserves logs)
      const timestamp = Date.now();
      const backupLog = `${this.paths.logFile}.${timestamp}.old`;
      try {
        await fs.rename(this.paths.logFile, backupLog);
        this.log('Rotated old log file');
      } catch {
        // If rename fails, try to delete
        try {
          await fs.unlink(this.paths.logFile);
          this.log('Removed locked log file');
        } catch {
          // Can't remove - will let pg_ctl try anyway
        }
      }
    } catch {
      // No log file
    }
  }
}

// Singleton instance
let serverInstance: PostgresServer | null = null;

export function getPostgresServer(config?: PostgresServerConfig): PostgresServer {
  if (!serverInstance) {
    if (!config) {
      throw new Error('PostgresServer config required on first call');
    }
    serverInstance = new PostgresServer(config);
  }
  return serverInstance;
}

export function resetPostgresServer(): void {
  if (serverInstance) {
    serverInstance.stop().catch(() => {});
    serverInstance = null;
  }
}
