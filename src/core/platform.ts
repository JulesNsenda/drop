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
import { DetectorService, getDetector } from './detector';
import { BuilderService, getBuilder } from './builder';
import { RouterService, getRouterService, resetRouterService } from './router';
import { ProcessManager, getProcessManager, resetProcessManager } from '../managers/process';
import { AppStateManager, getStateManager, resetStateManager } from '../managers/app/state-manager';
import { PostgresServer, getPostgresServer, resetPostgresServer, DatabaseProvisioner } from '../managers/database';
import { Logger, createLogger } from '../utils/logger';

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
  /** Enable API server */
  enableApi: boolean;
  /** API server port */
  apiPort: number;
  /** Enable API authentication */
  enableApiAuth: boolean;
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
  enableApi: true,
  apiPort: 3000,
  enableApiAuth: process.env.NODE_ENV === 'production',
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
  private postgresServer: PostgresServer | null = null;
  private dbProvisioner: DatabaseProvisioner | null = null;

  private subscriptions: Unsubscribe[] = [];
  private isRunning = false;
  private nextPort: number;
  private usedPorts: Set<number> = new Set();
  private appsInProgress: Set<string> = new Set(); // Track apps being built/started

  constructor(config?: Partial<PlatformConfig>) {
    this.config = {
      ...DEFAULT_CONFIG,
      dropRoot: config?.dropRoot ?? process.env.DROP_ROOT ?? DEFAULT_CONFIG.dropRoot,
      appsDirectory: config?.appsDirectory ?? process.env.DROP_APPS_DIR ?? DEFAULT_CONFIG.appsDirectory,
      logLevel: config?.logLevel ?? (process.env.DROP_LOG_LEVEL as PlatformConfig['logLevel']) ?? DEFAULT_CONFIG.logLevel,
      enableHttps: config?.enableHttps ?? (process.env.DROP_ENABLE_HTTPS !== undefined ? process.env.DROP_ENABLE_HTTPS === 'true' : DEFAULT_CONFIG.enableHttps),
      acmeEmail: config?.acmeEmail ?? process.env.DROP_ACME_EMAIL ?? DEFAULT_CONFIG.acmeEmail,
      acmeStaging: config?.acmeStaging ?? (process.env.DROP_ACME_STAGING !== undefined ? process.env.DROP_ACME_STAGING === 'true' : DEFAULT_CONFIG.acmeStaging),
      domainSuffix: config?.domainSuffix ?? process.env.DROP_DOMAIN_SUFFIX ?? DEFAULT_CONFIG.domainSuffix,
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

    // Unsubscribe from all events
    for (const unsub of this.subscriptions) {
      unsub();
    }
    this.subscriptions = [];

    // Stop services in reverse order
    if (this.watcher) {
      await this.watcher.stop();
    }

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

    // Stop PostgreSQL server
    if (this.postgresServer) {
      this.logger.info('Stopping PostgreSQL...', 'DATABASE');
      await this.postgresServer.stop();
      resetPostgresServer();
    }

    this.isRunning = false;
    this.eventBus.publish('platform:stopped', { timestamp: new Date() });
    this.logger.platformEvent('stopped');
    this.logger.close();
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
        enableAdminApi: false,
      },
    });

    // Initialize watcher (watches apps directory)
    this.watcher = new WatcherService({
      appsDir: this.config.appsDirectory,
      ignorePatterns: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      debounceMs: 1000,
      maxDepth: 2,
    });
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
          // App was marked running but isn't - mark as stopped
          await this.stateManager.setAppStatus(app.name, 'stopped');
        }
      }

      this.logger.info(`Synced state with ${processes.length} processes`, 'STATE');
    } catch (error) {
      this.logger.warn('Failed to sync state with processes', 'STATE', error);
    }
  }

  private setupEventHandlers(): void {
    // When watcher detects a new directory, detect the app type
    const watcherSub = this.eventBus.subscribe('watcher:change', async (payload) => {
      if (payload.changeType === 'addDir' && this.isTopLevelApp(payload.path)) {
        await this.handleNewApp(payload.path);
      }
    });
    this.subscriptions.push(watcherSub);

    // When app is detected, build it
    const detectedSub = this.eventBus.subscribe('app:detected', async (payload) => {
      if (this.config.autoBuild && payload.type !== 'unknown') {
        await this.handleBuildApp(payload.path, payload.name, payload.type as string);
      }
    });
    this.subscriptions.push(detectedSub);

    // When build completes, start the app
    const buildSub = this.eventBus.subscribe('build:completed', async (payload) => {
      if (this.config.autoStart) {
        await this.handleStartApp(payload.appId);
      }
    });
    this.subscriptions.push(buildSub);

    // When app starts, configure routing
    const startedSub = this.eventBus.subscribe('app:started', async (payload) => {
      await this.handleConfigureRoute(payload.name, payload.port);
    });
    this.subscriptions.push(startedSub);
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
    this.logger.appEvent('detected', appName);

    if (!this.detector) return;

    try {
      const result = await this.detector.detect(appPath);
      this.logger.info(`Detected ${appName} as ${result.type} (confidence: ${result.confidence})`, 'DETECTOR');

      // Register app in state manager
      if (this.stateManager) {
        await this.stateManager.registerApp(
          appName,
          appPath,
          result.type as 'nodejs' | 'python' | 'static' | 'docker' | 'unknown',
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
        // Update state with build duration
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
      const port = this.allocatePort();

      this.logger.appEvent('starting', appName, `port ${port}`);

      // Determine start command based on app type
      let script: string;
      let interpreter: string | undefined;
      let args: string[] | undefined;

      if (detection.type === 'static' || detection.type === 'spa') {
        // Static sites use our built-in static server
        const serveDir = path.join(appPath, detection.suggestedConfig?.outputDirectory || '.');
        // Use the compiled static-server.js from dist
        script = path.join(__dirname, 'static-server.js');
        args = [serveDir, '-s']; // -s for SPA mode
      } else {
        // For Node.js apps, the detector returns "node <file>" format
        const startCommand = detection.suggestedConfig?.startCommand || 'node index.js';

        if (startCommand.startsWith('node ')) {
          // Extract the script file from "node <file>"
          script = startCommand.substring(5); // Remove "node " prefix
        } else {
          script = startCommand;
        }
      }

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

      const status = await this.processManager.start({
        name: appName,
        script,
        interpreter,
        args,
        cwd: appPath,
        port,
        env: {
          NODE_ENV: 'production',
          PORT: port.toString(),
          ...dbEnvVars,
          ...depEnvVars,
        },
      });

      this.logger.appEvent('started', appName, `PID ${status.pid}, port ${port}`);

      // Update state to running with port and pid
      if (this.stateManager) {
        await this.stateManager.setAppStatus(appName, 'running', {
          port,
          pid: status.pid ?? undefined,
        });
      }

      // App is fully deployed now
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
      const hostname = `${appName}.${domainSuffix}`;
      const enableSsl = this.config.enableHttps && domainSuffix !== 'localhost';

      await this.router.addRoute({
        appName,
        hostname,
        upstream: `localhost:${port}`,
        ssl: enableSsl,
        redirectHttps: enableSsl,
        tls: enableSsl ? { auto: true } : undefined,
      });

      const protocol = enableSsl ? 'https' : 'http';
      this.logger.info(`Route configured: ${protocol}://${hostname} -> localhost:${port}`, 'ROUTER');
    } catch (error) {
      // Route might already exist
      this.logger.warn(`Failed to configure route for ${appName}`, 'ROUTER', error);
    }
  }

  private allocatePort(): number {
    while (this.usedPorts.has(this.nextPort) && this.nextPort <= this.config.portRangeEnd) {
      this.nextPort++;
    }

    if (this.nextPort > this.config.portRangeEnd) {
      throw new Error('No available ports in configured range');
    }

    const port = this.nextPort;
    this.usedPorts.add(port);
    this.nextPort++;
    return port;
  }

  releasePort(port: number): void {
    this.usedPorts.delete(port);
  }

  /**
   * Load used ports from existing PM2 processes
   * This ensures we don't allocate ports that are already in use
   */
  private async loadUsedPorts(): Promise<void> {
    if (!this.processManager) return;

    try {
      const processes = await this.processManager.getAllStatus();
      for (const proc of processes) {
        if (proc.port && proc.status === 'online') {
          this.usedPorts.add(proc.port);
          this.logger.debug(`Port ${proc.port} already in use by ${proc.name}`, 'PORT');
        }
      }

      // Find the highest used port to set nextPort correctly
      if (this.usedPorts.size > 0) {
        const maxPort = Math.max(...this.usedPorts);
        if (maxPort >= this.nextPort) {
          this.nextPort = maxPort + 1;
        }
      }

      this.logger.info(`Loaded ${this.usedPorts.size} used ports from running apps`, 'PORT');
    } catch (error) {
      this.logger.warn('Failed to load used ports from PM2', 'PORT', error);
    }
  }

  /** @deprecated Use this.logger instead */
  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, error?: unknown): void {
    this.logger.log(level, message, undefined, error);
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

  getPostgresServer(): PostgresServer | null {
    return this.postgresServer;
  }

  getDatabaseProvisioner(): DatabaseProvisioner | null {
    return this.dbProvisioner;
  }

  isActive(): boolean {
    return this.isRunning;
  }
}

// Factory function
export function createPlatform(config?: Partial<PlatformConfig>): DropPlatform {
  return new DropPlatform(config);
}
