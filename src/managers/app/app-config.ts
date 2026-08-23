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

/**
 * Who may OPEN an app in a browser — deliberately a different question from
 * who may MANAGE it (DROP-152).
 *
 * `canAccess` (api/access.ts) answers management: admin-or-owner, over
 * `AppState.userId`. This answers access, and the two must not be conflated —
 * an app gated to a review board is not thereby manageable by that board.
 *
 * `mode` is a FIELD, not an interface seam. When OIDC federation lands it
 * becomes `'drop-users' | 'oidc'` and the resolver branches on it; extracting
 * an `IdentitySource` interface before a second implementation exists buys
 * documentation and pre-commits a shape whose real constraints are unknown
 * (this repo has declined that exact seam twice — see
 * docs/plans/2026-08-13-service-provider-plugins.md).
 */
export interface AppAccessPolicy {
  mode: 'drop-users';
  /**
   * User ids (NOT usernames) permitted to open the app, on top of the owner
   * and any admin. Validated against the credential store at write time.
   */
  allow: string[];
}

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
  /**
   * When each backing service's detach cooldown last fired (epoch ms),
   * keyed the same way `services` is (by the catalog's extension id).
   * SYSTEM-OWNED, written only by `setServiceIntent` alongside `services` —
   * beside it rather than in a separate store so it survives restarts and
   * resets for free in tests. Per-SERVICE, not one shared per-app value: a
   * single epoch let detaching one service open a cooldown window that also
   * 429'd an unrelated service's detach for the same app. Absent until a
   * given service's first detach.
   */
  lastDetachAt?: Record<string, number>;
  /**
   * The browser access gate's policy (DROP-152). Absent on every app that has
   * not been explicitly gated, and absent is NOT "gated to nobody" — it is
   * "not gated", the behaviour every app has today.
   *
   * RESTRICTED, a strictly stronger tier than SYSTEM_CONFIG_FIELDS: only
   * `setAccessPolicy` may write it, and every other writer — the system ones
   * included — strips it at runtime. That matters because the deploy paths
   * (`upload-deploy.ts`, `git-deploy.ts`) already call the UNSTRIPPED system
   * writers with data derived from a request, so "system-owned" alone would
   * not keep a tenant-supplied `access` out of an authorization decision.
   *
   * Deliberately NOT modelled on `mcp`. For `mcp`, `source: 'declared'` means
   * the TENANT wrote it in their own drop.yaml, and the whole field is
   * recomputed and overwritten via `updateConfig` on every build
   * (platform.ts's handleBuildApp). An authorization field with that lifecycle
   * would let a tenant author their own allow-list and reset it on every
   * redeploy. `access` is set only by the admin route, never derived from app
   * source, and never touched by a build.
   */
  access?: AppAccessPolicy;
  /**
   * When this app's access policy should next be reviewed (ISO-8601, DROP-152
   * AC3). Governance METADATA, not authorization — so it sits on the SYSTEM
   * tier rather than the RESTRICTED one, which exists for fields that decide
   * who may do something and costs a dedicated setter per field.
   */
  reviewBy?: string;
}

/**
 * Platform-controlled AppConfig fields — never settable from a request body.
 * `upsertConfig`/`updateConfig` (the general-purpose writers) strip these at
 * runtime regardless of what their caller passes; `upsertSystemConfig` and
 * `setServiceIntent` are the only writers allowed to touch them.
 */
const SYSTEM_CONFIG_FIELDS = [
  'reviewBy',
  'services',
  'grantedApiScopes',
  'agentCreated',
  'ephemeral',
  'ephemeralPrincipalId',
  'expiresAt',
  'lastDetachAt',
] as const satisfies readonly (keyof AppConfig)[];

type SystemConfigField = (typeof SYSTEM_CONFIG_FIELDS)[number];

/**
 * A strictly stronger tier than SYSTEM_CONFIG_FIELDS: fields that even the
 * UNSTRIPPED system writers may not touch. Only the dedicated setter for each
 * one (`setAccessPolicy`) passes `restricted: true`.
 *
 * Why a second tier rather than adding `access` to SYSTEM_CONFIG_FIELDS: that
 * list's runtime strip runs ONLY on the `system: false` writers, and
 * `upsertSystemConfig`/`updateSystemConfig` — the unstripped ones — are already
 * called from `upload-deploy.ts` and `git-deploy.ts` on the agent/upload deploy
 * path. Those four call sites pass fixed object literals today, so the
 * excess-property check would in fact have caught a mistake there; the reason
 * that is not enough is that an excess-property check is not a boundary. It
 * fires on a fresh literal and on nothing else — not a cast, not a spread, not
 * a variable — which is precisely how the build-secret boundary and the
 * group-name containment were bypassed, both of them correct helpers with a
 * careless caller. An authorization field gets a RUNTIME strip on every writer
 * without exception, and this is the tier that provides one.
 *
 * These are NOT also listed in SYSTEM_CONFIG_FIELDS: this tier already strips
 * them on every writer that one covers, and listing them twice would emit two
 * warnings for one dropped field. `assertConfigTiersDisjoint` below pins that.
 */
const RESTRICTED_CONFIG_FIELDS = ['access'] as const satisfies readonly (keyof AppConfig)[];

type RestrictedConfigField = (typeof RESTRICTED_CONFIG_FIELDS)[number];

/**
 * The two tiers must stay disjoint — a field in both would be stripped twice
 * and warn twice for one write. Exported for the test that pins it rather than
 * asserted at module load, so adding a field to the wrong list fails CI rather
 * than the platform's boot.
 */
export function configTierOverlap(): string[] {
  return (RESTRICTED_CONFIG_FIELDS as readonly string[]).filter(field =>
    (SYSTEM_CONFIG_FIELDS as readonly string[]).includes(field)
  );
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
   * Save an app config to file.
   *
   * PRIVATE, and load-bearing that it stays so: this writes a whole config
   * object straight to disk and into the in-memory map, bypassing BOTH
   * `stripSystemFields` and `stripRestrictedFields`. The entire containment
   * story of those tiers rests on `write()` being the only way in. It was
   * public with a single internal caller, which is how every bypassing-caller
   * incident in this repo started.
   */
  private async saveConfig(config: AppConfig): Promise<void> {
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
   * Strips SYSTEM_CONFIG_FIELDS from a general-purpose write's updates at
   * runtime. The `Omit<AppConfig, SystemConfigField>` parameter type on
   * upsertConfig/updateConfig is documentation only — an excess-property
   * check fires on a fresh object literal but not on a cast or a spread, so
   * this is the actual guarantee that a system field can never reach
   * saveConfig through the general-purpose writers, however a caller got
   * there.
   */
  private stripSystemFields(appName: string, updates: Partial<AppConfig>): Partial<AppConfig> {
    const stripped: Partial<AppConfig> = { ...updates };
    const dropped: string[] = [];
    for (const field of SYSTEM_CONFIG_FIELDS) {
      if (field in stripped) {
        delete stripped[field];
        dropped.push(field);
      }
    }
    if (dropped.length > 0) {
      console.warn(
        `[app-config] stripped system field(s) [${dropped.join(', ')}] from a general-purpose ` +
          `config write for '${appName}' — use upsertSystemConfig/setServiceIntent instead`
      );
    }
    return stripped;
  }

  /**
   * Strips RESTRICTED_CONFIG_FIELDS from EVERY write that is not the field's
   * own dedicated setter — the system writers included. The narrowed
   * `Partial<Omit<AppConfig, RestrictedConfigField>>` parameter types are
   * documentation only (an excess-property check fires on a fresh object
   * literal but not on a cast or a spread); this is the actual guarantee.
   */
  private stripRestrictedFields(
    appName: string,
    updates: Partial<AppConfig>,
    allowed?: RestrictedConfigField
  ): Partial<AppConfig> {
    const stripped: Partial<AppConfig> = { ...updates };
    const dropped: string[] = [];
    for (const field of RESTRICTED_CONFIG_FIELDS) {
      if (field === allowed) continue;
      if (field in stripped) {
        delete stripped[field];
        dropped.push(field);
      }
    }
    if (dropped.length > 0) {
      console.warn(
        `[app-config] stripped restricted field(s) [${dropped.join(', ')}] from a config write ` +
          `for '${appName}' — only the field's own dedicated setter may write it`
      );
    }
    return stripped;
  }

  /**
   * The one read-merge-save body shared by all four general-purpose/system
   * writers plus setServiceIntent below — previously reimplemented once per
   * writer as four near-identical copies, orthogonal in exactly two axes:
   * whether a missing config is created (`create`) or refused with null, and
   * whether SYSTEM_CONFIG_FIELDS are stripped (`system`). `updates` may be an
   * updater function instead of a plain object so a caller (setServiceIntent)
   * can merge against the CURRENT config read inside the write chain rather
   * than a snapshot taken before it settled — same reason enqueueWrite's own
   * doc gives for reading `existing` inside the op.
   *
   * `create: true` forces `type`/`runtime`/`createdAt` exactly as
   * upsertConfig/upsertSystemConfig always have — `createdAt` in particular
   * IGNORES any caller-supplied value and is always `existing?.createdAt ??
   * now`. `create: false` (updateConfig/updateSystemConfig/setServiceIntent)
   * applies none of that: whatever `updates` carries for those fields (or
   * nothing) passes straight through unchanged, exactly as updateConfig
   * always has. This split is deliberate, not an oversight — collapsing it to
   * one behaviour would silently change what an explicit `updates.createdAt`
   * does on the update path.
   */
  private write(
    appName: string,
    updates: Partial<AppConfig> | ((existing: AppConfig | undefined) => Partial<AppConfig>),
    opts: { create: boolean; system: boolean; restricted?: RestrictedConfigField }
  ): Promise<AppConfig | null> {
    return this.enqueueWrite(appName, async () => {
      const existing = this.configs.get(appName);
      if (!existing && !opts.create) return null;

      const rawUpdates = typeof updates === 'function' ? updates(existing) : updates;
      const systemSafe = opts.system ? rawUpdates : this.stripSystemFields(appName, rawUpdates);
      // The restricted tier is applied INDEPENDENTLY of `system`, not nested
      // inside its else-branch: the whole point is that `system: true` does
      // not buy access to it. `opts.restricted` names ONE field — a blanket
      // boolean would let each dedicated setter write every other restricted
      // field too, which is not what the tier claims once a second one exists.
      const safeUpdates = this.stripRestrictedFields(appName, systemSafe, opts.restricted);
      const now = new Date().toISOString();

      // Cast, not a type hole: `opts.create` is a runtime boolean, not a
      // literal type, so TS can't narrow the ternary spread's two branches
      // into a definitely-required `type`/`runtime`/`createdAt` — but the
      // invariant holds either way. `create: true` always sets all three
      // right here; `create: false` only reaches this line when `existing`
      // is defined (guarded above), so they already came from its own
      // spread.
      const config = {
        ...existing,
        ...safeUpdates,
        name: appName, // Ensure name is always correct
        ...(opts.create
          ? {
              type: safeUpdates.type ?? existing?.type ?? 'unknown',
              runtime: safeUpdates.runtime ?? existing?.runtime ?? 'pm2',
              createdAt: existing?.createdAt ?? now,
            }
          : {}),
      } as AppConfig;

      await this.saveConfig(config);
      return config;
    });
  }

  /**
   * Create or update an app config with owner/caller-supplied fields. Never
   * accepts SYSTEM_CONFIG_FIELDS — see upsertSystemConfig for those.
   */
  async upsertConfig(
    appName: string,
    updates: Partial<Omit<AppConfig, SystemConfigField | RestrictedConfigField>>
  ): Promise<AppConfig> {
    // `create: true` never resolves null (see `write`'s own doc).
    return (await this.write(appName, updates as Partial<AppConfig>, {
      create: true,
      system: false,
    })) as AppConfig;
  }

  /**
   * Update specific fields of an app config with owner/caller-supplied
   * fields. Never accepts SYSTEM_CONFIG_FIELDS — see upsertSystemConfig for
   * those.
   */
  async updateConfig(
    appName: string,
    updates: Partial<Omit<AppConfig, SystemConfigField | RestrictedConfigField>>
  ): Promise<AppConfig | null> {
    return this.write(appName, updates as Partial<AppConfig>, { create: false, system: false });
  }

  /**
   * Unstripped writer for SYSTEM_CONFIG_FIELDS (services, grantedApiScopes,
   * agentCreated, ephemeral, ephemeralPrincipalId, expiresAt, lastDetachAt).
   * Same upsert semantics as upsertConfig (creates a config when none
   * exists) — trusted callers only: upload-deploy.ts and git-deploy.ts write
   * agentCreated/ephemeral/expiresAt/ephemeralPrincipalId here BEFORE
   * app:detected creates the config, so updateConfig's null-on-missing would
   * silently drop them. Never wire a request body into this directly. See
   * updateSystemConfig for a caller that must refuse rather than mint a
   * config when none exists.
   */
  async upsertSystemConfig(
    appName: string,
    updates: Partial<Omit<AppConfig, RestrictedConfigField>>
  ): Promise<AppConfig> {
    // `create: true` never resolves null (see `write`'s own doc).
    return (await this.write(appName, updates as Partial<AppConfig>, {
      create: true,
      system: true,
    })) as AppConfig;
  }

  /**
   * Unstripped mirror of updateConfig for SYSTEM_CONFIG_FIELDS: reads the
   * CURRENT config INSIDE the write chain and returns null when none
   * exists, rather than minting one. A caller that must refuse (not
   * upsert) when an app has runtime state but no persisted config — e.g.
   * the capabilities route — needs this, not upsertSystemConfig: checking
   * `hasConfig()` before an upsert is a snapshot-then-write race (a
   * concurrent deleteConfig can land in between and the upsert would then
   * mint exactly the skeleton config the check exists to refuse).
   */
  async updateSystemConfig(
    appName: string,
    updates: Partial<Omit<AppConfig, RestrictedConfigField>>
  ): Promise<AppConfig | null> {
    return this.write(appName, updates as Partial<AppConfig>, { create: false, system: true });
  }

  /**
   * The ONLY writer for `AppConfig.access` (DROP-152) — every other writer,
   * `upsertSystemConfig`/`updateSystemConfig` included, strips the field at
   * runtime (see RESTRICTED_CONFIG_FIELDS).
   *
   * `create: false`, for the same reason the capabilities route needs
   * `updateSystemConfig`: a `PUT /apps/<nonexistent>/access` must REFUSE, not
   * mint a skeleton `AppConfig`. A minted skeleton would then make the app
   * "exist" to `syncStateWithConfigs` on the next boot — configs are
   * authoritative there — so an authorization write against a typo would
   * fabricate an app.
   *
   * `undefined` clears the gate. It is written as an explicit `undefined`
   * rather than deleted from the merged object: `yaml.stringify` omits
   * undefined values, so the field leaves the file entirely (the same
   * clear-by-undefined `publicUrl` already relies on).
   */
  async setAccessPolicy(
    appName: string,
    access: AppAccessPolicy | undefined
  ): Promise<AppConfig | null> {
    return this.write(appName, { access }, { create: false, system: true, restricted: 'access' });
  }

  /**
   * Persist ONE service's attach/detach intent, merging into `services`
   * without clobbering sibling entries, plus an optional `lastDetachAt` for
   * THAT service — merged into the per-service `lastDetachAt` record the
   * same way, so detaching one service never clobbers or gates another's
   * cooldown (see that field's own doc above). Uses `write`'s updater-
   * function form so the merge reads the CURRENT config INSIDE the write
   * chain (enqueueWrite invokes the op at execution time, not at call time),
   * so a concurrent write for the same app can never be lost to a stale
   * snapshot. `create: false`: returns null when no config exists — this
   * writer must never create a skeleton config, which is exactly the
   * boot-corruption hazard the attach/detach guards exist to keep out.
   */
  async setServiceIntent(
    appName: string,
    serviceId: string,
    intent: 'attached' | 'detached',
    extras?: { lastDetachAt?: number }
  ): Promise<AppConfig | null> {
    return this.write(
      appName,
      (existing) => ({
        services: { ...(existing?.services ?? {}), [serviceId]: intent },
        ...(extras?.lastDetachAt !== undefined
          ? { lastDetachAt: { ...(existing?.lastDetachAt ?? {}), [serviceId]: extras.lastDetachAt } }
          : {}),
      }),
      { create: false, system: true }
    );
  }

  /**
   * Remove one user id from every app's access allow-list.
   *
   * Ids are validated against the credential store when a policy is written
   * and never again, so a deleted user's id would otherwise linger in every
   * list it was on. Nothing is granted by a stale entry —
   * `verifyAppSessionToken` re-resolves the user live on every request, so a
   * deleted account cannot open anything — but a governance list nobody can
   * read as authoritative is a governance list that has stopped working.
   *
   * A linear pass over the configs, deliberately, rather than the reverse
   * index this plan declined twice: the work is bounded by app count and runs
   * once per account deletion.
   *
   * Writes through `setAccessPolicy`, so the RESTRICTED tier still holds — this
   * is not a back door into `access`.
   */
  async pruneAllowListEntries(userId: string): Promise<string[]> {
    const touched: string[] = [];
    for (const config of this.getAllConfigs()) {
      const allow = config.access?.allow;
      if (!allow?.includes(userId)) continue;
      await this.setAccessPolicy(config.name, {
        ...config.access!,
        allow: allow.filter(id => id !== userId),
      });
      touched.push(config.name);
    }
    return touched;
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

/**
 * `getAppConfigService()`, but null instead of throwing when the service was
 * never initialized (tests / early failures) — for a defensive read that
 * should degrade gracefully (e.g. "no recorded intent") rather than fail the
 * whole request. Several routes were hand-rolling this exact try/catch
 * around `getAppConfigService()` (apps.ts, db.ts); this is the one place it
 * lives now, mirroring the null-returning posture `getDatabaseProvisioner`/
 * `getRedisProvisioner` already have for the same "not booted yet" case.
 */
export function getAppConfigServiceOrNull(): AppConfigService | null {
  try {
    return getAppConfigService();
  } catch {
    return null;
  }
}
