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
};

export class DropPlatform {
  private readonly config: PlatformConfig;
  private readonly eventBus: EventBus;

  private watcher: WatcherService | null = null;
  private detector: DetectorService | null = null;
  private builder: BuilderService | null = null;
  private processManager: ProcessManager | null = null;
  private router: RouterService | null = null;

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
      ...config,
    };
    this.eventBus = eventBus;
    this.nextPort = this.config.portRangeStart;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('DROP platform is already running');
    }

    this.log('info', 'Starting DROP platform...');
    this.log('info', `  Drop root: ${this.config.dropRoot}`);
    this.log('info', `  Apps directory: ${this.config.appsDirectory}`);

    this.eventBus.publish('platform:starting', { config: this.config as unknown as Record<string, unknown> });

    try {
      // Ensure required directories exist
      await this.ensureDirectories();

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
      this.log('info', 'DROP platform started successfully');
    } catch (error) {
      this.log('error', 'Failed to start platform', error);
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.log('info', 'Stopping DROP platform...');
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

    this.isRunning = false;
    this.eventBus.publish('platform:stopped', { timestamp: new Date() });
    this.log('info', 'DROP platform stopped');
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
    // Initialize detector
    this.detector = getDetector();

    // Initialize builder
    this.builder = getBuilder();

    // Initialize process manager
    this.processManager = getProcessManager();

    // Initialize router
    this.router = getRouterService({
      caddy: {
        caddyfilePath: this.config.caddyfilePath,
        autoReload: true,
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
    this.log('info', `New app detected: ${appName}`);

    if (!this.detector) return;

    try {
      const result = await this.detector.detect(appPath);
      this.log('info', `Detected ${appName} as ${result.type} (confidence: ${result.confidence})`);
    } catch (error) {
      this.log('error', `Failed to detect app type for ${appName}`, error);
    }
  }

  private async handleBuildApp(appPath: string, appName: string, _appType: string): Promise<void> {
    if (!this.builder || !this.detector) return;

    // Skip if already processing this app
    if (this.appsInProgress.has(appName)) {
      this.log('debug', `Skipping ${appName} - already in progress`);
      return;
    }
    this.appsInProgress.add(appName);

    this.log('info', `Building ${appName}...`);

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
        this.log('info', `Build completed for ${appName} in ${result.duration}ms`);
      } else {
        this.log('error', `Build failed for ${appName}: ${result.errors?.[0]?.message}`);
        this.appsInProgress.delete(appName);
      }
    } catch (error) {
      this.log('error', `Build failed for ${appName}`, error);
      this.appsInProgress.delete(appName);
    }
  }

  private async handleStartApp(appName: string): Promise<void> {
    if (!this.processManager || !this.detector) return;

    const appPath = path.join(this.config.appsDirectory, appName);

    try {
      const detection = await this.detector.detect(appPath);
      const port = this.allocatePort();

      this.log('info', `Starting ${appName} on port ${port}...`);

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

      const status = await this.processManager.start({
        name: appName,
        script,
        interpreter,
        args,
        cwd: appPath,
        port,
        env: { NODE_ENV: 'production' },
      });

      this.log('info', `Started ${appName} (PID: ${status.pid})`);
      // App is fully deployed now
      this.appsInProgress.delete(appName);
    } catch (error) {
      this.log('error', `Failed to start ${appName}`, error);
      this.appsInProgress.delete(appName);
    }
  }

  private async handleConfigureRoute(appName: string, port: number): Promise<void> {
    if (!this.router || !port) return;

    try {
      const hostname = `${appName}.localhost`;

      await this.router.addRoute({
        appName,
        hostname,
        upstream: `localhost:${port}`,
        ssl: false,
        redirectHttps: false,
      });

      this.log('info', `Route configured: ${hostname} -> localhost:${port}`);
    } catch (error) {
      // Route might already exist
      this.log('warn', `Failed to configure route for ${appName}`, error);
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

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, error?: unknown): void {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    if (levels[level] >= levels[this.config.logLevel]) {
      const timestamp = new Date().toISOString();
      const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

      if (level === 'error') {
        console.error(`${prefix} ${message}`, error || '');
      } else if (level === 'warn') {
        console.warn(`${prefix} ${message}`, error || '');
      } else {
        console.log(`${prefix} ${message}`);
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

  isActive(): boolean {
    return this.isRunning;
  }
}

// Factory function
export function createPlatform(config?: Partial<PlatformConfig>): DropPlatform {
  return new DropPlatform(config);
}
