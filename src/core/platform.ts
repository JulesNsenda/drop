/**
 * DROP Platform - Main orchestrator for the DROP PaaS
 *
 * This is the central coordinator that initializes and manages all
 * DROP services and their lifecycle.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { EventBus, eventBus, Unsubscribe } from './event-bus';
import { WatcherService } from './watcher';
import { DetectorService, getDetector, parseDropYaml, DetectionResult } from './detector';
import { BuilderService, getBuilder } from './builder';
import { RouterService, getRouterService, resetRouterService } from './router';
import { AppRuntime, AppStartSpec, getAppRuntime, resetAppRuntime } from '../managers/runtime';
import { AppStateManager, getStateManager, resetStateManager } from '../managers/app/state-manager';
import { AppConfigService, getAppConfigService, resetAppConfigService } from '../managers/app/app-config';
import { PostgresServer, getPostgresServer, resetPostgresServer, DatabaseProvisioner } from '../managers/database';
import { CaddyServer, getCaddyServer, resetCaddyServer } from '../managers/router';
import { SecretManager, getSecretManager, resetSecretManager } from '../managers/secret';
import { WebhookManager, getWebhookManager, resetWebhookManager } from './webhooks';
import { GitDeployService, getGitDeployService, resetGitDeployService } from './git-deploy';
import { getActivityLog, resetActivityLog } from '../managers/activity';
import { ApiServer, createApiServer } from '../api';
import { Logger, createLogger } from '../utils/logger';
import {
  validateDomain,
  validateDomainFormat,
  isLocalhostDomain,
} from '../utils/domain-validator';
import { createApiKey, deleteApiKeysByName } from '../api/middleware/auth';
import { IsolationMode, assertStartupConstraints } from './startup-constraints';
import { createContainerExecCommand } from './builder/container-build-runner';
import { migrateAllToDocker } from '../managers/runtime/runtime-migrator';
import { buildNginxConf } from '../utils/nginx-conf';
import { BuildLogService, getBuildLogService, resetBuildLogService } from '../managers/build-log/build-log';
import {
  LogRetentionService,
  getLogRetentionService,
  resetLogRetentionService,
} from '../managers/log-retention/log-retention';

export interface PlatformConfig {
  /** Root directory for DROP */
  dropRoot: string;
  /** Directory where apps are dropped */
  appsDirectory: string;
  /** Log level */
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** Default port range start */
  portRangeStart: number;
  /** Default port range end */
  portRangeEnd: number;
  /** Auto-build on detection */
  autoBuild: boolean;
  /** Auto-start after build */
  autoStart: boolean;
  /** Caddyfile path for router */
  caddyfilePath: string;
  /** Enable HTTPS for apps */
  enableHttps: boolean;
  /** ACME email for Let's Encrypt certificates */
  acmeEmail?: string;
  /** Use ACME staging (for testing) */
  acmeStaging?: boolean;
  /** Default domain suffix (e.g., "example.com" for apps at myapp.example.com) */
  domainSuffix?: string;
  /** DNS provider for DNS-01 challenge (wildcard certs) */
  dnsProvider?: 'cloudflare' | 'route53' | 'digitalocean' | 'godaddy';
  /** DNS provider credentials */
  dnsCredentials?: {
    apiToken?: string;
    zoneId?: string;
    accessKey?: string;
    secretKey?: string;
  };
  /** Use wildcard certificate for all apps */
  wildcardCert?: boolean;
  /** Enable API server */
  enableApi: boolean;
  /** API server port */
  apiPort: number;
  /** Enable API authentication */
  enableApiAuth: boolean;
  /** Maximum apps per user (0 = unlimited) */
  maxAppsPerUser: number;
  /**
   * App isolation mode.
   * - 'none'   — default; apps run as PM2 processes on the host. Single-user /
   *              fully-trusted. signup cannot be enabled in this mode.
   * - 'docker' — apps build and run in containers. Required for multi-user.
   *              Linux-first; Windows via Docker Desktop is dev/best-effort only.
   */
  isolation: IsolationMode;
  /**
   * Allow new users to self-register via POST /auth/signup.
   * Requires isolation: 'docker' and auth enabled — enforced at startup.
   * Default false; enable with DROP_ALLOW_SIGNUP=true.
   */
  allowSignup: boolean;
  /** Max databases a single user may provision (0 = unlimited). */
  maxDbsPerUser: number;
  /** Global limit on simultaneous builds (0 = unlimited). */
  maxConcurrentBuilds: number;
  /** Max disk usage per app directory in MB (0 = unlimited). */
  maxDiskMbPerApp: number;
  /**
   * Global cap on concurrently running apps (0 = unlimited).
   * In docker mode on a 4 GB server, each app container uses ~256 MB by
   * default, so 10 apps fills ~2.5 GB — set this to prevent OOM thrashing.
   * Default 0 (unlimited) for PM2 mode; set DROP_MAX_CONCURRENT_APPS in
   * drop.env when running with docker isolation.
   */
  maxConcurrentApps: number;
  /**
   * Per-app memory cap in MB (0 = no platform-set cap — the default). When > 0
   * it becomes PM2's max_memory_restart (process restarted on exceed — the
   * closest degraded equivalent to a hard limit, so a runaway can't OOM the
   * host) and the container --memory limit in docker mode.
   *
   * Opt-in by default (0) on purpose: forcing a cap would silently kill
   * existing PM2 apps that legitimately use more, and would override docker's
   * own tuned 256 MB container default. Operators enable it via
   * DROP_MAX_MEMORY_MB_PER_APP once they know their apps' real footprint;
   * multi-tenant (docker) installs should set it. When 0, docker containers
   * keep ContainerManager's 256 MB default.
   */
  maxMemoryMbPerApp: number;
  /**
   * Per-app CPU cap in cores (0 = no platform-set cap — the default). Honored
   * in docker mode (--cpus); PM2 cannot enforce CPU limits so it is ignored
   * there. When 0, docker keeps ContainerManager's 0.5-core default.
   */
  maxCpusPerApp: number;
  /**
   * Delete log files under data/logs older than this many days (min 1).
   * Bounds disk usage from per-app, Caddy, build, and platform logs. Default 14.
   */
  logRetentionDays: number;
  /**
   * Rotate the platform log at startup once it exceeds this many MB
   * (0 = never). Default 50.
   */
  logMaxFileMb: number;
}

// Determine platform-appropriate defaults
const isWindows = process.platform === 'win32';
const DEFAULT_DROP_ROOT = isWindows ? 'C:\\drop' : '/var/drop';
const DEFAULT_APPS_DIR = isWindows ? 'C:\\drop\\data\\webapps' : '/var/drop/data/webapps';
const DEFAULT_CADDYFILE = isWindows
  ? 'C:\\drop\\data\\appconf\\Caddyfile'
  : '/var/drop/data/appconf/Caddyfile';

const DEFAULT_CONFIG: PlatformConfig = {
  dropRoot: DEFAULT_DROP_ROOT,
  appsDirectory: DEFAULT_APPS_DIR,
  logLevel: 'info',
  portRangeStart: 3001,
  portRangeEnd: 3999,
  autoBuild: true,
  autoStart: true,
  caddyfilePath: DEFAULT_CADDYFILE,
  enableHttps: false,
  acmeEmail: undefined,
  acmeStaging: false,
  domainSuffix: 'localhost',
  dnsProvider: undefined,
  dnsCredentials: undefined,
  wildcardCert: false,
  enableApi: true,
  apiPort: 3000,
  enableApiAuth: process.env.DROP_DISABLE_AUTH !== 'true',
  maxAppsPerUser: parseInt(process.env.DROP_MAX_APPS_PER_USER || '5', 10),
  isolation: (process.env.DROP_ISOLATION as IsolationMode) ?? 'none',
  allowSignup: process.env.DROP_ALLOW_SIGNUP === 'true',
  maxDbsPerUser: parseInt(process.env.DROP_MAX_DBS_PER_USER || '3', 10),
  maxConcurrentBuilds: parseInt(process.env.DROP_MAX_CONCURRENT_BUILDS || '3', 10),
  maxDiskMbPerApp: parseInt(process.env.DROP_MAX_DISK_MB_PER_APP || '0', 10),
  maxConcurrentApps: parseInt(process.env.DROP_MAX_CONCURRENT_APPS || '0', 10),
  maxMemoryMbPerApp: parseInt(process.env.DROP_MAX_MEMORY_MB_PER_APP || '0', 10),
  maxCpusPerApp: parseFloat(process.env.DROP_MAX_CPUS_PER_APP || '0'),
  logRetentionDays: parseInt(process.env.DROP_LOG_RETENTION_DAYS || '14', 10),
  logMaxFileMb: parseInt(process.env.DROP_LOG_MAX_FILE_MB || '50', 10),
};

export class DropPlatform {
  private readonly config: PlatformConfig;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;

  private watcher: WatcherService | null = null;
  private detector: DetectorService | null = null;
  private builder: BuilderService | null = null;
  private runtime: AppRuntime | null = null;
  private router: RouterService | null = null;
  private stateManager: AppStateManager | null = null;
  private appConfigService: AppConfigService | null = null;
  private postgresServer: PostgresServer | null = null;
  private dbProvisioner: DatabaseProvisioner | null = null;
  private caddyServer: CaddyServer | null = null;
  private secretManager: SecretManager | null = null;
  private webhookManager: WebhookManager | null = null;
  private gitDeployService: GitDeployService | null = null;
  private apiServer: ApiServer | null = null;
  private buildLogService: BuildLogService | null = null;
  private logRetention: LogRetentionService | null = null;

  private subscriptions: Unsubscribe[] = [];
  private isRunning = false;
  private nextPort: number;
  private usedPorts: Map<number, string> = new Map(); // port -> appName ownership
  private appsInProgress: Set<string> = new Set(); // Track apps being built/started
  private appDeployTimes: Map<string, number> = new Map(); // Track when apps were last deployed
  private appBuildDurations: Map<string, number> = new Map(); // Last build duration per app (ms)
  /** Minimum post-deploy quiet window. Adaptive: max(this, lastBuildDuration * 2). */
  private readonly DEPLOY_COOLDOWN_MS_MIN = 5_000;
  /** Hard cap on the adaptive cooldown so a flaky 10-minute build doesn't lock out hot-reload forever. */
  private readonly DEPLOY_COOLDOWN_MS_MAX = 120_000;
  private certExpiryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly CERT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  /** Per-app health-probe intervals (PM2 mode only; Docker uses HEALTHCHECK). */
  private readonly healthProbers: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(config?: Partial<PlatformConfig>) {
    // Load DNS credentials from environment variables
    const dnsCredentials = config?.dnsCredentials ?? {
      apiToken: process.env.DROP_DNS_CF_API_TOKEN || process.env.CF_API_TOKEN,
      zoneId: process.env.DROP_DNS_CF_ZONE_ID || process.env.CF_ZONE_ID,
      accessKey: process.env.DROP_DNS_AWS_ACCESS_KEY || process.env.AWS_ACCESS_KEY_ID,
      secretKey: process.env.DROP_DNS_AWS_SECRET_KEY || process.env.AWS_SECRET_ACCESS_KEY,
    };

    this.config = {
      ...DEFAULT_CONFIG,
      dropRoot: config?.dropRoot ?? process.env.DROP_ROOT ?? DEFAULT_CONFIG.dropRoot,
      appsDirectory: config?.appsDirectory ?? process.env.DROP_APPS_DIR ?? DEFAULT_CONFIG.appsDirectory,
      logLevel: config?.logLevel ?? (process.env.DROP_LOG_LEVEL as PlatformConfig['logLevel']) ?? DEFAULT_CONFIG.logLevel,
      enableHttps: config?.enableHttps ?? (process.env.DROP_ENABLE_HTTPS !== undefined ? process.env.DROP_ENABLE_HTTPS === 'true' : DEFAULT_CONFIG.enableHttps),
      acmeEmail: config?.acmeEmail ?? process.env.DROP_ACME_EMAIL ?? DEFAULT_CONFIG.acmeEmail,
      acmeStaging: config?.acmeStaging ?? (process.env.DROP_ACME_STAGING !== undefined ? process.env.DROP_ACME_STAGING === 'true' : DEFAULT_CONFIG.acmeStaging),
      domainSuffix: config?.domainSuffix ?? process.env.DROP_DOMAIN_SUFFIX ?? DEFAULT_CONFIG.domainSuffix,
      dnsProvider: config?.dnsProvider ?? (process.env.DROP_DNS_PROVIDER as PlatformConfig['dnsProvider']) ?? DEFAULT_CONFIG.dnsProvider,
      dnsCredentials: Object.values(dnsCredentials).some(v => v) ? dnsCredentials : undefined,
      wildcardCert: config?.wildcardCert ?? (process.env.DROP_WILDCARD_CERT !== undefined ? process.env.DROP_WILDCARD_CERT === 'true' : DEFAULT_CONFIG.wildcardCert),
      enableApi: config?.enableApi ?? (process.env.DROP_ENABLE_API !== undefined ? process.env.DROP_ENABLE_API !== 'false' : DEFAULT_CONFIG.enableApi),
      apiPort: config?.apiPort ?? (process.env.DROP_API_PORT ? parseInt(process.env.DROP_API_PORT, 10) : DEFAULT_CONFIG.apiPort),
      enableApiAuth: config?.enableApiAuth ?? (process.env.DROP_ENABLE_API_AUTH !== undefined ? process.env.DROP_ENABLE_API_AUTH === 'true' : DEFAULT_CONFIG.enableApiAuth),
      ...config,
    };
    this.eventBus = eventBus;
    this.nextPort = this.config.portRangeStart;

    // Initialize logger (console only initially, file logging enabled after dirs created)
    this.logger = createLogger({
      level: this.config.logLevel,
      console: true,
      file: false,
      maxFileBytes: this.config.logMaxFileMb > 0 ? this.config.logMaxFileMb * 1024 * 1024 : 0,
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('DROP platform is already running');
    }

    this.logger.platformEvent('starting');
    this.logger.info(`Drop root: ${this.config.dropRoot}`, 'CONFIG');
    this.logger.info(`Apps directory: ${this.config.appsDirectory}`, 'CONFIG');

    this.eventBus.publish('platform:starting', { config: this.config as unknown as Record<string, unknown> });

    try {
      // Fail-closed startup constraints: docker reachability, signup gate
      await assertStartupConstraints({
        isolation: this.config.isolation,
        allowSignup: this.config.allowSignup,
        enableApiAuth: this.config.enableApiAuth,
      });

      // Validate domain configuration if HTTPS is enabled
      if (this.config.enableHttps && this.config.domainSuffix) {
        await this.validateDomainConfig();
      }

      // Ensure required directories exist
      await this.ensureDirectories();

      // Enable file logging now that directories exist
      const logDir = path.join(this.config.dropRoot, 'data', 'logs', 'drop-svc');
      this.logger.enableFileLogging(logDir);

      // Prune old logs so a long-lived box can't fill its disk (per-app, Caddy,
      // build and platform logs all live under data/logs). Sweeps now + daily.
      this.logRetention = getLogRetentionService(
        path.join(this.config.dropRoot, 'data', 'logs'),
        this.config.logRetentionDays
      );
      this.logRetention.start();

      // Initialize services
      await this.initializeServices();

      // In docker mode, stop any PM2-managed apps before the watcher starts so
      // containers can bind to the same ports without conflict.
      if (this.config.isolation === 'docker') {
        await this.runFirstBootMigration();
      }

      // Wire up event handlers
      this.setupEventHandlers();

      // Start watching for apps
      if (this.watcher) {
        await this.watcher.start();
      }

      // Start API server if enabled
      if (this.config.enableApi) {
        await this.startApiServer();
      }

      // Start certificate expiry monitoring if HTTPS is enabled
      if (this.config.enableHttps && !isLocalhostDomain(this.config.domainSuffix || 'localhost')) {
        this.startCertificateMonitoring();
      }

      this.isRunning = true;
      this.eventBus.publish('platform:started', { timestamp: new Date() });
      this.logger.platformEvent('started');
    } catch (error) {
      this.logger.platformEvent('error', error instanceof Error ? error.message : String(error));
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.platformEvent('stopping');
    this.eventBus.publish('platform:stopping', { timestamp: new Date() });

    // Stop certificate monitoring
    if (this.certExpiryTimer) {
      clearInterval(this.certExpiryTimer);
      this.certExpiryTimer = null;
    }

    // Stop the log-retention sweep
    if (this.logRetention) {
      this.logRetention.stop();
      resetLogRetentionService();
      this.logRetention = null;
    }

    // Unsubscribe from all events
    for (const unsub of this.subscriptions) {
      unsub();
    }
    this.subscriptions = [];

    // Stop services in reverse order
    if (this.watcher) {
      await this.watcher.stop();
    }

    // Let any in-flight build/start finish (best-effort, bounded) before we
    // tear down the builder/state so apps aren't left half-deployed.
    await this.drainInProgress(10_000);
    this.appsInProgress.clear();

    if (this.router) {
      this.router.stop();
      resetRouterService();
    }

    if (this.runtime) {
      resetAppRuntime();
      this.runtime = null;
    }

    // Close state manager
    if (this.stateManager) {
      await this.stateManager.close();
      resetStateManager();
    }

    // Reset app config service
    if (this.appConfigService) {
      resetAppConfigService();
    }

    // Stop PostgreSQL server
    if (this.postgresServer) {
      this.logger.info('Stopping PostgreSQL...', 'DATABASE');
      await this.postgresServer.stop();
      resetPostgresServer();
    }

    // Stop Caddy server
    if (this.caddyServer) {
      this.logger.info('Stopping Caddy...', 'CADDY');
      await this.caddyServer.stop();
      resetCaddyServer();
    }

    // Stop all health probers
    for (const [, timer] of this.healthProbers) clearInterval(timer);
    this.healthProbers.clear();

    // Reset secret manager, webhook manager, git deploy service, and build logs
    resetSecretManager();
    resetWebhookManager();
    resetGitDeployService();
    resetActivityLog();
    resetBuildLogService();

    // Stop API server
    if (this.apiServer) {
      await this.apiServer.stop();
      this.apiServer = null;
    }

    this.isRunning = false;
    this.eventBus.publish('platform:stopped', { timestamp: new Date() });
    this.logger.platformEvent('stopped');
    this.logger.close();
  }

  /** Wait (up to timeoutMs) for in-progress deploys to drain. */
  private async drainInProgress(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.appsInProgress.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 100);
        t.unref?.();
      });
    }
    if (this.appsInProgress.size > 0) {
      this.logger.warn(
        `Shutdown proceeding with ${this.appsInProgress.size} deploy(s) still in progress`,
        'PLATFORM'
      );
    }
  }

  private async ensureDirectories(): Promise<void> {
    const dataDir = path.join(this.config.dropRoot, 'data');

    // Directory structure per spec:
    // /var/drop/
    // ├── apps/drop-svc/          # Platform (replaced during upgrade)
    // └── data/                   # User data (preserved during upgrade)
    //     ├── webapps/            # Deployed web applications
    //     ├── drop-svc/           # Platform state (drop.db, encryption.key)
    //     │   └── pm2/            # PM2 config files
    //     ├── db/                 # App databases (SQLite/PostgreSQL)
    //     ├── appdata/            # Per-app persistent data
    //     ├── logs/               # All logs
    //     │   ├── drop-svc/       # Platform logs
    //     │   ├── webapps/        # App logs
    //     │   └── caddy/          # Caddy logs
    //     ├── appconf/            # Configuration files
    //     │   └── caddy/          # Caddy config
    //     │       ├── webapps/    # Per-app Caddy configs
    //     │       └── hosts/      # Per-host Caddy configs
    //     ├── backup/             # Automated backups
    //     └── temp/               # Temporary files

    const directories = [
      // Root
      this.config.dropRoot,
      // Platform directory (for future use)
      path.join(this.config.dropRoot, 'apps', 'drop-svc'),
      // Data directories (preserved during upgrade)
      dataDir,
      this.config.appsDirectory, // data/webapps
      path.join(dataDir, 'drop-svc'), // Platform state
      path.join(dataDir, 'drop-svc', 'pm2'), // PM2 config files
      path.join(dataDir, 'db'), // App databases
      path.join(dataDir, 'appdata'), // Per-app persistent data
      path.join(dataDir, 'logs'), // All logs
      path.join(dataDir, 'logs', 'drop-svc'), // Platform logs
      path.join(dataDir, 'logs', 'webapps'), // App logs
      path.join(dataDir, 'logs', 'caddy'), // Caddy logs
      path.join(dataDir, 'logs', 'builds'), // Per-deploy build logs
      path.join(dataDir, 'appconf'), // Configuration files
      path.join(dataDir, 'appconf', 'caddy'), // Caddy config root
      path.join(dataDir, 'appconf', 'caddy', 'webapps'), // Per-app Caddy configs
      path.join(dataDir, 'appconf', 'caddy', 'hosts'), // Per-host Caddy configs
      path.join(dataDir, 'backup'), // Automated backups
      path.join(dataDir, 'temp'), // Temporary files
    ];

    for (const dir of directories) {
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          this.log('warn', `Failed to create directory: ${dir}`, error);
        }
      }
    }

    // Create .gitkeep files to preserve empty directories
    const keepDirs = [
      path.join(dataDir, 'db'),
      path.join(dataDir, 'appdata'),
      path.join(dataDir, 'logs', 'webapps'),
      path.join(dataDir, 'logs', 'caddy'),
      path.join(dataDir, 'appconf', 'caddy', 'webapps'),
      path.join(dataDir, 'appconf', 'caddy', 'hosts'),
      path.join(dataDir, 'backup'),
      path.join(dataDir, 'temp'),
    ];

    for (const dir of keepDirs) {
      const keepFile = path.join(dir, '.gitkeep');
      try {
        await fs.access(keepFile);
      } catch {
        try {
          await fs.writeFile(keepFile, '');
        } catch (error) {
          this.log('debug', `Failed to create .gitkeep in ${dir}`, error);
        }
      }
    }

    // Create required files
    await this.ensureFiles(dataDir);
  }

  private async ensureFiles(dataDir: string): Promise<void> {
    // 1. Create encryption.key if it doesn't exist
    const encryptionKeyPath = path.join(dataDir, 'drop-svc', 'encryption.key');
    try {
      await fs.access(encryptionKeyPath);
    } catch {
      try {
        // Generate a random 32-byte key (256-bit) encoded as hex
        const crypto = await import('crypto');
        const key = crypto.randomBytes(32).toString('hex');
        await fs.writeFile(encryptionKeyPath, key, { mode: 0o600 });
        this.log('info', 'Generated encryption key');
      } catch (error) {
        this.log('warn', 'Failed to create encryption.key', error);
      }
    }

    // 2. Create platform config (drop.yaml) if it doesn't exist
    const configPath = path.join(dataDir, 'appconf', 'drop.yaml');
    try {
      await fs.access(configPath);
    } catch {
      try {
        const initialConfig = `# DROP Platform Configuration
# Generated on ${new Date().toISOString()}

# Platform settings
platform:
  logLevel: info
  portRangeStart: 3001
  portRangeEnd: 3999

# Build settings
build:
  autoBuild: true
  autoStart: true

# Backup settings (optional)
backup:
  enabled: false
  interval: 60  # minutes
  retention: 7  # number of backups to keep
  compression: true
`;
        await fs.writeFile(configPath, initialConfig);
        this.log('info', 'Created platform configuration');
      } catch (error) {
        this.log('warn', 'Failed to create drop.yaml', error);
      }
    }

    // 3. Create or upgrade the managed Caddyfile.
    // We version it with a header so we can detect and regenerate stale configs
    // on upgrade (e.g. when docker mode is first enabled on an existing install).
    await this.ensureCaddyfile(dataDir);

    // 4. Create initial platform log file
    const platformLogPath = path.join(dataDir, 'logs', 'drop-svc', 'drop-svc.log');
    try {
      await fs.access(platformLogPath);
    } catch {
      try {
        const logHeader = `# DROP Platform Log\n# Started: ${new Date().toISOString()}\n`;
        await fs.writeFile(platformLogPath, logHeader);
      } catch (error) {
        this.log('debug', 'Failed to create platform log file', error);
      }
    }

    // 5. Create error log file
    const errorLogPath = path.join(dataDir, 'logs', 'drop-svc', 'drop-svc-error.log');
    try {
      await fs.access(errorLogPath);
    } catch {
      try {
        const logHeader = `# DROP Platform Error Log\n# Started: ${new Date().toISOString()}\n`;
        await fs.writeFile(errorLogPath, logHeader);
      } catch (error) {
        this.log('debug', 'Failed to create error log file', error);
      }
    }
  }

  /**
   * Managed Caddyfile versioning.
   *
   * Version header `# DROP Caddyfile v2` lets us detect stale configs written
   * by older DROP releases and regenerate them.  Regeneration only touches the
   * global options block and import lines — per-app *.caddy files are managed
   * separately and are never rewritten here.
   *
   * The critical change from v1→v2: when `enableHttps` is true and domainSuffix
   * is not localhost, we omit `auto_https off` so Caddy uses HTTP-01 ACME by
   * default instead of requiring manual cert configuration.
   */
  private readonly CADDYFILE_VERSION = '# DROP Caddyfile v2';

  private buildCaddyfileContent(dataDir: string): string {
    const isHttps = this.config.enableHttps && !isLocalhostDomain(this.config.domainSuffix || 'localhost');
    const logFile = path.join(dataDir, 'logs', 'caddy', 'access.log').replace(/\\/g, '/');
    const webappsImport = path.join(dataDir, 'appconf', 'caddy', 'webapps', '*.caddy').replace(/\\/g, '/');
    const hostsImport = path.join(dataDir, 'appconf', 'caddy', 'hosts', '*.caddy').replace(/\\/g, '/');

    const globalBlock = [
      `{`,
      ...(this.config.acmeEmail ? [`    email ${this.config.acmeEmail}`] : []),
      ...(this.config.acmeStaging ? [`    acme_ca https://acme-staging-v02.api.letsencrypt.org/directory`] : []),
      `    admin localhost:2019`,
      ...(!isHttps ? [`    auto_https off`] : []),
      `}`,
    ].join('\n');

    return [
      `${this.CADDYFILE_VERSION}`,
      `# Managed by DROP — do not edit by hand.`,
      `# Delete this file to reset to defaults.`,
      ``,
      globalBlock,
      ``,
      `# Logging`,
      `(drop_logging) {`,
      `    log {`,
      `        output file ${logFile} {`,
      `            roll_size 100mb`,
      `            roll_keep 10`,
      `        }`,
      `        format json`,
      `    }`,
      `}`,
      ``,
      `# Import app and host configurations`,
      `import ${webappsImport}`,
      `import ${hostsImport}`,
      ``,
    ].join('\n');
  }

  private async ensureCaddyfile(dataDir: string): Promise<void> {
    // The managed Caddyfile is fully derived from config (global options + the
    // fixed logging snippet + import lines). Regenerate whenever the on-disk
    // content differs from what we'd produce now — this covers a missing file,
    // a stale (pre-v2) config, AND config changes like toggling HTTPS or the
    // ACME email. Per-app and host *.caddy files are separate imports and are
    // never touched here, so a rewrite is safe. Comparing full content also
    // avoids needless rewrites (and Caddy reloads) when nothing has changed.
    const desired = this.buildCaddyfileContent(dataDir);
    let existing: string | null = null;
    try {
      existing = await fs.readFile(this.config.caddyfilePath, 'utf-8');
    } catch {
      // File doesn't exist yet — will be written below.
    }

    if (existing === desired) {
      return;
    }

    if (existing !== null && !existing.startsWith(this.CADDYFILE_VERSION)) {
      this.logger.info(
        'Upgrading Caddyfile to v2 (stale config detected)',
        'CADDY'
      );
    }

    try {
      await fs.writeFile(this.config.caddyfilePath, desired, 'utf-8');
      this.logger.info(`Caddyfile written at ${this.config.caddyfilePath}`, 'CADDY');
    } catch (error) {
      this.logger.warn('Failed to write Caddyfile', 'CADDY', error);
    }
  }

  private async initializeServices(): Promise<void> {
    // Initialize PostgreSQL server
    this.logger.info('Initializing PostgreSQL...', 'DATABASE');
    this.postgresServer = getPostgresServer({
      dropRoot: this.config.dropRoot,
      onLog: (msg) => this.logger.debug(msg, 'POSTGRES'),
      // In docker mode the socket is bind-mounted into containers; a trust
      // pg_hba would give containers unauthenticated superuser access.
      strictSecure: this.config.isolation === 'docker',
    });

    await this.postgresServer.ensureReady((msg) => {
      this.logger.info(msg, 'DATABASE');
    });

    await this.postgresServer.start();
    this.logger.info(`PostgreSQL running on port ${this.postgresServer.getPort()}`, 'DATABASE');

    // Initialize database provisioner
    this.dbProvisioner = new DatabaseProvisioner(this.postgresServer, this.config.dropRoot);
    await this.dbProvisioner.initialize();

    // Ensure internal database exists
    const internalDb = await this.dbProvisioner.ensureInternalDatabase();
    this.logger.info(`Internal database ready: ${internalDb.database}`, 'DATABASE');

    // Initialize state manager for app tracking
    const stateFilePath = path.join(this.config.dropRoot, 'data', 'drop-svc', 'apps.json');
    this.stateManager = getStateManager({ stateFilePath });
    await this.stateManager.initialize();
    this.logger.info('App state manager initialized', 'STATE');

    // Initialize app config service for per-app config files
    const appConfigDir = path.join(this.config.dropRoot, 'data', 'appconf', 'webapps');
    this.appConfigService = getAppConfigService({
      configDir: appConfigDir,
      webappsDir: this.config.appsDirectory,
    });
    await this.appConfigService.initialize();
    this.logger.info(`App config service initialized (${this.appConfigService.getAllConfigs().length} configs loaded)`, 'CONFIG');

    // Initialize secret manager for encrypted app secrets
    const secretStorePath = path.join(this.config.dropRoot, 'data', 'drop-svc', 'secrets.json');
    this.secretManager = getSecretManager({
      storePath: secretStorePath,
      masterKey: process.env.DROP_MASTER_KEY,
      // Fall back to the auto-generated encryption.key (0600, separate from
      // secrets.json) so secrets aren't encrypted with a key derived from
      // their own store file.
      masterKeyPath: path.join(this.config.dropRoot, 'data', 'drop-svc', 'encryption.key'),
    });
    await this.secretManager.initialize();
    this.logger.info('Secret manager initialized', 'SECURITY');

    // Initialize webhook manager
    const webhookStorePath = path.join(this.config.dropRoot, 'data', 'drop-svc', 'webhooks.json');
    this.webhookManager = getWebhookManager({ storePath: webhookStorePath });
    await this.webhookManager.initialize();
    this.logger.info('Webhook manager initialized', 'WEBHOOKS');

    // Initialize git deploy service
    this.gitDeployService = getGitDeployService({
      appsDirectory: this.config.appsDirectory,
    });
    await this.gitDeployService.initialize();

    // Initialize activity log
    const activityLogPath = path.join(this.config.dropRoot, 'data', 'drop-svc', 'activity-log.json');
    const activityLog = getActivityLog(activityLogPath);
    await activityLog.initialize();

    // Sync state manager with app configs (configs are source of truth for ports)
    await this.syncStateWithConfigs();

    // Initialize detector
    this.detector = getDetector();

    // Initialize builder
    this.builder = getBuilder();

    // Initialize build log service (persists per-deploy stdout/stderr to files)
    const buildLogsDir = path.join(this.config.dropRoot, 'data', 'logs', 'builds');
    this.buildLogService = getBuildLogService(buildLogsDir);

    // Initialize the app runtime — docker when isolation=docker, PM2 otherwise.
    this.runtime = getAppRuntime(this.config.isolation === 'docker' ? 'docker' : 'pm2');

    // Load used ports from existing PM2 processes
    await this.loadUsedPorts();

    // Sync state with actual running processes
    await this.syncStateWithProcesses();

    // Initialize router with HTTPS config
    this.router = getRouterService({
      caddy: {
        caddyfilePath: this.config.caddyfilePath,
        autoReload: true,
        acmeEmail: this.config.acmeEmail,
        acmeStaging: this.config.acmeStaging,
        enableAdminApi: true,
        adminApi: 'localhost:2019',
        dnsProvider: this.config.dnsProvider,
        wildcardCert: this.config.wildcardCert,
      },
    });

    // Initialize Caddy server (for hostname-based routing)
    this.caddyServer = getCaddyServer({
      dropRoot: this.config.dropRoot,
      caddyfilePath: this.config.caddyfilePath,
      onLog: (msg) => this.logger.debug(msg, 'CADDY'),
      onError: (msg) => {
        this.logger.warn(msg, 'CADDY');
        this.eventBus.publish('platform:error', {
          error: new Error(msg),
          context: 'caddy',
        });
      },
    });

    const caddyAvailable = await this.caddyServer.ensureReady((msg) => {
      this.logger.info(msg, 'CADDY');
    });

    if (caddyAvailable) {
      await this.caddyServer.start();
      this.logger.info(`Caddy server running on port ${this.caddyServer.getPort()}`, 'CADDY');
    } else {
      this.logger.warn('Caddy not available - apps accessible via direct ports only', 'CADDY');
    }

    // Initialize watcher (watches apps directory).
    // isAppLocked tells the watcher to silently drop rebuild events while a
    // deploy is in flight — important for Docker builds that can take minutes.
    this.watcher = new WatcherService({
      appsDir: this.config.appsDirectory,
      ignorePatterns: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      debounceMs: 1000,
      maxDepth: 2,
      isAppLocked: (name) => this.appsInProgress.has(name),
    });
  }

  /**
   * Start the REST API server
   */
  private async startApiServer(): Promise<void> {
    const credentialsPath = path.join(this.config.dropRoot, 'data', 'drop-svc', 'api-credentials.json');

    const logDir = path.join(this.config.dropRoot, 'data', 'logs');

    const masterKeyPath = path.join(this.config.dropRoot, 'data', 'drop-svc', 'encryption.key');

    this.apiServer = createApiServer({
      port: this.config.apiPort,
      host: '0.0.0.0',
      credentialsPath,
      enableAuth: this.config.enableApiAuth,
      allowSignup: this.config.allowSignup,
      enableHttps: this.config.enableHttps,
      domainSuffix: this.config.domainSuffix,
      logDir,
      appsDirectory: this.config.appsDirectory,
      masterKeyPath,
    });

    await this.apiServer.initialize();
    await this.apiServer.start();

    this.logger.info(`API server running on port ${this.config.apiPort}`, 'API');
    if (this.config.enableApiAuth) {
      this.logger.info('API authentication: ENABLED', 'API');
      await this.writeLocalCliKey();
    }
    this.logger.info(`Dashboard available at http://localhost:${this.config.apiPort}/dashboard`, 'API');
  }

  /**
   * Sync app state with actual running PM2 processes
   * Updates state for apps that were started/stopped outside DROP
   */
  private async syncStateWithProcesses(): Promise<void> {
    if (!this.runtime || !this.stateManager) return;

    try {
      const processes = await this.runtime.getAllStatus();
      const runningNames = new Set(processes.filter((p) => p.status === 'running').map((p) => p.name));

      // Update state for each tracked app
      for (const app of this.stateManager.getAllApps()) {
        const proc = processes.find((p) => p.name === app.name);

        if (proc && proc.status === 'running') {
          // App is running - update state
          await this.stateManager.setAppStatus(app.name, 'running', {
            port: proc.port ?? undefined,
            pid: proc.pid ?? undefined,
          });
        } else if (app.status === 'running' && !runningNames.has(app.name)) {
          // App was 'running' but its process is gone (platform/host restarted
          // out from under it). Mark 'pending' — NOT 'stopped' — so the
          // startup detection scan rebuilds and restarts it. User-stopped apps
          // are persisted as 'stopped' and are intentionally left alone.
          await this.stateManager.setAppStatus(app.name, 'pending');
        }
      }

      this.logger.info(`Synced state with ${processes.length} processes`, 'STATE');
    } catch (error) {
      this.logger.warn('Failed to sync state with processes', 'STATE', error);
    }
  }

  /**
   * On first boot in docker mode, stop any PM2-managed apps and mark their
   * appconf runtime as 'docker' so the watcher's startup scan rebuilds them as
   * containers instead of trying to start new processes against ports that PM2
   * still holds.
   */
  private async runFirstBootMigration(): Promise<void> {
    if (!this.appConfigService) return;

    const configs = this.appConfigService.getAllConfigs();
    const pm2Count = configs.filter((c) => (c.runtime ?? 'pm2') === 'pm2').length;
    if (pm2Count === 0) return;

    this.logger.info(
      `Docker mode: migrating ${pm2Count} PM2 app(s) to container runtime...`,
      'MIGRATE'
    );

    const results = await migrateAllToDocker(configs);
    for (const r of results) {
      if (r.error) {
        this.logger.warn(`Migration failed for ${r.appName}: ${r.error}`, 'MIGRATE');
      } else {
        this.logger.info(`Migrated ${r.appName}: pm2 → docker`, 'MIGRATE');
      }
    }
  }

  /**
   * Sync state manager with app config files
   * Config files are the source of truth for port assignments
   */
  private async syncStateWithConfigs(): Promise<void> {
    if (!this.appConfigService || !this.stateManager) return;

    const configs = this.appConfigService.getAllConfigs();
    for (const config of configs) {
      // Register app in state manager with preserved port
      await this.stateManager.registerApp(
        config.name,
        config.path || path.join(this.config.appsDirectory, config.name),
        config.type,
        config.framework
      );

      // Update with additional fields from config
      if (config.port || config.lastDeployedAt || config.buildDuration) {
        await this.stateManager.updateApp(config.name, {
          port: config.port,
          lastDeployedAt: config.lastDeployedAt,
          buildDuration: config.buildDuration,
        });
      }
    }

    if (configs.length > 0) {
      this.logger.info(`Synced ${configs.length} apps from config files`, 'CONFIG');
    }
  }

  private setupEventHandlers(): void {
    // When watcher detects a new directory, detect the app type
    const watcherSub = this.eventBus.subscribe('watcher:change', async (payload) => {
      if (payload.changeType === 'addDir' && this.isTopLevelApp(payload.path)) {
        const appName = path.basename(payload.path);
        // Skip apps currently being cloned by git deploy (race condition prevention)
        if (this.gitDeployService?.isCloning(appName)) {
          this.logger.debug(`Skipping watcher detection for ${appName} - git clone in progress`, 'GIT-DEPLOY');
          return;
        }
        await this.handleNewApp(payload.path);
      }
    });
    this.subscriptions.push(watcherSub);

    // When app is detected, create config and build it
    const detectedSub = this.eventBus.subscribe('app:detected', async (payload) => {
      // Skip apps currently being cloned
      if (this.gitDeployService?.isCloning(payload.name)) return;

      const appType = (payload.type || 'unknown') as 'nodejs' | 'python' | 'go' | 'static' | 'docker' | 'unknown';

      // Create or update app config file (source of truth)
      if (this.appConfigService) {
        await this.appConfigService.upsertConfig(payload.name, {
          type: appType,
          path: payload.path,
          hostname: `${payload.name}.localhost`,
        });
      }

      // Register in state manager
      if (this.stateManager) {
        await this.stateManager.registerApp(payload.name, payload.path, appType);
      }

      // Build the app if auto-build is enabled (skip if user stopped it)
      const currentApp = this.stateManager?.getApp(payload.name);
      if (this.config.autoBuild && payload.type !== 'unknown' && currentApp?.status !== 'stopped') {
        await this.handleBuildApp(payload.path, payload.name, payload.type as string);
      }
    });
    this.subscriptions.push(detectedSub);

    // When build completes, start the app (unless it failed or was stopped).
    // handleBuildApp keeps the app in appsInProgress through the build and
    // hands ownership to handleStartApp; every path here that does NOT start
    // the app must release the guard, or future hot-reloads dead-end forever.
    const buildSub = this.eventBus.subscribe('build:completed', async (payload) => {
      if (payload.success === false) {
        // Failed build — handleBuildApp already marked it errored and cleaned up.
        this.appsInProgress.delete(payload.appId);
        return;
      }

      const app = this.stateManager?.getApp(payload.appId);
      const shouldStart = this.config.autoStart && app?.status !== 'stopped';

      if (shouldStart) {
        await this.handleStartApp(payload.appId); // owns appsInProgress cleanup
      } else {
        if (app?.status === 'stopped') {
          this.logger.info(`Skipping auto-start for ${payload.appId} - app was stopped by user`, 'APP');
        }
        this.appsInProgress.delete(payload.appId);
      }
    });
    this.subscriptions.push(buildSub);

    // When app starts, configure routing
    const startedSub = this.eventBus.subscribe('app:started', async (payload) => {
      await this.handleConfigureRoute(payload.name, payload.port);
    });
    this.subscriptions.push(startedSub);

    // When app files are updated, rebuild and restart
    const updateSub = this.eventBus.subscribe('app:update', async (payload) => {
      // Skip apps currently being cloned
      if (this.gitDeployService?.isCloning(payload.name)) return;
      await this.handleAppUpdate(payload.name, payload.path, payload.reason);
    });
    this.subscriptions.push(updateSub);

    // Stop health probers when an app is explicitly stopped or removed
    const statusSub = this.eventBus.subscribe('app:updated', (payload) => {
      const status = (payload.changes as { status?: string })?.status;
      if (status === 'stopped' || status === 'errored') {
        this.stopHealthProber(payload.appId);
      }
    });
    this.subscriptions.push(statusSub);
  }

  /**
   * Check if an app needs a database by looking at detection result or common ORM config files
   */
  private async appNeedsDatabase(appPath: string, detectionDatabase?: boolean | string): Promise<boolean> {
    // If detection already found database requirement, use that
    if (detectionDatabase === true || detectionDatabase === 'postgres' || detectionDatabase === 'sqlite') {
      return true;
    }

    // Otherwise, check for common ORM config files
    const dbIndicators = [
      'prisma/schema.prisma',
      'drizzle.config.ts',
      'drizzle.config.js',
      'knexfile.js',
      'knexfile.ts',
      'ormconfig.json',
      'typeorm.config.ts',
      'sequelize.config.js',
      '.sequelizerc',
    ];

    for (const indicator of dbIndicators) {
      try {
        const filePath = path.join(appPath, indicator);
        await fs.access(filePath);
        return true; // ORM config file found
      } catch {
        // File doesn't exist, continue checking
      }
    }

    return false;
  }

  /**
   * Parse drop.yaml and resolve depends_on to get dependency URLs
   * Returns environment variables to inject based on dependent apps
   */
  private async resolveDependencies(appPath: string, appName: string): Promise<Record<string, string>> {
    const envVars: Record<string, string> = {};

    try {
      const dropYamlPath = path.join(appPath, 'drop.yaml');
      await fs.access(dropYamlPath);

      const content = await fs.readFile(dropYamlPath, 'utf-8');

      // Simple YAML parsing for depends_on section
      // Format:
      // depends_on:
      //   - name: todo-api
      //     env: API_URL
      const dependsOnMatch = content.match(/depends_on:\s*\n((?:\s+-[^\n]+\n?)+)/);
      if (!dependsOnMatch) return envVars;

      const dependsOnBlock = dependsOnMatch[1];
      const dependencies: Array<{ name: string; env: string }> = [];

      // Parse each dependency
      const depMatches = dependsOnBlock.matchAll(/-\s*name:\s*(\S+)\s*\n\s*env:\s*(\S+)/g);
      for (const match of depMatches) {
        dependencies.push({ name: match[1], env: match[2] });
      }

      // Resolve each dependency
      for (const dep of dependencies) {
        if (!this.stateManager) continue;

        const depApp = this.stateManager.getApp(dep.name);
        if (depApp && depApp.port) {
          const url = `http://localhost:${depApp.port}`;
          envVars[dep.env] = url;
          this.logger.info(`Resolved dependency ${dep.name} -> ${dep.env}=${url}`, 'DEPS');
        } else {
          this.logger.warn(`Dependency ${dep.name} not found or not running for ${appName}`, 'DEPS');
        }
      }
    } catch {
      // No drop.yaml or parsing error - not a problem
    }

    return envVars;
  }

  /**
   * Generate DROP config file for static apps with dependencies
   */
  private async generateStaticConfig(appPath: string, envVars: Record<string, string>): Promise<void> {
    if (Object.keys(envVars).length === 0) return;

    const configContent = `// DROP-generated configuration
// Auto-generated based on depends_on in drop.yaml
window.DROP_CONFIG = ${JSON.stringify(envVars, null, 2)};
`;

    const configPath = path.join(appPath, 'drop-config.js');
    await fs.writeFile(configPath, configContent);
    this.logger.info(`Generated drop-config.js for static app`, 'DEPS');
  }

  private isTopLevelApp(appPath: string): boolean {
    const relative = path.relative(this.config.appsDirectory, appPath);
    // Must be a direct child (no path separators), non-empty, and not a parent reference
    if (!relative || relative.includes(path.sep) || relative.startsWith('..')) {
      return false;
    }
    // Skip hidden directories and invalid names
    const basename = path.basename(appPath);
    if (basename.startsWith('.') || basename === 'node_modules') {
      return false;
    }
    return true;
  }

  private async handleNewApp(appPath: string): Promise<void> {
    const appName = path.basename(appPath);

    // Skip apps currently being cloned by git deploy
    if (this.gitDeployService?.isCloning(appName)) {
      this.logger.debug(`Skipping detection for ${appName} - git clone in progress`, 'GIT-DEPLOY');
      return;
    }

    this.logger.appEvent('detected', appName);

    if (!this.detector) return;

    try {
      const result = await this.detector.detect(appPath);
      this.logger.info(`Detected ${appName} as ${result.type} (confidence: ${result.confidence})`, 'DETECTOR');

      const appType = result.type as 'nodejs' | 'python' | 'go' | 'static' | 'docker' | 'unknown';

      // Create or update app config file (source of truth)
      if (this.appConfigService) {
        await this.appConfigService.upsertConfig(appName, {
          type: appType,
          framework: result.framework ?? undefined,
          path: appPath,
          hostname: `${appName}.localhost`,
        });
      }

      // Register app in state manager
      if (this.stateManager) {
        await this.stateManager.registerApp(
          appName,
          appPath,
          appType,
          result.framework ?? undefined
        );
      }
    } catch (error) {
      this.logger.error(`Failed to detect app type for ${appName}`, 'DETECTOR', error);
    }
  }

  private async handleBuildApp(appPath: string, appName: string, _appType: string): Promise<void> {
    if (!this.builder || !this.detector) return;

    // Skip if already processing this app
    if (this.appsInProgress.has(appName)) {
      this.logger.debug(`Skipping ${appName} - already in progress`, 'BUILD');
      return;
    }

    // Enforce global concurrent build limit.  The deploy cooldown will
    // re-trigger the build on the next file change once a slot opens.
    if (this.config.maxConcurrentBuilds > 0 &&
        this.appsInProgress.size >= this.config.maxConcurrentBuilds) {
      this.logger.warn(
        `Build queue full (${this.appsInProgress.size}/${this.config.maxConcurrentBuilds}), ` +
        `deferring ${appName}`,
        'BUILD'
      );
      return;
    }

    this.appsInProgress.add(appName);

    this.logger.appEvent('building', appName);

    // Update state to building
    if (this.stateManager) {
      await this.stateManager.setAppStatus(appName, 'building');
    }

    try {
      const detection = await this.detector.detect(appPath);
      const workDir = await this.getBuildWorkDir(appName);

      const execCommand =
        this.config.isolation === 'docker' && this.runtime?.type === 'docker'
          ? createContainerExecCommand(
              (this.runtime as import('../managers/runtime').ContainerManager).docker,
              detection.type,
              appName
            )
          : undefined;

      const buildStartedAt = new Date();
      const logId = this.buildLogService
        ? await this.buildLogService.startBuild(appName, buildStartedAt)
        : null;

      const result = await this.builder.build({
        appName,
        appPath,
        appType: detection.type,
        framework: detection.framework || null,
        config: {
          buildCommand: detection.suggestedConfig?.buildCommand,
          installCommand: detection.suggestedConfig?.installCommand,
        },
        env: {},
        workDir,
        execCommand,
        onBuildLog: logId && this.buildLogService
          ? (line) => this.buildLogService!.writeLine(logId, line)
          : undefined,
      });

      if (logId && this.buildLogService) {
        await this.buildLogService.finishBuild(logId, appName);
      }

      if (result.success) {
        this.appBuildDurations.set(appName, result.duration);
        this.logger.appEvent('built', appName, `completed in ${result.duration}ms`);
        // Update config and state with build duration
        if (this.appConfigService) {
          await this.appConfigService.updateConfig(appName, { buildDuration: result.duration });
        }
        if (this.stateManager) {
          await this.stateManager.updateApp(appName, { buildDuration: result.duration });
        }
      } else {
        this.logger.appEvent('error', appName, result.errors?.[0]?.message || 'Build failed');
        if (this.stateManager) {
          await this.stateManager.setAppStatus(appName, 'errored', {
            error: result.errors?.[0]?.message || 'Build failed',
          });
        }
        this.appsInProgress.delete(appName);
      }
    } catch (error) {
      this.logger.appEvent('error', appName, error instanceof Error ? error.message : 'Build failed');
      if (this.stateManager) {
        await this.stateManager.setAppStatus(appName, 'errored', {
          error: error instanceof Error ? error.message : 'Build failed',
        });
      }
      this.appsInProgress.delete(appName);
    }
  }

  private async handleStartApp(appName: string): Promise<void> {
    if (!this.runtime || !this.detector) return;

    const appPath = path.join(this.config.appsDirectory, appName);

    // Update state to starting
    if (this.stateManager) {
      await this.stateManager.setAppStatus(appName, 'starting');
    }

    try {
      // Capacity guard: reject the deploy if the global running-app cap is reached.
      if (this.config.maxConcurrentApps > 0 && this.stateManager) {
        const runningCount = this.stateManager.getAllApps().filter(
          (a) => a.status === 'running' || a.status === 'starting'
        ).length;
        if (runningCount >= this.config.maxConcurrentApps) {
          throw new Error(
            `App capacity reached (${runningCount}/${this.config.maxConcurrentApps} running). ` +
            `Stop an existing app before deploying a new one, or increase DROP_MAX_CONCURRENT_APPS.`
          );
        }
      }

      const detection = await this.detector.detect(appPath);
      const port = this.allocatePort(appName);

      this.logger.appEvent('starting', appName, `port ${port}`);

      // Persistent data dir must be ready before script determination so that
      // the docker+static path can write nginx.conf into it.
      const dataDir = await this.ensureAppDataDirectory(appName);
      this.logger.info(`Data directory: ${dataDir}`, 'DATA');

      // Check if app needs a database and provision one.
      let dbEnvVars: Record<string, string> = {};
      const needsDb = await this.appNeedsDatabase(appPath, detection.suggestedConfig?.database);
      if (this.dbProvisioner && needsDb) {
        const pgSocketDir =
          this.config.isolation === 'docker'
            ? (this.postgresServer?.getSocketDir() ?? undefined)
            : undefined;
        const dbOpts = pgSocketDir ? { pgSocketDir } : undefined;

        const appState = this.stateManager?.getApp(appName);
        const ownerUserId = appState?.userId;
        if (ownerUserId && this.config.maxDbsPerUser > 0) {
          const allApps = this.stateManager?.getAllApps() ?? [];
          const userDbCount = allApps.filter(
            (a) => a.userId === ownerUserId && this.dbProvisioner!.isProvisioned(a.name)
          ).length;
          if (userDbCount >= this.config.maxDbsPerUser) {
            this.logger.warn(
              `DB quota reached for user ${ownerUserId} (${userDbCount}/${this.config.maxDbsPerUser}), ` +
              `skipping database provisioning for ${appName}`,
              'DATABASE'
            );
          } else {
            this.logger.info(`Provisioning database for ${appName}...`, 'DATABASE');
            const dbCreds = await this.dbProvisioner.provisionAppDatabase(appName);
            dbEnvVars = this.dbProvisioner.getEnvVars(appName, dbOpts) || {};
            this.logger.info(`Database provisioned: ${dbCreds.database}`, 'DATABASE');
          }
        } else {
          this.logger.info(`Provisioning database for ${appName}...`, 'DATABASE');
          const dbCreds = await this.dbProvisioner.provisionAppDatabase(appName);
          dbEnvVars = this.dbProvisioner.getEnvVars(appName, dbOpts) || {};
          this.logger.info(`Database provisioned: ${dbCreds.database}`, 'DATABASE');
        }
      }

      const spec = await this.buildStartSpec(appName, appPath, detection, port, dataDir, dbEnvVars);
      const status = await this.runtime.start(spec);

      this.logger.appEvent('started', appName, `PID ${status.pid}, port ${port}`);

      // Save port and data directory to config file (source of truth for restarts)
      if (this.appConfigService) {
        await this.appConfigService.updateConfig(appName, {
          port,
          dataDir,
          lastDeployedAt: new Date().toISOString(),
        });
      }

      // Update state to running with port and pid
      if (this.stateManager) {
        await this.stateManager.setAppStatus(appName, 'running', {
          port,
          pid: status.pid ?? undefined,
        });
      }

      // App is fully deployed now - record deploy time for cooldown
      this.appDeployTimes.set(appName, Date.now());
      this.appsInProgress.delete(appName);

      // Start health prober in PM2 mode (Docker uses its own HEALTHCHECK mechanism)
      if (spec.healthCheckPath && this.runtime?.type === 'pm2') {
        this.startHealthProber(appName, port, spec.healthCheckPath);
      }
    } catch (error) {
      this.logger.appEvent('error', appName, error instanceof Error ? error.message : 'Failed to start');
      if (this.stateManager) {
        await this.stateManager.setAppStatus(appName, 'errored', {
          error: error instanceof Error ? error.message : 'Failed to start',
        });
      }
      this.appsInProgress.delete(appName);
    }
  }

  private async handleConfigureRoute(appName: string, port: number): Promise<void> {
    if (!this.router || !port) return;

    try {
      const domainSuffix = this.config.domainSuffix || 'localhost';
      const defaultHostname = `${appName}.${domainSuffix}`;

      // Parse drop.yaml for custom domains
      const appPath = path.join(this.config.appsDirectory, appName);
      const dropYaml = await parseDropYaml(appPath);

      // Get domains from drop.yaml or use default
      let domains: string[] = [defaultHostname];
      let customTls: { certFile?: string; keyFile?: string } | undefined;

      let hasCustomDomains = false;
      if (dropYaml.success && dropYaml.config) {
        if (dropYaml.config.domains && dropYaml.config.domains.length > 0) {
          domains = dropYaml.config.domains;
          hasCustomDomains = true;
          this.logger.info(`Custom domains requested for ${appName}: ${domains.join(', ')}`, 'ROUTER');
        }

        // Check for custom TLS config
        if (dropYaml.config.tls) {
          if (dropYaml.config.tls.disabled) {
            this.logger.info(`TLS disabled for ${appName} via drop.yaml`, 'ROUTER');
          } else if (dropYaml.config.tls.certFile && dropYaml.config.tls.keyFile) {
            customTls = {
              certFile: dropYaml.config.tls.certFile,
              keyFile: dropYaml.config.tls.keyFile,
            };
            this.logger.info(`Custom TLS certificates configured for ${appName}`, 'ROUTER');
          }
        }
      }

      // Cross-tenant hostname guard: reject any custom domain already claimed by
      // a *different* app before it reaches Caddy. Without this, a tenant's
      // drop.yaml could claim another app's hostname/domain and hijack its
      // traffic, or introduce a duplicate site address that wedges Caddy's
      // config reload for the whole box. The app always keeps its own default
      // hostname (never filtered), so it stays reachable even if every custom
      // domain is refused.
      let acceptedCustomDomains: string[] = [];
      if (hasCustomDomains && this.appConfigService) {
        const owners = this.appConfigService.getDomainOwners(domainSuffix);
        acceptedCustomDomains = domains.filter((d) => {
          const owner = owners.get(d.toLowerCase());
          if (owner && owner !== appName) {
            this.logger.warn(
              `Refusing domain '${d}' for ${appName}: already claimed by '${owner}'`,
              'ROUTER'
            );
            return false;
          }
          return true;
        });
        domains = acceptedCustomDomains.length > 0 ? acceptedCustomDomains : [defaultHostname];

        // Persist only the accepted domains as the source of truth — never the
        // raw, possibly-hijacking request.
        await this.appConfigService.updateConfig(appName, {
          domains: acceptedCustomDomains,
          tls: dropYaml.config?.tls,
        });
      }

      // In docker (multi-user) mode inject security headers on all tenant routes.
      // Shared-domain isolation honest note: subdomains of one registrable domain
      // are same-site — these headers mitigate clickjacking and MIME sniffing but
      // do NOT provide full origin isolation (that requires separate domains).
      const tenantSecurityHeaders: Record<string, string> | undefined =
        this.config.isolation === 'docker'
          ? {
              'X-Frame-Options': 'SAMEORIGIN',
              'X-Content-Type-Options': 'nosniff',
              'Referrer-Policy': 'strict-origin-when-cross-origin',
              'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
            }
          : undefined;

      // Configure route for each domain
      for (const hostname of domains) {
        const isLocalhost = isLocalhostDomain(hostname);
        const enableSsl = this.config.enableHttps && !isLocalhost && !dropYaml.config?.tls?.disabled;

        await this.router.addRoute({
          appName: `${appName}-${hostname.replace(/\./g, '-')}`, // Unique route name per domain
          hostname,
          upstream: `localhost:${port}`,
          ssl: enableSsl,
          redirectHttps: enableSsl,
          tls: customTls
            ? { certFile: customTls.certFile, keyFile: customTls.keyFile }
            : (enableSsl ? { auto: true } : undefined),
          headers: tenantSecurityHeaders,
        });

        const protocol = enableSsl ? 'https' : 'http';
        const caddyAvailable = this.caddyServer?.getStatus() === 'running';

        if (caddyAvailable) {
          this.logger.info(`Route configured: ${protocol}://${hostname} -> localhost:${port}`, 'ROUTER');
        } else {
          this.logger.info(`Route configured: localhost:${port} (Caddy unavailable for ${hostname})`, 'ROUTER');
        }
      }

      // Reload Caddy to apply new routes
      if (this.caddyServer && this.caddyServer.getStatus() === 'running') {
        await this.caddyServer.reload();
      }
    } catch (error) {
      // Surface at error level: a failed reload means this (and every
      // subsequent) route change silently stops applying until an operator
      // intervenes — not a benign "route already exists".
      this.logger.error(`Failed to configure route for ${appName}`, 'ROUTER', error);
    }
  }

  /**
   * Handle app update events (file changes in existing apps)
   * Stops the running process, rebuilds, and restarts on the same port
   */
  private async handleAppUpdate(appName: string, appPath: string, reason: string): Promise<void> {
    if (!this.runtime || !this.stateManager || !this.detector || !this.builder) return;

    // Skip apps currently being cloned by git deploy
    if (this.gitDeployService?.isCloning(appName)) return;

    // Skip if already processing this app (e.g., during initial deployment)
    if (this.appsInProgress.has(appName)) {
      this.logger.debug(`Skipping update for ${appName} - already in progress`, 'UPDATE');
      return;
    }

    // Skip if app was just deployed (adaptive cooldown to prevent loops).
    // The window is max(5s, lastBuildDuration * 2) so Docker builds that take
    // minutes don't immediately re-trigger from their own output files.
    const lastDeployTime = this.appDeployTimes.get(appName);
    if (lastDeployTime && Date.now() - lastDeployTime < this.getEffectiveCooldownMs(appName)) {
      this.logger.debug(`Skipping update for ${appName} - within cooldown period`, 'UPDATE');
      return;
    }

    const appState = this.stateManager.getApp(appName);
    if (!appState) {
      // App not yet registered - this can happen during initial deployment
      // when file changes are detected before app:detected is fully processed
      this.logger.debug(`Skipping update for ${appName} - not yet registered`, 'UPDATE');
      return;
    }

    // A user-stopped app must not be resurrected by a file-change hot-reload.
    // Every other deploy path guards on this (detectedSub, buildSub); without
    // it, any edit or touch to a stopped app's files (git pull, editor
    // autosave) silently rebuilds and restarts it against the user's explicit
    // `drop stop`.
    if (appState.status === 'stopped') {
      this.logger.debug(`Skipping update for ${appName} - app was stopped by user`, 'UPDATE');
      return;
    }

    // Remember the current port and whether the app was running
    const originalPort = appState.port;
    const wasRunning = appState.status === 'running';

    this.logger.info(`Hot-reload triggered for ${appName}: ${reason}`, 'UPDATE');
    this.appsInProgress.add(appName);

    try {
      // M5.1 deploy transaction: keep old version serving while the new build
      // runs. Only stop the old process after a successful build — on failure,
      // restore the `running` status so the old version stays live.
      await this.stateManager.setAppStatus(appName, 'building');

      // Re-detect and rebuild the app
      const detection = await this.detector.detect(appPath);
      const workDir = await this.getBuildWorkDir(appName);
      const updateLogId = this.buildLogService
        ? await this.buildLogService.startBuild(appName, new Date())
        : null;
      const buildResult = await this.builder.build({
        appName,
        appPath,
        appType: detection.type,
        framework: detection.framework || null,
        config: {
          buildCommand: detection.suggestedConfig?.buildCommand,
          installCommand: detection.suggestedConfig?.installCommand,
        },
        env: {},
        workDir,
        onBuildLog: updateLogId && this.buildLogService
          ? (line) => this.buildLogService!.writeLine(updateLogId, line)
          : undefined,
      });
      if (updateLogId && this.buildLogService) {
        await this.buildLogService.finishBuild(updateLogId, appName);
      }

      if (!buildResult.success) {
        const buildError = buildResult.errors?.[0]?.message || 'Rebuild failed';
        this.logger.appEvent('error', appName, buildError);
        // Old process is still running — restore status and surface the error
        // so the dashboard shows it without taking down the live service.
        if (wasRunning) {
          await this.stateManager.setAppStatus(appName, 'running', {
            port: originalPort,
            error: `Build failed: ${buildError}`,
          });
        } else {
          await this.stateManager.setAppStatus(appName, 'errored', { error: buildError });
        }
        this.appsInProgress.delete(appName);
        return;
      }

      // Build succeeded — now stop the old version and swap in the new one
      if (wasRunning) {
        this.logger.info(`Stopping ${appName} to swap in new build...`, 'UPDATE');
        this.stopHealthProber(appName);
        await this.runtime.stop(appName);
        if (originalPort) {
          this.usedPorts.delete(originalPort);
        }
      }

      this.appBuildDurations.set(appName, buildResult.duration);
      this.logger.appEvent('built', appName, `rebuilt in ${buildResult.duration}ms`);

      // 4. Restart the app on the same port (or allocate new if none)
      const port = originalPort ?? this.allocatePort(appName);
      this.usedPorts.set(port, appName);

      await this.stateManager.setAppStatus(appName, 'starting');

      // Ensure data directory exists (preserved across upgrades)
      const dataDir = await this.ensureAppDataDirectory(appName);

      // Get env vars for an already-provisioned DB (no new provisioning on hot-reload).
      let dbEnvVars: Record<string, string> = {};
      if (this.dbProvisioner) {
        const pgSocketDir =
          this.config.isolation === 'docker'
            ? (this.postgresServer?.getSocketDir() ?? undefined)
            : undefined;
        dbEnvVars = this.dbProvisioner.getEnvVars(
          appName,
          pgSocketDir ? { pgSocketDir } : undefined
        ) || {};
      }

      const spec = await this.buildStartSpec(appName, appPath, detection, port, dataDir, dbEnvVars);
      const status = await this.runtime.start(spec);

      this.logger.appEvent('started', appName, `PID ${status.pid}, port ${port} (hot-reloaded)`);

      await this.stateManager.setAppStatus(appName, 'running', {
        port,
        pid: status.pid ?? undefined,
      });

      // Record deploy time for cooldown
      this.appDeployTimes.set(appName, Date.now());
      this.appsInProgress.delete(appName);
    } catch (error) {
      this.logger.appEvent('error', appName, error instanceof Error ? error.message : 'Hot-reload failed');
      await this.stateManager.setAppStatus(appName, 'errored', {
        error: error instanceof Error ? error.message : 'Hot-reload failed',
      });
      this.appsInProgress.delete(appName);
    }
  }

  /**
   * Return (and create) the scratch directory for a build's ephemeral
   * artifacts.  Lives at data/temp/{appName}/ — well outside the watched
   * webapps directory, so the watcher never sees build-context tarballs,
   * generated Dockerfiles, layer caches, or any other temp output.
   */
  private async getBuildWorkDir(appName: string): Promise<string> {
    const workDir = path.join(this.config.dropRoot, 'data', 'temp', appName);
    await fs.mkdir(workDir, { recursive: true });
    return workDir;
  }

  /**
   * Compute the effective post-deploy quiet window for an app.
   * The adaptive formula prevents a slow Docker build from triggering an
   * immediate re-build caused by its own output files, while still allowing
   * fast hot-reloads for quick builds.
   */
  private getEffectiveCooldownMs(appName: string): number {
    const last = this.appBuildDurations.get(appName) ?? 0;
    return Math.min(
      this.DEPLOY_COOLDOWN_MS_MAX,
      Math.max(this.DEPLOY_COOLDOWN_MS_MIN, last * 2)
    );
  }

  /**
   * Periodically probe an app's health endpoint (PM2 mode).
   * After 3 consecutive failures, restarts the app.
   * Docker mode handles health checks via the container HEALTHCHECK directive.
   */
  private startHealthProber(appName: string, port: number, healthPath: string): void {
    this.stopHealthProber(appName); // clear any previous prober
    let failures = 0;
    const interval = setInterval(async () => {
      try {
        const http = await import('http');
        const ok = await new Promise<boolean>((resolve) => {
          const req = http.get(
            { hostname: '127.0.0.1', port, path: healthPath, timeout: 5000 },
            (res) => resolve(res.statusCode !== undefined && res.statusCode < 400)
          );
          req.on('error', () => resolve(false));
          req.on('timeout', () => { req.destroy(); resolve(false); });
        });
        if (ok) {
          failures = 0;
        } else {
          failures++;
          this.logger.warn(`Health check failed for ${appName} (${failures}/3)`, 'HEALTH');
          if (failures >= 3 && this.runtime) {
            failures = 0;
            this.logger.appEvent('error', appName, 'health check failed — restarting');
            this.runtime.restart(appName).catch(() => undefined);
          }
        }
      } catch {
        // Ignore errors in the prober itself
      }
    }, 30_000);
    interval.unref?.();
    this.healthProbers.set(appName, interval);
  }

  private stopHealthProber(appName: string): void {
    const t = this.healthProbers.get(appName);
    if (t) {
      clearInterval(t);
      this.healthProbers.delete(appName);
    }
  }

  /**
   * Build the runtime-agnostic start specification for an app.  Called by both
   * handleStartApp (on first deploy) and handleUpdateApp (on hot-reload) so the
   * two paths can't drift apart.
   *
   * DB env vars are passed in by the caller: handleStartApp provisions the DB
   * first and passes the resulting vars; handleUpdateApp fetches the existing
   * vars for an already-provisioned DB.
   */
  private async buildStartSpec(
    appName: string,
    appPath: string,
    detection: DetectionResult,
    port: number,
    dataDir: string,
    dbEnvVars: Record<string, string>
  ): Promise<AppStartSpec> {
    let script: string;
    let interpreter: string | undefined;
    let args: string[] | undefined;

    if (detection.type === 'static' || detection.type === 'spa') {
      if (this.config.isolation === 'docker') {
        const outputSubdir = detection.suggestedConfig?.outputDirectory || '';
        const nginxConf = buildNginxConf(port, outputSubdir);
        const nginxConfPath = path.join(dataDir, 'nginx.conf');
        await fs.writeFile(nginxConfPath, nginxConf, 'utf-8');
        this.logger.info(`Wrote nginx.conf for ${appName} → port ${port}`, 'STATIC');

        script = '/bin/sh';
        interpreter = 'none';
        args = [
          '-c',
          `cp ${nginxConfPath} /etc/nginx/conf.d/default.conf && nginx -g 'daemon off;'`,
        ];
      } else {
        const serveDir = path.join(appPath, detection.suggestedConfig?.outputDirectory || '.');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fsSync = require('fs');
        const distPath = path.join(__dirname, '..', '..', 'dist', 'core', 'static-server.js');
        const localPath = path.join(__dirname, 'static-server.js');
        script = fsSync.existsSync(localPath)
          ? localPath
          : fsSync.existsSync(distPath)
          ? distPath
          : localPath;
        args = [serveDir, '-s'];
      }
    } else if (detection.type === 'go') {
      const startCommand = detection.suggestedConfig?.startCommand || `./${appName}`;
      script = startCommand;
      interpreter = 'none';
    } else {
      const startCommand = detection.suggestedConfig?.startCommand || 'node index.js';
      script = startCommand.startsWith('node ')
        ? startCommand.substring(5)
        : startCommand;
    }

    const depEnvVars = await this.resolveDependencies(appPath, appName);

    if (
      (detection.type === 'static' || detection.type === 'spa') &&
      Object.keys(depEnvVars).length > 0
    ) {
      await this.generateStaticConfig(appPath, depEnvVars);
    }

    let secretEnvVars: Record<string, string> = {};
    if (this.secretManager && this.secretManager.hasSecrets(appName)) {
      secretEnvVars = this.secretManager.getAll(appName);
      this.logger.info(`Injecting ${Object.keys(secretEnvVars).length} secret(s)`, 'SECURITY');
    }

    const dropYaml = await parseDropYaml(appPath);
    const healthCheckPath = dropYaml.success ? dropYaml.config?.healthCheck : undefined;

    const { outFile, errorFile } = await this.getAppLogPaths(appName);

    // In docker mode, pass the Postgres socket dir so ContainerManager can
    // bind-mount it; containers connect via unix socket instead of TCP.
    const pgSocketDir =
      this.config.isolation === 'docker'
        ? (this.postgresServer?.getSocketDir() ?? undefined)
        : undefined;

    // Optional per-app resource caps. Only set when an operator has configured
    // them (> 0), so we never silently kill an existing PM2 app or override
    // docker's own 256 MB / 0.5-core container defaults. When set, PM2 honors
    // `memory` (via max_memory_restart); docker honors both `memory` and `cpus`.
    const memory =
      this.config.maxMemoryMbPerApp > 0 ? `${this.config.maxMemoryMbPerApp}M` : undefined;
    const cpus = this.config.maxCpusPerApp > 0 ? this.config.maxCpusPerApp : undefined;
    const limits = memory !== undefined || cpus !== undefined ? { memory, cpus } : undefined;

    return {
      name: appName,
      script,
      interpreter,
      args,
      cwd: appPath,
      port,
      outFile,
      errorFile,
      appType: detection.type,
      healthCheckPath,
      pgSocketDir,
      limits,
      env: {
        ...secretEnvVars,
        NODE_ENV: 'production',
        PORT: port.toString(),
        DROP_DATA_DIR: dataDir,
        ...dbEnvVars,
        ...depEnvVars,
      },
    };
  }

  private async getAppLogPaths(appName: string): Promise<{ outFile: string; errorFile: string; logDir: string }> {
    const logDir = path.join(this.config.dropRoot, 'data', 'logs', 'webapps', appName);

    // Ensure log directory exists
    try {
      await fs.mkdir(logDir, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        this.logger.warn(`Failed to create log directory for ${appName}`, 'LOGS', error);
      }
    }

    // Format: appName-YYYY-MM-DD-out.log
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const outFile = path.join(logDir, `${appName}-${today}-out.log`);
    const errorFile = path.join(logDir, `${appName}-${today}-err.log`);

    return { outFile, errorFile, logDir };
  }

  /**
   * Ensure a persistent data directory exists for an app.
   * This directory survives app upgrades (source code replacements).
   * Returns the absolute path to the app's data directory.
   */
  private async ensureAppDataDirectory(appName: string): Promise<string> {
    const dataDir = path.join(this.config.dropRoot, 'data', 'appdata', appName);

    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        this.logger.warn(`Failed to create data directory for ${appName}`, 'DATA', error);
      }
    }

    // Create common subdirectories that apps often need
    const commonSubdirs = ['uploads', 'logs', 'cache'];
    for (const subdir of commonSubdirs) {
      try {
        await fs.mkdir(path.join(dataDir, subdir), { recursive: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          this.logger.debug(`Failed to create ${subdir} subdirectory for ${appName}`, 'DATA');
        }
      }
    }

    // In docker isolation mode the container runs as a non-root user (e.g. UID
    // 1000 'node' in node:20-slim).  Make the data dir world-writable so the
    // container user can write to it without a chown step.  This is acceptable
    // because the dir is only bind-mounted into this app's own container; Tier B
    // will tighten this with explicit UID alignment.
    if (this.config.isolation === 'docker') {
      try {
        await fs.chmod(dataDir, 0o777);
        for (const subdir of commonSubdirs) {
          await fs.chmod(path.join(dataDir, subdir), 0o777).catch(() => {});
        }
      } catch {
        this.logger.warn(`Could not chmod data directory for ${appName}`, 'DATA');
      }
    }

    return dataDir;
  }

  /**
   * Allocate a port for an app
   * If the app already has a port in config/state and it's available, reuse it
   * Otherwise allocate a new port from the configured range
   */
  private allocatePort(appName?: string): number {
    // Check if app already has a port assigned in config file (source of truth)
    if (appName && this.appConfigService) {
      const config = this.appConfigService.getConfig(appName);
      if (config?.port) {
        const portOwner = this.usedPorts.get(config.port);
        // Allow reuse if port is free OR owned by the same app
        if (!portOwner || portOwner === appName) {
          this.logger.debug(`Reusing port ${config.port} for ${appName} (from config)`, 'PORT');
          this.usedPorts.set(config.port, appName);
          return config.port;
        }
        this.logger.debug(`Port ${config.port} for ${appName} is used by ${portOwner}, allocating new`, 'PORT');
      }
    }

    // Fallback: check state manager
    if (appName && this.stateManager) {
      const appState = this.stateManager.getApp(appName);
      if (appState?.port) {
        const portOwner = this.usedPorts.get(appState.port);
        // Allow reuse if port is free OR owned by the same app
        if (!portOwner || portOwner === appName) {
          this.logger.debug(`Reusing port ${appState.port} for ${appName} (from state)`, 'PORT');
          this.usedPorts.set(appState.port, appName);
          return appState.port;
        }
        this.logger.debug(`Port ${appState.port} for ${appName} is used by ${portOwner}, allocating new`, 'PORT');
      }
    }

    // Allocate a new port
    while (this.usedPorts.has(this.nextPort) && this.nextPort <= this.config.portRangeEnd) {
      this.nextPort++;
    }

    if (this.nextPort > this.config.portRangeEnd) {
      throw new Error('No available ports in configured range');
    }

    const port = this.nextPort;
    if (appName) {
      this.usedPorts.set(port, appName);
    } else {
      this.usedPorts.set(port, '__anonymous__');
    }
    this.nextPort++;
    return port;
  }

  releasePort(port: number): void {
    this.usedPorts.delete(port);
  }

  /**
   * Load used ports from config files, state manager, and PM2 processes
   * This ensures we don't allocate ports that are already in use
   * Priority: Config files (source of truth) > PM2 running processes > State manager
   */
  private async loadUsedPorts(): Promise<void> {
    const portSources: Map<number, string> = new Map();

    // 1. Load from app config files (source of truth for port assignments)
    if (this.appConfigService) {
      for (const config of this.appConfigService.getAllConfigs()) {
        if (config.port) {
          portSources.set(config.port, config.name);
          this.logger.debug(`Port ${config.port} assigned to ${config.name} (from config)`, 'PORT');
        }
      }
    }

    // 2. Load from state manager (fallback for apps not yet in config)
    if (this.stateManager) {
      for (const app of this.stateManager.getAllApps()) {
        if (app.port && !portSources.has(app.port)) {
          portSources.set(app.port, app.name);
          this.logger.debug(`Port ${app.port} assigned to ${app.name} (from state)`, 'PORT');
        }
      }
    }

    // 3. Load from PM2 (actually running processes)
    //    These take precedence as they represent the current runtime state
    if (this.runtime) {
      try {
        const processes = await this.runtime.getAllStatus();
        for (const proc of processes) {
          if (proc.port && proc.status === 'running') {
            portSources.set(proc.port, proc.name);
            this.logger.debug(`Port ${proc.port} in use by ${proc.name} (from PM2)`, 'PORT');
          }
        }
      } catch (error) {
        this.logger.warn('Failed to load used ports from PM2', 'PORT', error);
      }
    }

    // Add all ports to usedPorts with their owning app name
    for (const [port, appName] of portSources.entries()) {
      this.usedPorts.set(port, appName);
    }

    // Find the highest used port to set nextPort correctly
    if (this.usedPorts.size > 0) {
      const maxPort = Math.max(...this.usedPorts.keys());
      if (maxPort >= this.nextPort) {
        this.nextPort = maxPort + 1;
      }
    }

    this.logger.info(`Loaded ${this.usedPorts.size} used ports from running apps and state`, 'PORT');
  }

  /** @deprecated Use this.logger instead */
  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, error?: unknown): void {
    this.logger.log(level, message, undefined, error);
  }

  /**
   * Start certificate expiry monitoring
   * Checks every 24 hours for expiring certificates
   */
  private startCertificateMonitoring(): void {
    this.logger.info('Starting certificate expiry monitoring (24h interval)', 'CERTS');

    // Run an initial check
    this.checkCertificateExpiry().catch(err => {
      this.logger.warn('Initial certificate check failed', 'CERTS', err);
    });

    // Schedule periodic checks. unref() so this background timer never keeps
    // the process (or a Jest worker) alive on its own.
    this.certExpiryTimer = setInterval(() => {
      this.checkCertificateExpiry().catch(err => {
        this.logger.warn('Certificate expiry check failed', 'CERTS', err);
      });
    }, this.CERT_CHECK_INTERVAL_MS);
    this.certExpiryTimer.unref?.();
  }

  /**
   * Check for expiring certificates and log warnings
   */
  private async checkCertificateExpiry(): Promise<void> {
    if (!this.caddyServer || this.caddyServer.getStatus() !== 'running') {
      return;
    }

    try {
      const expiringCerts = await this.caddyServer.getExpiringCertificates(7);

      if (expiringCerts.length > 0) {
        this.logger.warn(`${expiringCerts.length} certificate(s) expiring within 7 days:`, 'CERTS');
        for (const cert of expiringCerts) {
          const message = cert.daysUntilExpiry <= 0
            ? `  - ${cert.domain}: EXPIRED`
            : `  - ${cert.domain}: expires in ${cert.daysUntilExpiry} days`;
          this.logger.warn(message, 'CERTS');
        }

        // Publish event for monitoring integrations
        this.eventBus.publish('platform:warning' as never, {
          type: 'certificate_expiry',
          certificates: expiringCerts.map(c => ({
            domain: c.domain,
            daysUntilExpiry: c.daysUntilExpiry,
            status: c.status,
          })),
        } as never);
      } else {
        this.logger.debug('All certificates are healthy', 'CERTS');
      }
    } catch (err) {
      this.logger.log('debug', 'Could not check certificate expiry', 'CERTS', err);
    }
  }

  /**
   * Validate domain configuration for HTTPS
   * Called before starting services when HTTPS is enabled
   */
  private async validateDomainConfig(): Promise<void> {
    const domainSuffix = this.config.domainSuffix;

    if (!domainSuffix) {
      return;
    }

    // Skip validation for localhost (HTTPS will be disabled anyway)
    if (isLocalhostDomain(domainSuffix)) {
      this.logger.info('Localhost domain - HTTPS will use self-signed certificates or be disabled', 'HTTPS');
      return;
    }

    // Validate domain format
    if (!validateDomainFormat(domainSuffix)) {
      throw new Error(`Invalid domain format: ${domainSuffix}`);
    }

    this.logger.info(`Validating domain: ${domainSuffix}`, 'HTTPS');

    // Perform full domain validation
    const validation = await validateDomain(domainSuffix);

    // Log errors (blocking)
    for (const error of validation.errors) {
      this.logger.error(error, 'HTTPS');
      throw new Error(error);
    }

    // Log warnings (non-blocking)
    for (const warning of validation.warnings) {
      this.logger.warn(warning, 'HTTPS');
    }

    // Log HTTPS configuration
    this.logger.info(`HTTPS enabled for *.${domainSuffix}`, 'HTTPS');

    if (this.config.acmeEmail) {
      this.logger.info(`ACME email: ${this.config.acmeEmail}`, 'HTTPS');
    } else {
      this.logger.warn('No ACME email configured - certificate notifications will not be sent', 'HTTPS');
    }

    if (this.config.acmeStaging) {
      this.logger.info('Using ACME staging environment (Let\'s Encrypt testing)', 'HTTPS');
    }

    if (this.config.wildcardCert) {
      if (!this.config.dnsProvider) {
        this.logger.warn('Wildcard certificate requested but no DNS provider configured', 'HTTPS');
        this.logger.warn('Wildcard certificates require DNS-01 challenge via --dns-provider', 'HTTPS');
      } else {
        this.logger.info(`Wildcard certificate using ${this.config.dnsProvider} DNS challenge`, 'HTTPS');
      }
    }
  }

  // Public accessors
  getEventBus(): EventBus {
    return this.eventBus;
  }

  getConfig(): PlatformConfig {
    return { ...this.config };
  }

  getWatcher(): WatcherService | null {
    return this.watcher;
  }

  getDetector(): DetectorService | null {
    return this.detector;
  }

  getBuilder(): BuilderService | null {
    return this.builder;
  }

  getRuntime(): AppRuntime | null {
    return this.runtime;
  }

  /** @deprecated Use getRuntime() — kept for callers from the PM2-only era */
  getProcessManager(): AppRuntime | null {
    return this.runtime;
  }

  /**
   * Generate a fresh admin API key for local CLI use and write it to
   * data/drop-svc/local.key (mode 0600) so CLI commands can authenticate
   * without requiring the user to set DROP_API_KEY manually.
   * Called once per platform startup when auth is enabled.
   */
  private async writeLocalCliKey(): Promise<void> {
    try {
      const keyPath = path.join(this.config.dropRoot, 'data', 'drop-svc', 'local.key');
      await deleteApiKeysByName('cli-local');
      const { key } = await createApiKey('cli-local', 'admin');
      await fs.writeFile(keyPath, key, { encoding: 'utf-8', mode: 0o600 });
      this.logger.info('Local CLI auth key written', 'API');
    } catch (err) {
      this.logger.warn(
        `Could not write local CLI key: ${err instanceof Error ? err.message : String(err)}`,
        'API'
      );
    }
  }

  getRouter(): RouterService | null {
    return this.router;
  }

  getStateManager(): AppStateManager | null {
    return this.stateManager;
  }

  getAppConfigService(): AppConfigService | null {
    return this.appConfigService;
  }

  getPostgresServer(): PostgresServer | null {
    return this.postgresServer;
  }

  getDatabaseProvisioner(): DatabaseProvisioner | null {
    return this.dbProvisioner;
  }

  getCaddyServer(): CaddyServer | null {
    return this.caddyServer;
  }

  isActive(): boolean {
    return this.isRunning;
  }
}

// Factory function
export function createPlatform(config?: Partial<PlatformConfig>): DropPlatform {
  return new DropPlatform(config);
}
