/**
 * PostgreSQL Binary Manager
 *
 * Downloads and manages PostgreSQL binaries for Windows and Linux.
 * Binaries are downloaded on first run and stored in the DROP directory.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { createWriteStream, existsSync } from 'fs';
import { spawn } from 'child_process';

// PostgreSQL version to use
const PG_VERSION = '16.1';

// Download URLs for PostgreSQL binaries (fallback when no system package found)
const DOWNLOAD_URLS: Record<string, string> = {
  win32: `https://get.enterprisedb.com/postgresql/postgresql-${PG_VERSION}-1-windows-x64-binaries.zip`,
  linux: `https://get.enterprisedb.com/postgresql/postgresql-${PG_VERSION}-1-linux-x64-binaries.tar.gz`,
};

// Candidate system PostgreSQL bin directories (checked in order)
const SYSTEM_PG_BIN_DIRS = [
  '/usr/lib/postgresql/16/bin',
  '/usr/lib/postgresql/15/bin',
  '/usr/lib/postgresql/14/bin',
  '/usr/pgsql-16/bin',
  '/usr/pgsql-15/bin',
];

const PG_BINARIES = ['postgres', 'pg_ctl', 'initdb', 'psql', 'createdb', 'createuser'];

export interface PostgresBinariesConfig {
  /** Base directory for DROP (e.g., C:\drop or /var/drop) */
  dropRoot: string;
}

export interface BinaryPaths {
  /** Directory containing PostgreSQL binaries */
  binDir: string;
  /** Path to postgres executable */
  postgres: string;
  /** Path to pg_ctl executable */
  pgCtl: string;
  /** Path to initdb executable */
  initdb: string;
  /** Path to psql executable */
  psql: string;
  /** Path to createdb executable */
  createdb: string;
  /** Path to createuser executable */
  createuser: string;
  /** PostgreSQL data directory */
  dataDir: string;
  /** PostgreSQL log file */
  logFile: string;
}

export class PostgresBinaries {
  private readonly config: PostgresBinariesConfig;
  private readonly platform: NodeJS.Platform;
  private readonly isWindows: boolean;

  constructor(config: PostgresBinariesConfig) {
    this.config = config;
    this.platform = process.platform;
    this.isWindows = this.platform === 'win32';
  }

  /**
   * Get paths to PostgreSQL binaries and directories
   */
  getPaths(): BinaryPaths {
    const pgsqlDir = path.join(this.config.dropRoot, 'apps', 'drop-svc', 'pgsql');
    const binDir = path.join(pgsqlDir, 'bin');
    const dataDir = path.join(this.config.dropRoot, 'data', 'db', 'pgdata');
    const logDir = path.join(this.config.dropRoot, 'data', 'logs', 'postgres');
    const ext = this.isWindows ? '.exe' : '';

    return {
      binDir,
      postgres: path.join(binDir, `postgres${ext}`),
      pgCtl: path.join(binDir, `pg_ctl${ext}`),
      initdb: path.join(binDir, `initdb${ext}`),
      psql: path.join(binDir, `psql${ext}`),
      createdb: path.join(binDir, `createdb${ext}`),
      createuser: path.join(binDir, `createuser${ext}`),
      dataDir,
      logFile: path.join(logDir, 'postgresql.log'),
    };
  }

  /**
   * Check if PostgreSQL binaries are installed
   */
  async isInstalled(): Promise<boolean> {
    const paths = this.getPaths();
    try {
      await fs.access(paths.postgres);
      await fs.access(paths.initdb);
      await fs.access(paths.psql);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if PostgreSQL data directory is initialized
   */
  async isInitialized(): Promise<boolean> {
    const paths = this.getPaths();
    const pgVersionFile = path.join(paths.dataDir, 'PG_VERSION');
    try {
      await fs.access(pgVersionFile);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * On Linux, find a system-installed PostgreSQL and symlink its binaries into
   * the DROP bin dir so the download step can be skipped entirely.
   * Returns true if symlinks were created successfully.
   */
  async setupFromSystemPackage(): Promise<boolean> {
    if (this.isWindows) return false;

    const paths = this.getPaths();

    for (const systemBinDir of SYSTEM_PG_BIN_DIRS) {
      try {
        await fs.access(path.join(systemBinDir, 'postgres'));
      } catch {
        continue;
      }

      await fs.mkdir(paths.binDir, { recursive: true });

      for (const bin of PG_BINARIES) {
        const src = path.join(systemBinDir, bin);
        const dest = path.join(paths.binDir, bin);
        try {
          await fs.unlink(dest);
        } catch {
          // dest doesn't exist yet, that's fine
        }
        await fs.symlink(src, dest);
      }
      return true;
    }

    return false;
  }

  /**
   * Download PostgreSQL binaries
   */
  async download(onProgress?: (percent: number, message: string) => void): Promise<void> {
    const url = DOWNLOAD_URLS[this.platform];
    if (!url) {
      throw new Error(`Unsupported platform: ${this.platform}. Supported: win32, linux`);
    }

    const pgsqlDir = path.join(this.config.dropRoot, 'apps', 'drop-svc', 'pgsql');
    const tempDir = path.join(this.config.dropRoot, 'data', 'temp');
    const archiveExt = this.isWindows ? '.zip' : '.tar.gz';
    const archivePath = path.join(tempDir, `postgresql${archiveExt}`);

    // Ensure directories exist
    await fs.mkdir(pgsqlDir, { recursive: true });
    await fs.mkdir(tempDir, { recursive: true });

    onProgress?.(0, 'Starting PostgreSQL download...');

    // Download the archive
    await this.downloadFile(url, archivePath, (percent) => {
      onProgress?.(percent * 0.7, `Downloading PostgreSQL ${PG_VERSION}... ${Math.round(percent)}%`);
    });

    onProgress?.(70, 'Extracting PostgreSQL binaries...');

    // Extract the archive
    await this.extractArchive(archivePath, pgsqlDir);

    // Clean up
    try {
      await fs.unlink(archivePath);
    } catch {
      // Ignore cleanup errors
    }

    onProgress?.(100, 'PostgreSQL binaries installed successfully');
  }

  /**
   * Initialize PostgreSQL data directory
   */
  async initialize(onProgress?: (message: string) => void): Promise<void> {
    const paths = this.getPaths();

    // Ensure directories exist
    await fs.mkdir(paths.dataDir, { recursive: true });
    await fs.mkdir(path.dirname(paths.logFile), { recursive: true });

    onProgress?.('Initializing PostgreSQL data directory...');

    // Run initdb
    await this.runCommand(paths.initdb, [
      '-D', paths.dataDir,
      '-U', 'postgres',
      '-E', 'UTF8',
      '--locale=C',
      '-A', 'trust', // Local connections trusted (DROP manages access)
    ]);

    // Configure postgresql.conf for DROP.
    //
    // max_connections must leave real headroom for tenant apps: the platform's
    // own control-plane pool consumes some, and every DB-backed app opens its
    // own pool. At the old default of 100 a box exhausted connections in the
    // low dozens of apps ("too many clients"), taking down every app at once.
    // Default to 200 and make both knobs env-tunable to the host's fleet size.
    // NOTE: this applies only when the data dir is first initialised; existing
    // installs must set it via `ALTER SYSTEM SET max_connections = N;` (or edit
    // postgresql.conf) followed by a restart.
    const maxConnections = parseInt(process.env.DROP_PG_MAX_CONNECTIONS || '200', 10);
    const sharedBuffers = process.env.DROP_PG_SHARED_BUFFERS || '128MB';
    const configPath = path.join(paths.dataDir, 'postgresql.conf');
    const configAdditions = `
# DROP Platform Configuration
# Loopback-only by default: the bundled Postgres must never be reachable from the
# public interface. Apps in the default (PM2) mode connect over 127.0.0.1. If
# Docker container isolation is enabled, widen this to the Docker bridge CIDR
# (e.g. '127.0.0.1,172.17.0.1') — never back to '*'.
listen_addresses = '127.0.0.1'
port = 5433
max_connections = ${maxConnections}
shared_buffers = ${sharedBuffers}
log_destination = 'stderr'
logging_collector = off
`;
    await fs.appendFile(configPath, configAdditions);

    // Configure pg_hba.conf.  Host (TCP) lines start as trust so that
    // superuser-auth.ts can set the postgres password on first boot; they are
    // immediately migrated to scram-sha-256 by that module before the server
    // is exposed to any tenant.  The 0.0.0.0/0 wildcard covers the Docker
    // bridge gateway that containerised apps use to reach the host.
    const hbaPath = path.join(paths.dataDir, 'pg_hba.conf');
    const hbaContent = `
# DROP Platform
# TYPE  DATABASE        USER            ADDRESS                 METHOD
local   all             all                                     trust
host    all             all             127.0.0.1/32            trust
host    all             all             ::1/128                 trust
host    all             all             0.0.0.0/0               trust
`;
    await fs.writeFile(hbaPath, hbaContent);

    onProgress?.('PostgreSQL data directory initialized');
  }

  /**
   * Download a file with progress tracking
   */
  private downloadFile(
    url: string,
    destPath: string,
    onProgress?: (percent: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;

      const request = protocol.get(url, (response) => {
        // Handle redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            this.downloadFile(redirectUrl, destPath, onProgress)
              .then(resolve)
              .catch(reject);
            return;
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`Download failed with status ${response.statusCode}`));
          return;
        }

        const totalSize = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedSize = 0;

        const fileStream = createWriteStream(destPath);

        response.on('data', (chunk: Buffer) => {
          downloadedSize += chunk.length;
          if (totalSize > 0) {
            onProgress?.((downloadedSize / totalSize) * 100);
          }
        });

        response.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close();
          resolve();
        });

        fileStream.on('error', (err) => {
          fs.unlink(destPath).catch(() => {});
          reject(err);
        });
      });

      request.on('error', reject);
    });
  }

  /**
   * Extract archive (zip on Windows, tar.gz on Linux)
   */
  private async extractArchive(archivePath: string, destDir: string): Promise<void> {
    if (this.isWindows) {
      await this.extractZip(archivePath, destDir);
    } else {
      await this.extractTarGz(archivePath, destDir);
    }
  }

  /**
   * Extract zip file using PowerShell (Windows)
   */
  private extractZip(archivePath: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tempExtract = path.join(path.dirname(destDir), 'pgsql_temp');

      // Use PowerShell to extract
      const ps = spawn('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${tempExtract}' -Force`,
      ]);

      ps.on('close', async (code) => {
        if (code !== 0) {
          reject(new Error(`Failed to extract zip, exit code: ${code}`));
          return;
        }

        try {
          // EnterpriseDB archives have a nested pgsql folder
          const nestedDir = path.join(tempExtract, 'pgsql');
          if (existsSync(nestedDir)) {
            // Move contents from nested folder
            const items = await fs.readdir(nestedDir);
            for (const item of items) {
              await fs.rename(
                path.join(nestedDir, item),
                path.join(destDir, item)
              );
            }
            await fs.rm(tempExtract, { recursive: true, force: true });
          } else {
            // Move entire extracted content
            await fs.rename(tempExtract, destDir);
          }
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      ps.on('error', reject);
    });
  }

  /**
   * Extract tar.gz file (Linux)
   */
  private extractTarGz(archivePath: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const tar = spawn('tar', [
        '-xzf', archivePath,
        '-C', path.dirname(destDir),
        '--strip-components=1',
      ]);

      tar.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Failed to extract tar.gz, exit code: ${code}`));
        }
      });

      tar.on('error', reject);
    });
  }

  /**
   * Run a command and wait for completion
   */
  private runCommand(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        env: { ...process.env, PGDATA: undefined },
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`Command failed: ${command}\n${stderr || stdout}`));
        }
      });

      proc.on('error', reject);
    });
  }
}
