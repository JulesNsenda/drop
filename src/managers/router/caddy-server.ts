/**
 * Caddy Server Manager
 *
 * Manages the lifecycle of the Caddy web server for hostname-based routing.
 * Follows the same pattern as PostgresServer for consistency.
 */

import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  CaddyServerConfig,
  CaddyServerStatus,
  CaddyVersionInfo,
} from './caddy-server.types';
import { CaddyAdminClient, CertificateInfo } from './caddy-api';

const DEFAULT_PORT = 80;
const DEFAULT_ADMIN_PORT = 2019;
const STARTUP_TIMEOUT_MS = 10000;
const HEALTH_CHECK_INTERVAL_MS = 500;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5000;

export class CaddyServer {
  private readonly config: CaddyServerConfig;
  private readonly port: number;
  private readonly adminPort: number;
  private serverProcess: ChildProcess | null = null;
  private status: CaddyServerStatus = 'stopped';
  private installed: boolean | null = null;

  constructor(config: CaddyServerConfig) {
    this.config = config;
    this.port = config.port || DEFAULT_PORT;
    this.adminPort = config.adminPort || DEFAULT_ADMIN_PORT;
  }

  /**
   * Get current server status
   */
  getStatus(): CaddyServerStatus {
    return this.status;
  }

  /**
   * Get HTTP port
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Get admin API port
   */
  getAdminPort(): number {
    return this.adminPort;
  }

  /**
   * Get admin API URL
   */
  getAdminUrl(): string {
    return `http://localhost:${this.adminPort}`;
  }

  /**
   * Headers for Caddy admin API requests.
   *
   * Caddy 2.11+ enforces an origin check on the admin API for requests that
   * look like browser CORS calls. Node's fetch (undici) auto-sends
   * `Sec-Fetch-Mode: cors`, which triggers that check; with no Origin header
   * Caddy rejects the request with 403 "client is not allowed to access from
   * origin ''". Sending an Origin that matches the admin endpoint satisfies it.
   */
  private adminHeaders(extra?: Record<string, string>): Record<string, string> {
    return { Origin: this.getAdminUrl(), ...extra };
  }

  /**
   * Check if Caddy is installed on the system
   */
  async isInstalled(): Promise<boolean> {
    if (this.installed !== null) {
      return this.installed;
    }

    try {
      const command = process.platform === 'win32' ? 'where caddy' : 'which caddy';
      execSync(command, { stdio: 'pipe' });
      this.installed = true;
      return true;
    } catch {
      this.installed = false;
      return false;
    }
  }

  /**
   * Get Caddy version information
   */
  async getVersion(): Promise<CaddyVersionInfo | null> {
    if (!(await this.isInstalled())) {
      return null;
    }

    try {
      const output = execSync('caddy version', { encoding: 'utf-8', stdio: 'pipe' });
      // Version output is like "v2.7.6 h1:abc123"
      const match = output.match(/v?(\d+)\.(\d+)\.(\d+)/);
      if (match) {
        return {
          version: output.trim().split(' ')[0],
          major: parseInt(match[1], 10),
          minor: parseInt(match[2], 10),
          patch: parseInt(match[3], 10),
        };
      }
    } catch {
      // Failed to get version
    }

    return null;
  }

  /**
   * Ensure Caddy is available and ready to use
   * Returns true if Caddy is available, false if not installed
   */
  async ensureReady(onProgress?: (message: string) => void): Promise<boolean> {
    onProgress?.('Checking Caddy availability...');

    if (!(await this.isInstalled())) {
      this.status = 'unavailable';
      onProgress?.('Caddy not found - hostname routing disabled');
      return false;
    }

    const version = await this.getVersion();
    if (version) {
      onProgress?.(`Caddy ${version.version} found`);

      // Check minimum version (v2.0.0+)
      if (version.major < 2) {
        this.status = 'unavailable';
        onProgress?.('Caddy v2.0.0 or later required');
        return false;
      }
    }

    // Ensure Caddyfile exists
    try {
      await fs.access(this.config.caddyfilePath);
    } catch {
      onProgress?.('Creating initial Caddyfile...');
      await this.createInitialCaddyfile();
    }

    // Ensure log directory exists
    const logDir = path.join(this.config.dropRoot, 'data', 'logs', 'caddy');
    await fs.mkdir(logDir, { recursive: true });

    return true;
  }

  /**
   * Start the Caddy server
   */
  async start(): Promise<void> {
    if (this.status === 'running') {
      return;
    }

    if (this.status === 'unavailable') {
      this.log('Caddy not available - skipping start');
      return;
    }

    this.status = 'starting';
    this.log('Starting Caddy server...');

    // Check if Caddy is already running (from previous session)
    if (await this.isServerRunning()) {
      this.log('Caddy is already running');
      this.status = 'running';
      // Reload config in case it changed
      await this.reload();
      return;
    }

    try {
      await this.startServer();
      await this.waitForStartup();
      this.status = 'running';
      this.log(`Caddy started on port ${this.port}`);
    } catch (error) {
      this.status = 'error';
      this.log(`Failed to start Caddy: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  /**
   * Stop the Caddy server
   */
  async stop(): Promise<void> {
    if (this.status === 'stopped' || this.status === 'unavailable') {
      return;
    }

    this.status = 'stopping';
    this.log('Stopping Caddy server...');

    // Try graceful stop via admin API
    await this.stopViaAdminApi();

    // If we spawned the process, ensure it's terminated
    if (this.serverProcess) {
      await this.terminateProcess();
    }

    this.status = 'stopped';
    this.log('Caddy stopped');
  }

  /**
   * Reload Caddy configuration via admin API
   */
  async reload(): Promise<boolean> {
    if (this.status !== 'running') {
      this.log('Cannot reload - Caddy is not running');
      return false;
    }

    try {
      const caddyfileContent = await fs.readFile(this.config.caddyfilePath, 'utf-8');

      const response = await fetch(`${this.getAdminUrl()}/load`, {
        method: 'POST',
        headers: this.adminHeaders({ 'Content-Type': 'text/caddyfile' }),
        body: caddyfileContent,
      });

      if (!response.ok) {
        const error = await response.text();
        this.log(`Caddy reload failed: ${error}`);
        return false;
      }

      this.log('Caddy configuration reloaded');
      return true;
    } catch (error) {
      this.log(`Caddy reload error: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Check if Caddy server is running via admin API health check
   */
  async isServerRunning(): Promise<boolean> {
    try {
      const response = await fetch(`${this.getAdminUrl()}/config/`, {
        method: 'GET',
        headers: this.adminHeaders(),
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ============ Certificate Methods ============

  /**
   * Get a CaddyAdminClient for certificate operations
   */
  getAdminClient(): CaddyAdminClient {
    return new CaddyAdminClient(this.getAdminUrl());
  }

  /**
   * Get all managed certificates
   */
  async getCertificates(): Promise<CertificateInfo[]> {
    const client = this.getAdminClient();
    return client.getCertificates();
  }

  /**
   * Get certificate for a specific domain
   */
  async getCertificateForDomain(domain: string): Promise<CertificateInfo | null> {
    const client = this.getAdminClient();
    return client.getCertificateForDomain(domain);
  }

  /**
   * Get certificates expiring within the specified number of days
   */
  async getExpiringCertificates(days: number = 7): Promise<CertificateInfo[]> {
    const client = this.getAdminClient();
    return client.getExpiringCertificates(days);
  }

  /**
   * Get certificate health summary
   */
  async getCertificateHealth(): Promise<{
    total: number;
    valid: number;
    expiring: number;
    expired: number;
    healthy: boolean;
  }> {
    const certs = await this.getCertificates();
    const summary = {
      total: certs.length,
      valid: certs.filter(c => c.status === 'valid').length,
      expiring: certs.filter(c => c.status === 'expiring').length,
      expired: certs.filter(c => c.status === 'expired').length,
      healthy: true,
    };
    summary.healthy = summary.expired === 0;
    return summary;
  }

  // ============ Private Methods ============

  private async startServer(): Promise<void> {
    const args = [
      'run',
      '--config', this.config.caddyfilePath,
      '--adapter', 'caddyfile',
    ];

    this.serverProcess = spawn('caddy', args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // Handle process output
    this.serverProcess.stdout?.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        this.log(`[Caddy] ${message}`);
      }
    });

    this.serverProcess.stderr?.on('data', (data) => {
      const message = data.toString().trim();
      if (message) {
        // Caddy logs operational info (incl. TLS errors) to stderr — surface
        // at error level, not debug, so they aren't invisible in production.
        this.logError(`[Caddy] ${message}`);
      }
    });

    this.serverProcess.on('error', (error) => {
      this.logError(`Caddy process error: ${error.message}`);
      this.status = 'error';
    });

    this.serverProcess.on('exit', (code, signal) => {
      if (this.status !== 'stopping' && this.status !== 'stopped') {
        if (code !== 0 && code !== null) {
          this.logError(`Caddy exited unexpectedly with code ${code}`);
          this.status = 'error';
        } else if (signal) {
          this.logError(`Caddy terminated by signal ${signal}`);
          this.status = 'stopped';
        }
      }
      this.serverProcess = null;
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

    throw new Error(`Caddy failed to start within ${STARTUP_TIMEOUT_MS}ms`);
  }

  private async stopViaAdminApi(): Promise<void> {
    try {
      await fetch(`${this.getAdminUrl()}/stop`, {
        method: 'POST',
        headers: this.adminHeaders(),
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // Admin API might not be available
    }
  }

  private async terminateProcess(): Promise<void> {
    const process = this.serverProcess;
    if (!process) {
      return;
    }

    return new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        process.kill('SIGKILL');
        resolve();
      }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);

      process.once('exit', () => {
        clearTimeout(forceKill);
        resolve();
      });

      process.kill('SIGTERM');
    });
  }

  private async createInitialCaddyfile(): Promise<void> {
    const logDir = path.join(this.config.dropRoot, 'data', 'logs', 'caddy');

    const content = `# DROP Platform Caddyfile
# Auto-generated - routes are added automatically when apps are deployed

# Global options
{
    admin localhost:${this.adminPort}
    auto_https off
}

# Logging snippet
(drop_logging) {
    log {
        output file ${path.join(logDir, 'access.log').replace(/\\/g, '/')} {
            roll_size 100mb
            roll_keep 10
        }
        format json
    }
}

# Import app configurations
import ${path.join(this.config.dropRoot, 'data', 'appconf', 'caddy', 'webapps', '*.caddy').replace(/\\/g, '/')}
import ${path.join(this.config.dropRoot, 'data', 'appconf', 'caddy', 'hosts', '*.caddy').replace(/\\/g, '/')}
`;

    const dir = path.dirname(this.config.caddyfilePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.config.caddyfilePath, content, 'utf-8');
  }

  private log(message: string): void {
    this.config.onLog?.(message);
  }

  private logError(message: string): void {
    if (this.config.onError) {
      this.config.onError(message);
    } else {
      this.config.onLog?.(message);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton instance
let serverInstance: CaddyServer | null = null;

export function getCaddyServer(config?: CaddyServerConfig): CaddyServer {
  if (!serverInstance) {
    if (!config) {
      throw new Error('CaddyServer config required on first call');
    }
    serverInstance = new CaddyServer(config);
  }
  return serverInstance;
}

export function resetCaddyServer(): void {
  if (serverInstance) {
    serverInstance.stop().catch(() => {});
    serverInstance = null;
  }
}
