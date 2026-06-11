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
import { DetectorService, getDetector, parseDropYaml } from './detector';
import { BuilderService, getBuilder } from './builder';
import { RouterService, getRouterService, resetRouterService } from './router';
import { ProcessManager, getProcessManager, resetProcessManager } from '../managers/process';
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
};

export class DropPlatform {
  private readonly config: PlatformConfig;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;

  private watcher: WatcherService | null = null;
  private detector: DetectorService | null = null;
  private builder: BuilderService | null = null;
  private processManager: ProcessManager | null = null;
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

  private subscriptions: Unsubscribe[] = [];
  private isRunning = false;
  private nextPort: number;
  private usedPorts: Map<number, string> = new Map(); // port -> appName ownership
  private appsInProgress: Set<string> = new Set(); // Track apps being built/started
  private appDeployTimes: Map<string, number> = new Map(); // Track when apps were last deployed
  private readonly DEPLOY_COOLDOWN_MS = 5000; // Ignore updates within 5s of deploy
  private certExpiryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly CERT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
      // Validate domain configuration if HTTPS is enabled
      if (this.config.enableHttps && this.config.domainSuffix) {
        await this.validateDomainConfig();
      }

      // Ensure required directories exist
      await this.ensureDirectories();

      // Enable file logging now that directories exist
      const logDir = path.join(this.config.dropRoot, 'data', 'logs', 'drop-svc');
      this.logger.enableFileLogging(logDir);

      // Initialize services
      await this.initializeServices();

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

    if (this.processManager) {
      this.processManager.disconnect();
      resetProcessManager();
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

    // Reset secret manager, webhook manager, and git deploy service
    resetSecretManager();
    resetWebhookManager();
    resetGitDeployService();
    resetActivityLog();

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

    // 3. Create initial Caddyfile if it doesn't exist
    try {
      await fs.access(this.config.caddyfilePath);
    } catch {
      try {
        const initialCaddyfile = `# DROP Platform Caddyfile
# Auto-generated - routes are added automatically when apps are deployed

# Global options
{
    auto_https off
    admin off
}

# Logging
(drop_logging) {
    log {
        output file ${path.join(dataDir, 'logs', 'caddy', 'access.log').replace(/\\/g, '/')} {
            roll_size 100mb
            roll_keep 10
        }
        format json
    }
}

# Import app and host configurations
import ${path.join(dataDir, 'appconf', 'caddy', 'webapps', '*.caddy').replace(/\\/g, '/')}
import ${path.join(dataDir, 'appconf', 'caddy', 'hosts', '*.caddy').replace(/\\/g, '/')}
`;
        await fs.writeFile(this.config.caddyfilePath, initialCaddyfile);
        this.log('info', `Created initial Caddyfile at ${this.config.caddyfilePath}`);
      } catch (error) {
        this.log('warn', 'Failed to create initial Caddyfile', error);
      }
    }

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

  private async initializeServices(): Promise<void> {
    // Initialize PostgreSQL server
    this.logger.info('Initializing PostgreSQL...', 'DATABASE');
    this.postgresServer = getPostgresServer({
      dropRoot: this.config.dropRoot,
      onLog: (msg) => this.logger.debug(msg, 'POSTGRES'),
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

    // Initialize process manager
    this.processManager = getProcessManager();

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

    // Initialize watcher (watches apps directory)
    this.watcher = new WatcherService({
      appsDir: this.config.appsDirectory,
      ignorePatterns: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      debounceMs: 1000,
      maxDepth: 2,
    });
  }

  /**
   * Start the REST API server
   */
  private async startApiServer(): Promise<void> {
    const credentialsPath = path.join(this.config.dropRoot, 'data', 'drop-svc', 'api-credentials.json');

    const logDir = path.join(this.config.dropRoot, 'data', 'logs');

    this.apiServer = createApiServer({
      port: this.config.apiPort,
      host: '0.0.0.0',
      credentialsPath,
      enableAuth: this.config.enableApiAuth,
      logDir,
      appsDirectory: this.config.appsDirectory,
    });

    await this.apiServer.initialize();
    await this.apiServer.start();

    this.logger.info(`API server running on port ${this.config.apiPort}`, 'API');
    if (this.config.enableApiAuth) {
      this.logger.info('API authentication: ENABLED', 'API');
    }
    this.logger.info(`Dashboard available at http://localhost:${this.config.apiPort}/dashboard`, 'API');
  }

  /**
   * Sync app state with actual running PM2 processes
   * Updates state for apps that were started/stopped outside DROP
   */
  private async syncStateWithProcesses(): Promise<void> {
    if (!this.processManager || !this.stateManager) return;

    try {
      const processes = await this.processManager.getAllStatus();
      const runningNames = new Set(processes.filter((p) => p.status === 'online').map((p) => p.name));

      // Update state for each tracked app
      for (const app of this.stateManager.getAllApps()) {
        const proc = processes.find((p) => p.name === app.name);

        if (proc && proc.status === 'online') {
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
    this.appsInProgress.add(appName);

    this.logger.appEvent('building', appName);

    // Update state to building
    if (this.stateManager) {
      await this.stateManager.setAppStatus(appName, 'building');
    }

    try {
      const detection = await this.detector.detect(appPath);

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
      });

      if (result.success) {
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
    if (!this.processManager || !this.detector) return;

    const appPath = path.join(this.config.appsDirectory, appName);

    // Update state to starting
    if (this.stateManager) {
      await this.stateManager.setAppStatus(appName, 'starting');
    }

    try {
      const detection = await this.detector.detect(appPath);
      const port = this.allocatePort(appName);

      this.logger.appEvent('starting', appName, `port ${port}`);

      // Determine start command based on app type
      let script: string;
      let interpreter: string | undefined;
      let args: string[] | undefined;

      if (detection.type === 'static' || detection.type === 'spa') {
        // Static sites use our built-in static server
        const serveDir = path.join(appPath, detection.suggestedConfig?.outputDirectory || '.');
        // Prefer compiled dist/core/static-server.js, fallback to __dirname version
        const fsSync = require('fs');
        const distPath = path.join(__dirname, '..', '..', 'dist', 'core', 'static-server.js');
        const localPath = path.join(__dirname, 'static-server.js');
        script = fsSync.existsSync(localPath) ? localPath : fsSync.existsSync(distPath) ? distPath : localPath;
        args = [serveDir, '-s']; // -s for SPA mode
      } else if (detection.type === 'go') {
        // Go apps run as compiled binaries
        const startCommand = detection.suggestedConfig?.startCommand || `./${appName}`;
        script = startCommand;
        interpreter = 'none'; // No interpreter - run binary directly
      } else {
        // For Node.js/Python apps, the detector returns "node <file>" or "python <file>" format
        const startCommand = detection.suggestedConfig?.startCommand || 'node index.js';

        if (startCommand.startsWith('node ')) {
          // Extract the script file from "node <file>"
          script = startCommand.substring(5); // Remove "node " prefix
        } else {
          script = startCommand;
        }
      }

      // Create persistent data directory for the app
      const dataDir = await this.ensureAppDataDirectory(appName);
      this.logger.info(`Data directory: ${dataDir}`, 'DATA');

      // Check if app needs a database and provision one
      let dbEnvVars: Record<string, string> = {};
      const needsDb = await this.appNeedsDatabase(appPath, detection.suggestedConfig?.database);
      if (this.dbProvisioner && needsDb) {
        this.logger.info(`Provisioning database for ${appName}...`, 'DATABASE');
        const dbCreds = await this.dbProvisioner.provisionAppDatabase(appName);
        dbEnvVars = this.dbProvisioner.getEnvVars(appName) || {};
        this.logger.info(`Database provisioned: ${dbCreds.database}`, 'DATABASE');
      }

      // Resolve dependencies from drop.yaml
      const depEnvVars = await this.resolveDependencies(appPath, appName);

      // For static apps, generate drop-config.js with dependency URLs
      if ((detection.type === 'static' || detection.type === 'spa') && Object.keys(depEnvVars).length > 0) {
        await this.generateStaticConfig(appPath, depEnvVars);
      }

      // Load encrypted secrets for this app
      let secretEnvVars: Record<string, string> = {};
      if (this.secretManager && this.secretManager.hasSecrets(appName)) {
        secretEnvVars = this.secretManager.getAll(appName);
        this.logger.info(`Injecting ${Object.keys(secretEnvVars).length} secret(s)`, 'SECURITY');
      }

      // Configure log files with dated filenames (auto-captured from stdout/stderr)
      const { outFile, errorFile } = await this.getAppLogPaths(appName);

      const status = await this.processManager.start({
        name: appName,
        script,
        interpreter,
        args,
        cwd: appPath,
        port,
        outFile,
        errorFile,
        env: {
          NODE_ENV: 'production',
          PORT: port.toString(),
          DROP_DATA_DIR: dataDir,
          ...dbEnvVars,
          ...depEnvVars,
          ...secretEnvVars,
        },
      });

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

      if (dropYaml.success && dropYaml.config) {
        if (dropYaml.config.domains && dropYaml.config.domains.length > 0) {
          domains = dropYaml.config.domains;
          this.logger.info(`Custom domains configured for ${appName}: ${domains.join(', ')}`, 'ROUTER');
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

        // Save custom domains to app config
        if (this.appConfigService && dropYaml.config.domains) {
          await this.appConfigService.updateConfig(appName, {
            domains: dropYaml.config.domains,
            tls: dropYaml.config.tls,
          });
        }
      }

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
      // Route might already exist
      this.logger.warn(`Failed to configure route for ${appName}`, 'ROUTER', error);
    }
  }

  /**
   * Handle app update events (file changes in existing apps)
   * Stops the running process, rebuilds, and restarts on the same port
   */
  private async handleAppUpdate(appName: string, appPath: string, reason: string): Promise<void> {
    if (!this.processManager || !this.stateManager || !this.detector || !this.builder) return;

    // Skip apps currently being cloned by git deploy
    if (this.gitDeployService?.isCloning(appName)) return;

    // Skip if already processing this app (e.g., during initial deployment)
    if (this.appsInProgress.has(appName)) {
      this.logger.debug(`Skipping update for ${appName} - already in progress`, 'UPDATE');
      return;
    }

    // Skip if app was just deployed (cooldown period to prevent loops)
    const lastDeployTime = this.appDeployTimes.get(appName);
    if (lastDeployTime && Date.now() - lastDeployTime < this.DEPLOY_COOLDOWN_MS) {
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

    // Remember the current port so we can reuse it
    const originalPort = appState.port;

    this.logger.info(`Hot-reload triggered for ${appName}: ${reason}`, 'UPDATE');
    this.appsInProgress.add(appName);

    try {
      // 1. Stop the running process (if any)
      if (appState.status === 'running') {
        this.logger.info(`Stopping ${appName} for rebuild...`, 'UPDATE');
        await this.processManager.stop(appName);

        // Release the port from usedPorts (we'll re-add it when we restart)
        if (originalPort) {
          this.usedPorts.delete(originalPort);
        }
      }

      // 2. Update state to building
      await this.stateManager.setAppStatus(appName, 'building');

      // 3. Re-detect and rebuild the app
      const detection = await this.detector.detect(appPath);
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
      });

      if (!buildResult.success) {
        this.logger.appEvent('error', appName, buildResult.errors?.[0]?.message || 'Rebuild failed');
        await this.stateManager.setAppStatus(appName, 'errored', {
          error: buildResult.errors?.[0]?.message || 'Rebuild failed',
        });
        this.appsInProgress.delete(appName);
        return;
      }

      this.logger.appEvent('built', appName, `rebuilt in ${buildResult.duration}ms`);

      // 4. Restart the app on the same port (or allocate new if none)
      const port = originalPort ?? this.allocatePort(appName);
      this.usedPorts.set(port, appName);

      await this.stateManager.setAppStatus(appName, 'starting');

      // Determine start command
      let script: string;
      let args: string[] | undefined;

      if (detection.type === 'static' || detection.type === 'spa') {
        const serveDir = path.join(appPath, detection.suggestedConfig?.outputDirectory || '.');
        script = path.join(__dirname, 'static-server.js');
        args = [serveDir, '-s'];
      } else {
        const startCommand = detection.suggestedConfig?.startCommand || 'node index.js';
        script = startCommand.startsWith('node ') ? startCommand.substring(5) : startCommand;
      }

      // Ensure data directory exists (preserved across upgrades)
      const dataDir = await this.ensureAppDataDirectory(appName);

      // Get database env vars if needed
      let dbEnvVars: Record<string, string> = {};
      if (this.dbProvisioner) {
        dbEnvVars = this.dbProvisioner.getEnvVars(appName) || {};
      }

      // Resolve dependencies
      const depEnvVars = await this.resolveDependencies(appPath, appName);

      // For static apps, regenerate drop-config.js
      if ((detection.type === 'static' || detection.type === 'spa') && Object.keys(depEnvVars).length > 0) {
        await this.generateStaticConfig(appPath, depEnvVars);
      }

      // Load encrypted secrets for this app
      let secretEnvVars: Record<string, string> = {};
      if (this.secretManager && this.secretManager.hasSecrets(appName)) {
        secretEnvVars = this.secretManager.getAll(appName);
      }

      // Configure log files with dated filenames (auto-captured from stdout/stderr)
      const { outFile, errorFile } = await this.getAppLogPaths(appName);

      const status = await this.processManager.start({
        name: appName,
        script,
        args,
        cwd: appPath,
        port,
        outFile,
        errorFile,
        env: {
          NODE_ENV: 'production',
          PORT: port.toString(),
          DROP_DATA_DIR: dataDir,
          ...dbEnvVars,
          ...depEnvVars,
          ...secretEnvVars,
        },
      });

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
   * Get the log file paths for an app with today's date.
   * Format: {appName}-YYYY-MM-DD-out.log and {appName}-YYYY-MM-DD-err.log
   * Creates the log directory if it doesn't exist.
   */
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
    if (this.processManager) {
      try {
        const processes = await this.processManager.getAllStatus();
        for (const proc of processes) {
          if (proc.port && proc.status === 'online') {
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

  getProcessManager(): ProcessManager | null {
    return this.processManager;
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
