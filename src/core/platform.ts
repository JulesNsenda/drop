/**
 * DROP Platform - Main orchestrator for the DROP PaaS
 *
 * This is the central coordinator that initializes and manages all
 * DROP services and their lifecycle.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as yaml from 'yaml';
import { EventBus, eventBus, Unsubscribe, AppDeletedPayload, AppDetectedPayload } from './event-bus';
import { WatcherService } from './watcher';
import { DetectorService, getDetector, parseDropYaml, DetectionResult, DropYamlConfig } from './detector';
import { getProcfileWebCommand } from './detector/procfile';
import { BuilderService, getBuilder } from './builder';
import { RouterService, getRouterService, resetRouterService } from './router';
import { AppRuntime, AppProcessInfo, AppStartSpec, getAppRuntime, resetAppRuntime } from '../managers/runtime';
import { AppStateManager, getStateManager, resetStateManager } from '../managers/app/state-manager';
import { SettingsManager, getSettingsManager, resetSettingsManager } from '../managers/settings/settings-manager';
import { AppConfigService, getAppConfigService, resetAppConfigService } from '../managers/app/app-config';
import {
  PostgresServer,
  getPostgresServer,
  resetPostgresServer,
  DatabaseProvisioner,
  getDatabaseProvisioner,
  resetDatabaseProvisioner,
} from '../managers/database';
import {
  RedisServer,
  getRedisServer,
  resetRedisServer,
  RedisProvisioner,
  getRedisProvisioner,
  resetRedisProvisioner,
} from '../managers/redis';
import { CaddyServer, getCaddyServer, resetCaddyServer } from '../managers/router';
import { SecretManager, getSecretManager, resetSecretManager } from '../managers/secret';
import { WebhookManager, getWebhookManager, resetWebhookManager } from './webhooks';
import { GitDeployService, getGitDeployService, resetGitDeployService } from './git-deploy';
import { UploadDeployService, getUploadDeployService, resetUploadDeployService } from './upload-deploy';
import { getActivityLog, resetActivityLog } from '../managers/activity';
import { getDeployTracker, resetDeployTracker } from '../managers/deploy-tracker';
import { ApiServer, createApiServer } from '../api';
import { AppInProgressError, setPlatformOps, resetPlatformOps } from '../api/platform-ops';
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
import { HOST_ALIAS } from '../managers/runtime/container-config';
import { buildNginxConf } from '../utils/nginx-conf';
import { BuildLogService, getBuildLogService, resetBuildLogService } from '../managers/build-log/build-log';
import {
  LogRetentionService,
  getLogRetentionService,
  resetLogRetentionService,
} from '../managers/log-retention/log-retention';
import { hasEnoughDisk, getMinFreeDiskMb } from '../utils/disk';
import { probePort, probeHttp } from '../utils/http-probe';

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
  /** Run the bundled managed Redis (per-app logical DB + injected REDIS_URL). Default true. */
  enableRedis: boolean;
  /** Host TCP port for the managed Redis instance (default 6380). */
  redisPort: number;
  /** Max managed-Redis logical DBs a single user may provision (0 = unlimited). */
  maxRedisPerUser: number;
  /** Global limit on simultaneous builds (0 = unlimited). */
  maxConcurrentBuilds: number;
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
  /**
   * Cap on the compressed (as-uploaded) archive size for
   * `POST /apps/:name/source` (PRD-039), in MB. Enforced by the route's own
   * incremental byte counter while streaming to disk — never trusts
   * Content-Length. Default 100.
   */
  maxUploadSizeMb: number;
  /**
   * Cap on the cumulative decompressed size of an uploaded archive, in MB.
   * Enforced by `UploadDeployService`/`extractTarball` mid-extraction (aborts
   * as soon as the cap is crossed, not post-hoc). Distinct from
   * `maxUploadSizeMb`, which bounds the compressed upload itself. Default 1024.
   */
  maxUploadUnpackedMb: number;
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
  enableRedis: process.env.DROP_ENABLE_REDIS !== 'false',
  redisPort: parseInt(process.env.DROP_REDIS_PORT || '6380', 10),
  maxRedisPerUser: parseInt(process.env.DROP_MAX_REDIS_PER_USER || '3', 10),
  maxConcurrentBuilds: parseInt(process.env.DROP_MAX_CONCURRENT_BUILDS || '3', 10),
  maxConcurrentApps: parseInt(process.env.DROP_MAX_CONCURRENT_APPS || '0', 10),
  maxMemoryMbPerApp: parseInt(process.env.DROP_MAX_MEMORY_MB_PER_APP || '0', 10),
  maxCpusPerApp: parseFloat(process.env.DROP_MAX_CPUS_PER_APP || '0'),
  logRetentionDays: parseInt(process.env.DROP_LOG_RETENTION_DAYS || '14', 10),
  logMaxFileMb: parseInt(process.env.DROP_LOG_MAX_FILE_MB || '50', 10),
  maxUploadSizeMb: parseInt(process.env.DROP_MAX_UPLOAD_SIZE_MB || '100', 10),
  maxUploadUnpackedMb: parseInt(process.env.DROP_MAX_UPLOAD_UNPACKED_MB || '1024', 10),
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
  private settingsManager: SettingsManager | null = null;
  private appConfigService: AppConfigService | null = null;
  private postgresServer: PostgresServer | null = null;
  private dbProvisioner: DatabaseProvisioner | null = null;
  private redisServer: RedisServer | null = null;
  private redisProvisioner: RedisProvisioner | null = null;
  private caddyServer: CaddyServer | null = null;
  private secretManager: SecretManager | null = null;
  private webhookManager: WebhookManager | null = null;
  private gitDeployService: GitDeployService | null = null;
  private uploadDeployService: UploadDeployService | null = null;
  private apiServer: ApiServer | null = null;
  private buildLogService: BuildLogService | null = null;
  private logRetention: LogRetentionService | null = null;

  private subscriptions: Unsubscribe[] = [];
  // Held separately from `subscriptions`: must stay subscribed through
  // drainInProgress() in stop() so late-completing deploys still close out
  // (see the drain-window fix in docs/plans/2026-07-06-p2-4-deploy-observability.md).
  private deployTrackerUnsub?: Unsubscribe;
  private isRunning = false;
  private usedPorts: Map<number, string> = new Map(); // port -> appName ownership
  private appsInProgress: Set<string> = new Set(); // Track apps being built/started
  // Builds deferred because the concurrent-build cap was full (appName -> its
  // path + type hint). A first-boot or single-drop burst can briefly saturate
  // the cap — in docker mode especially, where a first-time base-image pull
  // holds a build slot for a while — and without a drain those deferred builds
  // wait for a file change that may never come, so a static/other app "never
  // starts automatically". `drainPendingBuilds` retries them as slots free.
  private pendingBuilds: Map<string, { appPath: string; appType: string }> = new Map();
  private buildDrainTimer: ReturnType<typeof setTimeout> | null = null;
  private appDeployTimes: Map<string, number> = new Map(); // Track when apps were last deployed
  // Apps whose rebuild+restart is being managed as a single transaction by
  // handleAppUpdate. Their builder.build still emits build:completed, but
  // buildSub must NOT also start them (that would double-start). Held only for
  // the duration of the build() call — see handleAppUpdate / buildSub.
  private selfManagedUpdates: Set<string> = new Set();
  private appBuildDurations: Map<string, number> = new Map(); // Last build duration per app (ms)
  /** Minimum post-deploy quiet window. Adaptive: max(this, lastBuildDuration * 2). */
  private readonly DEPLOY_COOLDOWN_MS_MIN = 5_000;
  /** Hard cap on the adaptive cooldown so a flaky 10-minute build doesn't lock out hot-reload forever. */
  private readonly DEPLOY_COOLDOWN_MS_MAX = 120_000;
  private certExpiryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly CERT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
  /** Per-app health-probe intervals (PM2 mode only; Docker uses HEALTHCHECK). */
  private readonly healthProbers: Map<string, ReturnType<typeof setInterval>> = new Map();
  /** Per-app post-deploy crash-loop watches (both modes; keyed on restart count). */
  private readonly crashLoopWatchers: Map<string, ReturnType<typeof setInterval>> = new Map();
  /** Restart count (over one watch interval) at/above which a running app is flagged crash-looping. */
  private readonly CRASHLOOP_RESTART_THRESHOLD = 3;
  /** Startup readiness window: how long handleStartApp waits for an app to come up before erroring. */
  private readonly readinessTimeoutMs = Math.max(
    50,
    Number(process.env.DROP_READINESS_TIMEOUT_MS) || 20_000
  );

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

    // Stop the pending-build drain
    if (this.buildDrainTimer) {
      clearTimeout(this.buildDrainTimer);
      this.buildDrainTimer = null;
    }
    this.pendingBuilds.clear();

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

    // Close settings manager
    if (this.settingsManager) {
      await this.settingsManager.close();
      resetSettingsManager();
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

    // Reset database provisioner singleton (paired with postgresServer above
    // since the provisioner depends on it)
    if (this.dbProvisioner) {
      resetDatabaseProvisioner();
      this.dbProvisioner = null;
    }

    // Stop managed Redis + reset its singletons (provisioner depends on server).
    if (this.redisServer) {
      this.logger.info('Stopping managed Redis...', 'REDIS');
      await this.redisServer.stop();
      resetRedisServer();
      this.redisServer = null;
    }
    if (this.redisProvisioner) {
      resetRedisProvisioner();
      this.redisProvisioner = null;
    }

    // Stop Caddy server
    if (this.caddyServer) {
      this.logger.info('Stopping Caddy...', 'CADDY');
      await this.caddyServer.stop();
      resetCaddyServer();
    }

    // Stop all health probers and crash-loop watches
    for (const [, timer] of this.healthProbers) clearInterval(timer);
    this.healthProbers.clear();
    for (const [, timer] of this.crashLoopWatchers) clearInterval(timer);
    this.crashLoopWatchers.clear();

    // Reset secret manager, webhook manager, git deploy service, build logs,
    // and the platform-ops seam (routes must 503 once the platform is down).
    resetSecretManager();
    resetWebhookManager();
    resetGitDeployService();
    resetUploadDeployService();
    resetActivityLog();
    resetBuildLogService();
    resetPlatformOps();

    // Tear down the deploy tracker's subscription only now — after the drain
    // above completes — so a deploy that finishes during the drain window
    // still gets its closing row recorded, then flush the final state to
    // disk before reset.
    if (this.deployTrackerUnsub) {
      this.deployTrackerUnsub();
      this.deployTrackerUnsub = undefined;
    }
    try {
      await getDeployTracker().flush();
    } catch {
      // best-effort
    }
    resetDeployTracker();

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

    // Backups contain plaintext DB credentials (db-credentials.json,
    // .pg-superuser, restore-roles.sql) — keep the root non-world-traversable.
    // (POSIX-effective only; on Windows this relies on NTFS ACL inheritance.)
    try {
      await fs.mkdir(path.join(dataDir, 'backup'), { recursive: true, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        this.log('warn', `Failed to create directory: ${path.join(dataDir, 'backup')}`, error);
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

    // Initialize database provisioner (module singleton so the API layer,
    // which holds no platform reference, can reach the same instance)
    this.dbProvisioner = getDatabaseProvisioner(this.postgresServer, this.config.dropRoot);
    if (!this.dbProvisioner) {
      throw new Error('Failed to initialize DatabaseProvisioner');
    }
    await this.dbProvisioner.initialize();

    // Ensure internal database exists
    const internalDb = await this.dbProvisioner.ensureInternalDatabase();
    this.logger.info(`Internal database ready: ${internalDb.database}`, 'DATABASE');

    // Initialize the managed Redis instance + provisioner. FAIL-SOFT: Redis is
    // an optional convenience (apps can still use an external REDIS_URL secret),
    // so a start failure (no redis-server on a dev host, docker hiccup) logs and
    // continues rather than aborting platform start. Apps that need Redis then
    // simply get no REDIS_URL — the same posture as Postgres-unavailable.
    if (this.config.enableRedis) {
      try {
        this.logger.info('Initializing managed Redis...', 'REDIS');
        this.redisServer = getRedisServer({
          dropRoot: this.config.dropRoot,
          port: this.config.redisPort,
          useDocker: this.config.isolation === 'docker',
          onLog: (msg) => this.logger.debug(msg, 'REDIS'),
        });
        await this.redisServer.start();
        this.redisProvisioner = getRedisProvisioner(this.redisServer, this.config.dropRoot);
        await this.redisProvisioner?.initialize();
        this.logger.info(`Managed Redis running on port ${this.redisServer.getPort()}`, 'REDIS');
      } catch (err) {
        this.logger.warn(
          'Managed Redis failed to start — apps needing Redis must use an external REDIS_URL secret',
          'REDIS',
          err
        );
        this.redisServer = null;
        this.redisProvisioner = null;
      }
    }

    // Initialize state manager for app tracking
    const stateFilePath = path.join(this.config.dropRoot, 'data', 'drop-svc', 'apps.json');
    this.stateManager = getStateManager({ stateFilePath });
    await this.stateManager.initialize();
    this.logger.info('App state manager initialized', 'STATE');

    // Initialize platform settings manager (admin-settable overrides, e.g.
    // DROP_PUBLIC_URL — see PRD-041). Must be loaded before startApiServer()
    // constructs the ApiServer, which reads getStoredPublicUrl() synchronously.
    const settingsFilePath = path.join(this.config.dropRoot, 'data', 'drop-svc', 'settings.json');
    this.settingsManager = getSettingsManager({ settingsFilePath });
    await this.settingsManager.load();
    this.logger.info('Settings manager initialized', 'CONFIG');

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

    // Initialize upload deploy service (PRD-039). Staging lives under
    // data/temp — same root as getBuildWorkDir, well outside the watched
    // webapps directory.
    this.uploadDeployService = getUploadDeployService({
      appsDirectory: this.config.appsDirectory,
      tempDirectory: path.join(this.config.dropRoot, 'data', 'temp'),
      maxUncompressedBytes: this.config.maxUploadUnpackedMb * 1024 * 1024,
      maxEntries: 20_000,
      extractTimeoutMs: 60_000,
    });

    // Initialize activity log
    const activityLogPath = path.join(this.config.dropRoot, 'data', 'drop-svc', 'activity-log.json');
    const activityLog = getActivityLog(activityLogPath);
    await activityLog.initialize();

    // Initialize deploy tracker (durable per-deploy timeline). Its unsubscribe
    // is held separately from `this.subscriptions` — see stop() — so it stays
    // wired through the shutdown drain window.
    const deployStorePath = path.join(this.config.dropRoot, 'data', 'drop-svc', 'deploys.json');
    const deployTracker = getDeployTracker(deployStorePath);
    await deployTracker.initialize();
    this.deployTrackerUnsub = deployTracker.subscribe(this.eventBus);

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

    // Initialize router with HTTPS config. importGlobs re-imports the apex/host
    // site files (hosts/*.caddy, written by install.sh) into the router's
    // generated Caddyfile — RouterService.reload() fully replaces the managed
    // Caddyfile with app routes, so without this the apex/dashboard is knocked
    // offline on the first route change.
    const hostsImportGlob = path
      .join(this.config.dropRoot, 'data', 'appconf', 'caddy', 'hosts', '*.caddy')
      .replace(/\\/g, '/');
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
        importGlobs: [hostsImportGlob],
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
      tempDirectory: path.join(this.config.dropRoot, 'data', 'temp'),
      maxUploadSizeMb: this.config.maxUploadSizeMb,
    });

    await this.apiServer.initialize();
    await this.apiServer.start();

    // Expose restart/start orchestration to the API routes via the
    // platform-ops seam — a direct import would be circular (platform → api → routes).
    setPlatformOps({
      restartApp: (name) => this.restartApp(name),
      isAppInProgress: (name) => this.appsInProgress.has(name),
      removeGroup: (name) => this.removeGroup(name),
    });

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
        } else if (
          (app.status === 'building' || app.status === 'starting') &&
          !runningNames.has(app.name)
        ) {
          // App was mid-deploy when the platform stopped: it's wedged in a
          // transient status with no live process, and nothing else demotes
          // these. Reset to 'pending' so the startup detection scan resumes the
          // deploy instead of it being stuck 'building'/'starting' forever.
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
    // App onboarding is driven by the watcher publishing app:detected directly
    // (WatcherService.handleAppDetected); the detector resolves the type and
    // detectedSub below persists it. There is no watcher:change → new-app path:
    // the watcher never emits watcher:change with changeType 'addDir'.

    // When app is detected, create config and build it
    const detectedSub = this.eventBus.subscribe('app:detected', (payload) =>
      this.handleAppDetected(payload)
    );
    this.subscriptions.push(detectedSub);

    // When build completes, start the app (unless it failed or was stopped).
    // handleBuildApp keeps the app in appsInProgress through the build and
    // hands ownership to handleStartApp; every path here that does NOT start
    // the app must release the guard, or future hot-reloads dead-end forever.
    const buildSub = this.eventBus.subscribe('build:completed', async (payload) => {
      // A hot-reload (handleAppUpdate) owns its own stop+rebuild+start as one
      // transaction — its builder.build emits build:completed too, but buildSub
      // must abstain or the app double-starts. handleAppUpdate owns appsInProgress
      // cleanup in that case, so we return without touching it. MUST be the first
      // statement (before any await): it is correct only because EventBus
      // dispatch is synchronous, so this runs during build()'s publish, between
      // handleAppUpdate's marker add() and the finally delete() bracketing the
      // await this.builder.build(...). A move to async/deferred dispatch would
      // silently reintroduce the double-start.
      if (this.selfManagedUpdates.has(payload.appId)) {
        return;
      }

      if (payload.success === false) {
        // Failed build — handleBuildApp already marked it errored and cleaned up.
        this.appsInProgress.delete(payload.appId);
        return;
      }

      const app = this.stateManager?.getApp(payload.appId);
      const shouldStart = this.config.autoStart && app?.status !== 'stopped';

      if (shouldStart) {
        // owns appsInProgress cleanup. outputPath rides the payload because
        // this dispatch happens synchronously inside build() — before
        // handleBuildApp can persist it to the app config.
        await this.handleStartApp(payload.appId, payload.outputPath);
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
      // Skip apps currently being uploaded (PRD-039)
      if (this.uploadDeployService?.isUploading(payload.name)) return;
      await this.handleAppUpdate(payload.name, payload.path, payload.reason, payload.bypassCooldown);
    });
    this.subscriptions.push(updateSub);

    // Stop health probers when an app is explicitly stopped or removed
    const statusSub = this.eventBus.subscribe('app:updated', (payload) => {
      const status = (payload.changes as { status?: string })?.status;
      if (status === 'stopped' || status === 'errored') {
        this.stopHealthProber(payload.appId);
        this.stopCrashLoopWatch(payload.appId);
      }
    });
    this.subscriptions.push(statusSub);

    // Release the deleted app's port(s) so allocatePort's range-scan can
    // reuse them. Keyed on app:deleted — published only by
    // stateManager.removeApp (real teardown) — NOT app:removed, which also
    // fires from the watcher's chokidar unlinkDir handler (a folder momentarily
    // vanishing, e.g. mid-redeploy) and would free a live/just-redeployed app's
    // port out from under it. See docs/plans/2026-07-07-p2-5-disk-and-port-guards.md.
    const deletedSub = this.eventBus.subscribe('app:deleted', async (payload) => {
      await this.handleAppDeleted(payload);
    });
    this.subscriptions.push(deletedSub);
  }

  /**
   * Release every port owned by a deleted app, and remove any Caddy routes
   * it still owns. Reverse-lookup over `usedPorts` (Map<port, appName>)
   * rather than a single stored port, because the map is the only place
   * ownership is tracked. Excludes the '__anonymous__' sentinel, which never
   * corresponds to a real app name.
   *
   * Route removal is the general fix for M4's route-leak: `app:deleted` is
   * published by every `stateManager.removeApp` call (the only production
   * call site is the DELETE /apps/:name route, including via
   * `teardownApp`/`removeGroup`'s own explicit — and here, redundant but
   * harmless — removal), so hooking it here covers deletion universally, not
   * just the paths that happen to also call `removeRoutesForApp` directly.
   */
  private async handleAppDeleted(payload: AppDeletedPayload): Promise<void> {
    for (const [port, owner] of this.usedPorts.entries()) {
      if (owner === payload.name && owner !== '__anonymous__') {
        this.usedPorts.delete(port);
        this.logger.debug(`Released port ${port} for deleted app ${payload.name}`, 'PORT');
      }
    }

    try {
      await this.router?.removeRoutesForApp(payload.appId);
    } catch (err) {
      this.logger.warn(
        `Failed to remove routes for deleted app ${payload.appId}`,
        'ROUTER',
        err
      );
    }
  }

  /**
   * Check if an app needs a database by looking at detection result or common ORM config files
   */
  private async appNeedsDatabase(appPath: string, detectionDatabase?: boolean | string): Promise<boolean> {
    // DROP has no SQLite provisioner — 'sqlite' still provisions PostgreSQL and
    // injects DATABASE_URL. Warn so the mismatch is visible instead of silent.
    if (detectionDatabase === 'sqlite') {
      this.logger.warn(
        "drop.yaml requested 'database: sqlite', but DROP only provisions PostgreSQL — " +
          "a PostgreSQL database will be provisioned and DATABASE_URL injected. " +
          "Set 'database: postgres' to silence this warning.",
        'DATABASE'
      );
    }

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
   * Whether an app wants managed Redis. An explicit `redis:` in drop.yaml wins
   * (true opts in, false opts out); otherwise auto-detect a Redis client in the
   * app's package.json dependencies — the same "detect from project files"
   * approach appNeedsDatabase uses for ORM config. Non-Node apps opt in via
   * `redis: true` in drop.yaml.
   */
  private async appNeedsRedis(appPath: string): Promise<boolean> {
    const dropYaml = await parseDropYaml(appPath);
    if (dropYaml.success && typeof dropYaml.config?.redis === 'boolean') {
      return dropYaml.config.redis;
    }

    try {
      const pkgRaw = await fs.readFile(path.join(appPath, 'package.json'), 'utf-8');
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const redisClients = [
        'ioredis',
        'redis',
        'bullmq',
        '@nestjs/bullmq',
        'bull',
        'rate-limit-redis',
        'connect-redis',
      ];
      if (redisClients.some((c) => c in deps)) {
        return true;
      }
    } catch {
      // No/unreadable package.json — not a Node app, or nothing to detect.
    }

    return false;
  }

  /**
   * Provision (or fetch the existing) managed-Redis env vars for an app.
   * Idempotent and fail-soft: returns {} when Redis is unavailable, the app
   * doesn't need it, or the user's quota is exceeded. Shared by the first-deploy
   * start path and the hot-reload/restart path (which just re-fetches the
   * existing allocation). The app-facing host is the container-reachable
   * `drop-host` alias under docker isolation, loopback otherwise.
   */
  private async provisionRedisEnvVars(
    appName: string,
    appPath: string
  ): Promise<Record<string, string>> {
    if (!this.redisProvisioner) {
      return {};
    }
    const redisHost = this.config.isolation === 'docker' ? HOST_ALIAS : '127.0.0.1';

    // Already provisioned (e.g. hot-reload/restart) — just return its URL.
    if (this.redisProvisioner.isProvisioned(appName)) {
      return this.redisProvisioner.getEnvVars(appName, { host: redisHost }) || {};
    }

    if (!(await this.appNeedsRedis(appPath))) {
      return {};
    }

    // Per-user quota (mirrors the Postgres DB quota).
    const ownerUserId = this.stateManager?.getApp(appName)?.userId;
    if (ownerUserId !== undefined && this.config.maxRedisPerUser > 0) {
      const count = (this.stateManager?.getAllApps() ?? []).filter(
        (a) => a.userId === ownerUserId && this.redisProvisioner!.isProvisioned(a.name)
      ).length;
      if (count >= this.config.maxRedisPerUser) {
        this.logger.warn(
          `Redis quota reached for user ${ownerUserId} (${count}/${this.config.maxRedisPerUser}), ` +
            `skipping Redis for ${appName}`,
          'REDIS'
        );
        return {};
      }
    }

    try {
      const alloc = await this.redisProvisioner.provisionAppRedis(appName);
      this.logger.info(`Redis provisioned for ${appName}: logical db ${alloc.db}`, 'REDIS');
      return this.redisProvisioner.getEnvVars(appName, { host: redisHost }) || {};
    } catch (err) {
      this.logger.warn(`Redis provisioning failed for ${appName}`, 'REDIS', err);
      return {};
    }
  }

  /**
   * Parse drop.yaml and resolve depends_on to get dependency URLs.
   * Returns environment variables to inject based on dependent apps.
   *
   * Resolution is config-based (via appConfigService.getConfig), NOT the
   * running app's runtime port — a dependency need only be REGISTERED, not
   * running, for this to resolve, which removes build-ordering. It also
   * means the URL is browser-reachable (hostname-based) whenever the
   * dependency has a custom domain or the platform serves a real domain
   * suffix, instead of always being a server-local `localhost:<port>` that a
   * browser can never reach.
   */
  private async resolveDependencies(appPath: string, appName: string): Promise<Record<string, string>> {
    const envVars: Record<string, string> = {};

    const dropYaml = await parseDropYaml(appPath);
    if (!dropYaml.success || !dropYaml.config?.depends_on?.length) {
      return envVars;
    }

    for (const dep of dropYaml.config.depends_on) {
      const baseUrl = this.resolveDependencyUrl(dep.name);
      if (!baseUrl) {
        this.logger.warn(`Dependency ${dep.name} not found or not configured for ${appName}`, 'DEPS');
        continue;
      }

      const url = dep.path ? this.joinDependencyUrlPath(baseUrl, dep.path) : baseUrl;
      envVars[dep.env] = url;
      this.logger.info(`Resolved dependency ${dep.name} -> ${dep.env}=${url}`, 'DEPS');
    }

    return envVars;
  }

  /**
   * Resolve the browser-reachable base URL for a registered dependency app,
   * from its persisted config — never the runtime/state-manager port.
   *
   * Precedence:
   * 1. The dependency's own custom domain (drop.yaml `domains`), if set.
   * 2. The platform's default hostname for the app (`<dep>.<domainSuffix>`),
   *    whenever a real (non-localhost) domain suffix is configured — this is
   *    the same hostname handleConfigureRoute always registers a route for,
   *    regardless of `enableHttps` (which only toggles TLS on that route, so
   *    protocol - not existence - is what depends on it).
   * 3. `http://localhost:<port>` as the pure-local-dev fallback, using the
   *    dependency's *configured* port (source of truth across restarts).
   *
   * Returns undefined when the dependency has no config at all (unknown /
   * not yet registered) or no fallback is resolvable.
   */
  private resolveDependencyUrl(depName: string): string | undefined {
    const depConfig = this.appConfigService?.getConfig(depName);
    if (!depConfig) return undefined;

    const domainSuffix = this.config.domainSuffix || 'localhost';

    const customDomain =
      depConfig.domains && depConfig.domains.length > 0 ? depConfig.domains[0] : undefined;
    if (customDomain) {
      const protocol = this.config.enableHttps && !isLocalhostDomain(customDomain) ? 'https' : 'http';
      return `${protocol}://${customDomain}`;
    }

    if (!isLocalhostDomain(domainSuffix)) {
      const protocol = this.config.enableHttps ? 'https' : 'http';
      return `${protocol}://${depName}.${domainSuffix}`;
    }

    if (depConfig.port) {
      return `http://localhost:${depConfig.port}`;
    }

    return undefined;
  }

  /** Append a drop.yaml dependency `path` to a resolved base URL, normalizing slashes. */
  private joinDependencyUrlPath(baseUrl: string, depPath: string): string {
    const base = baseUrl.replace(/\/+$/, '');
    const suffix = depPath.startsWith('/') ? depPath : `/${depPath}`;
    return `${base}${suffix}`;
  }

  /**
   * Build the env map handed to the builder's child process for a fresh
   * build (handleBuildApp) or a hot-reload rebuild (handleAppUpdate). Shared
   * so the two call sites can't drift.
   *
   * Precedence (later wins): drop.yaml `env` (runtime env, also usable at
   * build time) -> drop.yaml `build_env` (build-only, e.g. Vite `VITE_*`
   * vars a static bundler inlines) -> resolved `depends_on` URLs (highest
   * precedence — a build must always see the current, browser-reachable
   * dependency URL, not a stale build-time default).
   *
   * All values are coerced to strings: drop.yaml allows number/boolean
   * scalars, but a child process env must be `Record<string, string>`.
   */
  private async resolveBuildEnv(appPath: string, appName: string): Promise<Record<string, string>> {
    const dropYaml = await parseDropYaml(appPath);
    const config = dropYaml.success ? dropYaml.config : null;

    const depEnvVars = await this.resolveDependencies(appPath, appName);

    return {
      ...this.coerceEnvRecord(config?.env),
      ...this.coerceEnvRecord(config?.build_env),
      ...depEnvVars,
    };
  }

  /** Coerce drop.yaml's string|number|boolean env scalars to plain strings. */
  private coerceEnvRecord(
    rec?: Record<string, string | number | boolean>
  ): Record<string, string> {
    if (!rec) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(rec)) {
      out[key] = String(value);
    }
    return out;
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

  /**
   * Matches path segments 'node_modules', '.git', 'dist', or 'build' anywhere
   * in a path, bounded by path separators (or string start/end) so real
   * prefixes like 'distribution/' aren't accidentally excluded.
   */
  private static readonly MONOREPO_COPY_EXCLUDE_RE = /(^|[\\/])(node_modules|\.git|dist|build)([\\/]|$)/;

  /**
   * Expand a monorepo container (a repo whose root drop.yaml declares a
   * `services:` map) into N ordinary top-level DROP apps — one per service.
   *
   * Fork C (docs/plans/2026-07-12-monorepo-multi-service.md, M2): each
   * service's subtree is copied into its own top-level `webapps/<group>-<svc>`
   * folder and onboarded exactly like any other single-app deploy, so the
   * `appName == top-level-folder-name` invariant that the rest of the
   * platform relies on (reconciliation, DELETE, hot-reload) is preserved.
   * The container folder itself (`repoPath`) is never onboarded as an app.
   *
   * Idempotent: safe to re-run on every redeploy of the container (git pull /
   * re-upload re-emits `app:detected`) — each service's folder is fully
   * replaced (remove-then-copy) and its config/state are upserted, not
   * duplicated.
   */
  private async expandMonorepo(
    repoPath: string,
    repoName: string,
    config: DropYamlConfig
  ): Promise<void> {
    const group = (config.group || config.name || repoName).trim();
    const services = config.services ?? {};
    const serviceNames = new Set(Object.keys(services));

    if (serviceNames.size > this.config.maxConcurrentBuilds) {
      this.logger.warn(
        `Monorepo group '${group}' declares ${serviceNames.size} services, which exceeds ` +
          `maxConcurrentBuilds (${this.config.maxConcurrentBuilds}); services beyond the cap ` +
          `will be deferred by the build queue ("Build queue full") rather than built immediately`,
        'MONOREPO'
      );
    }

    for (const [svcName, svc] of Object.entries(services)) {
      try {
        const childName = `${group}-${svcName}`;
        if (!/^[a-zA-Z0-9_-]+$/.test(childName)) {
          this.logger.warn(
            `Skipping service '${svcName}' in monorepo group '${group}': derived app name ` +
              `'${childName}' contains characters outside [a-zA-Z0-9_-]`,
            'MONOREPO'
          );
          continue;
        }

        // Collision guard: refuse to clobber a standalone app (or an app from
        // a different group) that already owns this name. Allow refresh when
        // the existing config already belongs to this same group (redeploy).
        const existing = this.appConfigService?.getConfig(childName);
        if (existing && existing.group !== group) {
          this.logger.warn(
            `Skipping service '${svcName}': app '${childName}' already exists and does not ` +
              `belong to monorepo group '${group}'`,
            'MONOREPO'
          );
          continue;
        }

        const srcDir = path.join(repoPath, svc.path);
        try {
          const st = await fs.stat(srcDir);
          if (!st.isDirectory()) {
            this.logger.warn(
              `Skipping service '${svcName}': '${svc.path}' in '${repoName}' is not a directory`,
              'MONOREPO'
            );
            continue;
          }
        } catch {
          this.logger.warn(
            `Skipping service '${svcName}': path '${svc.path}' does not exist in '${repoName}'`,
            'MONOREPO'
          );
          continue;
        }

        const childPath = path.join(this.config.appsDirectory, childName);

        // Suppress the watcher's own onboarding of the folder we're about to
        // write — we onboard it ourselves below, same as the interception
        // above does for the container.
        this.watcher?.markAppKnown(childName);

        // Materialize (idempotent): drop any previous copy, then copy fresh,
        // excluding node_modules/.git/dist/build so redeploys stay cheap and
        // don't duplicate installed dependencies or build output.
        await fs.rm(childPath, { recursive: true, force: true });
        await fs.cp(srcDir, childPath, {
          recursive: true,
          force: true,
          filter: (src: string) => !DropPlatform.MONOREPO_COPY_EXCLUDE_RE.test(src),
        });

        // Resolve type: honor an explicit override, else detect from the
        // freshly copied subtree (the real source — the generated child
        // drop.yaml written below doesn't exist yet at detection time). If
        // the source subtree itself carries its own drop.yaml, it was copied
        // above and gets overwritten by the generated one next.
        let childType = svc.type;
        if (!childType && this.detector) {
          const det = await this.detector.detect(childPath, { silent: true });
          childType = det.type;
        }
        childType = childType || 'static';

        // Rewrite depends_on so a dependency naming a sibling service resolves
        // to that sibling's real, group-qualified child app name. Dependencies
        // on apps outside this group are left unchanged.
        const dependsOn = svc.depends_on?.map(dep =>
          serviceNames.has(dep.name) ? { ...dep, name: `${group}-${dep.name}` } : dep
        );

        // M3: `route` (services.<svc>.route) is now a top-level allowed key,
        // so it is written into the child drop.yaml and applied by
        // handleConfigureRoute as a same-origin Caddy path prefix (frontend at
        // `/`, backend at `/api`).
        const childConfig: DropYamlConfig = {
          name: childName,
          type: childType,
          ...(svc.database ? { database: svc.database } : {}),
          ...(typeof svc.redis === 'boolean' ? { redis: svc.redis } : {}),
          ...(svc.domains && svc.domains.length > 0 ? { domains: svc.domains } : {}),
          ...(svc.env ? { env: svc.env } : {}),
          ...(svc.build_env ? { build_env: svc.build_env } : {}),
          ...(svc.healthCheck ? { healthCheck: svc.healthCheck } : {}),
          ...(svc.build ? { build: svc.build } : {}),
          ...(svc.start ? { start: svc.start } : {}),
          ...(svc.route ? { route: svc.route } : {}),
          ...(dependsOn && dependsOn.length > 0 ? { depends_on: dependsOn } : {}),
        };
        await fs.writeFile(path.join(childPath, 'drop.yaml'), yaml.stringify(childConfig));

        // Same narrowing cast the normal onboarding path (detectedSub) and
        // handleBuildApp already use: the detector's AppType is wider than
        // the stored config/state runtime union.
        const narrowedType = childType as 'nodejs' | 'python' | 'go' | 'static' | 'docker' | 'unknown';

        if (this.appConfigService) {
          await this.appConfigService.upsertConfig(childName, {
            type: narrowedType,
            path: childPath,
            hostname: `${childName}.localhost`,
            group,
          });
        }
        if (this.stateManager) {
          await this.stateManager.registerApp(childName, childPath, narrowedType);
          await this.stateManager.updateApp(childName, { group });
        }

        // Sequential await: gives declared-order onboarding for the common
        // small-N case and stays under maxConcurrentBuilds without needing a
        // further file change to retrigger queued services (a single drop
        // produces none). If a service is deferred by the "Build queue full"
        // guard in handleBuildApp, it is not silently lost — the warning above
        // flags oversized groups — but it also won't auto-retrigger; that's
        // acceptable for the common small-N case and left for a future pass.
        if (this.config.autoBuild) {
          await this.handleBuildApp(childPath, childName, childType);
        }
      } catch (error) {
        this.logger.error(
          `Failed to expand service '${svcName}' in monorepo group '${group}': ` +
            `${error instanceof Error ? error.message : String(error)}`,
          'MONOREPO'
        );
      }
    }
  }

  /**
   * Handles `app:detected`: onboards a newly-seen app (or a monorepo
   * container) — persists its config/state and kicks off the initial build.
   * Extracted from the `setupEventHandlers` subscription (a pure move, same
   * behavior) so it can be exercised directly in tests without racing the
   * real fs I/O inside `parseDropYaml` through the event bus's fire-and-forget
   * dispatch.
   */
  private async handleAppDetected(payload: AppDetectedPayload): Promise<void> {
    // Skip apps currently being cloned
    if (this.gitDeployService?.isCloning(payload.name)) return;
    // Skip apps currently being uploaded (PRD-039) — same rationale as the
    // isCloning guard above: don't let the watcher onboard mid-upload.
    if (this.uploadDeployService?.isUploading(payload.name)) return;

    // Monorepo interception (M2): a root drop.yaml with a `services:` map
    // describes a group container, never a single app. Materialize each
    // declared service as its own top-level sibling app and skip the
    // normal single-app onboarding below for the container folder itself.
    const rootYaml = await parseDropYaml(payload.path);
    if (rootYaml.success && rootYaml.config?.services && Object.keys(rootYaml.config.services).length > 0) {
      this.watcher?.markAppKnown(payload.name);
      await this.expandMonorepo(payload.path, payload.name, rootYaml.config);
      return;
    }

    // Tell the watcher this app is known regardless of who published the
    // detection (git deploy publishes deterministically after a clone) —
    // otherwise the watcher's own debounced flush would emit a duplicate
    // app:detected for the same app a few seconds later. After the
    // isCloning guard on purpose: only mark what we actually onboard.
    this.watcher?.markAppKnown(payload.name);

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
    } else if (payload.type === 'unknown' && currentApp?.status !== 'stopped') {
      // Detection couldn't resolve a type: the build guard above never fires
      // for 'unknown', which used to leave the app registered at `pending`
      // forever with no logs explaining why. Fail loudly instead — a later
      // file change re-detects (handleAppUpdate only skips `stopped` apps),
      // so adding a drop.yaml/Procfile/manifest recovers the app automatically.
      await this.stateManager?.setAppStatus(payload.name, 'errored', {
        error:
          'Could not detect application type — add a drop.yaml, Procfile, or a recognized manifest ' +
          '(requirements.txt, package.json, go.mod, Dockerfile, index.html)',
      });
    }
  }

  private async handleBuildApp(appPath: string, appName: string, _appType: string): Promise<void> {
    if (!this.builder || !this.detector) return;

    // Skip if already processing this app
    if (this.appsInProgress.has(appName)) {
      this.logger.debug(`Skipping ${appName} - already in progress`, 'BUILD');
      return;
    }

    // Enforce global concurrent build limit. Deferred builds are queued and
    // retried by drainPendingBuilds as slots free, rather than waiting for a
    // file change that may never arrive (which left apps stuck "not started").
    if (this.config.maxConcurrentBuilds > 0 &&
        this.appsInProgress.size >= this.config.maxConcurrentBuilds) {
      this.logger.warn(
        `Build queue full (${this.appsInProgress.size}/${this.config.maxConcurrentBuilds}), ` +
        `deferring ${appName}`,
        'BUILD'
      );
      this.pendingBuilds.set(appName, { appPath, appType: _appType });
      this.scheduleBuildDrain();
      return;
    }

    // Proceeding — drop any queued entry for this app so the drain doesn't
    // start a duplicate build.
    this.pendingBuilds.delete(appName);
    this.appsInProgress.add(appName);

    this.logger.appEvent('building', appName);

    try {
      // Update state to building. Kept inside the try: if this write throws it
      // must not escape and leave the app wedged in appsInProgress — the catch
      // below releases the guard. (The success path intentionally keeps the
      // guard and hands off to handleStartApp, which owns the final release.)
      if (this.stateManager) {
        await this.stateManager.setAppStatus(appName, 'building');
      }

      const detection = await this.detector.detect(appPath, { silent: true });

      // Persist the real detected type. The watcher's app:detected event can't
      // know it (it only flags a hostname-pattern directory), and since detect()
      // no longer republishes (P1-6), this is the only place the stored type is
      // corrected from 'unknown' to the real runtime. Idempotent. The detector's
      // AppType is broader than the stored runtime union — cast to match, the
      // same way detectedSub does for the onboarding write.
      const detectedType = detection.type as
        | 'nodejs'
        | 'python'
        | 'go'
        | 'static'
        | 'docker'
        | 'unknown';
      if (this.appConfigService) {
        await this.appConfigService.updateConfig(appName, { type: detectedType });
      }
      if (this.stateManager) {
        await this.stateManager.updateApp(appName, { type: detectedType });
      }
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

      // Fresh deploy — nothing is currently serving this app, so a low-disk
      // abort is a hard failure: throw into the catch below, which marks the
      // app 'errored' and releases appsInProgress.
      const disk = await hasEnoughDisk(appPath);
      if (!disk.ok) {
        throw new Error(
          `Insufficient disk space: ${Math.round(disk.freeMb)} MB free, need ${getMinFreeDiskMb()} MB`
        );
      }

      const buildEnv = await this.resolveBuildEnv(appPath, appName);
      const buildOverride = (await parseDropYaml(appPath)).config?.build;

      const result = await this.builder.build({
        appName,
        appPath,
        appType: detection.type,
        framework: detection.framework || null,
        config: {
          buildCommand: buildOverride ?? detection.suggestedConfig?.buildCommand,
          installCommand: detection.suggestedConfig?.installCommand,
        },
        env: buildEnv,
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
        // Update config and state with build duration. Also persist where the
        // build's output landed: the start handler for THIS deploy already got
        // it via the build:completed payload (dispatched synchronously inside
        // build(), before this line runs) — this write is for later plain
        // restarts, which have no build to ask.
        if (this.appConfigService) {
          await this.appConfigService.updateConfig(appName, {
            buildDuration: result.duration,
            ...(result.outputPath ? { outputDirectory: result.outputPath } : {}),
          });
        }
        if (this.stateManager) {
          await this.stateManager.updateApp(appName, { buildDuration: result.duration });
        }
      } else if (result.errors?.[0]?.code === 'MAX_BUILDS') {
        // The builder's own concurrent-build cap fired (a redundant safety net
        // under the platform cap above). Don't error the app — re-queue it so
        // it retries when a slot frees, instead of leaving it permanently
        // failed after a transient burst.
        this.logger.warn(`Builder busy for ${appName}; re-queuing`, 'BUILD');
        this.appsInProgress.delete(appName);
        this.pendingBuilds.set(appName, { appPath, appType: _appType });
        this.scheduleBuildDrain();
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

  /** Schedule a single deferred drain of the pending-build queue (~2s later). */
  private scheduleBuildDrain(): void {
    if (this.buildDrainTimer) return;
    this.buildDrainTimer = setTimeout(() => {
      this.buildDrainTimer = null;
      void this.drainPendingBuilds();
    }, 2000);
    this.buildDrainTimer.unref?.();
  }

  /**
   * Start builds that were deferred by the concurrent-build cap, up to the
   * free slots, then re-arm while any remain queued. handleBuildApp adds to
   * appsInProgress synchronously (before its first await), so each dispatch in
   * this loop reserves its slot before the next iteration's size check, and
   * handleBuildApp re-queues itself if the cap refilled — so this converges
   * without over-subscribing.
   */
  private async drainPendingBuilds(): Promise<void> {
    for (const [appName, info] of [...this.pendingBuilds]) {
      if (this.config.maxConcurrentBuilds > 0 &&
          this.appsInProgress.size >= this.config.maxConcurrentBuilds) {
        break;
      }
      // Started some other way (or already running) since it was queued — drop it.
      if (this.appsInProgress.has(appName) ||
          this.stateManager?.getApp(appName)?.status === 'running') {
        this.pendingBuilds.delete(appName);
        continue;
      }
      this.pendingBuilds.delete(appName);
      void this.handleBuildApp(info.appPath, appName, info.appType);
    }
    if (this.pendingBuilds.size > 0) this.scheduleBuildDrain();
  }

  private async handleStartApp(appName: string, buildOutputDir?: string): Promise<void> {
    if (!this.runtime || !this.detector) {
      // Only reachable during teardown; release the guard so a queued deploy
      // isn't left wedged in appsInProgress forever.
      this.appsInProgress.delete(appName);
      return;
    }

    const appPath = path.join(this.config.appsDirectory, appName);

    try {
      // Update state to starting. Kept inside the try: if this write throws it
      // must not escape to the EventBus handler wrapper (which only logs) and
      // leave the app wedged in appsInProgress with no cleanup.
      if (this.stateManager) {
        await this.stateManager.setAppStatus(appName, 'starting');
      }

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

      const detection = await this.detector.detect(appPath, { silent: true });
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

      // Check if app needs Redis and provision a logical DB (fail-soft — a Redis
      // failure must never block the app start; the app just gets no REDIS_URL).
      const redisEnvVars = await this.provisionRedisEnvVars(appName, appPath);

      const spec = await this.buildStartSpec(
        appName,
        appPath,
        detection,
        port,
        dataDir,
        dbEnvVars,
        redisEnvVars,
        buildOutputDir
      );
      const status = await this.runtime.start(spec);

      this.logger.appEvent('started', appName, `PID ${status.pid}, port ${port}`);

      // Readiness gate: PM2/Docker report 'online' the instant a process is
      // (re)forked, so a crash-looping app satisfies runtime.start's own
      // wait — don't declare 'running' until the app actually proves it's up.
      // A first-deploy failure resolves to 'errored' (never 'crash-looping'):
      // the deploy tracker closes an episode only on running|errored, so
      // 'errored' is what makes deploy_files report the failure honestly.
      const readiness = await this.awaitReadiness(appName, port, spec);
      if (!readiness.ok) {
        this.logger.appEvent('error', appName, `readiness check failed: ${readiness.reason}`);
        if (this.stateManager) {
          await this.stateManager.setAppStatus(appName, 'errored', {
            port,
            pid: status.pid ?? undefined,
            error: `App started but failed its readiness check: ${readiness.reason}`,
          });
        }
        // The finally block releases appsInProgress; no prober/crash-watch here.
        return;
      }

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

      // Start health prober in PM2 mode (Docker uses its own HEALTHCHECK mechanism)
      if (spec.healthCheckPath && this.runtime?.type === 'pm2') {
        this.startHealthProber(appName, port, spec.healthCheckPath);
      }
      // Watch for a post-deploy crash-loop (both modes) — flips a running app to
      // 'crash-looping' when its runtime restart count climbs. Keyed on restart
      // count, not an HTTP rule, so a healthy JSON API (4xx at `/`) is never
      // mis-flagged. The deploy episode has already closed on 'running', so this
      // status change does not affect deploy_files.
      this.startCrashLoopWatch(appName);
    } catch (error) {
      this.logger.appEvent('error', appName, error instanceof Error ? error.message : 'Failed to start');
      if (this.stateManager) {
        await this.stateManager.setAppStatus(appName, 'errored', {
          error: error instanceof Error ? error.message : 'Failed to start',
        });
      }
    } finally {
      // Terminal handler: always release the in-progress guard on every settled
      // path (success, error, or a throw from the initial 'starting' write), so
      // a transient failure can never wedge the app out of future rebuilds.
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

      // Same-origin routing (M3): a monorepo child (a `group` in its config +
      // a `route` in its drop.yaml) is routed onto the SHARED group hostname
      // `<group>.<suffix>` at the route's path prefix — the frontend at `/`,
      // the backend at `/api*`. The group hostname is a COMPUTED default (not a
      // custom drop.yaml `domains` entry), so it bypasses the custom-domain
      // ownership guard below; two children coexist because the backend carries
      // a `/api*` prefix, making its Caddy site address differ from the
      // frontend's root address (identical addresses would wedge Caddy's
      // reload). A child that also declares custom `domains` opts out of this.
      let routePathPrefix: string | undefined;
      const appConfig = this.appConfigService?.getConfig(appName);
      const routeCfg = dropYaml.success ? dropYaml.config?.route : undefined;
      if (appConfig?.group && routeCfg && !hasCustomDomains) {
        domains = [`${appConfig.group}.${domainSuffix}`];
        const rp = routeCfg.path?.trim();
        if (rp && rp !== '/') {
          const prefix = (rp.startsWith('/') ? rp : `/${rp}`).replace(/\/+$/, '');
          // Caddy site-address path matcher: `<host>/api*` matches `/api` and
          // `/api/...`. No prefix stripping — the backend owns its `/api` path.
          routePathPrefix = prefix.endsWith('*') ? prefix : `${prefix}*`;
          if (routeCfg.strip) {
            this.logger.warn(
              `route.strip requested for ${appName} but prefix-stripping (Caddy handle_path) ` +
                `is not yet supported; serving with the prefix preserved (the backend must own '${prefix}')`,
              'ROUTER'
            );
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
          owner: appName, // Bare owning app name — lets removeRoutesForApp find every route this app owns
          hostname,
          ...(routePathPrefix ? { pathPrefix: routePathPrefix } : {}),
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
  private async handleAppUpdate(
    appName: string,
    appPath: string,
    reason: string,
    bypassCooldown?: boolean
  ): Promise<void> {
    if (!this.runtime || !this.stateManager || !this.detector || !this.builder) return;

    // Skip apps currently being cloned by git deploy
    if (this.gitDeployService?.isCloning(appName)) return;

    // Skip apps currently being uploaded (PRD-039)
    if (this.uploadDeployService?.isUploading(appName)) return;

    // Skip if already processing this app (e.g., during initial deployment).
    // An explicit redeploy that's dropped here is logged at info - the API/
    // webhook caller has already reported success, so a silent debug-level
    // drop would hide the fact that nothing actually happened.
    if (this.appsInProgress.has(appName)) {
      if (bypassCooldown) {
        this.logger.info(`Dropped redeploy for ${appName} - already in progress`, 'UPDATE');
      } else {
        this.logger.debug(`Skipping update for ${appName} - already in progress`, 'UPDATE');
      }
      return;
    }

    // A monorepo container (root drop.yaml has `services:`) is a group descriptor, never a buildable
    // app — the app:detected interception (see the detectedSub handler above) expands it into child
    // apps and never builds it. The git-deploy path registers the container in state, so without this
    // guard its app:update would fall through to detect-as-`unknown` → "No build strategy found". On an
    // EXPLICIT redeploy (bypassCooldown) re-expand — git pull refreshed the container and the children
    // are copies that must be re-materialized — via the same idempotent expandMonorepo path the
    // interception uses. On an incidental watcher file-settle (bypassCooldown false) skip: the
    // interception already expanded the children this deploy, and re-expanding would fs.rm/fs.cp their
    // folders out from under an in-flight build.
    const containerYaml = await parseDropYaml(appPath);
    if (
      containerYaml.success &&
      containerYaml.config?.services &&
      Object.keys(containerYaml.config.services).length > 0
    ) {
      if (bypassCooldown) {
        this.logger.info(`Re-expanding monorepo container '${appName}' (explicit redeploy)`, 'MONOREPO');
        await this.expandMonorepo(appPath, appName, containerYaml.config);
      } else {
        this.logger.debug(
          `Skipping update for monorepo container '${appName}' - not a buildable app`,
          'UPDATE'
        );
      }
      return;
    }

    // Skip if app was just deployed (adaptive cooldown to prevent loops), UNLESS
    // this is an explicit redeploy (bypassCooldown): the cooldown exists to stop
    // a build's own file writes from re-triggering the watcher, which an
    // explicit redeploy is not - and the watcher never sets this flag, so the
    // bypass can't leak into that loop-prevention path.
    // The window is max(5s, lastBuildDuration * 2) so Docker builds that take
    // minutes don't immediately re-trigger from their own output files.
    if (!bypassCooldown) {
      const lastDeployTime = this.appDeployTimes.get(appName);
      if (lastDeployTime && Date.now() - lastDeployTime < this.getEffectiveCooldownMs(appName)) {
        this.logger.debug(`Skipping update for ${appName} - within cooldown period`, 'UPDATE');
        return;
      }
    }

    const appState = this.stateManager.getApp(appName);
    if (!appState) {
      // App not yet registered - this can happen during initial deployment
      // when file changes are detected before app:detected is fully processed
      this.logger.debug(`Skipping update for ${appName} - not yet registered`, 'UPDATE');
      return;
    }

    // A user-stopped app must not be resurrected by a file-change hot-reload
    // (or an explicit redeploy). Every other deploy path guards on this
    // (detectedSub, buildSub); without it, any edit or touch to a stopped
    // app's files (git pull, editor autosave) silently rebuilds and restarts
    // it against the user's explicit `drop stop`.
    if (appState.status === 'stopped') {
      if (bypassCooldown) {
        this.logger.info(`Dropped redeploy for ${appName} - app was stopped by user`, 'UPDATE');
      } else {
        this.logger.debug(`Skipping update for ${appName} - app was stopped by user`, 'UPDATE');
      }
      return;
    }

    // Remember the current port and whether the app was running
    const originalPort = appState.port;
    const wasRunning = appState.status === 'running';

    this.logger.info(`Hot-reload triggered for ${appName}: ${reason}`, 'UPDATE');
    this.appsInProgress.add(appName);

    // Hot-reload — the app is currently RUNNING and serving traffic. Abort
    // with a `return`, never a `throw`: the catch below unconditionally marks
    // the app 'errored' and tears down its health prober, which is wrong for
    // a healthy running app that simply can't be rebuilt right now. Must run
    // after appsInProgress.add (before it would open a TOCTOU double-build
    // window) and before setAppStatus('building') (so status stays 'running').
    const disk = await hasEnoughDisk(appPath);
    if (!disk.ok) {
      this.logger.warn(
        `Skipping hot-reload of ${appName}: insufficient disk (${Math.round(disk.freeMb)} MB free, need ${getMinFreeDiskMb()} MB)`,
        'UPDATE'
      );
      this.appsInProgress.delete(appName);
      return;
    }

    try {
      // M5.1 deploy transaction: keep old version serving while the new build
      // runs. Only stop the old process after a successful build — on failure,
      // restore the `running` status so the old version stays live.
      await this.stateManager.setAppStatus(appName, 'building');

      // Re-detect and rebuild the app
      const detection = await this.detector.detect(appPath, { silent: true });

      // Persist the (possibly changed) type on hot-reload too — detect() is
      // silent, so this is the only place a static→node type change is recorded.
      const detectedType = detection.type as
        | 'nodejs'
        | 'python'
        | 'go'
        | 'static'
        | 'docker'
        | 'unknown';
      if (this.appConfigService) {
        await this.appConfigService.updateConfig(appName, { type: detectedType });
      }
      if (this.stateManager) {
        await this.stateManager.updateApp(appName, { type: detectedType });
      }

      const workDir = await this.getBuildWorkDir(appName);
      const updateLogId = this.buildLogService
        ? await this.buildLogService.startBuild(appName, new Date())
        : null;
      // Mark this app self-managed only around build(): the build:completed it
      // emits is dispatched synchronously inside build(), so buildSub sees the
      // marker and abstains from starting the app (handleAppUpdate starts it
      // below). finally guarantees the marker is cleared even on build failure —
      // a stuck marker would silently suppress the app's NEXT legit deploy.
      this.selfManagedUpdates.add(appName);
      let buildResult;
      try {
        const buildEnv = await this.resolveBuildEnv(appPath, appName);
        const buildOverride = (await parseDropYaml(appPath)).config?.build;
        buildResult = await this.builder.build({
          appName,
          appPath,
          appType: detection.type,
          framework: detection.framework || null,
          config: {
            buildCommand: buildOverride ?? detection.suggestedConfig?.buildCommand,
            installCommand: detection.suggestedConfig?.installCommand,
          },
          env: buildEnv,
          workDir,
          onBuildLog: updateLogId && this.buildLogService
            ? (line) => this.buildLogService!.writeLine(updateLogId, line)
            : undefined,
        });
      } finally {
        this.selfManagedUpdates.delete(appName);
      }
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

      // Build succeeded — now stop the old version and swap in the new one.
      // The port reservation is held throughout — no release here — because
      // buildFreshStartSpec's allocatePort() call below re-claims the same
      // config-sourced port; releasing it in between would open a window for
      // a concurrent deploy to steal it.
      // Also stop when the app is 'errored': the hot-reload catch block below
      // can mark an app errored while its PM2 process is still alive (the
      // failure happened after start), and skipping stop() here would hit
      // ProcessManager.start's online-early-return - a silent no-op that
      // leaves the old (broken) code running.
      if (wasRunning || appState.status === 'errored') {
        this.logger.info(`Stopping ${appName} to swap in new build...`, 'UPDATE');
        this.stopHealthProber(appName);
        await this.runtime.stop(appName);
      }

      this.appBuildDurations.set(appName, buildResult.duration);
      this.logger.appEvent('built', appName, `rebuilt in ${buildResult.duration}ms`);

      // Persist the rebuild's output dir for later plain restarts (mirrors
      // handleBuildApp); the start below gets the fresh value directly.
      if (this.appConfigService && buildResult.outputPath) {
        await this.appConfigService.updateConfig(appName, {
          outputDirectory: buildResult.outputPath,
        });
      }

      await this.stateManager.setAppStatus(appName, 'starting');

      const { spec, port } = await this.buildFreshStartSpec(
        appName,
        appPath,
        detection,
        buildResult.outputPath ?? undefined
      );
      const status = await this.runtime.start(spec);

      this.logger.appEvent('started', appName, `PID ${status.pid}, port ${port} (hot-reloaded)`);

      await this.stateManager.setAppStatus(appName, 'running', {
        port,
        pid: status.pid ?? undefined,
      });

      // Record deploy time for cooldown
      this.appDeployTimes.set(appName, Date.now());

      // Re-arm the health prober — stopHealthProber above tore it down and it
      // must restart against the new (hot-reloaded) process.
      if (spec.healthCheckPath && this.runtime?.type === 'pm2') {
        this.startHealthProber(appName, port, spec.healthCheckPath);
      }

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
   * Rebuild the start spec for an app the platform already knows about: port
   * resolution, the persistent data dir, and env vars for an
   * already-provisioned database (no new provisioning here — that only
   * happens on a fresh deploy, see handleStartApp). Shared by handleAppUpdate
   * (hot-reload) and restartApp so the two paths can't drift apart.
   *
   * State writes, health-prober (re)arming, and appDeployTimes bookkeeping
   * are NOT done here — they stay with the caller, which knows whether this
   * is a hot-reload or a restart and what else needs to happen around it.
   *
   * Port: allocatePort() is config-first (reuses the app's persisted port)
   * and does its own usedPorts bookkeeping; callers must NOT release the
   * port before calling this, or a concurrent deploy could steal it while
   * the spec is being rebuilt.
   */
  private async buildFreshStartSpec(
    appName: string,
    appPath: string,
    detection: DetectionResult,
    buildOutputDir?: string
  ): Promise<{ spec: AppStartSpec; port: number }> {
    const port = this.allocatePort(appName);

    // Ensure data directory exists (preserved across upgrades)
    const dataDir = await this.ensureAppDataDirectory(appName);

    // Get env vars for an already-provisioned DB (no new provisioning here).
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

    // Re-fetch the existing Redis allocation (idempotent; no new provisioning
    // on a hot-reload of an already-running app).
    const redisEnvVars = await this.provisionRedisEnvVars(appName, appPath);

    const spec = await this.buildStartSpec(
      appName,
      appPath,
      detection,
      port,
      dataDir,
      dbEnvVars,
      redisEnvVars,
      buildOutputDir
    );
    return { spec, port };
  }

  /**
   * Stop-if-running, rebuild the start spec from current state (secrets,
   * DATABASE_URL, DROP_DATA_DIR, dependency env), and start the app on its
   * existing port. Resolves once the app is running again.
   *
   * Serves both the start and restart routes via the platform-ops seam (see
   * api/platform-ops.ts): on a stopped app it degenerates to a fresh start.
   */
  async restartApp(appName: string): Promise<AppProcessInfo> {
    // Synchronous check-and-insert — no await between the check and the add,
    // mirroring handleAppUpdate — so two concurrent restarts of the same app
    // can't both pass the guard.
    if (this.appsInProgress.has(appName)) {
      throw new AppInProgressError(appName);
    }
    this.appsInProgress.add(appName);

    try {
      if (!this.runtime || !this.detector || !this.stateManager || !this.appConfigService) {
        throw new Error('Platform is not fully initialized');
      }

      // Resolve the app. Out-of-tree (admin-deployed) apps have state but no
      // appconf, so fall back through both before the webapps-dir default.
      const config = this.appConfigService.getConfig(appName);
      const state = this.stateManager.getApp(appName);
      if (!config && !state) {
        throw new Error(`Application not found: ${appName}`);
      }
      const appPath = config?.path || state?.path || path.join(this.config.appsDirectory, appName);

      const runtimeStatus = await this.runtime.getStatus(appName);
      const isRunning = runtimeStatus?.status === 'running';

      // Capacity guard: only relevant when this restart is actually starting
      // a currently-stopped app (same check as handleStartApp).
      if (!isRunning && this.config.maxConcurrentApps > 0) {
        const runningCount = this.stateManager.getAllApps().filter(
          (a) => a.status === 'running' || a.status === 'starting'
        ).length;
        if (runningCount >= this.config.maxConcurrentApps) {
          throw new Error(
            `App capacity reached (${runningCount}/${this.config.maxConcurrentApps} running). ` +
            `Stop an existing app before starting a new one, or increase DROP_MAX_CONCURRENT_APPS.`
          );
        }
      }

      try {
        this.stopHealthProber(appName);
        // Delete, not stop: PM2's env update on a bare restart/start is a
        // merge, so a removed secret would keep being injected; delete forces
        // a fresh registration (and, on docker, a fresh container) so the
        // spec built below is what actually ends up running.
        await this.runtime.delete(appName);

        const detection = await this.detector.detect(appPath, { silent: true });
        const { spec, port } = await this.buildFreshStartSpec(appName, appPath, detection);
        const status = await this.runtime.start(spec);

        this.logger.appEvent('started', appName, `PID ${status.pid}, port ${port} (restarted)`);

        await this.stateManager.setAppStatus(appName, 'running', {
          port,
          pid: status.pid ?? undefined,
        });

        // buildFreshStartSpec's drop-config.js write (static apps with
        // depends_on) lands inside the watched directory; record the deploy
        // time so the watcher's own debounced event doesn't read it back as a
        // user change and trigger a spurious hot-reload.
        this.appDeployTimes.set(appName, Date.now());

        if (spec.healthCheckPath && this.runtime.type === 'pm2') {
          this.startHealthProber(appName, port, spec.healthCheckPath);
        }

        return status;
      } catch (error) {
        this.logger.appEvent('error', appName, error instanceof Error ? error.message : 'Failed to restart');
        await this.stateManager.setAppStatus(appName, 'errored', {
          error: error instanceof Error ? error.message : 'Failed to restart',
        });
        throw error;
      }
    } finally {
      this.appsInProgress.delete(appName);
    }
  }

  /**
   * Full app teardown — mirrors the steps DELETE /apps/:name performs
   * (stop+delete the runtime process, remove Caddy routes, dump-then-drop
   * the provisioned database unless `keepData`, remove state/secrets/deploy
   * history/config, delete the generated folder). Used directly by
   * `removeGroup` for each group child; the DELETE route itself keeps its
   * own inline copy of these steps (not refactored to call this, to avoid
   * risk to the working single-app delete path — see M4 plan).
   *
   * Every step is independently best-effort (try/catch) so one failing step
   * (e.g. no provisioned database, PM2 already gone) never aborts the rest
   * of the teardown.
   */
  private async teardownApp(name: string, opts: { keepData?: boolean } = {}): Promise<void> {
    // Resolve the on-disk path BEFORE removing config/state — both are the
    // only places it's recorded, and both get deleted below.
    const appPath =
      this.appConfigService?.getConfig(name)?.path ??
      this.stateManager?.getApp(name)?.path ??
      path.join(this.config.appsDirectory, name);

    try {
      await this.runtime?.stop(name);
      await this.runtime?.delete(name);
    } catch {
      // Process might not exist in the runtime
    }

    // Explicit + deterministic: `stateManager.removeApp` below also triggers
    // this via `app:deleted` -> `handleAppDeleted`, but that's fire-and-forget
    // from this method's perspective. Calling it here directly means a caller
    // awaiting `teardownApp` (e.g. `removeGroup`, before it removes the group
    // container folder) knows routes are actually gone. The event-driven call
    // that follows is a harmless no-op (removeRoutesForApp no-ops when there's
    // nothing left to remove).
    try {
      await this.router?.removeRoutesForApp(name);
    } catch (err) {
      this.logger.warn(`Failed to remove routes for ${name}`, 'ROUTER', err);
    }

    if (!opts.keepData) {
      try {
        await this.dbProvisioner?.backupAndDeleteAppDatabase(name);
      } catch (err) {
        this.logger.warn(`Database teardown failed for ${name}`, 'DATABASE', err);
      }
      try {
        // Free the app's logical Redis DB (FLUSHDB + release the number).
        // Idempotent + fail-soft; a no-op if the app had no Redis.
        await this.redisProvisioner?.deprovisionAppRedis(name);
      } catch (err) {
        this.logger.warn(`Redis teardown failed for ${name}`, 'REDIS', err);
      }
    }

    try {
      await this.stateManager?.removeApp(name);
    } catch (err) {
      this.logger.warn(`Failed to remove state for ${name}`, 'STATE', err);
    }

    try {
      await this.secretManager?.deleteAll(name);
    } catch {
      // Secret manager may not be initialised
    }

    try {
      getDeployTracker().purgeApp(name);
    } catch {
      // Deploy tracker may not be initialised
    }

    try {
      await this.appConfigService?.deleteConfig(name);
    } catch {
      // Config may not exist
    }

    try {
      await fs.rm(appPath, { recursive: true, force: true });
    } catch {
      // Folder may already be gone
    }
  }

  /**
   * Tear down every app belonging to a monorepo group (M4): each child gets
   * the full `teardownApp` treatment, then the group's CONTAINER folder
   * (`webapps/<group>/`, which holds the root drop.yaml with `services:`) is
   * removed too — otherwise it would regenerate the deleted children on the
   * watcher's next scan. Per-child failures are isolated so one bad child
   * doesn't abort teardown of the rest. Exposed to the API via the
   * platform-ops seam (`removeGroup`).
   */
  async removeGroup(groupName: string): Promise<{ removed: string[] }> {
    const children = this.stateManager?.getAllApps().filter((a) => a.group === groupName) ?? [];
    const removed: string[] = [];

    for (const child of children) {
      try {
        await this.teardownApp(child.name);
        removed.push(child.name);
      } catch (err) {
        this.logger.error(
          `Failed to tear down '${child.name}' in group '${groupName}'`,
          'MONOREPO',
          err
        );
      }
    }

    // Defense-in-depth before a recursive fs.rm: the container path is derived
    // from a `group` tag. That tag is already transitively constrained to
    // [A-Za-z0-9_-] (expandMonorepo only creates children whose `<group>-<svc>`
    // name passes that regex), but re-assert it here so this destructive delete
    // can never escape the webapps directory even if a group value is ever set
    // by a future/other code path.
    if (/^[a-zA-Z0-9_-]+$/.test(groupName)) {
      try {
        await fs.rm(path.join(this.config.appsDirectory, groupName), { recursive: true, force: true });
      } catch (err) {
        this.logger.warn(`Failed to remove group container folder for '${groupName}'`, 'MONOREPO', err);
      }
    } else {
      this.logger.warn(
        `Refusing to remove container folder for group '${groupName}': unsafe name`,
        'MONOREPO'
      );
    }

    return { removed };
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
   * Block until a just-started app proves it's actually up, or fail. Returns
   * `{ ok: false }` (caller writes `errored`, closing the deploy episode) when:
   *  - the process exits or crash-loops (runtime restart count climbs) during
   *    the startup window; or
   *  - a web app never answers an HTTP probe within the window.
   * A background worker that never binds its assigned port AND declares no
   * healthCheck passes on process-liveness alone (never HTTP-gated). An HTTP
   * probe counts as success on ANY response (4xx/5xx included) — "the app
   * answered" means it's serving; a 404-at-`/` JSON API is healthy. Docker
   * port-bind alone is NOT trusted (the userland proxy accepts connections
   * before the in-container app listens), so in docker mode the HTTP probe is
   * required; in PM2 mode a bind is sufficient (lenient for slow-booting apps).
   * Never throws.
   */
  private async awaitReadiness(
    appName: string,
    port: number,
    spec: AppStartSpec
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!this.runtime) return { ok: true };
    const windowMs = this.readinessTimeoutMs;
    const isDocker = this.config.isolation === 'docker';
    const healthPath = spec.healthCheckPath || '/';
    const baselineRestarts = (await this.runtime.getStatus(appName))?.restarts ?? 0;
    const start = Date.now();

    /** Whether the process died or restarted (crash-loop) since start. */
    const liveness = async (): Promise<{ dead: boolean; crashed: boolean }> => {
      const info = await this.runtime?.getStatus(appName);
      if (!info || info.status === 'stopped' || info.status === 'errored') {
        return { dead: true, crashed: false };
      }
      return { dead: false, crashed: info.restarts > baselineRestarts };
    };

    // Poll: succeed as soon as an HTTP probe answers; fail as soon as the
    // process dies or crash-loops.
    while (Date.now() - start < windowMs) {
      const l = await liveness();
      if (l.dead) return { ok: false, reason: 'process exited during startup' };
      if (l.crashed) return { ok: false, reason: 'process crash-looped during startup' };
      if (await probePort('127.0.0.1', port, 1000)) {
        const r = await probeHttp('127.0.0.1', port, healthPath, 3000);
        if (r.responded) return { ok: true };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, windowMs)));
    }

    // Window elapsed with no HTTP success — classify the (stable) process.
    const l = await liveness();
    if (l.dead) return { ok: false, reason: 'process exited during startup' };
    if (l.crashed) return { ok: false, reason: 'process crash-looped during startup' };
    const bound = await probePort('127.0.0.1', port, 1000);
    if (!bound && !spec.healthCheckPath) return { ok: true }; // worker: no port, no health check
    if (bound && !isDocker) return { ok: true }; // PM2: a bind proves it's listening
    return {
      ok: false,
      reason: `no HTTP response on :${port} within ${Math.round(windowMs / 1000)}s`,
    };
  }

  /**
   * After a successful deploy, watch for the process entering a crash-loop and
   * flip its status to 'crash-looping'. Keyed on the runtime's restart count
   * (PM2 restart_time / Docker RestartCount), NOT an HTTP health rule, so a
   * healthy JSON API returning 4xx at `/` is never mis-flagged. Only escalates
   * an app that is currently 'running'. Both isolation modes.
   */
  private startCrashLoopWatch(appName: string): void {
    this.stopCrashLoopWatch(appName);
    let baseline: number | null = null;
    const interval = setInterval(async () => {
      try {
        const info = await this.runtime?.getStatus(appName);
        if (!info) return;
        if (baseline === null) {
          baseline = info.restarts;
          return;
        }
        if (this.stateManager?.getApp(appName)?.status !== 'running') return;
        if (info.restarts - baseline >= this.CRASHLOOP_RESTART_THRESHOLD) {
          this.logger.appEvent(
            'error',
            appName,
            `crash-looping (${info.restarts - baseline} restarts since deploy)`
          );
          await this.stateManager?.setAppStatus(appName, 'crash-looping', {
            error: 'Process is restarting repeatedly',
          });
          baseline = info.restarts; // re-baseline so we don't re-flag every tick
        }
      } catch {
        // Ignore errors in the watch itself.
      }
    }, 30_000);
    interval.unref?.();
    this.crashLoopWatchers.set(appName, interval);
  }

  private stopCrashLoopWatch(appName: string): void {
    const t = this.crashLoopWatchers.get(appName);
    if (t) {
      clearInterval(t);
      this.crashLoopWatchers.delete(appName);
    }
  }

  /** True if `p` exists on disk (best-effort; any access error → false). */
  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Constrain a static app's build-output subdir to a safe relative path.
   * The value is interpolated into nginx.conf (`root /app/<subdir>`) and can
   * originate from a user-supplied drop.yaml `build.output`, so absolute
   * paths, traversal, and anything that could smuggle nginx directives
   * (whitespace, `;`, `{`) must not pass. Invalid or root-ish values
   * collapse to '' — serve the app root, the pre-existing default.
   */
  private sanitizeOutputSubdir(subdir: string): string {
    const trimmed = subdir.replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!trimmed || trimmed === '.') return '';
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(trimmed)) return '';
    if (trimmed.split('/').some((seg) => seg === '..')) return '';
    return trimmed;
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
    dbEnvVars: Record<string, string>,
    redisEnvVars: Record<string, string> = {},
    buildOutputDir?: string
  ): Promise<AppStartSpec> {
    let script: string;
    let interpreter: string | undefined;
    let args: string[] | undefined;

    // Honor an explicit `start` command from drop.yaml as an override. The
    // manifest detector only reads the object form `start.command`, so a plain
    // `start: node dist/server.js` string (including the ones monorepo
    // expansion writes into each child's drop.yaml) was previously ignored,
    // leaving e.g. a TypeScript backend stuck on the `node index.js` default.
    const dropYamlCfg = await parseDropYaml(appPath);
    const startOverride = dropYamlCfg.success ? dropYamlCfg.config?.start : undefined;

    // Procfile `web:` is the next rung down: a user-provided, language-agnostic
    // start command (e.g. App B's Flask `python3 app.py`) that should win over
    // the detector's guessed framework default (e.g. a gunicorn invocation
    // against an app with no gunicorn dependency installed). Computed once so
    // both the go and generic branches below share the same precedence.
    const procfileWeb = await getProcfileWebCommand(appPath);

    if (detection.type === 'static' || detection.type === 'spa') {
      // Detection alone can't always name the build output dir: the manifest
      // detector wins detection for any app carrying a drop.yaml (confidence
      // 1.0) but only knows an explicit `build.output` — for a Vite/CRA app
      // typed `static` without one, serving the app root delivers the SOURCE
      // index.html (→ /src/main.tsx → octet-stream). Fall back to the dir the
      // build strategy reported: fresh from this build's payload, else the
      // value persisted after the last successful build (plain restarts).
      const outputSubdir = this.sanitizeOutputSubdir(
        detection.suggestedConfig?.outputDirectory ||
          buildOutputDir ||
          this.appConfigService?.getConfig(appName)?.outputDirectory ||
          ''
      );
      if (this.config.isolation === 'docker') {
        const nginxConf = buildNginxConf(port, outputSubdir);
        const nginxConfPath = path.join(dataDir, 'nginx.conf');
        await fs.writeFile(nginxConfPath, nginxConf, 'utf-8');
        this.logger.info(`Wrote nginx.conf for ${appName} → port ${port}`, 'STATIC');

        // Tier B: nginx runs unprivileged (uid 101, zero caps), so the full
        // config is passed via -c from the bind-mounted data dir instead of
        // being copied into root-owned /etc/nginx.
        script = '/bin/sh';
        interpreter = 'none';
        args = ['-c', `nginx -c ${nginxConfPath} -g 'daemon off;'`];
      } else {
        const serveDir = path.join(appPath, outputSubdir || '.');
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
      // Precedence: drop.yaml `start` (explicit override) → Procfile `web:` →
      // detector-suggested command → the built binary default.
      const startCommand =
        startOverride || procfileWeb || detection.suggestedConfig?.startCommand || `./${appName}`;
      if (this.config.isolation === 'docker') {
        // Docker execs the container Cmd array directly, with no shell — so a
        // multi-token command or an env ref (e.g. $PORT) must go through
        // /bin/sh -c to split args and expand vars.
        script = '/bin/sh';
        interpreter = 'none';
        args = ['-c', startCommand];
      } else {
        script = startCommand;
        interpreter = 'none';
      }
    } else {
      // Precedence: drop.yaml `start` (explicit override, DROP's own manifest,
      // sits above everything else) → Procfile `web:` (a user-provided,
      // language-agnostic start command) → the detector's framework-guessed
      // command → the generic default. This is why a Flask app's Procfile
      // `python3 app.py` wins over the python detector's gunicorn default —
      // the gunicorn command is never reached, so a missing gunicorn
      // dependency can't break the start.
      const startCommand =
        startOverride || procfileWeb || detection.suggestedConfig?.startCommand || 'node index.js';
      // Python deps are installed into an in-app-dir virtualenv (.venv) by
      // PythonBuildStrategy so they survive into the fresh runtime; put its
      // bin dir first on PATH so `gunicorn`/`uvicorn`/`python` resolve to the
      // installed packages. The venv is always written to the real (host)
      // appPath by the build step — check for it there regardless of run
      // mode — but embed whichever base dir the command will actually run
      // against: the container's /app mount under docker, or appPath itself
      // under PM2 (no remapping on the host).
      const isPython = ['python', 'django', 'flask', 'fastapi'].includes(detection.type);
      const venvPrefixFor = async (baseDir: string): Promise<string> =>
        isPython && (await this.pathExists(path.join(appPath, '.venv')))
          ? `export PATH="${baseDir}/.venv/bin:$PATH"; `
          : '';

      if (this.config.isolation === 'docker') {
        // Docker execs the Cmd array directly with NO shell, so a multi-token
        // start command — the python detector's `gunicorn --bind 0.0.0.0:$PORT
        // app:app`/`uvicorn ... --port $PORT`, or `node dist/server.js` — would
        // be treated as one bogus executable name and $PORT would never expand.
        // Run it through /bin/sh -c. `exec` replaces the shell with the app
        // process so the container's PID 1 is the real app (correct signal
        // handling / metrics / crash-restart).
        const venvPrefix = await venvPrefixFor('/app');
        script = '/bin/sh';
        interpreter = 'none';
        args = ['-c', `${venvPrefix}exec ${startCommand}`];
      } else {
        // PM2 fork mode: previously this branch passed the raw, possibly
        // multi-token startCommand as a bare `script` (with any leading
        // `node ` stripped) and no args/interpreter — PM2 treated it as a
        // single executable name, so a multi-token command (gunicorn/uvicorn
        // invocations, `python app.py --flag`) failed with ENOENT and $PORT
        // (only present in the child env) never expanded. Mirror the docker
        // branch's shape: run through /bin/sh -c so the command is split and
        // $PORT expands, and `exec` so the shell is replaced by the app
        // process — PM2 then monitors the real app's PID (correct
        // metrics/restart/memory-cap). Node gets no venv prefix (isPython is
        // false for it), so its command stays prefix-free:
        // `/bin/sh -c 'exec node …'`.
        const venvPrefix = await venvPrefixFor(appPath);
        script = '/bin/sh';
        interpreter = 'none';
        args = ['-c', `${venvPrefix}exec ${startCommand}`];
      }
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

    const healthCheckPath = dropYamlCfg.success ? dropYamlCfg.config?.healthCheck : undefined;

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

    // The DROP control-plane API is reachable from docker-isolated containers
    // via the `drop-host` ExtraHosts alias (ContainerManager); non-isolated
    // (PM2) apps share the host's loopback directly. Placed after
    // ...secretEnvVars below so it is platform-authoritative — a tenant
    // secret must not be able to redirect the destination of an admin
    // Bearer credential.
    const dropApiUrl =
      this.config.isolation === 'docker'
        ? `http://${HOST_ALIAS}:${this.config.apiPort}`
        : `http://127.0.0.1:${this.config.apiPort}`;

    // Admin-conferred capability grant (PR2): apps with a non-empty
    // grantedApiScopes get a fresh, scope-only (role: 'none') provisioning
    // key minted and rotated on every start — the previous key (if any) is
    // deleted first so a stale key never remains valid. Ungranted apps get
    // no DROP_API_KEY at all. Minting is best-effort: if auth isn't
    // initialized (e.g. DROP_DISABLE_AUTH), skip rather than fail the deploy.
    const grantedScopes = this.appConfigService?.getConfig(appName)?.grantedApiScopes ?? [];
    let dropApiKey: string | undefined;
    if (grantedScopes.length > 0) {
      try {
        await deleteApiKeysByName(`app:${appName}:provision`);
        const { key } = await createApiKey(`app:${appName}:provision`, 'none', undefined, grantedScopes);
        dropApiKey = key;
      } catch (err) {
        this.logger.warn(`Could not mint provisioning key for ${appName}`, 'SECURITY', err);
      }
    }

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
        // drop.yaml `env` (tenant config) is the base layer — now injected at
        // START as well as build, so `env:` is honored end-to-end. Placed
        // FIRST so secrets and every platform-authoritative var (PORT,
        // DROP_DATA_DIR, DROP_API_URL/KEY, DATABASE_URL) still override it and
        // a tenant cannot hijack them. `build_env` is intentionally NOT
        // injected here — it is build-only by design.
        ...this.coerceEnvRecord(dropYamlCfg.success ? dropYamlCfg.config?.env : undefined),
        ...secretEnvVars,
        NODE_ENV: 'production',
        PORT: port.toString(),
        DROP_DATA_DIR: dataDir,
        DROP_API_URL: dropApiUrl,
        ...(dropApiKey ? { DROP_API_KEY: dropApiKey } : {}),
        ...dbEnvVars,
        ...redisEnvVars,
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

    // Allocate a new port: scan the full configured range for the first free
    // slot so interior gaps freed by app:deleted are reused, rather than a
    // monotonic cursor that only ever moves forward. Synchronous — no await
    // between the scan and the claim — so two concurrent callers can't race
    // onto the same port (see docs/plans/2026-07-07-p2-5-disk-and-port-guards.md).
    for (let p = this.config.portRangeStart; p <= this.config.portRangeEnd; p++) {
      if (!this.usedPorts.has(p)) {
        this.usedPorts.set(p, appName ?? '__anonymous__');
        return p;
      }
    }

    throw new Error('No available ports in configured range');
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
