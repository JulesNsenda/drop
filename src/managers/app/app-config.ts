/**
 * App Config Service
 *
 * Manages per-app configuration files stored in appconf/webapps/.
 * Each app has its own YAML config file that persists across restarts.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';
import { writeFileAtomic } from '../../utils/atomic-write';
import type { RuntimeType } from '../runtime/app-runtime.types';

export interface AppConfig {
  name: string;
  type: 'nodejs' | 'python' | 'go' | 'static' | 'docker' | 'unknown';
  /**
   * Which runtime executes this app. Pre-v2 config files have no value;
   * they are normalized to 'pm2' on load so upgrades are config-compatible.
   * Set to 'docker' per app by the PM2→container cutover (PRD-029).
   */
  runtime?: RuntimeType;
  port?: number;
  framework?: string;
  hostname?: string;
  path?: string;
  createdAt: string;
  lastDeployedAt?: string;
  buildDuration?: number;
  /**
   * Build output directory relative to the app root (e.g. 'dist'), as reported
   * by the build strategy after the last successful build. The static serve
   * path falls back to this when detection can't supply one: the manifest
   * detector wins detection for any app carrying a drop.yaml (confidence 1.0)
   * but only knows an explicit `build.output`, so without this a built SPA
   * would be served from its source root on restart.
   */
  outputDirectory?: string;
  env?: Record<string, string>;
  /** Persistent data directory path - survives app upgrades */
  dataDir?: string;
  /** Custom domains for this app (from drop.yaml) */
  domains?: string[];
  /** Custom TLS configuration */
  tls?: {
    certFile?: string;
    keyFile?: string;
    disabled?: boolean;
  };
  /**
   * Capability scopes DROP has granted this app for calling its own control-plane
   * API (e.g. ['users:create']). Admin-conferred, default none. When non-empty,
   * DROP mints a least-privilege per-app API key (role 'none' + these scopes) and
   * injects it as DROP_API_KEY at start — so the app never holds a full admin key.
   * See docs/plans/2026-07-11-scoped-provisioning-token.md.
   */
  grantedApiScopes?: string[];
  /**
   * Grouping tag for apps expanded from a single monorepo deploy (e.g. a repo
   * `ezsign` with `services: {backend, frontend}` expands to apps
   * `ezsign-backend` / `ezsign-frontend`, both tagged `group: ezsign`). Lets
   * lifecycle ops and the dashboard relate sibling apps. Absent for ordinary
   * standalone apps. See docs/plans/2026-07-12-monorepo-multi-service.md (M2).
   */
  group?: string;
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
  /**
   * Per-app write chain. Concurrent upsert/update/delete for the same app run
   * one after another so a call can't read a stale in-memory snapshot and then
   * overwrite a field a concurrent call just wrote (lost update). Keyed by app;
   * different apps never block each other.
   */
  private writeChains: Map<string, Promise<unknown>> = new Map();

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
      // v1 config files predate the runtime field
      if (config && !config.runtime) {
        config.runtime = 'pm2';
      }
      return config;
    } catch {
      return null;
    }
  }

  /**
   * Clean up config files for apps that no longer exist
   */
  private async cleanupStaleConfigs(): Promise<void> {
    // Guard: if the webapps root itself is unreachable (e.g. a network mount
    // that's briefly down at startup), do NOT treat every app as stale and
    // delete all their configs — including their canonical port assignments.
    try {
      await fs.access(this.webappsDir);
    } catch {
      console.warn(
        `[app-config] webapps directory ${this.webappsDir} is not accessible; skipping stale-config cleanup`
      );
      return;
    }

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
    await writeFileAtomic(configPath, content);
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
   * Run a write op serialized against other writes for the same app. The op
   * must read the current config *inside* itself so it sees the result of the
   * prior write rather than a snapshot taken before it settled.
   */
  private enqueueWrite<T>(appName: string, op: () => Promise<T>): Promise<T> {
    const prev = this.writeChains.get(appName) ?? Promise.resolve();
    const result = prev.then(() => op());
    // Advance the chain with a tail that never rejects, so one failed op does
    // not break serialization (or leak an unhandled rejection) for later ones.
    this.writeChains.set(
      appName,
      result.then(
        () => undefined,
        () => undefined
      )
    );
    return result;
  }

  /**
   * Create or update an app config
   */
  async upsertConfig(appName: string, updates: Partial<AppConfig>): Promise<AppConfig> {
    return this.enqueueWrite(appName, async () => {
      const existing = this.configs.get(appName);
      const now = new Date().toISOString();

      const config: AppConfig = {
        ...existing,
        ...updates,
        name: appName, // Ensure name is always correct
        type: updates.type ?? existing?.type ?? 'unknown',
        runtime: updates.runtime ?? existing?.runtime ?? 'pm2',
        createdAt: existing?.createdAt ?? now,
      };

      await this.saveConfig(config);
      return config;
    });
  }

  /**
   * Update specific fields of an app config
   */
  async updateConfig(appName: string, updates: Partial<AppConfig>): Promise<AppConfig | null> {
    return this.enqueueWrite(appName, async () => {
      const existing = this.configs.get(appName);
      if (!existing) return null;

      const config: AppConfig = {
        ...existing,
        ...updates,
        name: appName, // Ensure name is always correct
      };

      await this.saveConfig(config);
      return config;
    });
  }

  /**
   * Delete an app config
   */
  async deleteConfig(appName: string): Promise<boolean> {
    return this.enqueueWrite(appName, async () => {
      const configPath = this.getConfigPath(appName);
      try {
        await fs.unlink(configPath);
        this.configs.delete(appName);
        return true;
      } catch {
        return false;
      }
    });
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

  /**
   * Map every domain claimed by any app (its default hostname plus any custom
   * domains) to the app that owns it. Used to stop one app from claiming a
   * hostname already owned by another (cross-tenant routing hijack). Keys are
   * lowercased for case-insensitive comparison.
   *
   * `domainSuffix` is the platform's serving suffix (e.g. `dropkit.sh`). The
   * hostname persisted in config is always `${name}.localhost`, but the
   * hostname an app actually *serves on* is `${name}.${domainSuffix}` (computed
   * at route time, never persisted). We seed those here — and let them win over
   * any persisted `domains` entry — so a different app can never claim (or keep
   * a stale claim on) `${victim}.${domainSuffix}` on a non-localhost box.
   */
  getDomainOwners(domainSuffix?: string): Map<string, string> {
    const owners = new Map<string, string>();
    // Pass 1: persisted hostname + custom domains.
    for (const [appName, config] of this.configs) {
      if (config.hostname) owners.set(config.hostname.toLowerCase(), appName);
      for (const d of config.domains ?? []) {
        owners.set(d.toLowerCase(), appName);
      }
    }
    // Pass 2: each app's computed default hostname is authoritative for that app.
    if (domainSuffix) {
      for (const appName of this.configs.keys()) {
        owners.set(`${appName}.${domainSuffix}`.toLowerCase(), appName);
      }
    }
    return owners;
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
