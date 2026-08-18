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
   * SHA-256 hash over the sorted (relativePath, mtimeMs, size) tuple of every
   * file/dir in the app's source tree, excluding build output/dependency
   * dirs (node_modules, dist, build, ...) — see platform.ts's
   * computeSourceMtimeMs. Boot reconciliation (M1, DROP_BOOT_RECONCILE)
   * compares the CURRENT hash against this recorded value to decide whether
   * a running app's source changed since it was last deployed. Deliberately
   * mtime-to-mtime (well, tuple-to-tuple), not mtime-to-`lastDeployedAt`:
   * `tar -x` preserves original mtimes, so a fresh deploy can land with older
   * mtimes than its own deploy timestamp and would otherwise look unchanged
   * forever. Hashing the whole tuple set (not just the single newest mtime,
   * the M1 review round-2 item 2 fix) catches a deletion/rename that never
   * touches the newest file, and a replaced file whose archived mtime lands
   * below the tree's existing max — both of which a max-mtime-only signal
   * missed on the tar/upload redeploy path. Absent on pre-M1 configs, on
   * configs recorded before this hash replaced the raw max-mtime number, and
   * for apps that have never deployed — all three read as "no recorded
   * signature" and redeploy once (the migration seam).
   */
  /**
   * Per-app disk ceiling in MB, overriding DROP_MAX_APP_DISK_MB.
   *
   * An explicit 0 EXEMPTS this app, which is deliberately distinct from unset:
   * an operator can excuse one legitimately large app without disabling the
   * ceiling for everything else.
   */
  maxDiskMb?: number;
  /**
   * Whether a new build goes live on its own. Unset falls back to
   * DROP_DEFAULT_PROMOTION. A per-app value wins either way — an operator who
   * marked one app `auto` on a `manual` platform meant it.
   */
  /**
   * True when an AGENT credential created this app.
   *
   * Set ONLY on first creation and never on a redeploy, and never from caller
   * input (SEC-11). Setting it on any agent-assisted deploy would flag a
   * long-lived human-owned app permanently the first time an agent redeployed
   * it — and this flag is what exposes an app to automatic DELETION, database
   * included.
   */
  agentCreated?: boolean;
  /**
   * A throwaway app with a lifetime (Step 10). `expiresAt` is ISO-8601; the
   * reap sweep tears the app down once it passes. Absent on ordinary apps, and
   * a MALFORMED value counts as expired rather than immortal.
   */
  ephemeral?: boolean;
  expiresAt?: string;
  /** Who created it, for the per-caller ephemeral quota. */
  ephemeralPrincipalId?: string;
  /** Operator opt-out from idle reaping. */
  noReap?: boolean;
  /**
   * This app speaks MCP on `path` (Step 11). Declared in drop.yaml or inferred
   * from a manifest. A LABEL — it changes no routing (the whole-host
   * reverse_proxy already carries the path) and no auth: `none` means the
   * endpoint is public unless the app authenticates callers itself.
   */
  mcp?: {
    path: string;
    /**
     * `none` — DROP guards nothing; the endpoint is public unless the app
     * authenticates callers itself.
     * `drop` — DROP is the authorization server for this endpoint. Only a
     * DECLARED endpoint may be `drop`: opting an app into a login gate is a
     * decision its owner makes, never one inferred from a dependency.
     */
    auth: 'none' | 'drop';
    /**
     * Whether the tenant DECLARED this endpoint in drop.yaml or DROP inferred
     * it from a manifest. Load-bearing, not bookkeeping: only a declared
     * endpoint becomes an OAuth resource, so inference stays cosmetic exactly
     * as mcp-detect.ts claims.
     */
    source: 'declared' | 'inferred';
  };
  promotion?: 'auto' | 'manual';
  /**
   * A built-but-unpromoted deploy, when promotion is manual. Absent when
   * nothing is held. The running version is untouched while this is set.
   */
  pendingPromotion?: {
    deployId?: string;
    builtAt: string;
    outputDirectory?: string;
  };
  sourceHash?: string;
  /**
   * SHA-256 fingerprint of the app's secret key/value set (sorted, hashed —
   * never the plaintext values) as of the last successful deploy. `PUT`/
   * `DELETE /api/v1/secrets/:name` has no restart hook, so the next start is
   * the only point a rotated or revoked secret is actually applied; boot
   * reconciliation (M1) compares this against the CURRENT fingerprint and
   * forces a redeploy on any difference — otherwise a revoked secret would
   * stay live in a skipped, still-running process indefinitely. Absent on
   * pre-M1 configs and for apps that have never deployed.
   */
  secretFingerprint?: string;
  /**
   * SHA-256 fingerprint recorded at the last successful deploy — see
   * container-config.ts's containerPolicyFingerprint (M1 review item 4,
   * round-2 diff pass; replaces a hand-bumped integer version that could
   * only ever be manually incremented and missed everything except an
   * explicit doc-comment bump). Covers the fixed container-hardening
   * constants (CapDrop, SecurityOpt, PidsLimit, ...) AND the operator-tunable
   * inputs (apiPort, maxMemoryMbPerApp, maxCpusPerApp) that also affect a PM2
   * app's env/max_memory_restart. Container hardening is fixed at
   * container-creation time and reaches an existing container only by
   * recreating it; boot reconciliation (M1) forces a redeploy when this is
   * stale, regardless of isolation mode, so a policy change actually reaches
   * already-running apps instead of only new ones.
   */
  runtimeSpecFingerprint?: string;
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
  /**
   * The effective public URL for a same-origin monorepo child (the group
   * domain plus the service's route path — e.g. `https://ezsign.dropkit.sh`
   * for the frontend, `https://ezsign.dropkit.sh/api` for the backend). Set by
   * platform.handleConfigureRoute at route-configuration time, because that is
   * the one place that knows a child is routed onto the group host rather than
   * its own `<name>` subdomain. Absent for standalone apps and for group
   * children that declare their own `domains` (those use the name/domain-based
   * URL). computeAppUrl returns this so the dashboard links to the address that
   * is actually routed, not a dead `<name>.<suffix>`.
   */
  publicUrl?: string;
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
  /**
   * The owner's explicit attach/detach intent per backing service, keyed by the
   * catalog's extension id ('postgres' | 'redis'). SYSTEM-OWNED: written only by
   * the attach/detach routes from fixed literals, NEVER from a request body.
   * That containment is complete by construction today — the one route that
   * accepts a body goes through `pickUpdatableFields` (apps.ts), an ALLOWLIST
   * over `UPDATABLE_APP_FIELDS` that writes `AppState`, not `AppConfig`. Keep it
   * that way: do not add a route that spreads a body into upsert/updateConfig.
   */
  services?: Record<string, 'attached' | 'detached'>;
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
    // M1 review item 5 (round-2 diff pass): 0600, matching secrets.json — a
    // per-app config now also carries sourceHash/secretFingerprint/
    // runtimeSpecFingerprint (boot reconciliation, M1), and the previous
    // default (writeFileAtomic's 0644) left it world-readable. Existing
    // files on disk pick this up on their NEXT write, same as any other
    // progressive permission tightening.
    await writeFileAtomic(configPath, content, { mode: 0o600 });
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
