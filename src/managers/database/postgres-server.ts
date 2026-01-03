/**
 * PostgreSQL Server Manager
 *
 * Manages the lifecycle of the bundled PostgreSQL server.
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Pool } from 'pg';
import { PostgresBinaries, BinaryPaths } from './postgres-binaries';

export interface PostgresServerConfig {
  /** Base directory for DROP */
  dropRoot: string;
  /** Port to run PostgreSQL on */
  port?: number;
  /** Callback for log messages */
  onLog?: (message: string) => void;
}

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error';

const DEFAULT_PORT = 5433; // Use non-standard port to avoid conflicts
const STARTUP_TIMEOUT_MS = 30000;
const HEALTH_CHECK_INTERVAL_MS = 1000;

export class PostgresServer {
  private readonly config: PostgresServerConfig;
  private readonly binaries: PostgresBinaries;
  private readonly port: number;
  private paths: BinaryPaths | null = null;
  private serverProcess: ChildProcess | null = null;
  private status: ServerStatus = 'stopped';
  private pool: Pool | null = null;

  constructor(config: PostgresServerConfig) {
    this.config = config;
    this.port = config.port || DEFAULT_PORT;
    this.binaries = new PostgresBinaries({ dropRoot: config.dropRoot });
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
    return `postgresql://postgres@localhost:${this.port}/${database}`;
  }

  /**
   * Ensure PostgreSQL is installed and initialized
   */
  async ensureReady(onProgress?: (message: string) => void): Promise<void> {
    this.paths = this.binaries.getPaths();

    // Check if binaries are installed
    if (!(await this.binaries.isInstalled())) {
      onProgress?.('PostgreSQL binaries not found, downloading...');
      await this.binaries.download((_percent, message) => {
        onProgress?.(message);
      });
    }

    // Check if data directory is initialized
    if (!(await this.binaries.isInitialized())) {
      onProgress?.('Initializing PostgreSQL database...');
      await this.binaries.initialize(onProgress);
    }

    // Ensure log directory exists
    await fs.mkdir(path.dirname(this.paths.logFile), { recursive: true });
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

    // Check if PostgreSQL is already running (from previous session)
    if (await this.isServerRunning()) {
      this.log('PostgreSQL is already running');
      this.status = 'running';
      await this.initializePool();
      return;
    }

    // Start the server
    try {
      await this.startServer();
      await this.waitForStartup();
      await this.initializePool();
      this.status = 'running';
      this.log(`PostgreSQL started on port ${this.port}`);
    } catch (error) {
      this.status = 'error';
      throw error;
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
    await pool.query(`CREATE USER "${safeUsername}" WITH PASSWORD '${password}'`);
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

    const postgres = this.paths.postgres;
    const dataDir = this.paths.dataDir;
    // logFile is configured in postgresql.conf, not needed for spawn

    // Start postgres directly (more reliable than pg_ctl on Windows)
    this.serverProcess = spawn(postgres, [
      '-D', dataDir,
      '-p', this.port.toString(),
    ], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
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
      if (this.status !== 'stopping' && this.status !== 'stopped') {
        this.log(`PostgreSQL exited unexpectedly with code ${code}`);
        this.status = 'error';
      }
    });

    // Unref so the process can run independently
    this.serverProcess.unref();
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
    try {
      const pool = new Pool({
        host: 'localhost',
        port: this.port,
        user: 'postgres',
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
    this.pool = new Pool({
      host: 'localhost',
      port: this.port,
      user: 'postgres',
      database: 'postgres',
      max: 20,
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
