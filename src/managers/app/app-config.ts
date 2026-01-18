/**
 * App Config Service
 *
 * Manages per-app configuration files stored in appconf/webapps/.
 * Each app has its own YAML config file that persists across restarts.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';

export interface AppConfig {
  name: string;
  type: 'nodejs' | 'python' | 'static' | 'docker' | 'unknown';
  port?: number;
  framework?: string;
  hostname?: string;
  path?: string;
  createdAt: string;
  lastDeployedAt?: string;
  buildDuration?: number;
  env?: Record<string, string>;
  /** Persistent data directory path - survives app upgrades */
  dataDir?: string;
}

export interface AppConfigServiceOptions {
  configDir: string; // e.g., /var/drop/data/appconf/webapps
  webappsDir: string; // e.g., /var/drop/data/webapps
}

export class AppConfigService {
  private readonly configDir: string;
  private readonly webappsDir: string;
  private configs: Map<string, AppConfig> = new Map();
  private initialized = false;

  constructor(options: AppConfigServiceOptions) {
    this.configDir = options.configDir;
    this.webappsDir = options.webappsDir;
  }

  /**
   * Initialize the service - ensures directory exists and loads existing configs
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure config directory exists
    await fs.mkdir(this.configDir, { recursive: true });

    // Load all existing configs
    await this.loadAllConfigs();

    // Clean up stale configs (where app folder no longer exists)
    await this.cleanupStaleConfigs();

    this.initialized = true;
  }

  /**
   * Load all app configs from the config directory
   */
  private async loadAllConfigs(): Promise<void> {
    try {
      const files = await fs.readdir(this.configDir);
      const yamlFiles = files.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));

      for (const file of yamlFiles) {
        const appName = path.basename(file, path.extname(file));
        const config = await this.loadConfig(appName);
        if (config) {
          this.configs.set(appName, config);
        }
      }
    } catch (error) {
      // Directory might not exist yet - that's fine
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * Load a single app config from file
   */
  private async loadConfig(appName: string): Promise<AppConfig | null> {
    const configPath = this.getConfigPath(appName);
    try {
      const content = await fs.readFile(configPath, 'utf-8');
      const config = yaml.parse(content) as AppConfig;
      return config;
    } catch {
      return null;
    }
  }

  /**
   * Clean up config files for apps that no longer exist
   */
  private async cleanupStaleConfigs(): Promise<void> {
    const staleApps: string[] = [];

    for (const [appName, _config] of this.configs) {
      const appPath = path.join(this.webappsDir, appName);
      try {
        await fs.access(appPath);
      } catch {
        // App folder doesn't exist - mark for cleanup
        staleApps.push(appName);
      }
    }

    for (const appName of staleApps) {
      await this.deleteConfig(appName);
      this.configs.delete(appName);
    }
  }

  /**
   * Get the config file path for an app
   */
  private getConfigPath(appName: string): string {
    return path.join(this.configDir, `${appName}.yaml`);
  }

  /**
   * Save an app config to file
   */
  async saveConfig(config: AppConfig): Promise<void> {
    const configPath = this.getConfigPath(config.name);
    const content = yaml.stringify(config, { indent: 2 });
    await fs.writeFile(configPath, content, 'utf-8');
    this.configs.set(config.name, config);
  }

  /**
   * Get an app config
   */
  getConfig(appName: string): AppConfig | undefined {
    return this.configs.get(appName);
  }

  /**
   * Check if an app has a config
   */
  hasConfig(appName: string): boolean {
    return this.configs.has(appName);
  }

  /**
   * Get all app configs
   */
  getAllConfigs(): AppConfig[] {
    return Array.from(this.configs.values());
  }

  /**
   * Create or update an app config
   */
  async upsertConfig(appName: string, updates: Partial<AppConfig>): Promise<AppConfig> {
    const existing = this.configs.get(appName);
    const now = new Date().toISOString();

    const config: AppConfig = {
      ...existing,
      ...updates,
      name: appName, // Ensure name is always correct
      type: updates.type ?? existing?.type ?? 'unknown',
      createdAt: existing?.createdAt ?? now,
    };

    await this.saveConfig(config);
    return config;
  }

  /**
   * Update specific fields of an app config
   */
  async updateConfig(appName: string, updates: Partial<AppConfig>): Promise<AppConfig | null> {
    const existing = this.configs.get(appName);
    if (!existing) return null;

    const config: AppConfig = {
      ...existing,
      ...updates,
      name: appName, // Ensure name is always correct
    };

    await this.saveConfig(config);
    return config;
  }

  /**
   * Delete an app config
   */
  async deleteConfig(appName: string): Promise<boolean> {
    const configPath = this.getConfigPath(appName);
    try {
      await fs.unlink(configPath);
      this.configs.delete(appName);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get all assigned ports from configs
   */
  getAssignedPorts(): Map<number, string> {
    const ports = new Map<number, string>();
    for (const [appName, config] of this.configs) {
      if (config.port) {
        ports.set(config.port, appName);
      }
    }
    return ports;
  }

  /**
   * Check if a port is assigned to any app
   */
  isPortAssigned(port: number): boolean {
    for (const config of this.configs.values()) {
      if (config.port === port) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get the app that owns a specific port
   */
  getAppByPort(port: number): string | undefined {
    for (const [appName, config] of this.configs) {
      if (config.port === port) {
        return appName;
      }
    }
    return undefined;
  }
}

// Singleton instance
let appConfigServiceInstance: AppConfigService | null = null;

export function getAppConfigService(options?: AppConfigServiceOptions): AppConfigService {
  if (!appConfigServiceInstance) {
    if (!options) {
      throw new Error('AppConfigService options required on first call');
    }
    appConfigServiceInstance = new AppConfigService(options);
  }
  return appConfigServiceInstance;
}

export function resetAppConfigService(): void {
  appConfigServiceInstance = null;
}
