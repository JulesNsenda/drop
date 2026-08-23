/**
 * DROP Platform - Main orchestrator for the DROP PaaS
 *
 * This is the central coordinator that initializes and manages all
 * DROP services and their lifecycle.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as yaml from 'yaml';
import * as crypto from 'crypto';
import { EventBus, eventBus, Unsubscribe, AppDeletedPayload, AppDetectedPayload } from './event-bus';
import { isReservedHost } from '../utils/reserved-hosts';
import { isValidEnvVarName } from '../utils/env-var-names';
import { getPublicUrl } from '../api/runtime-config';
import type { DeployFailureReason } from './event-bus/event-bus.types';
import { WatcherService } from './watcher';
// Imported from the concrete file, NOT the './watcher' barrel: several test
// suites mock './watcher' wholesale (only exporting WatcherService), and this
// constant is read at platform.ts module-load time — going through the
// barrel would make loading this module depend on every consumer's mock
// shape. watcher.config.ts itself has no WatcherService dependency, so this
// stays a live import (no drift) without dragging chokidar/WatcherService in.
import { DEFAULT_IGNORE_PATTERNS } from './watcher/watcher.config';
import {
  DetectorService,
  getDetector,
  parseDropYaml,
  type DropYamlParseResult,
  DetectionResult,
  DropYamlConfig,
  AppType,
  detectMcp,
  readMcpInputs,
} from './detector';
import { getProcfileWebCommand } from './detector/procfile';
import { BuilderService, getBuilder } from './builder';
import { RouterService, getRouterService, resetRouterService } from './router';
import { AppRuntime, AppProcessInfo, AppStartSpec, getAppRuntime, resetAppRuntime } from '../managers/runtime';
import { AppStateManager, AppStatus, getStateManager, resetStateManager } from '../managers/app/state-manager';
import { SettingsManager, getSettingsManager, resetSettingsManager } from '../managers/settings/settings-manager';
import { AppConfig, AppConfigService, getAppConfigService, resetAppConfigService } from '../managers/app/app-config';
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
import { tryLogActivity } from '../managers/activity';
import {
  promotionModeFor,
  shouldHoldForPromotion,
  type PromotionMode,
} from '../managers/guardrail/promotion';
import { getPrincipalQuota, resetPrincipalQuota } from '../managers/guardrail/principal-quota';
import { isExpired } from '../managers/guardrail/ephemeral';
import { checkDetachCooldown, checkDumpByteBudget } from '../managers/guardrail/detach-limits';
import {
  planIdleSweep,
  createIdleSweepState,
  dryRunSweeps,
  idleWindowMs,
  type IdleSweepState,
} from '../managers/guardrail/idle-reaper';
import {
  findOverCeiling,
  toMb,
  configuredCeilingBytes,
  DISK_SWEEP_INTERVAL_MS,
} from '../managers/guardrail/disk-ceiling';
import {
  getDeployBreaker,
  guardrailKeysFor,
  checkGuardrailKeys,
  resetDeployBreaker,
  type GuardrailKey,
  type DeployActorInfo,
} from '../managers/guardrail/deploy-breaker';
import {
  getDeployTracker,
  resetDeployTracker,
  getDeployDetailStore,
  resetDeployDetailStore,
} from '../managers/deploy-tracker';
import { ApiServer, createApiServer } from '../api';
import {
  AppInProgressError,
  AppNeedsConfigError,
  setPlatformOps,
  resetPlatformOps,
  type AttachableServiceId,
  type AttachServiceResult,
  type DetachServiceOutcome,
  type DetachServiceResult,
  type DetachServiceRestartOutcome,
} from '../api/platform-ops';
import { planSecretPreflight, generateSecretValue } from '../managers/secret/secret-preflight';
import { Logger, createLogger } from '../utils/logger';
import { isPathWithin } from '../utils/paths';
import { syncTree, DEFAULT_PRESERVE } from '../utils/tree-sync';
import {
  validateDomain,
  validateDomainFormat,
  isLocalhostDomain,
} from '../utils/domain-validator';
import { createApiKey, deleteApiKeysByName } from '../api/middleware/auth';
// The STRICT name pattern (the API's), not the folder-drop parser's looser
// check: this decides whether a name is safe to write into a Caddy literal.
import { isValidAppName } from '../api/middleware/validate';
import { IsolationMode, assertStartupConstraints } from './startup-constraints';
import { createContainerExecCommand } from './builder/container-build-runner';
import { migrateAllToDocker } from '../managers/runtime/runtime-migrator';
import { HOST_ALIAS, containerPolicyFingerprint } from '../managers/runtime/container-config';
import { buildNginxConf } from '../utils/nginx-conf';
import { BuildLogService, getBuildLogService, resetBuildLogService } from '../managers/build-log/build-log';
import {
  LogRetentionService,
  getLogRetentionService,
  resetLogRetentionService,
} from '../managers/log-retention/log-retention';
import { hasEnoughDisk, getMinFreeDiskMb } from '../utils/disk';
import { getAccessLog, resetAccessLog } from '../managers/access-log/access-log';
import { sessionCookieName as appSessionCookieName } from '../api/app-access/names';
import {
  assessAccessGate,
  describeAccessGateRefusal,
  resolveHttpsEffective,
  isGateApplied,
  gateEnforced as computeGateEnforced,
  ACCESS_GATE_ENFORCEMENT_AVAILABLE,
  type AccessGateVerdict,
} from '../managers/guardrail/access-gate';
// Imported from the concrete file, NOT the '../managers/runtime' barrel: five
// platform test suites mock that barrel wholesale and would hand back
// `undefined` for anything they did not list -- the same reason
// DEFAULT_IGNORE_PATTERNS is imported from watcher.config.ts above.
import {
  getTenantNetworkIsolation,
  probeTenantNetworkIsolation,
} from '../managers/runtime/container-manager';
import { probePort, probeHttp } from '../utils/http-probe';

/** See PlatformConfig.bootReconcileMode. */
export type BootReconcileMode = 'off' | 'observe' | 'on';

/**
 * Parses DROP_BOOT_RECONCILE. Accepts the literal mode names plus common
 * boolean spellings for the plan's kill switch (`DROP_BOOT_RECONCILE=false`)
 * so an operator writing `=true`/`=false` gets the side they expect rather
 * than a silent 'off'. An unrecognized value warns and falls back to 'off' —
 * the safest, today-unchanged default.
 */
function parseBootReconcileMode(raw: string | undefined): BootReconcileMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'off' || value === 'false' || value === '0' || value === 'no') {
    return 'off';
  }
  if (value === 'observe') {
    return 'observe';
  }
  if (value === 'on' || value === 'true' || value === '1' || value === 'yes') {
    return 'on';
  }
  console.warn(`[platform] Unrecognized DROP_BOOT_RECONCILE value '${raw}', defaulting to 'off'`);
  return 'off';
}

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
  /**
   * Operator kill switch for the DROP-152 browser access gate
   * (`DROP_FEATURE_ACCESS_GATE`). Default true — a security control's off
   * switch defaults to keeping the control ON; defaulting it off would
   * silently disarm a control that is live in production while policies
   * stay on disk and simply stop being enforced. Read by
   * `assessAccessGate`, the boot sweep, and forwarded to the API via
   * `ApiServerConfig.accessGateEnabled`.
   */
  enableAccessGate: boolean;
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
  /**
   * Run the secret preflight (PRD-051): before starting an app, auto-generate
   * declared generatable secrets and PARK the app in `needs-config` if a
   * declared-required secret is missing, instead of letting it crash-loop.
   * Default true; the escape hatch is DROP_ENABLE_SECRET_PREFLIGHT=false.
   */
  enableSecretPreflight: boolean;
  /**
   * Boot reconciliation (M1): stops the watcher's initial scan from
   * fabricating `app:detected` — and therefore a full rebuild — for every
   * existing app dir on every platform restart.
   * - 'off'     — default; today's behaviour, unchanged, no boot-reconcile logs.
   * - 'observe' — computes and LOGS the skip/redeploy decision it would make
   *               per app, but changes nothing (validates the logic against a
   *               real fleet before flipping the default).
   * - 'on'      — acts on the decision: an already-running app with an
   *               unchanged source signature is routing-reconciled only (no
   *               detect/install/build/runtime.start); anything ambiguous
   *               still redeploys in full.
   * Settable via DROP_BOOT_RECONCILE in /etc/drop/drop.env — the kill switch
   * lives there, not in code, so backing out is edit-and-restart.
   */
  bootReconcileMode: BootReconcileMode;
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
  enableAccessGate: process.env.DROP_FEATURE_ACCESS_GATE !== 'false',
  maxAppsPerUser: parseInt(process.env.DROP_MAX_APPS_PER_USER || '5', 10),
  isolation: (process.env.DROP_ISOLATION as IsolationMode) ?? 'none',
  allowSignup: process.env.DROP_ALLOW_SIGNUP === 'true',
  maxDbsPerUser: parseInt(process.env.DROP_MAX_DBS_PER_USER || '3', 10),
  enableRedis: process.env.DROP_ENABLE_REDIS !== 'false',
  redisPort: parseInt(process.env.DROP_REDIS_PORT || '6380', 10),
  maxRedisPerUser: parseInt(process.env.DROP_MAX_REDIS_PER_USER || '3', 10),
  enableSecretPreflight: process.env.DROP_ENABLE_SECRET_PREFLIGHT !== 'false',
  bootReconcileMode: parseBootReconcileMode(process.env.DROP_BOOT_RECONCILE),
  maxConcurrentBuilds: parseInt(process.env.DROP_MAX_CONCURRENT_BUILDS || '3', 10),
  maxConcurrentApps: parseInt(process.env.DROP_MAX_CONCURRENT_APPS || '0', 10),
  maxMemoryMbPerApp: parseInt(process.env.DROP_MAX_MEMORY_MB_PER_APP || '0', 10),
  maxCpusPerApp: parseFloat(process.env.DROP_MAX_CPUS_PER_APP || '0'),
  logRetentionDays: parseInt(process.env.DROP_LOG_RETENTION_DAYS || '14', 10),
  logMaxFileMb: parseInt(process.env.DROP_LOG_MAX_FILE_MB || '50', 10),
  maxUploadSizeMb: parseInt(process.env.DROP_MAX_UPLOAD_SIZE_MB || '100', 10),
  maxUploadUnpackedMb: parseInt(process.env.DROP_MAX_UPLOAD_UNPACKED_MB || '1024', 10),
};

/**
 * Directory names skipped when computing an app's source-mtime signature
 * (see computeSourceMtimeMs) — derived from the watcher's own ignore globs
 * (`**\/<name>\/**`, imported straight from watcher.config.ts, see the
 * DEFAULT_IGNORE_PATTERNS import above) so the two can never drift apart.
 * File-level ignore patterns (e.g. `**\/*.log`) don't apply to a directory
 * walk and are dropped; a build's writes to a plain file inside the source
 * tree (not a whole ignored dir) still counts toward the signature, which is
 * intentional — see decideBootReconciliation's fail-toward-redeploy doctrine.
 */
const BOOT_RECONCILE_IGNORE_DIRS = new Set(
  DEFAULT_IGNORE_PATTERNS
    .map((p) => p.match(/^\*\*\/(.+)\/\*\*$/)?.[1])
    .filter((name): name is string => Boolean(name))
);

/**
 * Bounds on computeSourceMtimeMs's recursive walk (M1 review item F): under
 * isolation 'none' a tenant controls their own app directory and could
 * otherwise hold platform startup hostage with a huge/deep tree, since the
 * walk runs serially per app inside start(), before the API server comes up.
 * Exceeding any bound fails the scan (caught by the caller) — fail toward
 * redeploying, never toward a false "unchanged" from a partial scan.
 */
const BOOT_RECONCILE_SCAN_MAX_DEPTH = 12;
const BOOT_RECONCILE_SCAN_MAX_ENTRIES = 20_000;
const BOOT_RECONCILE_SCAN_TIMEOUT_MS = 5_000;

/**
 * Max apps decided concurrently during boot reconciliation (M1 review item 9,
 * round-2 diff pass) — see reconcileAppsOnBoot's doc comment for why the
 * decide/act split exists and why there is no global deadline alongside this.
 */
const BOOT_RECONCILE_CONCURRENCY = 4;

/**
 * A source-tree scan result (M1 review item 2, round-2 diff pass): a SHA-256
 * hash over the sorted (relativePath, mtimeMs, size) tuple of every file/dir
 * in the app's source tree, plus the newest mtime's path for the log line
 * only. The ORIGINAL signal — the max mtime alone — missed a deletion or
 * rename that didn't touch whichever file held that max, and missed a
 * replaced file whose (tar/upload-archived) mtime happened to land below it;
 * both are exactly the tar/upload redeploy path this exists to protect,
 * since git clone and the monorepo copy always write fresh mtimes. The hash
 * has no notion of "before/after" — any difference in the tuple set redeploys.
 */
export interface SourceSignature {
  hash: string;
  /** Path of the newest file/dir relative to the app root, e.g. 'src/index.ts' — diagnostics only, not part of the comparison. */
  newestPath: string;
}

export type BootReconcileAction = 'leave' | 'skip' | 'redeploy';

export interface BootReconcileDecision {
  action: BootReconcileAction;
  reason: string;
}

/**
 * The cheap half of the skip predicate — pure in-memory state, no I/O.
 * Checked FIRST (M1 review item F) so an app that's already decidable never
 * pays for the source-mtime walk or the secret-fingerprint computation.
 */
export interface CheapBootReconcileInput {
  /**
   * The app's persisted status as of boot, BEFORE syncStateWithConfigs /
   * syncStateWithProcesses reconcile it against the live runtime (which can
   * overwrite 'errored'/'needs-config'/'crash-looping' with 'running' for an
   * app whose broken process the runtime still reports as up) — see
   * DropPlatform.bootStatusSnapshot.
   */
  status: AppStatus | undefined;
  /** Whether the runtime (PM2/Docker) reports this app running RIGHT NOW — queried fresh, not trusted from status alone. */
  isRuntimeRunning: boolean;
  /** Whether the persisted config carries a port to reconcile routing against. */
  hasPort: boolean;
  /**
   * Whether the runtime's own reported port for this (running) app differs
   * from the persisted AppConfig.port. A skip trusts config.port to
   * reconcile routing — if the two disagree, routing the app's hostname to
   * config.port would point it at whatever else is actually bound there.
   */
  portDrifted: boolean;
  /**
   * Monorepo group tag (AppConfig.group), or undefined for a standalone app.
   * A grouped app's container is never seeded (it has no AppConfig of its
   * own — see the plan's monorepo limitation) and so still fires its own
   * app:detected on boot, which unconditionally re-copies and rebuilds every
   * child via expandMonorepo — a routing-only skip here would be clobbered
   * moments later. Never skip a grouped app.
   */
  group: string | undefined;
  /**
   * Count of admin-granted control-plane API scopes (AppConfig.grantedApiScopes).
   * DROP_API_KEY is minted fresh (and the previous key deleted) only inside
   * buildStartSpec, which a skip never calls — skipping an app with a
   * non-empty grant would leave a scoped key valid indefinitely and break
   * the revocation repair PUT /apps/:name/capabilities depends on.
   */
  grantedApiScopesCount: number;
  /**
   * Whether AppConfig.runtimeSpecFingerprint matches
   * containerPolicyFingerprint() computed right now (M1 review item 4,
   * round-2 diff pass — see container-config.ts). Checked for every app
   * regardless of isolation mode: several of the fingerprinted inputs
   * (apiPort, maxMemoryMbPerApp, maxCpusPerApp) affect a PM2 app's
   * env/max_memory_restart just as much as a container's spec, so gating
   * this to docker-only (the original design) meant an operator raising
   * DROP_MAX_MEMORY_MB_PER_APP or changing the API port never reached an
   * already-running PM2 app either. The docker-only constants in the
   * fingerprint (CAP_DROP, SECURITY_OPT, ...) are static under PM2 and never
   * cause a mismatch there on their own.
   */
  runtimeSpecCurrent: boolean;
}

/**
 * The expensive half of the skip predicate — only reached when the cheap
 * gate above is undecided. Requires a filesystem walk (currentSignature) and
 * a secret-store read (secretFingerprintChanged), which reconcileAppsOnBoot
 * defers until it knows they're actually needed.
 */
export interface SignatureBootReconcileInput {
  /** Source signature hash recorded at the app's last deploy (AppConfig.sourceHash), or undefined if never recorded. */
  recordedHash: string | undefined;
  /** Signature computed right now, or undefined when the scan failed (missing app dir, read error, over a scan bound, ...). */
  currentSignature: SourceSignature | undefined;
  /**
   * Whether the app's CURRENT secret key/value set differs from the
   * fingerprint recorded at its last deploy (AppConfig.secretFingerprint —
   * see DropPlatform.hasSecretFingerprintChanged). `PUT`/`DELETE
   * /api/v1/secrets/:name` has no restart hook, so the next start is the
   * only apply point; skipping would leave a revoked secret live forever.
   */
  secretFingerprintChanged: boolean;
}

export type BootReconcileInput = CheapBootReconcileInput & SignatureBootReconcileInput;

/**
 * The cheap phase of the boot-reconciliation verdict — see
 * docs/plans/2026-07-25-restart-isolation-and-marketing-split.md M1. Pure and
 * side-effect-free. Returns `null` when undecided, meaning the caller must
 * proceed to the (expensive) signature phase; every non-null return is
 * final — the signature is never even computed.
 */
export function decideBootReconciliationCheap(
  input: CheapBootReconcileInput
): BootReconcileDecision | null {
  const { status, isRuntimeRunning, hasPort, portDrifted, group, grantedApiScopesCount, runtimeSpecCurrent } =
    input;

  // A user-stopped app is deliberately not running — leave it alone exactly
  // like the normal app:detected path does today (handleAppDetected gates on
  // status !== 'stopped' before ever calling handleBuildApp). Redeploying (or
  // even route-reconciling) it here would resurrect an app the user stopped.
  if (status === 'stopped') {
    return { action: 'leave', reason: 'app is stopped' };
  }

  if (group) {
    return { action: 'redeploy', reason: `app belongs to monorepo group '${group}'` };
  }

  // Allowlist, not a denylist: only a CONFIRMED-running app may be skipped.
  // 'pending'/'starting'/'building'/undefined all fall through here too — a
  // platform killed inside awaitReadiness persists 'starting' with a live
  // process and a matching signature, and would otherwise be silently
  // adopted as skip-worthy despite never proving it was ready. This also
  // folds in the previous denylist (errored/needs-config/crash-looping):
  // none of those is 'running', so all redeploy via this one check.
  if (status !== 'running') {
    return { action: 'redeploy', reason: `status is ${status ?? 'unknown'}, not running` };
  }

  if (!isRuntimeRunning) {
    return { action: 'redeploy', reason: 'runtime does not report the app running' };
  }

  if (!hasPort) {
    return { action: 'redeploy', reason: 'no persisted port to reconcile routing against' };
  }

  if (portDrifted) {
    return {
      action: 'redeploy',
      reason: 'runtime-reported port differs from the persisted port',
    };
  }

  if (grantedApiScopesCount > 0) {
    return { action: 'redeploy', reason: 'app holds granted API scopes — DROP_API_KEY must rotate on start' };
  }

  if (!runtimeSpecCurrent) {
    return { action: 'redeploy', reason: 'runtime spec revision is stale' };
  }

  return null; // undecided — proceed to the signature phase
}

/**
 * The signature phase of the boot-reconciliation verdict — only reached when
 * decideBootReconciliationCheap returns null. Still pure/side-effect-free;
 * the I/O (the scan, the secret read) happens in the caller, before this is
 * invoked.
 */
export function decideBootReconciliationSignature(
  input: SignatureBootReconcileInput
): BootReconcileDecision {
  const { recordedHash, currentSignature, secretFingerprintChanged } = input;

  if (recordedHash === undefined) {
    return { action: 'redeploy', reason: 'no recorded source signature' };
  }

  if (!currentSignature) {
    return { action: 'redeploy', reason: 'source signature computation failed' };
  }

  if (currentSignature.hash !== recordedHash) {
    // Any difference redeploys. A hash has no notion of "before/after" the
    // way a raw mtime did — there's no "newer"/"older" direction to report
    // any more, only "changed or not" — but that's strictly stronger: the
    // old max-mtime-only signal missed a deletion/rename that didn't touch
    // the single newest file, and missed a replaced file whose (tar/upload-
    // archived) mtime happened to land below the tree's existing max. This
    // hashes every (relativePath, mtimeMs, size) tuple, so any addition,
    // deletion, rename, or in-place edit anywhere in the tree changes it.
    return {
      action: 'redeploy',
      reason:
        'source changed (hash mismatch, ' +
        // JSON.stringify, not raw interpolation: under isolation 'none' a
        // tenant controls their own filenames and could otherwise forge a
        // fake log line via a crafted path (control chars, embedded newlines).
        `newest: ${JSON.stringify(currentSignature.newestPath)})`,
    };
  }

  if (secretFingerprintChanged) {
    return { action: 'redeploy', reason: 'secret set changed since last deploy' };
  }

  return { action: 'skip', reason: 'signature unchanged' };
}

/**
 * Full boot-reconciliation verdict for one already-known (persisted-config)
 * app — runs both phases unconditionally. This is the entry point used by
 * unit tests that exercise the whole matrix in one call; reconcileAppsOnBoot
 * itself calls the two phases separately so it can skip the expensive one
 * (see decideBootReconciliationCheap's doc comment).
 *
 * The governing failure mode is silent staleness: a wrong 'skip' leaves an
 * app serving old code with no error and nothing to notice, which is worse
 * than today's rebuild-everything behaviour. Every ambiguous case therefore
 * redeploys; 'skip' is returned only for the single narrow case of a known,
 * non-grouped, unscoped app under a current runtime spec that the runtime
 * reports running right now, with a port to reconcile, an unchanged source
 * signature, and an unchanged secret set.
 */
export function decideBootReconciliation(input: BootReconcileInput): BootReconcileDecision {
  return decideBootReconciliationCheap(input) ?? decideBootReconciliationSignature(input);
}

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
  /** Periodic per-app disk accounting (Step 8c). */
  private diskSweepTimer: NodeJS.Timeout | null = null;
  /** Idle-reaper sweep (Step 9). */
  private idleSweepTimer: NodeJS.Timeout | null = null;
  private readonly idleState: IdleSweepState = createIdleSweepState();
  /**
   * app name -> sweeps in which it was a reap candidate and was only logged.
   *
   * Per app, not per sweep and not per process: this is what guarantees that
   * EVERY deletion is preceded by `DROP_IDLE_REAP_DRY_RUNS` logged warnings
   * naming that app, rather than the budget being spent by whichever app
   * happened to qualify first.
   */
  private readonly idleDryRuns = new Map<string, number>();

  private subscriptions: Unsubscribe[] = [];
  // Held separately from `subscriptions`: must stay subscribed through
  // drainInProgress() in stop() so late-completing deploys still close out
  // (see the drain-window fix in docs/plans/2026-07-06-p2-4-deploy-observability.md).
  private deployTrackerUnsub?: Unsubscribe;
  private deployDetailUnsub?: Unsubscribe;
  /**
   * appName -> the guardrail key this deploy was admitted under.
   *
   * Held so the OUTCOME is recorded against the same key the gate checked. The
   * principal is known only where the deploy was triggered, and the success or
   * failure surfaces much later in a different handler — recomputing the key
   * there would silently key automation-triggered outcomes differently from the
   * gate that let them through, so the window would never close.
   */
  private readonly breakerKeys: Map<string, GuardrailKey[]> = new Map();
  private isRunning = false;
  // Snapshot of each app's persisted status, taken in initializeServices
  // BEFORE syncStateWithConfigs/syncStateWithProcesses run — both reconcile
  // status against the live runtime and can overwrite 'errored'/'needs-config'/
  // 'crash-looping' with 'running' for an app whose (broken) process the
  // runtime still reports as up. reconcileAppsOnBoot (M1) reads status from
  // here, not post-sync, so its always-redeploy rule for those statuses is
  // reachable for the exact case it exists for. Cleared after boot
  // reconciliation runs so it can't leak into a later start() on this instance.
  private bootStatusSnapshot: Map<string, AppStatus> | null = null;
  private usedPorts: Map<number, string> = new Map(); // port -> appName ownership
  private appsInProgress: Set<string> = new Set(); // Track apps being built/started
  // Builds deferred because the concurrent-build cap was full (appName -> its
  // path + type hint). A first-boot or single-drop burst can briefly saturate
  // the cap — in docker mode especially, where a first-time base-image pull
  // holds a build slot for a while — and without a drain those deferred builds
  // wait for a file change that may never come, so a static/other app "never
  // starts automatically". `drainPendingBuilds` retries them as slots free.
  private pendingBuilds: Map<string, { appPath: string; appType: string; actor?: DeployActorInfo }> =
    new Map();
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
  /**
   * Startup readiness window: how long handleStartApp waits for an app to
   * prove it is up. A process that dies or crash-loops fails immediately
   * regardless, so this bounds only the ambiguous "still booting?" case —
   * raising it delays no real failure. 20s was under the cold-start time of
   * ordinary apps (migrations, large dependency graphs, connection warm-up).
   * Keep below the MCP deploy wait (DEFAULT_DEPLOY_WAIT_MS, 120s) so
   * deploy_files still reports an outcome rather than timing out.
   */
  private readonly readinessTimeoutMs = Math.max(
    50,
    Number(process.env.DROP_READINESS_TIMEOUT_MS) || 60_000
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
      // The gate's evidence trail. Under data/logs so the EXISTING retention
      // sweep prunes it — which is why its files end `.access.log`.
      getAccessLog(path.join(this.config.dropRoot, 'data', 'logs'));

      this.logRetention = getLogRetentionService(
        path.join(this.config.dropRoot, 'data', 'logs'),
        this.config.logRetentionDays
      );
      this.logRetention.start();
      this.startDiskCeilingSweep();
      this.startIdleReaper();

      // Anchor the deploy quota under DROP_ROOT. Its fallback path is relative
      // and would resolve against whatever CWD `drop serve` was launched from,
      // scattering the store — and silently handing every caller a fresh
      // allowance whenever the service is started from a different directory.
      const quotaStore = path.join(
        this.config.dropRoot,
        'data',
        'drop-svc',
        'principal-quotas.json'
      );
      await getPrincipalQuota(quotaStore).initialize();

      // Initialize services
      await this.initializeServices();

      // In docker mode, stop any PM2-managed apps before the watcher starts so
      // containers can bind to the same ports without conflict.
      if (this.config.isolation === 'docker') {
        await this.runFirstBootMigration();
      }

      // Wire up event handlers
      this.setupEventHandlers();

      // DROP-152: establish whether tenant containers are isolated from each
      // other BEFORE anything reads the answer. `ensureNetwork` otherwise runs
      // only on the first container start, and a docker box restarting into
      // steady state skips every app at boot reconciliation and starts none —
      // so the value stayed 'unknown' for the whole process lifetime and the
      // `tenant-network-shared` blocker could never fire on precisely the box
      // it exists to describe.
      if (this.config.isolation === 'docker') {
        await probeTenantNetworkIsolation().catch((error) => {
          this.logger.warn('Could not determine tenant network isolation', 'RUNTIME', error);
        });
      }

      // Report any persisted access-gate policy this box cannot enforce.
      // Placed HERE, after initializeServices() has loaded the app configs --
      // assertStartupConstraints above runs before that and can see no app's
      // policy at all -- and deliberately non-fatal.
      await this.sweepAccessGates();

      // M1 boot reconciliation (DROP_BOOT_RECONCILE): decide skip vs redeploy
      // per known app BEFORE the watcher starts, so a stable app's own
      // initial scan never fabricates an app:detected for it. No-op unless
      // the flag is set — see reconcileAppsOnBoot. 'observe' is deferred
      // below (M1 review item 9, round-2 diff pass): it never seeds the
      // watcher or gates anything (pure logging), so running it here would
      // needlessly delay the watcher/API server coming up for a mode whose
      // entire purpose is passive measurement.
      if (this.config.bootReconcileMode !== 'observe') {
        await this.reconcileAppsOnBoot();
      }

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

      // 'observe' mode's boot reconciliation pass, deferred (see above) —
      // fire-and-forget: it only logs, never seeds/gates, and must not delay
      // `platform:started` for the rest of the fleet.
      if (this.config.bootReconcileMode === 'observe') {
        void this.reconcileAppsOnBoot();
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

    if (this.diskSweepTimer) {
      clearInterval(this.diskSweepTimer);
      this.diskSweepTimer = null;
    }
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = null;
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
    if (this.deployDetailUnsub) {
      this.deployDetailUnsub();
      this.deployDetailUnsub = undefined;
    }
    // The access log aggregates in memory between flushes, and `deploy.yml`
    // stops this process on every push to `develop` — so without this the
    // current window is lost on every deploy.
    try {
      await getAccessLog().flush();
    } catch {
      // Never block shutdown on log hygiene.
    }
    resetAccessLog();

    try {
      await getDeployTracker().flush();
    } catch {
      // best-effort
    }
    resetDeployTracker();
    try {
      await getDeployDetailStore().flush();
    } catch {
      // best-effort
    }
    resetDeployDetailStore();
    this.breakerKeys.clear();
    resetDeployBreaker();
    resetPrincipalQuota();

    // Stop API server
    if (this.apiServer) {
      await this.apiServer.stop();
      this.apiServer = null;
    }

    // Close settings manager — AFTER the API server, deliberately.
    //
    // This used to sit up with the state-manager resets, ~90 lines earlier,
    // which left a multi-second window (Postgres and Redis shutdown, then
    // Caddy) during which the API was still serving requests while the
    // singleton had been reset. `getSettingsManager()` self-defaults rather
    // than throwing, so a caller in that window got a FRESH manager with
    // empty settings and `corrupt = false` — meaning
    // `getUserConnectorsEnabled()` returned its `?? true` default and the
    // connector gate silently FAILED OPEN while Caddy was still routing to
    // us. Every push to `develop` restarts this service, so that window
    // opened on every deploy. Torn down last, after its last consumer.
    if (this.settingsManager) {
      await this.settingsManager.close();
      resetSettingsManager();
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

    // Ensure ancestors exist first (default mode, same as everywhere else).
    try {
      await fs.mkdir(dataDir, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        this.log('warn', `Failed to create directory: ${dataDir}`, error);
      }
    }

    // Platform state (settings.json, secrets.json, encryption.key, ...) can
    // hold plaintext secrets (e.g. the GitHub webhook HMAC secret) — keep the
    // directory non-world-traversable, same rationale as `backup` below.
    // (POSIX-effective only; on Windows this relies on NTFS ACL inheritance.)
    //
    // Two-step, not a single `recursive: true, mode: 0o700` mkdir:
    //  1. Non-recursive create at 0700. Since `dataDir` already exists (or a
    //     transient failure above left it missing, in which case this simply
    //     ENOENTs and gets warn-logged rather than creating it), this call
    //     has at most one path segment (`drop-svc`) to create — it is
    //     structurally impossible for a non-recursive mkdir to stamp an
    //     ancestor directory (`data/`, the drop root) 0700 and block
    //     traversal into siblings like `data/webapps` for non-owner
    //     processes. EEXIST is swallowed; other errors are warn-logged.
    //  2. Unconditional chmod, in its own try/catch. `mkdir`'s `mode` only
    //     applies at creation time, so step 1 alone would leave an install
    //     upgraded from before this hardening was added at its old, looser
    //     mode forever. Chmod-ing every start closes that gap for existing
    //     installs too. Best-effort: warn on failure, and this is a no-op on
    //     Windows (no POSIX mode bits) — never fatal either way.
    try {
      await fs.mkdir(path.join(dataDir, 'drop-svc'), { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        this.log('warn', `Failed to create directory: ${path.join(dataDir, 'drop-svc')}`, error);
      }
    }
    try {
      await fs.chmod(path.join(dataDir, 'drop-svc'), 0o700);
    } catch (error) {
      this.log('warn', `Failed to set permissions on directory: ${path.join(dataDir, 'drop-svc')}`, error);
    }

    const directories = [
      // Root
      this.config.dropRoot,
      // Platform directory (for future use)
      path.join(this.config.dropRoot, 'apps', 'drop-svc'),
      // Data directories (preserved during upgrade)
      dataDir,
      this.config.appsDirectory, // data/webapps
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
        // The MODULE singleton must be cleared too, not just these fields.
        // `getRedisProvisioner(server, root)` above SETS it before
        // `initialize()` is awaited, so a failed initialize leaves a live
        // singleton that every route-side reader (GET /db/:name's redis flag
        // and quota state) still sees — reporting Redis as available on a box
        // where the platform has disowned it, and then 500ing when the user
        // clicks Attach because `this.redisProvisioner` is null. Display and
        // enforcement must not disagree at the point of a button press.
        resetRedisProvisioner();
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

    // Per-deploy diagnostics, alongside the tracker's milestone rows. Same
    // lifetime and the same held-separately unsubscribe, so a deploy failing
    // during the shutdown drain still records why.
    const detailStorePath = path.join(
      this.config.dropRoot,
      'data',
      'drop-svc',
      'deploy-details.json'
    );
    const deployDetails = getDeployDetailStore(detailStorePath);
    await deployDetails.initialize();
    this.deployDetailUnsub = deployDetails.subscribe(this.eventBus);

    // Snapshot pre-sync status for reconcileAppsOnBoot (M1) — see
    // bootStatusSnapshot's doc comment. Must be taken before the very first
    // reconciling call below. Gated on the mode so 'off' (default) stays a
    // true no-op — no scan, no seeding, no logs, not even this Map build.
    if (this.stateManager && this.config.bootReconcileMode !== 'off') {
      this.bootStatusSnapshot = new Map(
        this.stateManager.getAllApps().map((a) => [a.name, a.status])
      );
    }

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
    // No ignorePatterns override here: createWatcherConfig MERGES overrides
    // with DEFAULT_IGNORE_PATTERNS rather than replacing it, and
    // node_modules/.git/dist/build are already in that default set — a
    // hardcoded duplicate here was a no-op that undermined
    // DEFAULT_IGNORE_PATTERNS as the single source of truth (see
    // BOOT_RECONCILE_IGNORE_DIRS above, which derives from it).
    this.watcher = new WatcherService({
      appsDir: this.config.appsDirectory,
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
      // DROP-151 Phase 2: GET /db/:name reports quota state alongside
      // checkDbQuota/checkRedisQuota's enforcement — same limits, via
      // runtime-config so a route file never has to re-derive them.
      maxDbsPerUser: this.config.maxDbsPerUser,
      maxRedisPerUser: this.config.maxRedisPerUser,
      // DROP-152: the access-gate route refuses to enable a gate outside
      // docker isolation. Passed through rather than re-read from the env in
      // the route, so the route and the platform can never disagree about
      // which mode is actually running.
      isolation: this.config.isolation === 'docker' ? 'docker' : 'none',
      // DROP-153: the operator kill switch, forwarded so a route can answer
      // "is this box even trying to enforce a gate" without re-reading the
      // env var itself.
      accessGateEnabled: this.config.enableAccessGate,
    });

    await this.apiServer.initialize();
    await this.apiServer.start();

    // Expose restart/start orchestration to the API routes via the
    // platform-ops seam — a direct import would be circular (platform → api → routes).
    setPlatformOps({
      restartApp: (name) => this.restartApp(name),
      isAppInProgress: (name) => this.appsInProgress.has(name),
      promoteApp: (name) => this.promoteApp(name),
      removeGroup: (name) => this.removeGroup(name),
      purgeAppArtifacts: (name, opts) => this.purgeAppArtifacts(name, opts),
      attachService: (name, serviceId) => this.attachService(name, serviceId),
      detachService: (name, serviceId) => this.detachService(name, serviceId),
      getServiceIntent: (name, serviceId) => this.getServiceIntent(name, serviceId),
      reconfigureRoute: (name) => this.reconfigureRoute(name),
      assessAccessGate: (name) => this.assessAccessGate(name),
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

  /**
   * Source-tree signature across an app's source tree, skipping
   * BOOT_RECONCILE_IGNORE_DIRS — the signature phase of boot reconciliation
   * (M1) compares the returned hash against AppConfig.sourceHash. Throws
   * (ENOENT, permission error, over a scan bound, ...) when appPath is
   * missing/unreadable/too large; callers must treat that as "redeploy",
   * never swallow it into a false "unchanged".
   *
   * M1 review item 2 (round-2 diff pass): hashes the sorted
   * (relativePath, mtimeMs, size) tuple of every file/dir, not just the
   * single newest mtime — a max-mtime-only signal missed a deletion/rename
   * that didn't touch whichever file held the max, and missed a replaced
   * file whose (tar/upload-archived) mtime happened to land below it. Git
   * clone and the monorepo copy always write fresh mtimes, so they were
   * never at risk; the tar/upload path — the whole reason mtime-to-mtime was
   * chosen over lastDeployedAt in the first place — was.
   *
   * Bounded on depth, entry count, and wall-clock time (M1 review item F):
   * under isolation 'none' a tenant controls their own app directory and
   * this runs serially per app inside start(), before the API server comes
   * up — an unbounded walk would let one huge/deep tree hold platform
   * startup hostage. Each bound throws a DISTINCT message (not a generic
   * catch-all) so reconcileAppsOnBoot's logs can tell "app dir deleted"
   * apart from "tree too big to scan" — both still redeploy either way, but
   * only one of them is actionable by an operator reading the boot log.
   */
  private async computeSourceMtimeMs(appPath: string): Promise<SourceSignature> {
    const deadline = Date.now() + BOOT_RECONCILE_SCAN_TIMEOUT_MS;
    let entriesVisited = 0;

    const rootStat = await fs.stat(appPath);
    let newestMtimeMs = rootStat.mtimeMs;
    let newestPath = '.';
    // (relativePath, mtimeMs, size) per entry — the actual signature. The
    // root itself is included so a bare touch of the app dir (no children
    // changed) still registers.
    const entries: Array<[string, number, number]> = [['.', rootStat.mtimeMs, rootStat.size]];

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > BOOT_RECONCILE_SCAN_MAX_DEPTH) {
        throw new Error(`boot-reconcile scan exceeded depth cap (${BOOT_RECONCILE_SCAN_MAX_DEPTH})`);
      }
      // Checked between awaits (readdir/lstat), not preemptively — a single
      // slow syscall can still overrun this, which is an accepted tradeoff:
      // the bound exists to stop an unbounded WALK, not to guarantee a hard
      // wall-clock ceiling.
      if (Date.now() > deadline) {
        throw new Error(`boot-reconcile scan exceeded timeout (${BOOT_RECONCILE_SCAN_TIMEOUT_MS}ms)`);
      }

      const dirEntries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of dirEntries) {
        if (BOOT_RECONCILE_IGNORE_DIRS.has(entry.name)) continue;

        entriesVisited++;
        if (entriesVisited > BOOT_RECONCILE_SCAN_MAX_ENTRIES) {
          throw new Error(`boot-reconcile scan exceeded entry cap (${BOOT_RECONCILE_SCAN_MAX_ENTRIES})`);
        }

        const full = path.join(dir, entry.name);
        const stat = await fs.lstat(full);
        const relative = path.relative(appPath, full);
        entries.push([relative, stat.mtimeMs, stat.size]);
        if (stat.mtimeMs > newestMtimeMs) {
          newestMtimeMs = stat.mtimeMs;
          newestPath = relative;
        }
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
        }
      }
    };
    await walk(appPath, 0);

    // Sorted for determinism — readdir's order is not guaranteed to be
    // stable across calls/platforms, and an unsorted hash would flag a
    // no-op re-scan as "changed".
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    const hash = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');

    return { hash, newestPath };
  }

  /**
   * Whether the app's current secret set differs from the fingerprint
   * recorded at its last deploy (AppConfig.secretFingerprint). Delegates to
   * SecretManager.fingerprint (M1 review item 5, round-2 diff pass — hashes
   * each key with its STORED CIPHERTEXT, never a decrypted value, so no
   * plaintext ever crosses into AppConfig, a much weaker boundary — a 0644
   * YAML file — than the secrets store's own 0600 encrypted JSON). An
   * unavailable secretManager counts as changed — fail toward redeploying
   * rather than assume "unchanged" from a comparison we can't actually make,
   * the same doctrine as every other ambiguous signal in
   * decideBootReconciliation.
   */
  private hasSecretFingerprintChanged(config: AppConfig): boolean {
    if (!this.secretManager) return true;
    const current = this.secretManager.fingerprint(config.name);
    return current !== config.secretFingerprint;
  }

  /**
   * Record the source-mtime signature, secret-set fingerprint, and current
   * runtime-spec revision observed at THIS successful deploy — read back by
   * reconcileAppsOnBoot (M1) on the NEXT boot to decide skip vs redeploy.
   * Called from every path that confirms a real process/container is up
   * (handleStartApp after readiness succeeds, handleAppUpdate and
   * restartApp after runtime.start() succeeds — neither of those two gates
   * on readiness today, so "runtime.start() succeeded" is their equivalent
   * success point). A git/upload redeploy that never recorded here would
   * look "unchanged" for a whole extra boot cycle before the fresh state was
   * ever compared against.
   *
   * Deliberately NEVER awaited by its callers (`void this.recordDeploySignature(...)`)
   * and never throws (every step, including the config write, is
   * try/caught): this is pure post-success bookkeeping, not part of the
   * deploy's own success/failure contract, and MUST NOT delay the
   * 'running' state-manager write or appsInProgress's release — either
   * would reopen a window between "runtime/state report the app up" and
   * "the deploy is actually finished" that a concurrent caller (another
   * restart, a readiness-polling test) can race into. Best-effort in the
   * fullest sense: on any failure the field is just left unrecorded, which
   * reconcileAppsOnBoot already treats as "redeploy" next time (fail toward
   * redeploying), same as any other ambiguous case. Still logically "after
   * the app is confirmed up" per its call sites — capturing it earlier would
   * race the app's own startup writes into its tree (migrations, generated
   * files, first-run bootstrapping) and make skip/redeploy nondeterministic.
   */
  private async recordDeploySignature(appName: string, appPath: string): Promise<void> {
    try {
      if (!this.appConfigService) return;

      let sourceHash: string | undefined;
      try {
        sourceHash = (await this.computeSourceMtimeMs(appPath)).hash;
      } catch {
        sourceHash = undefined;
      }

      const secretFingerprint = this.secretManager?.fingerprint(appName);

      await this.appConfigService.updateConfig(appName, {
        ...(sourceHash !== undefined ? { sourceHash } : {}),
        ...(secretFingerprint !== undefined ? { secretFingerprint } : {}),
        runtimeSpecFingerprint: containerPolicyFingerprint({
          apiPort: this.config.apiPort,
          maxMemoryMbPerApp: this.config.maxMemoryMbPerApp,
          maxCpusPerApp: this.config.maxCpusPerApp,
          // DROP-072: same gating as the actual mount/env-var call sites
          // (buildStartSpec) — undefined outside docker isolation.
          pgSocketDir:
            this.config.isolation === 'docker'
              ? (this.postgresServer?.getSocketDir() ?? undefined)
              : undefined,
        }),
      });
    } catch (error) {
      this.logger.warn(`Failed to record deploy signature for ${appName}`, 'BOOT', error);
    }
  }

  /**
   * M1 boot reconciliation (DROP_BOOT_RECONCILE). Runs once at startup,
   * AFTER setupEventHandlers (the app:detected subscriber the redeploy path
   * publishes to must already exist) and AFTER runFirstBootMigration (docker
   * mode's runtime status must reflect the migration). Modes 'off' and 'on'
   * run BEFORE watcher.start() — the watcher's own initial scan would
   * otherwise fabricate app:detected for every existing app dir against its
   * empty in-memory knownApps set. Mode 'observe' is the one exception
   * (M1 review item 9, round-2 diff pass): it never seeds the watcher or
   * gates anything, so `start()` defers and fire-and-forgets it until AFTER
   * watcher.start()/startApiServer() — running it before either needlessly
   * delayed boot for a mode whose entire purpose is passive measurement. See
   * docs/plans/2026-07-25-restart-isolation-and-marketing-split.md M1.
   *
   * 'off' (default) is a pure no-op: no scan, no seeding, no logs — today's
   * behaviour, byte-for-byte. 'observe' computes and logs the decision it
   * would make per app without seeding the watcher or acting on it, so the
   * normal app:detected pipeline still runs unchanged. 'on' seeds the
   * watcher's knownApps from persisted config (suppressing its fabricated
   * detection) and acts: 'skip' reconciles routing only (handleConfigureRoute
   * — no detect/install/build/runtime.start) and re-arms the health prober +
   * crash-loop watch (armPostDeployWatches) so a left-running app is
   * supervised exactly like a freshly deployed one, 'redeploy' publishes
   * app:detected (the SAME event and subscriber a real watcher-driven
   * detection uses) so the monorepo services: interception and the
   * isCloning/isUploading/autoBuild guards all apply exactly once, in their
   * one normal place — fire-and-forget, the same way the watcher's own
   * dispatch is fire-and-forget (EventBus.publish never awaits its
   * subscribers), so a rebuilding app never blocks the rest of startup.
   *
   * The cheap half of the predicate (status/running/port/group/scopes/spec)
   * is checked before the expensive half (source-mtime walk, secret
   * fingerprint, item-1 readiness probe) so an app that's already decidable
   * costs no I/O. The whole DECIDE half (decideOneAppOnBoot) runs with
   * bounded concurrency across apps (M1 review item 9); the ACT half
   * (markAppKnown/routing/watches/publish) stays serial, in original config
   * order, so nothing here introduces new concurrent access to shared
   * platform state (see decideOneAppOnBoot's and reconcileAppsOnBoot's
   * internal comments). Every per-app decision AND act step is independently
   * try/caught: an unexpected failure anywhere redeploys just that one app
   * rather than aborting reconciliation for the rest of the fleet.
   */
  private async reconcileAppsOnBoot(): Promise<void> {
    const mode = this.config.bootReconcileMode;
    if (mode === 'off') {
      this.bootStatusSnapshot = null;
      return;
    }
    if (!this.appConfigService || !this.stateManager || !this.runtime || !this.watcher) {
      this.bootStatusSnapshot = null;
      return;
    }

    const configs = this.appConfigService.getAllConfigs();
    if (configs.length === 0) {
      this.bootStatusSnapshot = null;
      return;
    }

    let runningByName: Map<string, AppProcessInfo>;
    try {
      const processes = await this.runtime.getAllStatus();
      runningByName = new Map(
        processes.filter((p) => p.status === 'running').map((p) => [p.name, p])
      );
    } catch (error) {
      // Can't tell what's actually running — fail toward today's behaviour
      // (leave the watcher to fabricate app:detected as usual) rather than
      // guess and possibly skip a genuinely-dead app.
      this.logger.warn('Boot reconcile: failed to read runtime status, skipping', 'BOOT', error);
      this.bootStatusSnapshot = null;
      return;
    }

    // M1 review item 9 (round-2 diff pass): the DECIDE half of each app's
    // reconciliation (the source-tree walk, up to 5s, plus — for a skip
    // candidate — the readiness probe, up to ~4s) is the expensive part and
    // reads no shared platform state, so it runs with BOUNDED CONCURRENCY
    // (4 workers) rather than fully serially — on a large fleet that's the
    // difference between "boot takes minutes" and "boot takes seconds". The
    // ACT half (markAppKnown, handleConfigureRoute, armPostDeployWatches,
    // eventBus.publish) stays SERIAL, in original config order, run only
    // after every decision is in: RouterService.addRoute's regenerateConfig
    // reads the full routes map and writes the WHOLE Caddyfile per call —
    // two concurrent writes for different apps race on which one lands
    // last, and the loser's route silently disappears from disk. Splitting
    // decide/act avoids that without touching RouterService's own locking
    // (out of scope here).
    //
    // Deliberately NO global deadline for the whole pass: an app "not yet
    // reached" under a deadline would get no markAppKnown and no
    // app:detected — and since item 6 replaced the watcher's boot-epoch with
    // chokidar's own `ignoreInitial: true`, nothing else would ever detect
    // it either. The per-app 5s scan bound (item F) already caps the
    // pathological single-app case; bounding the WHOLE pass has no
    // fail-safe fallback to bound toward.
    const decisions = await this.mapWithConcurrency(
      configs,
      BOOT_RECONCILE_CONCURRENCY,
      (config) => this.decideOneAppOnBoot(config, this.bootStatusSnapshot, runningByName)
    );

    // Batches the Caddy reload (M1 review item G): a skip's route is added
    // via router.addRoute (which writes/regenerates the Caddyfile on its
    // own), but the actual `caddy reload` is deferred to ONE call after every
    // app in this pass has been decided — N skipped apps cost one reload,
    // not N serialized ones on the boot path.
    let anySkipped = false;

    for (const result of decisions) {
      const { config, appPath } = result;

      if (result.kind === 'group') {
        // A group child's BUILD belongs to its container. Its ROUTING does not.
        //
        // Deferring both left a running child with no Caddy route whenever the
        // container's expansion then failed — and because a group's children
        // share ONE hostname, that took the entire host out of Caddy: no site
        // block, so no certificate served and the TLS handshake refused
        // outright. Observed on dropkit.sh, where `ezsign.dropkit.sh` was
        // unreachable for hours while every other subdomain served fine and the
        // frontend process was alive the whole time. The trigger that day was
        // the group-ownership guard throwing (DROP-128), but any expansion
        // failure does it: a guardrail refusal, a full build queue, a parse
        // error. The blast radius is the worst part — one child's problem takes
        // down the healthy sibling too.
        //
        // So routing is reconciled here regardless, from the config that is
        // already the source of truth for ports.
        //
        // Only for a child the RUNTIME reports running: pointing Caddy at a
        // dead port would trade "host missing" for "502 on every path of a
        // shared host", and a deliberately-stopped child must not be published.
        const port = config.port;
        if (mode === 'on' && typeof port === 'number' && runningByName.has(config.name)) {
          await this.handleConfigureRoute(config.name, port, { skipCaddyReload: true });
          // Joins the same batched reload the skip branch below uses.
          anySkipped = true;
          this.logger.info(
            `Boot reconcile: group child '${config.name}' routing reconciled — ` +
              `build left to its container`,
            'BOOT'
          );
        } else {
          this.logger.info(
            `Boot reconcile: leaving group child '${config.name}' to its container's own detection`,
            'BOOT'
          );
        }
        continue;
      }

      if (result.kind === 'error') {
        if (mode === 'observe') {
          this.logger.info(`Boot reconcile (observe): would redeploy '${config.name}' — ${result.reason}`, 'BOOT');
          continue;
        }
        this.logger.warn(`Boot reconcile: '${config.name}' errored during decision, redeploying`, 'BOOT', result.error);
        this.watcher.markAppKnown(config.name);
        this.eventBus.publish('app:detected', { name: config.name, path: appPath, type: undefined });
        continue;
      }

      // result.kind === 'decided'
      const { decision, scanned, healthCheckPath } = result;

      if (mode === 'observe') {
        // "(no scan)" makes clear the source/secret comparison never ran —
        // without it the M0 measurement can't tell "didn't scan" (cheap
        // gate decided) from "scanned and matched" (signature phase ran).
        this.logger.info(
          `Boot reconcile (observe): would ${decision.action} '${config.name}' — ${decision.reason}` +
            (scanned ? '' : ' (no scan)'),
          'BOOT'
        );
        continue;
      }

      let published = false; // guards the catch block against a double-publish
      try {
        // mode === 'on': suppress the watcher's own fabricated detection for
        // this app regardless of the verdict below — we're handling it here.
        this.watcher.markAppKnown(config.name);

        if (decision.action === 'leave') {
          this.logger.info(`Boot reconcile: leaving '${config.name}' alone — ${decision.reason}`, 'BOOT');
        } else if (decision.action === 'skip') {
          this.logger.info(`Boot reconcile: '${config.name}' unchanged — reconciling routing only`, 'BOOT');
          const port = config.port as number;
          await this.handleConfigureRoute(config.name, port, { skipCaddyReload: true });
          anySkipped = true;
          // Re-arm the same supervision a fresh deploy gets (health prober +
          // crash-loop watch): this app is being left running, UNattended,
          // for the rest of the process's life, and the watches from its
          // ORIGINAL deploy (this platform process, if any) do not survive a
          // restart — without this, a skip would silently stop noticing a
          // dead or crash-looping app until the next full redeploy.
          // healthCheckPath was already parsed during the decide phase (as
          // part of the item 1 readiness probe) — reused here instead of
          // re-parsing drop.yaml.
          this.armPostDeployWatches(config.name, port, healthCheckPath);
        } else {
          this.logger.info(`Boot reconcile: redeploying '${config.name}' — ${decision.reason}`, 'BOOT');
          // Publish, don't call handleBuildApp directly: this is the exact
          // same event/subscriber a real watcher-driven detection uses, so
          // the monorepo services: interception and the
          // isCloning/isUploading/autoBuild guards inside handleAppDetected
          // all apply automatically instead of being bypassed.
          published = true;
          this.eventBus.publish('app:detected', { name: config.name, path: appPath, type: undefined });
        }
      } catch (error) {
        // Any unexpected failure anywhere above must not strand this app OR
        // abort reconciliation for the rest of the fleet — fail toward
        // redeploying it, the same doctrine as every other ambiguous case.
        this.logger.warn(`Boot reconcile: '${config.name}' errored acting on decision, redeploying`, 'BOOT', error);
        this.watcher.markAppKnown(config.name);
        if (!published) {
          this.eventBus.publish('app:detected', { name: config.name, path: appPath, type: undefined });
        }
      }
    }

    if (anySkipped) {
      await this.reloadCaddyIfRunning();
    }

    // One-shot: never read on a later start() of this same instance.
    this.bootStatusSnapshot = null;
  }

  /**
   * Bounded-concurrency map — runs `mapper` over `items` with at most
   * `limit` in flight at once, preserving result order (M1 review item 9,
   * round-2 diff pass). A plain worker pool: each of `limit` workers pulls
   * the next unclaimed index until the queue is empty.
   */
  private async mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<R>
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(limit, items.length));
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const i = nextIndex++;
        if (i >= items.length) return;
        results[i] = await mapper(items[i], i);
      }
    });
    await Promise.all(workers);
    return results;
  }

  /**
   * The DECIDE half of one app's boot reconciliation — everything up to and
   * including the item-1 readiness probe, but none of the platform-state
   * mutation (markAppKnown, route configuration, watch arming, the
   * app:detected publish). Side-effect-free enough to run concurrently
   * across apps (M1 review item 9) — see reconcileAppsOnBoot's doc comment
   * for why the ACT half stays serial. Never throws: any failure is
   * captured into an `{ kind: 'error' }` result so one app's problem can't
   * abort the whole batch.
   */
  private async decideOneAppOnBoot(
    config: AppConfig,
    bootStatusSnapshot: Map<string, AppStatus> | null,
    runningByName: Map<string, AppProcessInfo>
  ): Promise<
    | { kind: 'group'; config: AppConfig; appPath: string }
    | { kind: 'error'; config: AppConfig; appPath: string; reason: string; error: unknown }
    | {
        kind: 'decided';
        config: AppConfig;
        appPath: string;
        decision: BootReconcileDecision;
        scanned: boolean;
        healthCheckPath: string | undefined;
      }
  > {
    const appPath = config.path || path.join(this.config.appsDirectory, config.name);

    try {
      // M1 review item 3 (round-2 diff pass): a grouped child's fate is
      // entirely the monorepo CONTAINER's — expandMonorepo re-copies +
      // rebuilds EVERY child as one atomic fs.rm+fs.cp+build whenever the
      // container's own (unrelated, never-seeded) app:detected fires.
      // Treating the child itself as a reconcile candidate — even to
      // "redeploy" it — publishes the CHILD's own app:detected seconds-to-
      // minutes before the container's detection ever fires, so a build is
      // already in flight when expandMonorepo's fs.rm/fs.cp lands under it.
      // NEVER touch a grouped app here: no markAppKnown, no decision, no
      // publish, in EITHER mode — checked before anything else (including
      // the 'stopped' status below) so a user-stopped grouped child gets
      // the identical true no-op, not the leave+markAppKnown branch a
      // stopped standalone app takes.
      if (config.group) {
        return { kind: 'group', config, appPath };
      }

      if (!this.stateManager) {
        throw new Error('state manager unavailable');
      }

      // Prefer the PRE-sync snapshot: syncStateWithConfigs/syncStateWithProcesses
      // reconcile status against the live runtime and can overwrite
      // 'errored'/'needs-config'/'crash-looping' with 'running' for an app
      // whose broken process the runtime still reports as up (e.g. a failed
      // readiness check never stops the process) — reading post-sync status
      // here would make the always-redeploy rule for those statuses
      // unreachable for exactly the case it exists for.
      const status = bootStatusSnapshot?.get(config.name) ?? this.stateManager.getApp(config.name)?.status;
      const runtimeProc = runningByName.get(config.name);
      const isRuntimeRunning = runtimeProc !== undefined;
      // M1 review item 4 (round-2 diff pass): isolation-agnostic — see
      // CheapBootReconcileInput.runtimeSpecCurrent's doc comment.
      const runtimeSpecCurrent =
        config.runtimeSpecFingerprint ===
        containerPolicyFingerprint({
          apiPort: this.config.apiPort,
          maxMemoryMbPerApp: this.config.maxMemoryMbPerApp,
          maxCpusPerApp: this.config.maxCpusPerApp,
          // DROP-072: same gating as the actual mount/env-var call sites
          // (buildStartSpec) — undefined outside docker isolation.
          pgSocketDir:
            this.config.isolation === 'docker'
              ? (this.postgresServer?.getSocketDir() ?? undefined)
              : undefined,
        });
      // Port drift (M1 review item H): the skip path trusts config.port to
      // reconcile routing, but the runtime's own report is right there —
      // if they disagree, a routing-only skip would publish the app's
      // hostname to whatever else is actually bound at config.port.
      const portDrifted =
        isRuntimeRunning &&
        runtimeProc!.port !== null &&
        config.port !== undefined &&
        runtimeProc!.port !== config.port;

      let decision = decideBootReconciliationCheap({
        status,
        isRuntimeRunning,
        hasPort: Boolean(config.port),
        portDrifted,
        group: config.group,
        grantedApiScopesCount: config.grantedApiScopes?.length ?? 0,
        runtimeSpecCurrent,
      });
      let scanned = false;

      if (!decision) {
        scanned = true;
        let currentSignature: SourceSignature | undefined;
        try {
          currentSignature = await this.computeSourceMtimeMs(appPath);
        } catch (scanError) {
          // Distinct log line (item F): "deleted" vs "too big to scan" are
          // both a redeploy, but only one is actionable by an operator.
          this.logger.warn(
            `Boot reconcile: source scan failed for '${config.name}', redeploying`,
            'BOOT',
            scanError
          );
          currentSignature = undefined;
        }

        decision = decideBootReconciliationSignature({
          recordedHash: config.sourceHash,
          currentSignature,
          secretFingerprintChanged: this.hasSecretFingerprintChanged(config),
        });
      }

      // M1 review item 1 (round-2 diff pass, CRITICAL): the runtime
      // reporting "running" only proves the OS considers the process/
      // container alive — restartApp and handleAppUpdate write 'running'
      // immediately after runtime.start() with NO readiness gate of their
      // own, so a wedged app can carry status 'running' + a matching
      // signature straight through to here. Before committing to skip,
      // positively probe it — one bounded single-shot check (NOT the
      // polling awaitReadiness, whose per-deploy 60s retry window would
      // reintroduce the very boot-blocking item 9 exists to avoid).
      // Probed in BOTH modes, not just 'on': observe's numbers must
      // reflect exactly what 'on' would actually decide, not a rosier
      // subset of it that never checked.
      let healthCheckPath: string | undefined;
      if (decision.action === 'skip') {
        const dropYaml = await parseDropYaml(appPath);
        healthCheckPath = dropYaml.success ? dropYaml.config?.healthCheck : undefined;
        const answers = await this.probeSkipReadiness(config.port as number, healthCheckPath);
        if (!answers) {
          decision = {
            action: 'redeploy',
            reason: 'skip candidate did not answer a readiness probe',
          };
        }
      }

      return { kind: 'decided', config, appPath, decision, scanned, healthCheckPath };
    } catch (error) {
      const reason = `error during decision: ${error instanceof Error ? error.message : String(error)}`;
      return { kind: 'error', config, appPath, reason, error };
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
        // Manual promotion holds the build here, BEFORE anything starts. On a
        // first deploy nothing has ever served, so nothing goes live; on a
        // redeploy the running version is untouched.
        if (await this.holdForPromotion(payload.appId, payload.outputPath, payload.deployId)) {
          this.appsInProgress.delete(payload.appId);
          return;
        }
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
      await this.handleAppUpdate(
        payload.name,
        payload.path,
        payload.reason,
        payload.bypassCooldown,
        payload
      );
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
   * DROP-151: the owner's persisted attach/detach intent for a backing
   * service, if any — the TOP of the precedence order every call site below
   * must honour:
   *
   *   AppConfig.services  >  manifest declaration (`database:` / `redis:`)  >  inference
   *
   * Intent sits ABOVE the manifest, not merely above inference. The
   * justification is temporal, and it is the same rule as the owner-wins
   * precedent elsewhere in this file (appDatabaseUrlSource): the button was
   * clicked AFTER the manifest was written, so it is the newer intent. And on
   * the `deploy_from_git` path the manifest author is a third party, not
   * necessarily the app's owner — so a stale upstream pinning
   * `database: postgres` must not permanently deny the owner the ability to
   * detach their own database while it keeps counting against their quota.
   * Once an app has been attached or detached through this mechanism, its
   * manifest key stops being authoritative for that service; re-attaching is
   * what hands authority back.
   */
  private appServiceIntent(
    appName: string,
    serviceId: 'postgres' | 'redis'
  ): 'attached' | 'detached' | undefined {
    return this.appConfigService?.getConfig(appName)?.services?.[serviceId];
  }

  /**
   * Whether an app needs a database.
   *
   * Four sources, in precedence order:
   *   0. `AppConfig.services.postgres` — the owner's own attach/detach
   *      intent. Wins over everything below, including an explicit
   *      drop.yaml `database:` — see appServiceIntent's own comment for why
   *      intent outranks the manifest.
   *   1. An explicit `database:` in drop.yaml — the owner said so, so it wins
   *      outright otherwise.
   *   2. An ORM config file on disk.
   *   3. A Postgres client or ORM in package.json dependencies.
   *
   * (3) is why this exists in its current shape. It used to check only (1) and
   * (2), so an app built the way an agent builds one — Express, the `pg`
   * client, hand-written SQL, no drop.yaml and no ORM config file — got no
   * database and started with no DATABASE_URL at all. Meanwhile appNeedsRedis
   * right below has always read package.json. The asymmetry was the bug.
   *
   * Only clients DROP's PostgreSQL can actually serve are listed. A MySQL or
   * Mongo driver is deliberately absent: handing that app a `postgres://`
   * DATABASE_URL would be a connection string it cannot use, which is worse
   * than none. Embedded SQLite needs no provisioning either.
   */
  private async appNeedsDatabase(
    appName: string,
    appPath: string,
    detectionDatabase?: boolean | string
  ): Promise<boolean> {
    // Intent wins outright, above even the sqlite warning below — a detached
    // app must not log a mismatch warning for a database it no longer has.
    const intent = this.appServiceIntent(appName, 'postgres');
    if (intent === 'detached') return false;
    if (intent === 'attached') {
      // An attached app that has SINCE acquired its own DATABASE_URL (via
      // drop.yaml `env:`) is a real conflict, and DROP wins it: `dbEnvVars` is
      // spread after the `env:` layer, so the app is repointed at DROP's
      // database. That is deliberate and matches how an explicit
      // `database: postgres` already behaves — both are the owner asking for a
      // DROP database in as many words, and attach refuses up-front when the
      // app already has its own URL. It is logged rather than silent because
      // the failure mode (an app quietly talking to an empty database) is
      // indistinguishable from a bug at runtime. Whether an owner-supplied URL
      // should outrank an explicit declaration is a real question, but it is
      // pre-existing and applies equally to `database:` — so it belongs in its
      // own change, not smuggled in behind a different precedence for intent.
      const conflicting = await this.appDatabaseUrlSource(appName, appPath);
      if (conflicting) {
        this.logger.warn(
          `${appName} is attached to a DROP database but also supplies its own DATABASE_URL ` +
            `(${conflicting}) — the DROP database wins and the app's own URL is ignored. ` +
            'Detach the DROP database if the app should use its own.',
          'DATABASE'
        );
      }
      return true;
    }

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

    // NOTE: `database: false` is NOT an opt-out — it falls through to the
    // inference below, exactly as it did before DROP-150. B2 makes the
    // validator accept the boolean (so `database: true` stops discarding the
    // whole manifest), which is a parsing fix and stands on its own; making
    // `false` actually decline a database is a separate, behaviour-changing
    // question that was deliberately left out of that change.
    //
    // It is not just a missing branch. `appNeedsDatabase` is consulted only on
    // the deploy path — `buildFreshStartSpec` (restart, hot-reload) re-reads
    // the provisioner unconditionally — so an opt-out here would make deploy
    // and restart disagree about whether the app has a DATABASE_URL. And for
    // an app that already has a provisioned database there is no way to hand
    // it back short of deleting the app, so `false` would strand a database
    // that still holds tenant data and still counts against the per-user
    // quota. Both need answering before this becomes an opt-out; see the
    // `database: sqlite` question (B4), which is the same shape.

    // Everything below this line is INFERRED, not declared — so an owner who
    // has already supplied a DATABASE_URL has answered the question, and
    // inference must not overrule them. This is not merely tidiness: in the
    // start env, `...dbEnvVars` is spread AFTER BOTH `...secretEnvVars` and the
    // drop.yaml `env:` base layer, so provisioning here would override either
    // one and silently repoint the app from its real database at a
    // freshly-created empty one. An explicit `database:` in drop.yaml is exempt
    // (handled above) because that is the owner asking for a DROP database in
    // as many words.
    const ownSource = await this.appDatabaseUrlSource(appName, appPath);
    if (ownSource) {
      this.logger.debug(
        `${appName} supplies its own DATABASE_URL (${ownSource}) — skipping inferred database provisioning`,
        'DATABASE'
      );
      return false;
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

    // Finally, a Postgres client or ORM in package.json. Mirrors appNeedsRedis:
    // an app that installed a driver intends to talk to a database, whether or
    // not it also keeps an ORM config file. Non-Node apps declare `database:`
    // in drop.yaml instead — requirements.txt and go.mod are not read here.
    try {
      const pkgRaw = await fs.readFile(path.join(appPath, 'package.json'), 'utf-8');
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const postgresClients = [
        'pg',
        'pg-promise',
        'postgres',
        'slonik',
        'porsager-postgres',
        '@prisma/client',
        'prisma',
        'drizzle-orm',
        'knex',
        'sequelize',
        'typeorm',
        'objection',
        '@mikro-orm/postgresql',
      ];
      if (postgresClients.some((c) => c in deps)) {
        return true;
      }
    } catch {
      // No/unreadable package.json — not a Node app, or nothing to detect.
    }

    return false;
  }

  /**
   * Where the app's own DATABASE_URL comes from, if it has one — `'secret'`,
   * `'drop.yaml env'`, or null. Both layers matter: `dbEnvVars` is spread after
   * each of them when the start env is assembled, so provisioning would
   * override either.
   *
   * Fail-soft in both directions: an unavailable secret store or an unparseable
   * drop.yaml reports "no DATABASE_URL", which preserves the pre-existing
   * provisioning behavior rather than silently withholding a database.
   */
  private async appDatabaseUrlSource(
    appName: string,
    appPath: string
  ): Promise<'secret' | 'drop.yaml env' | null> {
    try {
      if (this.secretManager?.get(appName, 'DATABASE_URL')) return 'secret';
    } catch {
      // Secret store unavailable — fall through to the drop.yaml check.
    }

    try {
      const dropYaml = await parseDropYaml(appPath);
      const declared = dropYaml.success ? dropYaml.config?.env?.DATABASE_URL : undefined;
      // `env:` values may be string | number | boolean; only a non-empty
      // string is a usable connection string.
      if (typeof declared === 'string' && declared.trim().length > 0) {
        return 'drop.yaml env';
      }
    } catch {
      // Unreadable/invalid drop.yaml — nothing declared.
    }

    return null;
  }

  /**
   * The Redis mirror of `appDatabaseUrlSource`.
   *
   * This exists because the owner-supplied-URL protection was originally built
   * for Postgres only, which left the identical hazard wide open on Redis:
   * `redisEnvVars` is spread AFTER `secretEnvVars` in the start env, so
   * provisioning managed Redis for an app whose owner set their own
   * `REDIS_URL` silently repoints it at an empty instance. For a session or
   * cache store that is not a degraded feature — it is silent destruction of
   * live auth state, with the real store orphaned and still holding the data.
   */
  private async appRedisUrlSource(
    appName: string,
    appPath: string
  ): Promise<'secret' | 'drop.yaml env' | null> {
    try {
      if (this.secretManager?.get(appName, 'REDIS_URL')) return 'secret';
    } catch {
      // Secret store unavailable — fall through to the drop.yaml check.
    }

    try {
      const dropYaml = await parseDropYaml(appPath);
      const declared = dropYaml.success ? dropYaml.config?.env?.REDIS_URL : undefined;
      if (typeof declared === 'string' && declared.trim().length > 0) {
        return 'drop.yaml env';
      }
    } catch {
      // Unreadable/invalid drop.yaml — nothing declared.
    }

    return null;
  }

  /**
   * Whether an app wants managed Redis.
   *
   * `AppConfig.services.redis` — the owner's own attach/detach intent — wins
   * over everything below, same precedence as appNeedsDatabase (see
   * appServiceIntent's own comment). Otherwise: an explicit `redis:` in
   * drop.yaml wins (true opts in, false opts out); failing that, auto-detect a
   * Redis client in the app's package.json dependencies — the same "detect
   * from project files" approach appNeedsDatabase uses for ORM config.
   * Non-Node apps opt in via `redis: true` in drop.yaml.
   */
  private async appNeedsRedis(appName: string, appPath: string): Promise<boolean> {
    const intent = this.appServiceIntent(appName, 'redis');
    if (intent === 'detached') return false;
    if (intent === 'attached') {
      // Mirrors appNeedsDatabase: attach refuses up front when the app already
      // supplies its own REDIS_URL, but an app can acquire one AFTERWARDS and
      // the intent is permanent. DROP's instance wins (redisEnvVars is spread
      // after secretEnvVars), so log it — an app silently talking to an empty
      // session store is indistinguishable from a bug at runtime.
      const conflicting = await this.appRedisUrlSource(appName, appPath);
      if (conflicting) {
        this.logger.warn(
          `${appName} is attached to managed Redis but also supplies its own REDIS_URL ` +
            `(${conflicting}) — the managed instance wins and the app's own URL is ignored. ` +
            'Detach managed Redis if the app should use its own.',
          'REDIS'
        );
      }
      return true;
    }

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
   * doesn't need it, or the user's quota is exceeded. The app-facing host is
   * the container-reachable `drop-host` alias under docker isolation, loopback
   * otherwise.
   *
   * **This ALLOCATES on the restart path, and that is the one asymmetry to
   * know about here.** It is shared by the first-deploy start path and the
   * hot-reload/restart path (`buildFreshStartSpec`), and it does not care
   * which one is calling: an app with no existing allocation runs the full
   * `appNeedsRedis` -> quota -> `provisionAppRedis` sequence either way. So an
   * app that becomes Redis-shaped gets Redis on a plain `restart`.
   *
   * Postgres does the opposite. `buildFreshStartSpec` only ever re-reads an
   * existing database allocation, so an app that newly needs a *database*
   * needs a redeploy, not a restart (see `handleStartApp`, the sole caller of
   * the provisioning branch). The two services genuinely differ; this comment
   * used to claim the restart path "just re-fetches the existing allocation",
   * which is true of Postgres and false of Redis.
   *
   * Whether allocate-on-restart is *desirable* has never been decided — it is
   * recorded as an open question in the backing-service plan. It is pinned by
   * a test asserting allocation actually occurs, so a future change to it is
   * deliberate rather than accidental.
   */
  private async provisionRedisEnvVars(
    appName: string,
    appPath: string
  ): Promise<Record<string, string>> {
    if (!this.redisProvisioner) {
      return {};
    }

    // A 'detached' intent must win here, ABOVE the "already provisioned" early
    // return just below — otherwise a still-allocated Redis DB (deprovision
    // failed, or simply hasn't run yet on this restart) would keep coming back
    // on every restart regardless of the owner's explicit Detach, silently
    // ignoring it on exactly the path (buildFreshStartSpec) detach most needs
    // to reach.
    if (this.appServiceIntent(appName, 'redis') === 'detached') {
      return {};
    }

    const redisHost = this.config.isolation === 'docker' ? HOST_ALIAS : '127.0.0.1';

    // Already provisioned (e.g. hot-reload/restart) — just return its URL.
    if (this.redisProvisioner.isProvisioned(appName)) {
      return this.redisProvisioner.getEnvVars(appName, { host: redisHost }) || {};
    }

    if (!(await this.appNeedsRedis(appName, appPath))) {
      return {};
    }

    // Per-user quota (mirrors the Postgres DB quota).
    const ownerUserId = this.stateManager?.getApp(appName)?.userId;
    const redisQuota = this.checkRedisQuota(ownerUserId);
    if (!redisQuota.allowed) {
      this.logger.warn(
        `Redis quota reached for user ${ownerUserId} (${redisQuota.used}/${redisQuota.limit}), ` +
          `skipping Redis for ${appName}`,
        'REDIS'
      );
      return {};
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
   * Postgres per-user database quota. Extracted from what used to be an
   * inline branch in handleStartApp so a future attach route (DROP-151 Phase
   * 2) can refuse explicitly instead of the deploy path's own silent
   * warn-and-skip. Never throws; handleStartApp's behaviour on `allowed:
   * false` is unchanged — it still just skips provisioning and logs.
   *
   * Deliberately a TRUTHY test on `ownerUserId`, not `!== undefined` — an
   * ownerless app (a `DROP_API_KEY`/`cli-local` deploy) skips this quota
   * entirely. This diverges from checkRedisQuota below ON PURPOSE: unifying
   * the two either caps every ownerless app on the box under one shared
   * Postgres-shaped bucket, or gives Redis an unlimited ownerless path.
   * Neither is a decision this change makes — see the extension-catalog
   * plan's open question 1. Preserve this divergence; do not normalise it.
   */
  private checkDbQuota(
    ownerUserId: string | undefined
  ): { allowed: true } | { allowed: false; used: number; limit: number } {
    if (!ownerUserId || this.config.maxDbsPerUser <= 0 || !this.dbProvisioner) {
      return { allowed: true };
    }
    const used = (this.stateManager?.getAllApps() ?? []).filter(
      (a) => a.userId === ownerUserId && this.dbProvisioner!.isProvisioned(a.name)
    ).length;
    if (used >= this.config.maxDbsPerUser) {
      return { allowed: false, used, limit: this.config.maxDbsPerUser };
    }
    return { allowed: true };
  }

  /**
   * Redis per-user quota. Extracted from what used to be an inline branch in
   * provisionRedisEnvVars, mirroring checkDbQuota above — with the one
   * deliberate divergence documented there: this uses `ownerUserId !==
   * undefined`, not a truthy test, so an ownerless app IS subject to this
   * quota (shared across every ownerless app on the box). Do not normalise
   * the two checks to agree.
   */
  private checkRedisQuota(
    ownerUserId: string | undefined
  ): { allowed: true } | { allowed: false; used: number; limit: number } {
    if (ownerUserId === undefined || this.config.maxRedisPerUser <= 0 || !this.redisProvisioner) {
      return { allowed: true };
    }
    const used = (this.stateManager?.getAllApps() ?? []).filter(
      (a) => a.userId === ownerUserId && this.redisProvisioner!.isProvisioned(a.name)
    ).length;
    if (used >= this.config.maxRedisPerUser) {
      return { allowed: false, used, limit: this.config.maxRedisPerUser };
    }
    return { allowed: true };
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
      // Shape check only. Whether this name COLLIDES with something DROP
      // already sets is decided in buildStartSpec, positionally, against the
      // env it actually assembled — not here against a list. (A list cannot
      // express it: the protected set includes every owner-set secret.)
      //
      // Deliberately here and not in the parser: rejecting a malformed name at
      // parse time discards the WHOLE manifest (B2's bug), which would break
      // already-deployed entries like `env: API-URL` and fail OPEN on the
      // required-secret gate. Skipping the one entry keeps the rest of the
      // config — and the preflight — intact.
      if (!isValidEnvVarName(dep.env)) {
        this.logger.warn(
          `${appName}: depends_on '${dep.name}' names '${dep.env.slice(0, 40)}', which is not a ` +
            `valid environment variable name (letters, digits, underscore; not starting with a ` +
            `digit; max 64 chars) — skipping this injection`,
          'DEPS'
        );
        continue;
      }

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
   * Verify a service's source subtree is safe to materialize, immediately
   * before the copy that consumes it.
   *
   * `services.<x>.path` is validated at parse time by the drop.yaml parser's
   * `validateContainedPath`, but that check is purely lexical — it rejects
   * absolute paths and `..` traversal without ever touching the disk, so it
   * cannot see a symlink. `fs.stat` then *follows* symlinks, so a link
   * pointing out of the repo satisfies the "is it a directory?" check too.
   *
   * That matters because `fs.cp` does not dereference — it RECREATES each
   * symlink at the destination. A symlinked `services.<x>.path` makes the
   * child app directory itself a symlink aliasing the target, and a symlink
   * nested inside the subtree is reproduced verbatim inside the child. Either
   * way a static child serves whatever sits on the other end, including
   * another tenant's tree. `git clone` materializes symlinks, so this is
   * tenant-controlled input.
   *
   * Posture matches the upload path, which aborts an entire archive rather
   * than silently dropping a symlink entry (`tar-extract.ts`): refuse the
   * service and name the offending path, rather than materializing a
   * partially-correct tree.
   *
   * Only entries the copy would actually take are inspected — the same
   * exclusions the `fs.cp` filter applies — so a pnpm workspace's
   * `node_modules` link farm is irrelevant, never having been copied.
   */
  private async assertServiceSourceSafe(
    repoPath: string,
    srcDir: string
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    // Realpaths both sides, so a symlinked/junctioned segment can't escape.
    //
    // `isPathWithin` degrades to a LEXICAL resolve if realpath throws, which
    // would silently reduce this to the parse-time check it exists to
    // strengthen. That fallback is unreachable here: the caller has already
    // `fs.stat`ed srcDir, so it exists and every component is traversable —
    // and a symlink cycle throws ELOOP from that stat, skipping the service
    // before this runs. Keep the stat gate ahead of this call.
    if (!(await isPathWithin(repoPath, srcDir))) {
      return {
        ok: false,
        reason: 'it resolves outside the repository (symlinked or otherwise redirected)',
      };
    }

    const findSymlink = async (dir: string): Promise<string | null> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (DropPlatform.MONOREPO_COPY_EXCLUDE_RE.test(full)) continue;
        // readdir(withFileTypes) reports the entry's own type (lstat
        // semantics), so this sees the link itself, not its target — and
        // never follows it, so a link cycle can't spin this walk.
        if (entry.isSymbolicLink()) return full;
        if (entry.isDirectory()) {
          const found = await findSymlink(full);
          if (found) return found;
        }
      }
      return null;
    };

    const symlink = await findSymlink(srcDir);
    if (symlink) {
      return {
        ok: false,
        reason:
          `it contains a symlink ('${path.relative(repoPath, symlink)}'), which the copy would ` +
          `recreate inside the app directory`,
      };
    }

    return { ok: true };
  }

  /**
   * Whether anything at all occupies `p` — deliberately `lstat`, not the
   * `fs.access` of `pathExists`.
   *
   * `access` follows symlinks, so a DANGLING link reports "nothing here" and
   * the collision guard below would delete it. The guard's question is "does
   * this name already belong to something?", and a link occupies the name
   * whether or not its target resolves — the same follow-vs-don't distinction
   * that let a symlinked service path through `fs.stat` above.
   */
  private async entryExists(p: string): Promise<boolean> {
    try {
      await fs.lstat(p);
      return true;
    } catch {
      return false;
    }
  }

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
    config: DropYamlConfig,
    /** The caller whose redeploy triggered this, for guardrail keying. */
    actor?: DeployActorInfo
  ): Promise<void> {
    const group = (config.group || config.name || repoName).trim();
    const services = config.services ?? {};
    const serviceNames = new Set(Object.keys(services));

    // The deploy-from-git path registers the cloned repo itself as an app
    // before detection can know it's a container. That entry must survive —
    // its gitSource is what webhook auto-redeploys match on — but it is not
    // a runnable app: tag it so listings hide it and group teardown finds it
    // (the group can differ from the entry's own name via drop.yaml
    // name:/group:). Runs on every expansion, so a phantom left by an older
    // platform heals on the next redeploy. Folder-dropped containers were
    // never registered and no entry is created for them here.
    // OWNERSHIP GUARD on the group tag itself.
    //
    // `group` comes from the tenant's own drop.yaml and is validated only as a
    // non-empty string, yet it is treated downstream as an IDENTITY: it decides
    // which apps a group teardown destroys, and (Step 11) which OAuth resource
    // an app's MCP endpoint resolves to. A tenant naming another user's app as
    // their group therefore reaches into that user's world — the same root as
    // the deletion defect fixed in 026a712, closed here at the source rather
    // than patched at each consumer.
    //
    // Refuse rather than silently renaming: an operator who wrote `group: x`
    // and got `y` would have no idea why their services are not grouped.
    // A CLAIMANT is someone else's hold on the name — never this container's
    // own group members.
    //
    // The original `a.group === group` matched the children expandMonorepo
    // itself materializes, and since children were never given a userId they
    // read as belonging to a different owner than their own container. So the
    // FIRST expansion succeeded (no children yet) and every one after it threw:
    // a container refused because of its own offspring. On dropkit.sh that left
    // the `ezsign` group un-redeployable for three days, and the guard's own
    // regression test hid it by seeding a child with a userId that production
    // never writes.
    const containerOwner = this.stateManager?.getApp(repoName)?.userId;
    const groupClaimant = this.stateManager?.getAllApps().find((a) => {
      if (a.name === repoName) return false;
      // An app literally NAMED the group — the attack this guard exists for.
      if (a.name === group) return true;
      if (a.group !== group) return false;
      // Another CONTAINER for the same group: two tenants racing one name.
      if (a.isGroupContainer) return true;
      // Otherwise a MEMBER — a child of this group. Only a claimant when it is
      // demonstrably someone's; an unowned member is adopted below instead.
      //
      // This clause is NOT purely transitional. A folder-dropped container has
      // no userId of its own, so `containerOwner` is undefined and its children
      // stay unowned permanently — for those groups this is the steady state,
      // not a migration window. Removing it once "everything has a userId"
      // would break every folder-dropped group.
      return a.userId !== undefined;
    });
    if (groupClaimant && groupClaimant.userId !== containerOwner) {
      this.logger.error(
        `Refusing monorepo group '${group}' for '${repoName}': the name is already held by ` +
          `'${groupClaimant.name}', which belongs to a different owner.`,
        'MONOREPO'
      );
      throw new Error(
        `Monorepo group '${group}' is already in use by another account. ` +
          'Choose a different `group:` in drop.yaml.'
      );
    }

    if (this.stateManager?.hasApp(repoName)) {
      await this.stateManager.updateApp(repoName, { group, isGroupContainer: true });
    }

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

        const childPath = path.join(this.config.appsDirectory, childName);

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

        // ...and fail CLOSED when nothing vouches for the name but a directory
        // is already sitting there. Materialization below wipes childPath, so
        // "no config" must not read as "free to delete": a folder owns its name
        // from the moment it exists on disk, but only acquires an AppConfig once
        // the `app:detected` handler has run. `existing === undefined` therefore
        // also covers a real app mid-onboarding, one whose detection failed, and
        // an earlier expansion that crashed between the copy and the config
        // write — none of them ours to remove. A legitimate re-expansion is
        // unaffected: it matched the `existing` branch above.
        //
        // If `appConfigService` were unset, `existing` is always undefined and
        // this refuses every child whose folder exists. That is the safe
        // direction, and unreachable in practice: `initializeServices` assigns
        // it unconditionally, and both callers are event handlers that only
        // fire once the watcher is running.
        if (!existing && (await this.entryExists(childPath))) {
          this.logger.warn(
            `Skipping service '${svcName}': '${childPath}' already exists on disk with no app ` +
              `config to vouch for it; refusing to delete it. Remove it manually if it is stale.`,
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

        // Symlink containment — the parse-time check is lexical and the stat
        // above follows links, so neither can see one. Resolved here, against
        // the tree that is about to be copied.
        const safety = await this.assertServiceSourceSafe(repoPath, srcDir);
        if (!safety.ok) {
          this.logger.warn(
            `Skipping service '${svcName}': path '${svc.path}' in '${repoName}' rejected — ` +
              `${safety.reason}`,
            'MONOREPO'
          );
          continue;
        }

        // A user-stopped child is skipped BEFORE anything is written. Both
        // downstream paths refuse to build one (`handleAppUpdate:4439`,
        // `buildSub`), but they refuse AFTER the copy would have landed —
        // which would leave a stopped child holding new, unbuilt source for
        // the next `drop start` to serve.
        const childState = this.stateManager?.getApp(childName);
        if (childState?.status === 'stopped') {
          this.logger.info(
            `Skipping service '${svcName}': '${childName}' was stopped by the user`,
            'MONOREPO'
          );
          continue;
        }

        // Suppress the watcher's own onboarding of the folder we're about to
        // write — we onboard it ourselves below, same as the interception
        // above does for the container.
        this.watcher?.markAppKnown(childName);

        // Materialize IN PLACE (idempotent). This used to be
        // `fs.rm(childPath)` + `fs.cp`, which deleted a RUNNING child's whole
        // tree — build output and installed dependencies included — and left
        // its document root empty for the entire install + build. A docker
        // static child's nginx returned 500 throughout, and any early return
        // in the build path made that permanent (DROP-122).
        //
        // syncTree lands the source over the child, prunes what the source no
        // longer has, and keeps `node_modules` — so nothing is reinstalled
        // from scratch and no window exists where the tree is simply gone.
        //
        // `exclude` and `preserve` do different jobs here, deliberately:
        // `dist`/`build` are excluded from the source AND not preserved, so
        // the prune deletes the child's stale output. That is what forces a
        // rebuild — `StaticBuildStrategy.preBuild` treats a surviving
        // `dist/index.html` as "already built" and skips the build entirely,
        // which is the trap that got v2 of this change rejected.
        await syncTree(srcDir, childPath, {
          exclude: DropPlatform.MONOREPO_COPY_EXCLUDE_RE,
          preserve: DEFAULT_PRESERVE,
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
          // `!== undefined`, not a truthy check: `database: false` is now an
          // explicit opt-out (see appNeedsDatabase), and a truthy test drops
          // it here — the child would silently fall back to inference and get
          // a database its manifest declined. Same silent-drop class as the
          // historically missing `userId`. The `redis` line below has always
          // used `typeof … === 'boolean'` for exactly this reason.
          ...(svc.database !== undefined ? { database: svc.database } : {}),
          ...(typeof svc.redis === 'boolean' ? { redis: svc.redis } : {}),
          ...(svc.domains && svc.domains.length > 0 ? { domains: svc.domains } : {}),
          ...(svc.env ? { env: svc.env } : {}),
          ...(svc.build_env ? { build_env: svc.build_env } : {}),
          ...(svc.secrets ? { secrets: svc.secrets } : {}),
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
        // An EXISTING child is UPDATED, never re-registered.
        //
        // `registerApp` forces `status` back to 'pending' for anything not
        // already 'stopped' (state-manager.ts:265). That is correct for a
        // fresh deploy and fatal for a running child: `handleAppUpdate` reads
        // `wasRunning` from this status, and with it false BOTH halves of its
        // transaction invert — on success the stop is skipped and
        // `ProcessManager.start` early-returns on an already-online process
        // (new build on disk, old code still serving, deploy reported green);
        // on failure the child is marked 'errored' while its old process is
        // still alive. This inversion is precisely what got v2 rejected.
        // Children inherit the CONTAINER'S OWNER. Without this they were
        // written with no userId at all, which (a) made the ownership guard
        // above refuse the container on its own children, and (b) left group
        // apps invisible to their own non-admin owner, since listings filter by
        // userId. Safe to set unconditionally: the guard has already refused
        // any member owned by someone other than `containerOwner`, so by here a
        // member is either unowned or already ours.
        if (this.stateManager) {
          if (childState) {
            await this.stateManager.updateApp(childName, {
              type: narrowedType,
              path: childPath,
              group,
              ...(containerOwner ? { userId: containerOwner } : {}),
            });
          } else {
            await this.stateManager.registerApp(childName, childPath, narrowedType);
            await this.stateManager.updateApp(childName, {
              group,
              ...(containerOwner ? { userId: containerOwner } : {}),
            });
          }
        }

        // Sequential await: gives declared-order onboarding for the common
        // small-N case and stays under maxConcurrentBuilds without needing a
        // further file change to retrigger queued services (a single drop
        // produces none). If a service is deferred by the "Build queue full"
        // guard in handleBuildApp, it is not silently lost — the warning above
        // flags oversized groups — but it also won't auto-retrigger; that's
        // acceptable for the common small-N case and left for a future pass.
        if (this.config.autoBuild) {
          // Children inherit the container's actor. Left undefined they would
          // each key as automation on their OWN name, so a loop that varies
          // service names would accumulate nowhere.
          //
          // An EXISTING child goes through the update transaction every other
          // app on this platform already gets: build in place while the old
          // process keeps serving, stop only after the build succeeds, restart
          // on the same port, and restore 'running' if it fails. A FIRST-EVER
          // child has nothing to keep serving, so it takes the ordinary fresh
          // deploy path.
          //
          // The child is deliberately NOT added to `appsInProgress`: that set
          // holds the CONTAINER for the duration of the expansion, and adding
          // the child would make handleAppUpdate's own in-progress guard
          // (:4320) drop it — silently skipping the build on 100% of
          // expansions. All three critics found that independently in v1.
          // Re-read rather than reuse `childState`: that was captured before
          // the copy, and the copy is real I/O. `appsInProgress` holds the
          // CONTAINER, which does not stop a `drop stop` on the child, so the
          // child can be stopped mid-expansion. Routing a now-stopped child to
          // handleAppUpdate would have it refuse at :4439 — after the source
          // had landed — reproducing the "new source, never built" state the
          // pre-copy check above exists to prevent.
          //
          // The two reads answer different questions and are not
          // interchangeable: `childState` (pre-copy) is "did this child exist
          // before this expansion?", which decides the routing — re-reading
          // for that would always say yes, because the registration above has
          // since run. `stateNow` is only "has it been stopped since?".
          const stateNow = this.stateManager?.getApp(childName);
          if (stateNow?.status === 'stopped') {
            this.logger.info(
              `Not building service '${svcName}': '${childName}' was stopped during expansion`,
              'MONOREPO'
            );
          } else if (childState) {
            await this.handleAppUpdate(
              childName,
              childPath,
              'monorepo re-expansion',
              true,
              actor
            );
          } else {
            await this.handleBuildApp(childPath, childName, childType, actor);
          }
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
  /**
   * Whether an app is a MATERIALIZED MONOREPO CHILD — a folder expandMonorepo
   * copied out of a container's `services:` map, as opposed to a standalone
   * app or the container itself.
   *
   * The discriminator is deliberate: expandMonorepo tags the container with
   * `isGroupContainer: true` and tags each child with only `group`, so
   * "grouped but not a container" is exactly the set whose lifecycle belongs
   * to someone else. Both stores are consulted because the config file is the
   * source of truth across restarts while state carries `isGroupContainer`.
   *
   * A standalone app is unaffected even if its own drop.yaml declares
   * `group:` — nothing copies that into its AppConfig; only expandMonorepo
   * writes the field.
   */
  private isGroupedChild(appName: string): boolean {
    const config = this.appConfigService?.getConfig(appName);
    const state = this.stateManager?.getApp(appName);
    if (state?.isGroupContainer) return false;
    return Boolean(config?.group || state?.group);
  }

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
      // Hold the container name in appsInProgress for the duration of the
      // expansion: the DELETE route's in-progress guard keys off it (a
      // teardown must not interleave with the fs.rm/fs.cp of child folders)
      // and a concurrent app:update for the container drops re-entrantly.
      // finally-guaranteed release — a stuck entry would wedge the app.
      this.appsInProgress.add(payload.name);
      try {
        await this.expandMonorepo(payload.path, payload.name, rootYaml.config, payload);
      } finally {
        this.appsInProgress.delete(payload.name);
      }
      return;
    }

    // A materialized monorepo CHILD must never be onboarded independently —
    // its fate is entirely the container's, which re-copies and rebuilds every
    // child as one atomic fs.rm+fs.cp+build (expandMonorepo). Without this the
    // watcher's boot scan onboards `<group>-<service>` folders as ordinary
    // apps: each publishes its own app:detected and starts building, and the
    // container's expansion then lands fs.rm/fs.cp underneath — leaving a
    // static child pointed at a build output that no longer exists (nginx
    // 500s with a `try_files` redirect cycle, which is how this was found).
    //
    // boot-reconcile already refuses grouped apps for exactly this reason, but
    // DROP_BOOT_RECONCILE defaults to 'off', so that guard does not run on a
    // default box and this path was the one that actually executed.
    //
    // Safe against the container's own build path: expandMonorepo calls
    // handleBuildApp DIRECTLY and never publishes app:detected for a child, so
    // nothing here blocks a legitimate group build.
    // Gated on ORIGIN, not just identity. Only a watcher-fabricated detection
    // is refused: an API-originated one is someone deliberately asking for this
    // app. migrate-runtime is the sharp case — it STOPS the app and then
    // publishes app:detected to bring it back, so swallowing that event would
    // leave a migrated child down permanently with nothing but a log line.
    // The watcher already added the child to knownApps before publishing
    // (watcher.ts), so there is nothing to mark here.
    if (payload.origin === 'watcher' && this.isGroupedChild(payload.name)) {
      // info, not debug: if the container later fails to expand (a bad
      // drop.yaml, an ownership refusal), this line is the only trace that
      // something is deliberately declining to build the child.
      this.logger.info(
        `Skipping watcher onboarding of grouped child '${payload.name}' — its monorepo container owns rebuilds`,
        'MONOREPO'
      );
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
      await this.handleBuildApp(payload.path, payload.name, payload.type as string, payload);
    } else if (payload.type === 'unknown' && currentApp?.status !== 'stopped') {
      // Detection couldn't resolve a type: the build guard above never fires
      // for 'unknown', which used to leave the app registered at `pending`
      // forever with no logs explaining why. Fail loudly instead — a later
      // file change re-detects (handleAppUpdate only skips `stopped` apps),
      // so adding a drop.yaml/Procfile/manifest recovers the app automatically.
      const detectError = new Error(
        'Could not detect application type — add a drop.yaml, Procfile, or a recognized manifest ' +
          '(requirements.txt, package.json, go.mod, Dockerfile, index.html)'
      );
      await this.stateManager?.setAppStatus(payload.name, 'errored', {
        error: detectError.message,
      });
      // No build ever starts on this path, so without an episode an MCP deploy
      // of an undetectable folder waits out its full budget and reports "still
      // building" rather than this error.
      // It still gets its own deploy id: the episode is a real terminal
      // outcome for a real deploy attempt, and one the caller must be able to
      // name like any other.
      this.failDeployEpisode(payload.name, detectError, crypto.randomUUID());
    }
  }

  private async handleBuildApp(
    appPath: string,
    appName: string,
    _appType: string,
    actor?: DeployActorInfo
  ): Promise<void> {
    if (!this.builder || !this.detector) return;

    // Skip if already processing this app
    if (this.appsInProgress.has(appName)) {
      this.logger.debug(`Skipping ${appName} - already in progress`, 'BUILD');
      return;
    }

    // GUARDRAIL, gated HERE and not at the tool boundaries (SEC-15). This is
    // the single choke point every deploy path traverses — watcher, webhook,
    // git, upload, MCP. A tool-boundary gate would leave webhook- and
    // watcher-driven redeploy loops completely unthrottled, and a stolen
    // webhook secret buys an unmetered build loop, builds being the most
    // expensive thing on the box.
    //
    // Automation gets its own key rather than being treated as an anonymous
    // caller, so a looping watcher cannot consume the quota of the human who
    // happens to own the app.
    const existing = this.stateManager?.getApp(appName);
    const guardKeys = this.guardrailKeys(appName, !existing, actor ?? {});
    const verdict = this.checkGuardrails(guardKeys);
    if (!verdict.allowed) {
      const reason =
        `Too many failed deploys (${verdict.failures}). ` +
        `Retry in ${verdict.retryAfterSeconds}s.`;
      this.logger.warn(`Deploy of ${appName} refused by guardrail: ${reason}`, 'BUILD');
      // See the matching release in handleAppUpdate: a stale key would turn
      // this refusal into a counted failure against the window that refused it.
      this.releaseGuardrailKeys(appName);
      // Reported as a normal deploy failure so a caller polling for an outcome
      // gets an answer instead of waiting out its budget — the same reason
      // failDeployEpisode exists.
      this.failDeployEpisode(appName, new Error(reason), crypto.randomUUID(), 'GUARDRAIL_TRIPPED');
      return;
    }
    this.breakerKeys.set(appName, guardKeys);

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
      // The actor rides along. Without it the drain re-enters with no caller,
      // so anyone who keeps maxConcurrentBuilds slots busy has their next
      // deploys re-keyed as anonymous automation — no principal window, no
      // owner window. Four parallel deploys is enough to arrange.
      this.pendingBuilds.set(appName, { appPath, appType: _appType, actor });
      // Reserved above, but nothing will be recorded for this attempt: the
      // retry re-enters handleBuildApp and re-reserves.
      this.releaseGuardrailKeys(appName);
      this.scheduleBuildDrain();
      return;
    }

    // Proceeding — drop any queued entry for this app so the drain doesn't
    // start a duplicate build.
    this.pendingBuilds.delete(appName);
    this.appsInProgress.add(appName);

    this.logger.appEvent('building', appName);

    // Whether builder.build() was entered. Declared out here so the catch can
    // see it: the builder publishes its own build:started/build:failed, so a
    // failure AFTER this point must not be given a synthesized episode — that
    // would report a second, spurious failure for a deploy that already
    // reported one. A throw BEFORE it has no episode at all, which is what
    // failDeployEpisode exists to fix.
    let builderEntered = false;

    // One id for this deploy, minted HERE — at the call site that begins it —
    // and threaded into the build log filename, the build's events, and the
    // synthesized failure episode below, so the log, the tracker episode and
    // the caller all name the same deploy.
    //
    // Minted BEFORE the try, not next to startBuild: a throw in detection never
    // reaches the build, and those failures still have to report under a real
    // id rather than one the tracker invents.
    const deployId = crypto.randomUUID();

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
      // MCP endpoint (Step 11). Resolved on every build so removing the
      // dependency or the `mcp:` block clears it — hence the explicit
      // `undefined`, which is how pendingPromotion is cleared too.
      //
      // ROUTING READS THIS. `handleConfigureRoute` emits a Caddy forward_auth
      // guard when `source === 'declared' && auth === 'drop'`, and `mcp.path`
      // is rendered into the generated Caddyfile — so it must stay
      // MCP_PATH_REGEX-validated at the parser, and any future writer of this
      // field (an API setter, an MCP tool) inherits that requirement.
      const mcpEndpoint = detectMcp(
        await readMcpInputs(appPath, (await parseDropYaml(appPath)).config?.mcp)
      );
      if (this.appConfigService) {
        await this.appConfigService.updateConfig(appName, {
          type: detectedType,
          mcp: mcpEndpoint
            ? { path: mcpEndpoint.path, auth: mcpEndpoint.auth, source: mcpEndpoint.source }
            : undefined,
        });
      }
      if (this.stateManager) {
        await this.stateManager.updateApp(appName, { type: detectedType });
      }
      const workDir = await this.getBuildWorkDir(appName);

      const execCommand = this.buildExecCommandFor(detection.type, appName);

      const buildStartedAt = new Date();
      const logId = this.buildLogService
        ? await this.buildLogService.startBuild(appName, buildStartedAt, deployId)
        : null;

      // Everything between startBuild and closeBuildLog must sit in this
      // try/finally: the disk check below throws on a low-disk box, and that
      // used to skip finishBuild entirely — leaking the log's write stream and
      // never running retention for the app.
      let result;
      try {
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

        builderEntered = true;
        result = await this.builder.build({
          appName,
          appPath,
          deployId,
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
      } finally {
        await this.closeBuildLog(logId, appName);
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
        // Deliberately NOT a guardrail failure: the deploy is being retried,
        // not rejected. Counting a queue wait as a failure would let a busy
        // platform trip the breaker on apps that never actually failed — and
        // the retry re-enters this method and re-gates itself.
        this.releaseGuardrailKeys(appName);
        this.appsInProgress.delete(appName);
        this.pendingBuilds.set(appName, { appPath, appType: _appType, actor });
        this.scheduleBuildDrain();
      } else {
        this.logger.appEvent('error', appName, result.errors?.[0]?.message || 'Build failed');
        if (this.stateManager) {
          await this.stateManager.setAppStatus(appName, 'errored', {
            error: result.errors?.[0]?.message || 'Build failed',
          });
        }
        // The COMMONEST failure, and the one a loop is actually made of: the
        // build ran and returned unsuccessfully. failDeployEpisode does not
        // fire here (the builder published its own episode), so without this
        // the breaker counted only pre-build and readiness failures and would
        // never trip on a repeatedly-failing build.
        this.recordDeployOutcome(appName, false);
        this.appsInProgress.delete(appName);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Build failed');
      this.logger.appEvent('error', appName, err.message);
      if (this.stateManager) {
        await this.stateManager.setAppStatus(appName, 'errored', { error: err.message });
      }
      // A throw BEFORE builder.build() (detection, the disk check,
      // resolveBuildEnv, a malformed drop.yaml) never opened a deploy episode,
      // so the MCP deploy tools would poll their full budget and report "still
      // building" instead of this error.
      if (!builderEntered) {
        this.failDeployEpisode(appName, err, deployId);
      }
      this.appsInProgress.delete(appName);
    }
  }

  /**
   * Make a deploy failure OBSERVABLE as a terminal deploy episode.
   *
   * Every MCP deploy tool polls `waitForDeployOutcome` for an episode that
   * reaches a terminal status. A failure that never opened one therefore reads
   * as "still in progress" until the caller's full wait budget (~120s) expires,
   * and then reports "still building" instead of the failure. Two such paths
   * exist, both reachable without anything unusual:
   *
   *  - `handleAppDetected`'s `unknown`-type branch, which errors the app
   *    WITHOUT ever calling `handleBuildApp` — i.e. deploying a folder with no
   *    recognizable manifest.
   *  - anything throwing inside `handleBuildApp` BEFORE `builder.build()`:
   *    detection, the disk-space check, `resolveBuildEnv`, or a malformed
   *    drop.yaml.
   *
   * Synthesizes the open only when nothing is open, so a build that already
   * reported its own failure isn't given a second, spurious episode. The
   * `buildId` is not used for correlation (the tracker keys on app name), so a
   * synthetic one is fine.
   */
  private failDeployEpisode(
    appName: string,
    error: Error,
    deployId?: string,
    /**
     * Names the refusal so it does not classify as PREBUILD_FAILED.
     *
     * Every other caller of this genuinely failed before the build — detection,
     * the disk check, a malformed drop.yaml — and 'pre-build' is the truthful
     * stage for those. A guardrail refusal shares the stage but not the cause:
     * nothing was attempted, so the PREBUILD_FAILED hint ("check detection, the
     * environment, or drop.yaml") sends the caller to look at something that is
     * not wrong.
     */
    code?: 'GUARDRAIL_TRIPPED' | 'QUOTA_EXCEEDED'
  ): void {
    this.recordDeployOutcome(appName, false);
    try {
      const tracker = getDeployTracker();
      const buildId = `deploy-${appName}-${Date.now()}`;
      if (!tracker.hasOpenEpisode(appName)) {
        eventBus.publish('build:started', { appId: appName, buildId, deployId });
      }
      // 'pre-build' is the truthful stage for every caller of this: detection
      // failures, the disk check, resolveBuildEnv, a malformed drop.yaml — all
      // of them end the deploy before builder.build() is entered.
      eventBus.publish('build:failed', {
        appId: appName,
        buildId,
        error,
        deployId,
        stage: 'pre-build',
        code,
      });
    } catch {
      // Tracker not initialised (isolated tests) — observability only, never
      // allowed to interfere with the failure being reported.
    }
  }

  /**
   * Record a deploy outcome against the guardrail key this deploy was ADMITTED
   * under, then forget it.
   *
   * Keyed from the map rather than recomputed: the principal is known only
   * where the deploy was triggered, and the outcome surfaces later in a
   * different handler. Recomputing here would key automation outcomes
   * differently from the gate that admitted them, so their window would never
   * close and a looping watcher would stay blocked forever.
   *
   * A deploy with no recorded key was never gated (it predates this, or the
   * platform restarted mid-deploy) — nothing to record.
   */
  private guardrailKeys(
    appName: string,
    isNewApp: boolean,
    actor: DeployActorInfo
  ): GuardrailKey[] {
    return guardrailKeysFor(appName, isNewApp, actor);
  }

  private checkGuardrails(keys: GuardrailKey[]): {
    allowed: boolean;
    failures: number;
    retryAfterSeconds?: number;
  } {
    return checkGuardrailKeys(keys);
  }

  /**
   * Abandon an episode's guardrail keys without recording anything.
   *
   * Must be called on every path that reserved keys and then returned without
   * deploying. A key left behind is charged to the NEXT outcome recorded for
   * that app — including the failure that `failDeployEpisode` records when a
   * later attempt is refused, which would let a refusal extend its own
   * cooldown indefinitely, or charge principal A for principal B's episode.
   */
  private releaseGuardrailKeys(appName: string): void {
    this.breakerKeys.delete(appName);
  }

  private recordDeployOutcome(appName: string, ok: boolean): void {
    const keys = this.breakerKeys.get(appName);
    if (!keys) return;
    this.breakerKeys.delete(appName);
    try {
      const breaker = getDeployBreaker();
      for (const entry of keys) {
        if (!ok) {
          breaker.recordFailure(entry.key, Date.now(), entry.threshold);
        } else if (entry.clearOnSuccess) {
          breaker.recordSuccess(entry.key);
        }
        // A success does NOT clear a decay-only key. See
        // GuardrailKey.clearOnSuccess: the owner backstop must not be wipeable
        // by one cheap deploy, or it stops being a backstop.
      }
    } catch {
      // Guardrail state is best-effort; it must never fail a deploy.
    }
  }

  /**
   * Close a build log stream. Never throws.
   *
   * Called from `finally` on both build paths, where a throw would replace the
   * error actually being propagated with an unrelated logging failure. A no-op
   * when the build log service is disabled or no log was opened.
   */
  private async closeBuildLog(logId: string | null, appName: string): Promise<void> {
    if (!logId || !this.buildLogService) return;
    try {
      await this.buildLogService.finishBuild(logId, appName);
    } catch (error) {
      this.logger.warn(`Failed to close build log for ${appName}`, 'BUILD', error);
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
      void this.handleBuildApp(info.appPath, appName, info.appType, info.actor);
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

    // Resolve identically to reconcileAppsOnBoot (M1 review item K): prefer
    // the persisted AppConfig.path (set at detection time, and — for a
    // monorepo child — the copied per-service folder, not appsDirectory/name)
    // over the hardcoded join, falling back to the join only when no config
    // (or no path on it) exists yet.
    const appPath =
      this.appConfigService?.getConfig(appName)?.path ||
      path.join(this.config.appsDirectory, appName);

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
      const declaredPort = (await parseDropYaml(appPath))?.config?.port;
      const port = this.allocatePort(appName, declaredPort);

      this.logger.appEvent('starting', appName, `port ${port}`);

      // Persistent data dir must be ready before script determination so that
      // the docker+static path can write nginx.conf into it.
      const dataDir = await this.ensureAppDataDirectory(appName);
      this.logger.info(`Data directory: ${dataDir}`, 'DATA');

      // Check if app needs a database and provision one.
      let dbEnvVars: Record<string, string> = {};
      const needsDb = await this.appNeedsDatabase(
        appName,
        appPath,
        detection.suggestedConfig?.database
      );
      if (this.dbProvisioner && needsDb) {
        const pgSocketDir =
          this.config.isolation === 'docker'
            ? (this.postgresServer?.getSocketDir() ?? undefined)
            : undefined;
        const dbOpts = pgSocketDir ? { pgSocketDir } : undefined;

        const appState = this.stateManager?.getApp(appName);
        const ownerUserId = appState?.userId;
        const dbQuota = this.checkDbQuota(ownerUserId);
        if (!dbQuota.allowed) {
          this.logger.warn(
            `DB quota reached for user ${ownerUserId} (${dbQuota.used}/${dbQuota.limit}), ` +
            `skipping database provisioning for ${appName}`,
            'DATABASE'
          );
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
      await this.noteRuntimeLogStart(appName);
      const status = await this.runtime.start(spec);

      this.logger.appEvent('started', appName, `PID ${status.pid}, port ${port}`);

      // Readiness gate: PM2/Docker report 'online' the instant a process is
      // (re)forked, so a crash-looping app satisfies runtime.start's own
      // wait — don't declare 'running' until the app actually proves it's up.
      // A first-deploy failure resolves to 'errored' (never 'crash-looping'):
      // the deploy tracker closes an episode only on running|errored, so
      // 'errored' is what makes deploy_files report the failure honestly.
      // Persist the port BEFORE the readiness verdict. The app config is the
      // source of truth for port assignment across restarts, and this used to
      // sit after the failure return — so an app that failed readiness kept a
      // live process on a port nothing had recorded, and the next allocation
      // was free to hand that same port to another app.
      if (this.appConfigService) {
        await this.appConfigService.updateConfig(appName, {
          port,
          dataDir,
          lastDeployedAt: new Date().toISOString(),
        });
      }

      const readiness = await this.awaitReadiness(appName, port, spec);
      if (!readiness.ok) {
        this.logger.appEvent('error', appName, `readiness check failed: ${readiness.reason}`);
        // Close the runtime-log window FIRST. Without an end offset a retained
        // copy runs start-to-EOF, which sweeps in anything appended after this
        // deploy died — including by a re-registered app of the same name.
        this.recordDeployOutcome(appName, false);
        await this.noteRuntimeLogEnd(appName);
        // Published BEFORE the 'errored' status write below: that write is
        // what closes the deploy episode, and a subscriber correlating by app
        // name needs the episode still open to resolve this app's deployId.
        // Carries a closed-set reason, never readiness.reason — that string is
        // diagnostic text and must not reach a persisted record.
        eventBus.publish('deploy:failed', {
          appId: appName,
          phase: 'boot',
          // The category, not readiness.reason — that string is diagnostic
          // text and must not reach a persisted record. Defaults to
          // 'process-exited' only because every !ok path sets one today; the
          // fallback exists so a future branch cannot publish undefined.
          reason: readiness.failure ?? 'process-exited',
        });
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

      if (readiness.warning) {
        this.logger.warn(
          `${appName} did not prove ready before the deploy completed: ${readiness.warning}`,
          'APP'
        );
      }

      // Record the signature (source mtime, secret fingerprint, runtime-spec
      // revision) observed at THIS deploy — read back by reconcileAppsOnBoot
      // (M1) on the NEXT boot to decide skip vs redeploy. AFTER readiness
      // succeeds, logically (capturing it earlier races the app's own
      // startup writes into its tree) — but fire-and-forget (`void`), not
      // awaited: it must never delay the 'running' status write or the
      // eventual appsInProgress release, which several callers/tests treat
      // as available the instant runtime.start()/readiness settles.
      void this.recordDeploySignature(appName, appPath);

      // Update state to running with port and pid.
      //
      // readinessUnverified is passed EXPLICITLY as a boolean, never omitted:
      // this is the one path where the readiness gate actually ran, so it is
      // the only path entitled to assert a verdict either way. Passing `false`
      // on a clean pass is load-bearing — it clears a flag left by an earlier
      // unverified deploy. The ungated paths (handleAppUpdate, restartApp)
      // deliberately pass nothing at all.
      if (this.stateManager) {
        await this.stateManager.setAppStatus(appName, 'running', {
          port,
          pid: status.pid ?? undefined,
          readinessUnverified: Boolean(readiness.warning),
        });
      }

      // SUCCESS — clears the guardrail window.
      //
      // Including the readiness-WARNING case. Counting succeeded_unverified as
      // a failure would contradict D1, which exists to preserve DROP-063's
      // leniency: five legitimately-slow-but-healthy deploys would trip the
      // breaker on a perfectly good app. The agent still gets the unverified
      // status and a hint — that is the signal to act on, not a throttle.
      this.recordDeployOutcome(appName, true);

      // App is fully deployed now - record deploy time for cooldown
      this.appDeployTimes.set(appName, Date.now());

      // Arm the health prober + crash-loop watch that keep this app supervised
      // for the rest of its running life. The deploy episode has already
      // closed on 'running', so a later crash-loop status change does not
      // affect deploy_files.
      this.armPostDeployWatches(appName, port, spec.healthCheckPath);
    } catch (error) {
      // Secret preflight park (PRD-051): not a failure — the app declared
      // required secrets that aren't set. Record them and stop, so the operator
      // gets an actionable `needs-config` instead of a crash-loop. The
      // `starting` transition above already cleared any stale error.
      if (error instanceof AppNeedsConfigError) {
        this.logger.warn(
          `${appName} parked in needs-config — set required secret(s): ` +
            `${error.missingSecrets.join(', ')}, then restart`,
          'SECURITY'
        );
        if (this.stateManager) {
          await this.stateManager.setAppStatus(appName, 'needs-config', {
            missingSecrets: error.missingSecrets,
          });
        }
        // COUNTED. buildFreshStartSpec throws this AFTER the build completed,
        // so the install and build were already paid for, and the `secrets:`
        // block that triggers it is tenant-controlled — leaving it uncounted
        // made `deploy → full build → park → deploy` a free, unbounded loop.
        this.recordDeployOutcome(appName, false);
        return;
      }
      this.logger.appEvent('error', appName, error instanceof Error ? error.message : 'Failed to start');
      if (this.stateManager) {
        await this.stateManager.setAppStatus(appName, 'errored', {
          error: error instanceof Error ? error.message : 'Failed to start',
        });
      }
      // A whole class of expensive, caller-reproducible failures reaches here
      // rather than the readiness verdict — port allocation, secret/env
      // resolution, runtime spec assembly, runtime.start() itself. Uncounted,
      // they were invisible to the breaker AND left a stale key behind.
      this.recordDeployOutcome(appName, false);
    } finally {
      // Terminal handler: always release the in-progress guard on every settled
      // path (success, error, or a throw from the initial 'starting' write), so
      // a transient failure can never wedge the app out of future rebuilds.
      this.appsInProgress.delete(appName);
    }
  }

  /**
   * @param opts.skipCaddyReload Defer the actual `caddy reload` to the
   * caller — router.addRoute below still writes/regenerates the Caddyfile
   * itself. Used by reconcileAppsOnBoot (M1 review item G) to batch N
   * skipped apps' routes into ONE reload instead of N serialized ones on
   * the boot path; every other caller reloads immediately as before.
   */
  private async handleConfigureRoute(
    appName: string,
    port: number,
    opts?: { skipCaddyReload?: boolean; routeOnly?: boolean }
  ): Promise<void> {
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
      // The path portion of the child's public URL, set ONLY for a same-origin
      // group child: '' when it serves the group root (frontend), '/api' etc.
      // for a path-prefixed sibling (backend). `undefined` means "not a
      // same-origin child" — leave the name/domain-based URL alone.
      let sameOriginPublicPath: string | undefined;
      const appConfig = this.appConfigService?.getConfig(appName);
      const routeCfg = dropYaml.success ? dropYaml.config?.route : undefined;
      if (appConfig?.group && routeCfg && !hasCustomDomains) {
        domains = [`${appConfig.group}.${domainSuffix}`];
        sameOriginPublicPath = '';
        const rp = routeCfg.path?.trim();
        if (rp && rp !== '/') {
          const prefix = (rp.startsWith('/') ? rp : `/${rp}`).replace(/\/+$/, '');
          // Caddy site-address path matcher: `<host>/api*` matches `/api` and
          // `/api/...`. No prefix stripping — the backend owns its `/api` path.
          routePathPrefix = prefix.endsWith('*') ? prefix : `${prefix}*`;
          // Display path never carries the Caddy wildcard: `/api*` → `/api`.
          sameOriginPublicPath = prefix.replace(/\*+$/, '');
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
          // The platform's OWN host is not in `owners` — it is not an app — so
          // it read as unclaimed, and unclaimed means available. A tenant
          // claiming it gets a Caddy block for DROP's hostname pointing at
          // their app, which serves DROP's OAuth and MCP endpoints: a victim's
          // control-plane token delivered straight to a tenant.
          if (isReservedHost(d, getPublicUrl(), domainSuffix)) {
            this.logger.warn(
              `Refusing domain '${d}' for ${appName}: reserved by the platform`,
              'ROUTER'
            );
            return false;
          }
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
        //
        // Skipped under `routeOnly`. This method is now reachable from an
        // authorization write (`reconfigureRoute`), and persisting whatever
        // `domains:`/`tls:` the tenant's drop.yaml happens to contain RIGHT
        // NOW would make an admin's access-policy change an apply path for
        // tenant edits made since the last deploy, with no deploy and no
        // review. A route re-emission must not mutate persisted config.
        if (!opts?.routeOnly) {
          await this.appConfigService.updateConfig(appName, {
            domains: acceptedCustomDomains,
            tls: dropYaml.config?.tls,
          });
        }
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

      // DROP-guarded MCP endpoint (Step 11, PR 2b). `source: 'declared'` AND
      // `auth: 'drop'` — the same pair the verify endpoint requires, so the
      // Caddy guard and the gateway can never disagree about which apps are
      // protected. Inference is deliberately excluded: enrolling an app into a
      // login gate because it depends on the MCP SDK is a decision its owner
      // never made.
      const mcpConfig = this.appConfigService?.getConfig(appName)?.mcp;
      const apiPortUsable = Number.isInteger(this.config.apiPort) && this.config.apiPort > 0;
      if (mcpConfig?.source === 'declared' && mcpConfig.auth === 'drop' && !apiPortUsable) {
        // `apiPort` comes from parseInt(env), and `??` does not catch NaN. A
        // `forward_auth localhost:NaN` fails to parse the WHOLE Caddyfile, not
        // just this block — every site on the box loses its config. Refuse the
        // guard instead, and say so: an app that asked to be protected and is
        // not must never be silent.
        this.logger.error(
          `App '${appName}' declares mcp.auth: drop but the API port is not usable ` +
            `(${String(this.config.apiPort)}); refusing to emit the auth guard. ` +
            'Its MCP endpoint is NOT protected.',
          'ROUTER'
        );
      }
      const mcpGuard =
        mcpConfig?.source === 'declared' && mcpConfig.auth === 'drop' && apiPortUsable
          ? {
              path: mcpConfig.path,
              appName,
              // 127.0.0.1, not `localhost`: on an IPv6-preferring resolver
              // `localhost` is ::1, which a Node listener bound to 0.0.0.0 does
              // not serve. Go's dialer usually falls back, but this removes the
              // dependency on that.
              verifyUpstream: `127.0.0.1:${this.config.apiPort}`,
            }
          : undefined;

      if (mcpGuard && this.config.isolation !== 'docker') {
        // The guard lives only in Caddy. Outside docker isolation an app binds
        // its own port on the host, so the endpoint stays reachable directly on
        // that port with no OAuth at all. Under docker, containers publish to
        // 127.0.0.1 only and inter-container traffic is disabled, which closes
        // it. Emit the guard either way — an edge control beats none — but do
        // not let an operator believe it is complete.
        this.logger.warn(
          `App '${appName}' has a DROP-guarded MCP endpoint, but this platform is not in ` +
            'docker isolation: the app port is reachable directly, bypassing the guard.',
          'ROUTER'
        );
      }

      // Reserved-hostname guard on the FINAL domain list, whatever produced
      // it. The custom-domain branch above already runs requested `domains`
      // through isReservedHost, but its fallback on `domains.length === 0`
      // reuses `defaultHostname` unchecked — and an app with no custom
      // domains at all never reaches that branch, so `defaultHostname` is
      // used as-is. Both paths land here: an app named e.g. `dashboard`
      // would otherwise get a Caddy block for the platform's own host
      // unconditionally, with no drop.yaml `domains:` required to trigger it.
      const routableDomains = domains.filter((hostname) => {
        if (isReservedHost(hostname, getPublicUrl(), domainSuffix)) {
          this.logger.warn(
            `Refusing route for ${appName}: hostname '${hostname}' is reserved by the platform`,
            'ROUTER'
          );
          return false;
        }
        return true;
      });
      if (routableDomains.length === 0) {
        this.logger.warn(
          `App '${appName}' has no routable hostname (every candidate is reserved by the ` +
            'platform); no route was configured',
          'ROUTER'
        );
      }
      domains = routableDomains;

      // DROP-152 browser access gate. Assessed HERE, at emission, and not only
      // at the route that sets the policy: the two are separated in time by
      // anything from a redeploy to a platform upgrade, and a box can stop
      // satisfying the premise in between (HTTPS turned off, a drop.yaml
      // `tls: {disabled: true}` landing on the next deploy, an in-place upgrade
      // leaving drop-net with ICC enabled). An app asked to be protected and
      // not protected must never be silent -- the dashboard would otherwise
      // report it as gated on the strength of the persisted policy alone.
      // The config service is the ONLY way to know an app is gated. If it is
      // unavailable we cannot tell, and "cannot tell" must not read as "not
      // gated" — that is the same permissive-read-of-an-absent-input defect
      // that `canOpen`'s optional policy parameter was. Leave the flag alone
      // and say so rather than clearing it.
      const accessPolicy = this.appConfigService
        ? this.appConfigService.getConfig(appName)?.access
        : undefined;
      const accessKnown = Boolean(this.appConfigService);
      // `domains` here is the post-filter list this method is about to route.
      const accessVerdict = accessPolicy
        ? await this.assessAccessGate(appName, dropYaml, domains)
        : undefined;
      if (accessVerdict && !accessVerdict.enforceable) {
        // `featureEnabled` is the field, not blocker-list shape: a flag-off
        // box carrying a SECOND blocker (e.g. every `none`-isolation dev box
        // also fails `isolation-not-docker`) is still an operator DECISION at
        // its root, not a defect, and must not log ERROR on every boot
        // forever — that would bury the real HTTPS/isolation breaks this log
        // level exists to surface (DROP-153).
        if (!accessVerdict.featureEnabled) {
          this.logger.info(
            `Access gate for '${appName}' is not enforced: an operator has switched off the ` +
              'DROP_FEATURE_ACCESS_GATE kill switch on this platform. No guard was emitted.',
            'ROUTER'
          );
        } else {
          this.logger.error(
            `${describeAccessGateRefusal(appName, accessVerdict)}. Refusing to emit the access ` +
              'guard: this app is NOT protected.',
            'ROUTER'
          );
        }
      }
      // Whether the gate is actually going to be enforced for this app — the
      // condition `accessGuard` keys on.
      const gateEnforced = computeGateEnforced(accessVerdict, Boolean(accessPolicy));
      // Narrower than the inverse of `gateEnforced`: true only when the kill
      // switch is the reason enforcement is off. Keying the hostname filter
      // and the `tls` override below on `gateEnforced` (i.e. relaxing them
      // for every blocker, not just this one) let a tenant trip a SECOND
      // blocker — an extra `domains:` entry (`multi-hostname`), a dropped
      // `publicUrl` — and have their still-gated app served over plaintext,
      // re-opening the same "tenant switches off their own gate" defect a
      // different door (bd86006) already closed once. Only the kill switch
      // may relax them: every other blocker is a defect this box must keep
      // refusing to route around. Keying the filter/override on bare
      // `accessPolicy` (policy presence, not enforceability) has the
      // opposite failure: with the kill switch off, an app whose only
      // hostname is plaintext ended up routed NOWHERE, which is worse than
      // ungated (DROP-153) — hence `!gateWithdrawn` rather than `accessPolicy`
      // alone.
      const gateWithdrawn = Boolean(accessPolicy && accessVerdict && !accessVerdict.featureEnabled);
      // Named once and reused below (hostname filter here, `tls` override in
      // the per-domain loop) rather than repeating `accessPolicy &&
      // !gateWithdrawn` at each site.
      const gateStillAsserted = Boolean(accessPolicy && !gateWithdrawn);
      if (gateStillAsserted) {
        // A gated app is not served on a plaintext or reserved hostname. The
        // inputs that would otherwise disable the gate — a `.localhost` entry
        // in `domains:`, `tls: {disabled: true}` — are TENANT-authored, so
        // honouring them would hand the governed party an off switch for the
        // control governing them. Dropping the hostname keeps the app's real
        // HTTPS address serving and gated.
        const gateSafe = this.gateRoutableHostnames(domains, domainSuffix);
        if (gateSafe.length !== domains.length) {
          this.logger.warn(
            `App '${appName}' carries an access policy; refusing to route it on ` +
              `${domains.length - gateSafe.length} plaintext/reserved hostname(s) that would ` +
              'disable the gate',
            'ROUTER'
          );
        }
        domains = gateSafe;
      }

      // The browser access gate (DROP-152). Computed as ONE value, beside
      // mcpGuard, rather than as a section inside the per-domain loop — that
      // loop already sits 60 lines deep in a 340-line method, and the next
      // guard should be able to follow this shape rather than deepen it.
      const accessGuard = gateEnforced
        ? {
            appName,
            verifyUpstream: `127.0.0.1:${this.config.apiPort}`,
            cookieName: appSessionCookieName(appName),
          }
        : undefined;

      // Configure route for each domain
      let resolvedPublicUrl: string | undefined;
      for (const hostname of domains) {
        const isLocalhost = isLocalhostDomain(hostname);
        // `tls.disabled` is tenant-authored; a gated app does not get to opt
        // out of the transport its session cookie requires. Keyed on
        // `gateStillAsserted`, not `gateEnforced` — see that condition's
        // comment above.
        const tlsDisabled = gateStillAsserted ? false : dropYaml.config?.tls?.disabled;
        const enableSsl = this.config.enableHttps && !isLocalhost && !tlsDisabled;

        await this.router.addRoute({
          appName: `${appName}-${hostname.replace(/\./g, '-')}`, // Unique route name per domain
          owner: appName, // Bare owning app name — lets removeRoutesForApp find every route this app owns
          hostname,
          pathPrefix: routePathPrefix,
          upstream: `localhost:${port}`,
          ssl: enableSsl,
          redirectHttps: enableSsl,
          tls: customTls
            ? { certFile: customTls.certFile, keyFile: customTls.keyFile }
            : (enableSsl ? { auto: true } : undefined),
          headers: tenantSecurityHeaders,
          // DROP-guarded MCP endpoint (Step 11). Only for an app that DECLARED
          // it — an inferred label must never put a login gate in front of
          // someone's app — and only when the API port is known, since the
          // guard is a proxy to DROP's own verify endpoint.
          //
          // Passed EXPLICITLY, never `...(guard ? {…} : {})`. `addRoute`
          // replaces rather than merges (see its own doc), and it can only
          // remove a guard the caller has actually said is gone — a missing key
          // is indistinguishable from "unchanged". Turning a guard off used to
          // leave it in the Caddyfile for the life of the process.
          mcpAuth: mcpGuard,
          accessAuth: accessGuard,
        });

        const protocol = enableSsl ? 'https' : 'http';
        const caddyAvailable = this.caddyServer?.getStatus() === 'running';

        // A same-origin group child is routed onto exactly this one group host;
        // capture the real, fully-resolved public URL (proto + host + route
        // path) so computeAppUrl can hand the dashboard a link that is actually
        // routed. Skip localhost — there is no external URL there, and the
        // dashboard's host:port fallback covers dev.
        if (sameOriginPublicPath !== undefined && !isLocalhost) {
          resolvedPublicUrl = `${protocol}://${hostname}${sameOriginPublicPath}`;
        }

        if (caddyAvailable) {
          this.logger.info(`Route configured: ${protocol}://${hostname} -> localhost:${port}`, 'ROUTER');
        } else {
          this.logger.info(`Route configured: localhost:${port} (Caddy unavailable for ${hostname})`, 'ROUTER');
        }
      }

      // Reconcile the persisted group URL (not set-only). resolvedPublicUrl is
      // the address actually routed this run, or undefined when the app is no
      // longer a same-origin child (route removed, or custom domains added —
      // including the `[]` left by a rejected custom domain). Writing it every
      // time it CHANGES both fills the dashboard link for a group child and
      // CLEARS a stale one, so computeAppUrl can never link to the group host
      // for an app no longer served there (which would load a sibling's app).
      // The change-guard avoids a config write per app on every start.
      if (!opts?.routeOnly && this.appConfigService && resolvedPublicUrl !== appConfig?.publicUrl) {
        await this.appConfigService.updateConfig(appName, { publicUrl: resolvedPublicUrl });
      }

      // Reload Caddy to apply new routes — unless the caller is batching
      // several of these into one trailing reload (opts.skipCaddyReload).
      const reloadOutcome = opts?.skipCaddyReload
        ? ('skipped' as const)
        : await this.reloadCaddyIfRunning();
      if (reloadOutcome === 'failed') {
        this.logger.error(
          `Caddy REJECTED the configuration emitted for '${appName}'. Routing is unchanged, ` +
            'so this app is serving whatever block it had before — and the rejected file is ' +
            'what Caddy will read at its next start.',
          'ROUTER'
        );
      }

      // Written HERE, after the routes are actually emitted and reloaded, not
      // beside the verdict above. Everything in this method runs inside a
      // catch that only logs, so a throw from addRoute or the Caddy reload
      // leaves the PREVIOUS block live — recording "gate applied" before that
      // point asserted a control that had not been installed. The catch arm
      // below records the opposite.
      //
      // The value is `true` for every gated app while ACCESS_GATE_ENFORCEMENT
      // is unavailable: this build emits no access guard at all, so a policy
      // that exists is by definition not applied. It is not a verdict about
      // the box; it is a fact about the binary.
      if (accessKnown) {
        // "Applied" requires THREE things, not one: the box can enforce a gate,
        // this build has an emitter at all, and Caddy actually accepted the
        // configuration carrying it. A rejected `/load` does not throw — it
        // returns false — so without the reload outcome this line recorded
        // "gate applied" for a config Caddy had refused, leaving the previous
        // ungated block live. `skipped` is not success either: the boot path
        // batches reloads, so nothing had reached Caddy yet at this point.
        //
        // `gateWithdrawn` is handled SEPARATELY from the general
        // `!isGateApplied` case: when the kill switch is the only reason
        // enforcement is off, there is no gate to apply at all, so "unapplied"
        // is the wrong axis to record `true` on. Doing so pinned the flag
        // `true` forever (nothing ever clears it while the switch stays off),
        // and `apps.share.ts` drives a full Caddyfile regenerate + reload off
        // that flag on every share/revoke write — an unbounded retry loop for
        // a state that isn't actually broken. Clear it instead.
        await this.stateManager?.setAccessGateUnapplied(
          appName,
          accessVerdict
            ? gateWithdrawn
              ? undefined
              : !isGateApplied({
                  enforceable: accessVerdict.enforceable,
                  enforcementAvailable: ACCESS_GATE_ENFORCEMENT_AVAILABLE,
                  reloadOutcome,
                })
            : undefined
        );
      }
    } catch (error) {
      // A gated app whose route configuration threw is NOT protected: Caddy
      // kept whatever block it had, which does not carry the guard.
      if (this.appConfigService?.getConfig(appName)?.access) {
        await this.stateManager
          ?.setAccessGateUnapplied(appName, true)
          .catch(() => undefined);
      }
      // Surface at error level: a failed reload means this (and every
      // subsequent) route change silently stops applying until an operator
      // intervenes — not a benign "route already exists".
      this.logger.error(`Failed to configure route for ${appName}`, 'ROUTER', error);
    }
  }

  /**
   * Reload Caddy iff it's actually running, and REPORT whether it took.
   *
   * `'skipped'` is not `'ok'`: Caddy not running (or a batching caller
   * deferring the reload) means the emitted config has not reached it, which is
   * a different thing from a config it accepted. The access gate's state flag
   * distinguishes all three, because recording "gate applied" after a reload
   * Caddy REJECTED asserts a control that was never installed — and a rejected
   * `/load` does not throw, so the surrounding catch never sees it.
   */
  private async reloadCaddyIfRunning(): Promise<'ok' | 'failed' | 'skipped'> {
    if (!this.caddyServer || this.caddyServer.getStatus() !== 'running') return 'skipped';
    return (await this.caddyServer.reload()) ? 'ok' : 'failed';
  }

  /**
   * Whether a browser access gate (DROP-152) can actually be enforced for this
   * app, resolved from the platform's own live view.
   *
   * THE only resolution. The route reaches it through `PlatformOps`, route
   * emission and the boot sweep call it directly — so there is one answer per
   * app, not a platform answer and a route answer that have to be argued into
   * agreement. An earlier shape had the route re-derive the same five inputs
   * from `runtime-config` + `AppConfig`; the claim that it could only ever be
   * optimistic was prose with nothing pinning it, and it was already
   * falsifiable on `authEnabled`.
   *
   * Two resolution rules are load-bearing:
   *
   *  - **Tenant `tls: {disabled: true}` is IGNORED.** It is authored in the
   *    app's own `drop.yaml`, so honouring it would let the tenant switch off
   *    a governance control an admin set, by editing one line in a file they
   *    own. `handleConfigureRoute` correspondingly refuses to honour it for a
   *    gated app, so this is not an optimistic read — it is the policy.
   *  - **Non-HTTPS hostnames are dropped, not tolerated.** A `.localhost`
   *    entry in a tenant's `domains:` would otherwise flip `httpsEffective`
   *    false for the app's real HTTPS hostname too. A gated app is not routed
   *    on a plaintext host at all (again enforced at emission); if that leaves
   *    no hostname, the verdict is `no-https`.
   *
   * `parsed` lets `handleConfigureRoute` hand over the `drop.yaml` it has
   * already read, so the common path parses once.
   */
  private async assessAccessGate(
    appName: string,
    parsed?: DropYamlParseResult,
    /**
     * The hostnames the caller is ACTUALLY about to route this app on.
     *
     * Load-bearing. Without it this method resolved its own list straight from
     * the tenant's `drop.yaml`, while `handleConfigureRoute` routed the
     * ownership-filtered `acceptedCustomDomains` (falling back to the default
     * host). A tenant could make the two disagree with one line of a file they
     * own — a second `domains:` entry trips `multi-hostname`, a reserved one
     * empties the list and trips `no-https` — at which point the verdict
     * refuses, no guard is emitted, and **the app is still served, ungated**.
     *
     * That is the same off-switch already closed for `tls: {disabled: true}`
     * and for `.localhost` entries, reached through a third door. The verdict
     * now describes the set that is really being emitted.
     */
    routedHostnames?: string[]
  ): Promise<AccessGateVerdict> {
    const dropYaml =
      parsed ?? (await parseDropYaml(path.join(this.config.appsDirectory, appName)));
    const config = this.appConfigService?.getConfig(appName);
    const state = this.stateManager?.getApp(appName);
    const suffix = this.config.domainSuffix || 'localhost';

    const declared = dropYaml.success ? dropYaml.config?.domains : undefined;
    const hasCustomDomains = Boolean(declared && declared.length > 0);
    let hostnames: string[] = hasCustomDomains
      ? (declared as string[])
      : [`${appName}.${suffix}`];
    // A same-origin monorepo child is routed onto the shared group host —
    // mirroring handleConfigureRoute's own branch, which is also why a gate on
    // a single child is refused outright below.
    if (config?.group && dropYaml.success && dropYaml.config?.route && !hasCustomDomains) {
      hostnames = [`${config.group}.${suffix}`];
    }
    // The caller's list wins when it has one — see `routedHostnames`.
    hostnames = this.gateRoutableHostnames(routedHostnames ?? hostnames, suffix);

    return assessAccessGate({
      featureEnabled: this.config.enableAccessGate,
      isolation: this.config.isolation === 'docker' ? 'docker' : 'none',
      authEnabled: this.config.enableApiAuth,
      httpsEffective: resolveHttpsEffective(hostnames, {
        enableHttps: this.config.enableHttps,
        isLocalhost: isLocalhostDomain,
      }),
      networkIsolation: getTenantNetworkIsolation(),
      // The login host the gate's first hop redirects to, and the value
      // `reservedHosts()` is derived from.
      publicUrl: getPublicUrl(),
      hostnameCount: hostnames.length,
      apiPortUsable: Number.isInteger(this.config.apiPort) && this.config.apiPort > 0,
      // The strict pattern, not the folder-drop one: this name is written into
      // Caddy directives as a literal, and an unparseable directive rejects
      // the whole file.
      appNameSafe: isValidAppName(appName),
      // `group` lives in AppConfig for a CHILD and in AppState for the
      // container (expandMonorepo writes `{ group, isGroupContainer }` to state
      // only). Reading config alone left the container gateable: an admin could
      // persist a policy on an app that serves nothing, while the children
      // holding the data stayed open on the group host.
      group: config?.group ?? state?.group,
      isGroupContainer: state?.isGroupContainer === true,
    });
  }

  /**
   * The hostnames a GATED app may be routed on: reserved hosts and plaintext
   * hosts removed. Shared by the verdict and by route emission so the set the
   * verdict is about is the set that is actually served.
   */
  private gateRoutableHostnames(hostnames: string[], suffix: string): string[] {
    return hostnames.filter(
      (hostname) =>
        !isReservedHost(hostname, getPublicUrl(), suffix) &&
        this.config.enableHttps &&
        !isLocalhostDomain(hostname)
    );
  }

  /**
   * Re-emit one app's Caddy route blocks from its CURRENT config and reload
   * Caddy, without stopping, rebuilding or restarting it. See
   * `PlatformOps.reconfigureRoute` for why this exists.
   */
  private async reconfigureRoute(appName: string): Promise<void> {
    if (this.appsInProgress.has(appName)) {
      // A deploy in flight will write the route itself when it starts the app;
      // racing it here could emit a block for a port that is about to change.
      throw new AppInProgressError(appName);
    }
    // CHECK-then-ACT is not enough: a deploy starting immediately after the
    // check would race this, and because DROP reuses freed ports the losing
    // write can point a hostname at a port a different tenant's app now owns.
    // Hold the guard for the duration, like every other lifecycle path.
    this.appsInProgress.add(appName);
    try {
      // AppConfig is the source of truth for ports (see the two-phase
      // reconciliation in syncStateWithConfigs); AppState is the fallback for
      // an app whose config has not been written yet.
      const port =
        this.appConfigService?.getConfig(appName)?.port ?? this.stateManager?.getApp(appName)?.port;
      if (!port) {
        // Nothing is routed for an app with no port. Not an error: a stopped or
        // never-deployed app's gate takes effect the next time it is routed.
        this.logger.info(
          `No route to reconfigure for '${appName}' - it has no assigned port`,
          'ROUTER'
        );
        return;
      }

      await this.handleConfigureRoute(appName, port, { routeOnly: true });
    } finally {
      this.appsInProgress.delete(appName);
    }
  }

  /**
   * Report every persisted access-gate policy this box cannot enforce
   * (DROP-152), and record the resulting `accessGateUnapplied` state for
   * each app. A REPORTER — it never touches Caddy.
   *
   * A SWEEP, not a startup constraint. `assertStartupConstraints` runs before
   * the config layer loads -- so it cannot see any app's policy -- and it
   * throws to exit the process, which would let one tenant's gate declaration
   * refuse to boot the entire fleet. This logs and returns.
   *
   * DELIBERATELY does not re-emit any app's route to strip a stale guard out
   * of Caddy when the DROP_FEATURE_ACCESS_GATE kill switch is off, even
   * though a guard already loaded stays there until that app's next route
   * event. An earlier version of this method did exactly that (via
   * `reconfigureRoute`), which sounded like the safe move but was not:
   *
   *  - it ran in `start()` BEFORE boot reconciliation and the watcher have
   *    routed anything, when `RouterService.routes` is still nearly empty and
   *    never seeded from disk — so `addRoute`'s `regenerateConfig()` wrote a
   *    Caddyfile describing only the handful of apps this sweep had touched
   *    so far, truncating every OTHER app on the box. That is strictly worse
   *    than the stale guard it was meant to fix, and batching the reloads
   *    (tried in an earlier round) does not close the window: the file write
   *    happens inside `addRoute` regardless of `skipCaddyReload`, which only
   *    defers the `caddy reload` admin-API call;
   *  - it bought little even ignoring that risk. `/verify` admits (204,
   *    `gate-disabled`) whenever `isAccessGateEnabled()` is false, so a stale
   *    guard cannot lock anyone out any more — it costs an extra hop, not
   *    availability. And `handleConfigureRoute` already drops the guard
   *    through the ORDINARY emission path once its own `gateWithdrawn`
   *    condition is true, so the guard clears itself on this app's next
   *    deploy, restart, or boot-reconcile pass regardless of anything this
   *    method does.
   *
   * `setAccessGateUnapplied` is still cleared (never set) for a gated app
   * while the switch is off: there is no gate to apply, so "unapplied" is
   * the wrong axis to assert `true` on — see `handleConfigureRoute`'s own
   * `gateWithdrawn` handling, which this mirrors.
   *
   * The kill-switch-off case is reported as ONE aggregate line naming every
   * affected app, not a per-app message — mirroring the `unenforceable`
   * summary below. An earlier version distinguished running vs. stopped
   * (reading `runtime.getAllStatus()`) and monorepo group members (reading
   * `assessAccessGate()`, which opens with a `parseDropYaml` parse) per app,
   * but all three branches ended in the same "no action is required" text,
   * so the distinction cost real boot time — a `listContainers` + N
   * `inspect` + a per-container `stats` call under docker, plus a
   * `parseDropYaml` per gated app — to choose between wording nobody acted
   * on differently.
   */
  private async sweepAccessGates(): Promise<void> {
    const configs = this.appConfigService?.getAllConfigs() ?? [];
    const unenforceable: string[] = [];
    const withdrawn: string[] = [];

    for (const config of configs) {
      if (!config.access) {
        // Not `continue`: a gate removed while the platform was down must
        // clear the flag, or the estate view reports "gate not applied" for an
        // app that no longer has a gate. The write is change-guarded, so this
        // is a no-op for the overwhelming majority of apps that never had one.
        await this.stateManager?.setAccessGateUnapplied(config.name, undefined);
        continue;
      }
      if (!this.config.enableAccessGate) {
        // There is no gate to apply while the switch is off, so "unapplied"
        // is the wrong axis to record `true` on (mirrors the route-emission
        // fix). Collected for the aggregate line below rather than logged
        // per app — every app in this state ends at the same "no action is
        // required" fact regardless of whether it is running or part of a
        // monorepo group.
        await this.stateManager?.setAccessGateUnapplied(config.name, undefined);
        withdrawn.push(config.name);
        continue;
      }
      const verdict = await this.assessAccessGate(config.name);
      if (!verdict.enforceable) {
        unenforceable.push(config.name);
        this.logger.error(describeAccessGateRefusal(config.name, verdict), 'ROUTER');
      }
      // 'skipped': the sweep reads persisted state at boot and emits nothing,
      // so it can never assert that Caddy is carrying the guard.
      await this.stateManager?.setAccessGateUnapplied(
        config.name,
        !isGateApplied({
          enforceable: verdict.enforceable,
          enforcementAvailable: ACCESS_GATE_ENFORCEMENT_AVAILABLE,
          reloadOutcome: 'skipped',
        })
      );
    }

    if (withdrawn.length > 0) {
      this.logger.info(
        `${withdrawn.length} app(s) carry an access-gate policy that is not enforced ` +
          `(DROP_FEATURE_ACCESS_GATE is switched off): ${withdrawn.join(', ')}. Any guard ` +
          'already in Caddy for these apps stays there until their next route emission, but ' +
          '/verify is admitting every request in the meantime — no action is required.',
        'ROUTER'
      );
    }

    if (unenforceable.length > 0) {
      this.logger.error(
        `${unenforceable.length} app(s) have an access-gate policy this platform cannot enforce: ` +
          `${unenforceable.join(', ')}. They are NOT protected.`,
        'ROUTER'
      );
    }
  }

  /**
   * The shim tenant-authored build commands are executed through.
   *
   * Under docker isolation this returns a runner that executes `install`,
   * `build` and any drop.yaml hook INSIDE an ephemeral build container (own
   * user, `CapDrop: ALL`, no docker socket). Returning `undefined` makes the
   * builder fall back to `executeCommand`, i.e. a plain host `child_process`
   * running as the platform user — who is in the `docker` group on an
   * isolation=docker box and therefore root-equivalent. A tenant `postinstall`
   * on that path reaches every other tenant's data, `encryption.key` and
   * `api-credentials.json`.
   *
   * It exists as a helper because BOTH build entry points must use it and one
   * of them silently did not: `handleBuildApp` built this inline while
   * `handleAppUpdate` — the path every upload and git REDEPLOY of an existing
   * app takes — passed no `execCommand` at all. Keep both call sites on this
   * method; a third build path must call it too.
   */
  private buildExecCommandFor(
    appType: AppType,
    appName: string
  ): ReturnType<typeof createContainerExecCommand> | undefined {
    // Host isolation: there is no build container, and running the command on
    // the host is the intended behaviour, not a fallback.
    if (this.config.isolation !== 'docker') {
      return undefined;
    }

    // FAIL CLOSED. Configured for docker isolation but without a container
    // runtime is not "run it on the host anyway" — that silently converts a
    // misconfiguration (or a shutdown window, where stop() nulls the runtime
    // while a build is still going) into executing an untrusted command
    // unconfined as a user in the docker group. Refuse instead: the build
    // fails loudly, the previously-deployed version keeps serving, and the
    // operator sees a config error rather than an invisible sandbox bypass.
    if (this.runtime?.type !== 'docker') {
      throw new Error(
        'Refusing to build: DROP_ISOLATION=docker but no container runtime is available. ' +
          'Building would run this app’s install/build commands directly on the host.'
      );
    }

    return createContainerExecCommand(
      (this.runtime as import('../managers/runtime').ContainerManager).docker,
      appType,
      appName
    );
  }

  /**
   * Handle app update events (file changes in existing apps)
   * Stops the running process, rebuilds, and restarts on the same port
   */
  private async handleAppUpdate(
    appName: string,
    appPath: string,
    reason: string,
    bypassCooldown?: boolean,
    actor?: DeployActorInfo
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
        // GUARDRAIL. This branch RETURNS below, above the gate on the ordinary
        // rebuild path, and expandMonorepo is one of the most expensive things
        // on the box: a git pull plus an fs.rm/fs.cp of every child tree plus a
        // build per service. Whether an app takes this branch is decided by the
        // caller's own drop.yaml (`services:`), so leaving it ungated let any
        // caller opt into an unmetered build loop.
        const containerKeys = this.guardrailKeys(appName, false, actor ?? {});
        const containerVerdict = this.checkGuardrails(containerKeys);
        if (!containerVerdict.allowed) {
          const refusal =
            `Too many failed deploys (${containerVerdict.failures}). ` +
            `Retry in ${containerVerdict.retryAfterSeconds}s.`;
          this.logger.warn(`Re-expansion of '${appName}' refused by guardrail: ${refusal}`, 'MONOREPO');
          this.releaseGuardrailKeys(appName);
          this.failDeployEpisode(appName, new Error(refusal), crypto.randomUUID(), 'GUARDRAIL_TRIPPED');
          return;
        }
        this.breakerKeys.set(appName, containerKeys);

        this.logger.info(`Re-expanding monorepo container '${appName}' (explicit redeploy)`, 'MONOREPO');
        // Same in-progress bracket as the app:detected interception: blocks a
        // concurrent DELETE (409) and re-entrant updates while child folders
        // are re-materialized out from under running apps.
        this.appsInProgress.add(appName);
        try {
          await this.expandMonorepo(appPath, appName, containerYaml.config, actor);
          this.recordDeployOutcome(appName, true);
        } catch (err) {
          this.recordDeployOutcome(appName, false);
          throw err;
        } finally {
          this.appsInProgress.delete(appName);
        }
      } else {
        this.logger.debug(
          `Skipping update for monorepo container '${appName}' - not a buildable app`,
          'UPDATE'
        );
      }
      return;
    }

    // The mirror of the container guard above, and deliberately AFTER it so the
    // container is identified positively (by its own `services:` map) before
    // anything is refused for being grouped — otherwise a container that ever
    // gained a `group` in its AppConfig would stop re-expanding, silently.
    //
    // An INCIDENTAL file-settle on a materialized CHILD is almost always the
    // container's own fs.cp landing in that folder, so rebuilding here races
    // the expansion that is writing the files: the child rebuilds against a
    // half-copied tree, and a static child ends up serving a build output that
    // was replaced underneath it.
    //
    // Only the incidental path is refused. An explicit redeploy still runs —
    // refusing it would be worse — though note such a build lands in a tree the
    // container will fs.rm on its next expansion, so it survives only until the
    // next group redeploy. Redirecting that path to the container is follow-up
    // work, not something to guess at here.
    if (!bypassCooldown && this.isGroupedChild(appName)) {
      this.logger.debug(
        `Skipping incidental update for grouped child '${appName}' — its monorepo container owns rebuilds`,
        'MONOREPO'
      );
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

    // GUARDRAIL. A SECOND choke point, not a duplicate: handleAppUpdate does
    // not route through handleBuildApp — it has its own build — so the Step 7
    // gate covered only FIRST deploys. Redeploy is the path an agent loop
    // actually rides (deploy, fail, "fix", redeploy, fail), and it is where
    // upload-deploy and git-redeploy send every app that already exists.
    //
    // Deliberately here, below every skip guard above (in-progress, monorepo
    // container, cooldown, unregistered, user-stopped) and below the
    // `reason`/`wasRunning` reads: each of those returns without deploying, and
    // an update that never deploys must neither be refused nor leave a key in
    // breakerKeys for some later episode's outcome to be recorded against.
    const guardKeys = this.guardrailKeys(appName, false, actor ?? {});
    const verdict = this.checkGuardrails(guardKeys);
    if (!verdict.allowed) {
      const refusal =
        `Too many failed deploys (${verdict.failures}). Retry in ${verdict.retryAfterSeconds}s.`;
      this.logger.warn(`Redeploy of ${appName} refused by guardrail: ${refusal}`, 'UPDATE');
      // Released BEFORE reporting. failDeployEpisode records a failure, and a
      // key left over from an earlier aborted episode would receive it — so
      // every refused retry would push a new failure into the window that
      // refused it and re-arm the cooldown, extending its own lockout forever.
      this.releaseGuardrailKeys(appName);
      // Suppress the watcher's follow-up. upload-deploy LANDS the files before
      // publishing app:update, so a refusal here does not undo the write — and
      // those writes are inside the watched tree. Without this the watcher's
      // debounced flush would republish app:update with NO actor moments later,
      // laundering the refused build into the `watcher::<app>` bucket and
      // running it anyway. An explicit redeploy still bypasses this and is
      // re-gated above, which is the intended behaviour.
      this.appDeployTimes.set(appName, Date.now());
      // Reported as a normal deploy failure so a caller polling for an outcome
      // gets an answer instead of waiting out its budget.
      this.failDeployEpisode(appName, new Error(refusal), crypto.randomUUID(), 'GUARDRAIL_TRIPPED');
      return;
    }
    this.breakerKeys.set(appName, guardKeys);

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
      // Released, not counted: the build never ran, and the box being full is
      // not evidence the caller is looping. Leaving the key set would hand this
      // episode's slot to whatever outcome is recorded next.
      this.releaseGuardrailKeys(appName);
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
      // Same mint-and-thread as handleBuildApp. This path must NOT be skipped:
      // upload-deploy routes every EXISTING app here, so it is the dominant
      // path for an agent redeploying, and threading only the fresh-deploy path
      // would leave exactly those builds unaddressable.
      const updateDeployId = crypto.randomUUID();
      const updateLogId = this.buildLogService
        ? await this.buildLogService.startBuild(appName, new Date(), updateDeployId)
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
          deployId: updateDeployId,
          appType: detection.type,
          framework: detection.framework || null,
          config: {
            buildCommand: buildOverride ?? detection.suggestedConfig?.buildCommand,
            installCommand: detection.suggestedConfig?.installCommand,
          },
          env: buildEnv,
          workDir,
          // Parity with handleBuildApp — see buildExecCommandFor. Without this
          // every redeploy of an EXISTING app ran its tenant-authored install
          // and build commands on the host instead of inside the build
          // container, and this is the path upload-deploy and git redeploy both
          // take, i.e. the common one.
          execCommand: this.buildExecCommandFor(detection.type, appName),
          onBuildLog: updateLogId && this.buildLogService
            ? (line) => this.buildLogService!.writeLine(updateLogId, line)
            : undefined,
        });
      } finally {
        this.selfManagedUpdates.delete(appName);
        // Also in the finally: resolveBuildEnv/parseDropYaml above can throw,
        // and the close used to sit after this block — so a throw leaked the
        // log's write stream and skipped retention, exactly as on the fresh
        // deploy path.
        await this.closeBuildLog(updateLogId, appName);
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
        this.recordDeployOutcome(appName, false);
        this.appsInProgress.delete(appName);
        return;
      }

      // Manual promotion holds HERE, before the stop. This is the branch SEC-9
      // found broken in the withhold-the-route design: on a redeploy the route
      // already exists, so gating it did nothing and unapproved code went live
      // the instant the new process started. Holding before the stop leaves the
      // approved version running and serving, untouched.
      if (await this.holdForPromotion(appName, buildResult.outputPath ?? undefined, updateDeployId)) {
        // A held build is not a failed one — the guardrail window must not be
        // charged for a deploy the operator asked to be held.
        this.releaseGuardrailKeys(appName);
        await this.stateManager.setAppStatus(appName, appState.status);
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
      await this.noteRuntimeLogStart(appName);
      const status = await this.runtime.start(spec);

      this.logger.appEvent('started', appName, `PID ${status.pid}, port ${port} (hot-reloaded)`);

      // Record the signature this hot-reload landed at (M1) — a git/upload
      // redeploy that never recorded here would look "unchanged" for a whole
      // extra boot cycle. runtime.start() (above) always recreates the
      // container in docker mode, so the runtime-spec revision recorded here
      // is accurate too. Fire-and-forget (`void`), not awaited: must never
      // delay the 'running' status write or appsInProgress's release.
      void this.recordDeploySignature(appName, appPath);

      await this.stateManager.setAppStatus(appName, 'running', {
        port,
        pid: status.pid ?? undefined,
      });

      // Record deploy time for cooldown
      this.appDeployTimes.set(appName, Date.now());

      // Re-arm the health prober AND the crash-loop watch — stopHealthProber
      // above tore the prober down, and armPostDeployWatches re-baselines the
      // crash-loop watch's restart count against the NEW (hot-reloaded)
      // process rather than continuing to watch the old one's count.
      this.armPostDeployWatches(appName, port, spec.healthCheckPath);

      this.recordDeployOutcome(appName, true);
      this.appsInProgress.delete(appName);
    } catch (error) {
      // Secret preflight park (PRD-051) on a hot-reload — e.g. the edited
      // drop.yaml added a required `secrets:` entry. Park in `needs-config`
      // (not `errored`) so the operator gets the actionable missing list. The
      // `starting` transition above already cleared any stale error.
      if (error instanceof AppNeedsConfigError) {
        this.logger.warn(
          `${appName} parked in needs-config on hot-reload — set required secret(s): ` +
            `${error.missingSecrets.join(', ')}, then restart`,
          'SECURITY'
        );
        await this.stateManager.setAppStatus(appName, 'needs-config', {
          missingSecrets: error.missingSecrets,
        });
        // COUNTED, unlike the pre-build deferrals. AppNeedsConfigError is
        // thrown from buildFreshStartSpec, which runs AFTER builder.build() has
        // completed — so the install and build were already paid for. The
        // `secrets:` block that triggers it is tenant-controlled and both
        // upload-deploy and git-redeploy publish with bypassCooldown, so
        // leaving it uncounted made `deploy → full build → park → deploy` a
        // free, unbounded loop. (An earlier revision likened this to MAX_BUILDS;
        // that was wrong — MAX_BUILDS aborts BEFORE the build.)
        this.recordDeployOutcome(appName, false);
        this.appsInProgress.delete(appName);
        return;
      }
      this.logger.appEvent('error', appName, error instanceof Error ? error.message : 'Hot-reload failed');
      await this.stateManager.setAppStatus(appName, 'errored', {
        error: error instanceof Error ? error.message : 'Hot-reload failed',
      });
      this.recordDeployOutcome(appName, false);
      this.appsInProgress.delete(appName);
    }
  }

  /**
   * Rebuild the start spec for an app the platform already knows about: port
   * resolution, the persistent data dir, and service env vars. Shared by
   * handleAppUpdate (hot-reload) and restartApp so the two paths can't drift
   * apart.
   *
   * Provisioning here is NOT uniform across services, despite what this
   * comment used to say ("no new provisioning here — that only happens on a
   * fresh deploy"). That holds for the **database**: this path only re-reads
   * an already-provisioned one, so an app that newly needs a database needs a
   * redeploy rather than a restart. It is **false for Redis**:
   * `provisionRedisEnvVars` below allocates when there is no existing
   * allocation, on this path as much as on the deploy path.
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
    // Restart path: honour a declared `port:` here too, or a restart would
    // quietly hand back the previously auto-allocated port and undo it.
    const declaredPort = (await parseDropYaml(appPath))?.config?.port;
    const port = this.allocatePort(appName, declaredPort);

    // Ensure data directory exists (preserved across upgrades)
    const dataDir = await this.ensureAppDataDirectory(appName);

    // Get env vars for an already-provisioned DB (no new provisioning here).
    // Skip entirely when the owner's intent is 'detached'. This is LOAD-
    // BEARING, not defensive: detachService persists 'detached' BEFORE
    // deprovisioning (the persist-first invariant — see its own method doc),
    // so a 'detached' intent with a still-live registry entry is the
    // EXPECTED shape of a partial detach (a crash or a failed `DROP DATABASE`
    // /`DROP USER` between the persist and the drop), not a rare edge case.
    // This guard is the only thing stopping this restart path from
    // re-injecting a DSN for a database the owner explicitly asked to
    // remove. Its two siblings, `appNeedsDatabase` and `provisionRedisEnvVars`
    // (which guards the same way for Redis, and `appNeedsRedis` beneath it),
    // check the same intent for the same reason on the deploy/attach path.
    let dbEnvVars: Record<string, string> = {};
    if (this.dbProvisioner && this.appServiceIntent(appName, 'postgres') !== 'detached') {
      const pgSocketDir =
        this.config.isolation === 'docker'
          ? (this.postgresServer?.getSocketDir() ?? undefined)
          : undefined;
      dbEnvVars = this.dbProvisioner.getEnvVars(
        appName,
        pgSocketDir ? { pgSocketDir } : undefined
      ) || {};
    }

    // Redis: re-fetches an existing allocation, and ALLOCATES a new one if
    // there isn't one — unlike the database lines above, which only re-read.
    // See provisionRedisEnvVars' own comment for why the two differ.
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
      return await this.doRestart(appName);
    } finally {
      this.appsInProgress.delete(appName);
    }
  }

  /**
   * The body of restartApp, extracted so `attachService` (DROP-151 Phase 2)
   * can hold the `appsInProgress` guard across provisioning AND the restart
   * that follows it, instead of releasing and re-acquiring the guard between
   * the two — which would let a deploy sneak in and race the provisioning
   * step. Callers MUST already hold the guard for `appName`; this method
   * neither checks nor releases it. restartApp above is the only other
   * caller, and its own contract (guard check, AppInProgressError, the
   * appsInProgress release) is unchanged — this is a pure extraction.
   */
  private async doRestart(appName: string): Promise<AppProcessInfo> {
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
      // Also here, even though a plain restart opens no deploy episode and
      // the store will discard it — so that a start site is never the one
      // that was forgotten if restarts later become addressable.
      await this.noteRuntimeLogStart(appName);
      const status = await this.runtime.start(spec);

      this.logger.appEvent('started', appName, `PID ${status.pid}, port ${port} (restarted)`);

      // Record the signature this restart landed at (M1) — a restart is
      // the only apply point for a rotated secret (no other restart hook
      // exists), and runtime.delete()+start() above always recreates the
      // container in docker mode, so the runtime-spec revision recorded
      // here is accurate too. Fire-and-forget (`void`), not awaited: must
      // never delay the 'running' status write or appsInProgress's release.
      void this.recordDeploySignature(appName, appPath);

      await this.stateManager.setAppStatus(appName, 'running', {
        port,
        pid: status.pid ?? undefined,
      });

      // buildFreshStartSpec's drop-config.js write (static apps with
      // depends_on) lands inside the watched directory; record the deploy
      // time so the watcher's own debounced event doesn't read it back as a
      // user change and trigger a spurious hot-reload.
      this.appDeployTimes.set(appName, Date.now());

      // Re-arm the health prober AND the crash-loop watch. Note: this
      // resets crash-loop detection's restart-count baseline rather than
      // continuing whatever watch (if any) was already running — correct,
      // since delete()+start() above is a genuinely new process/container.
      this.armPostDeployWatches(appName, port, spec.healthCheckPath);

      return status;
    } catch (error) {
      // Secret preflight park (PRD-051): re-park in `needs-config` rather than
      // `errored` (e.g. a "retry" that still has some required secrets unset),
      // then re-throw so the caller/route reports which are missing.
      if (error instanceof AppNeedsConfigError) {
        await this.stateManager.setAppStatus(appName, 'needs-config', {
          missingSecrets: error.missingSecrets,
        });
        throw error;
      }
      this.logger.appEvent('error', appName, error instanceof Error ? error.message : 'Failed to restart');
      await this.stateManager.setAppStatus(appName, 'errored', {
        error: error instanceof Error ? error.message : 'Failed to restart',
      });
      throw error;
    }
  }

  /**
   * Attach/detach refusals go to the platform logger, never the ActivityLog
   * ring. The ring holds only 500 entries, and a caller hammering a cheap,
   * repeatable refusal (the route's rate limit permits ~20/min) could evict
   * every security-relevant entry in it within about 25 minutes. Both
   * operations log through this one place so that stays true by construction
   * rather than by two call sites happening to agree.
   */
  private logServiceRefusal(
    op: 'attach' | 'detach',
    appName: string,
    serviceId: AttachableServiceId,
    reason: string
  ): void {
    this.logger.warn(`${op} refused for '${appName}' (${serviceId}): ${reason}`, 'SERVICES');
  }

  /**
   * Log a refusal and hand it straight back, so attachService/detachService's
   * ~15 refusal sites are each a single `return this.refuse(...)` instead of
   * a `logServiceRefusal(...)` call hand-paired with a `return { ... }` a few
   * lines below it — the "every refusal is logged" invariant used to hold
   * only because 15 call sites happened to remember both halves; now it holds
   * because there is only one half to remember. Generic over the refusal
   * shape so it serves both attachService's and detachService's differently-
   * shaped refusal arms (both always carry a string `reason`) — `const T` so
   * a call site's object literal (e.g. `reason: 'no-app-config'`,
   * `attached: false`) keeps its literal type through the call instead of
   * widening to `string`/`boolean`, which would make every refusal fail to
   * satisfy AttachServiceResult/DetachServiceResult's discriminated unions.
   * `label` overrides the string actually logged, for the two detach-limit
   * refusals whose wire `reason` ('detach-limit') is too coarse on its own to
   * tell the cooldown and dump-budget limiters apart in the platform log.
   */
  private refuse<const T extends { reason: string }>(
    op: 'attach' | 'detach',
    appName: string,
    serviceId: AttachableServiceId,
    refusal: T,
    label?: string
  ): T {
    this.logServiceRefusal(op, appName, serviceId, label ?? refusal.reason);
    return refusal;
  }

  /**
   * DROP-151 Phase 2: attach a backing service (postgres|redis) to an app —
   * quota check, provision, persist the owner's explicit intent
   * (`AppConfig.services`), then restart so the env var is actually injected.
   * See platform-ops.ts's AttachServiceResult for the discriminated return
   * shape; a refusal is a RETURN VALUE (never thrown) except for "busy",
   * which throws AppInProgressError, matching restartApp's own contract.
   *
   * Guard ordering matters and is deliberate:
   *   1. Busy — the WHOLE attach is guarded, not just the restart at the end.
   *      Held for the entire method (provisioning included), same primitive
   *      `handleStartApp`/`restartApp` hold it for — so this also IS the
   *      per-app provisioning serialization the plan calls for: nothing else
   *      that touches `provisionAppDatabase`/`provisionAppRedis` for this
   *      app can run while this guard is held, so a second concurrent
   *      attach (or a racing deploy) is refused before it can reach
   *      provisioning, rather than needing its own separate lock.
   *   2. Ephemeral apps are refused outright — the TTL sweep tears down with
   *      `skipDatabaseBackup: true`, so data attached here would die on a
   *      timer with no dump anywhere.
   *   3. Postgres only: refuse when the app already supplies its own
   *      DATABASE_URL (secret or drop.yaml env:). `appDatabaseUrlSource`
   *      exists precisely so inference never silently repoints an app from
   *      its real database at a freshly-created empty one; an explicit
   *      attach must not bypass that by construction.
   *   4. Quota, via the extracted checkDbQuota/checkRedisQuota — a structured
   *      refusal, not the deploy path's warn-and-skip: a caller that clicked
   *      Attach must never get a success response with real downtime and no
   *      database.
   *   5. Provision (see point 1 for why no extra lock is needed here).
   *   6. Persist `services[serviceId] = 'attached'` — the precedence
   *      `appServiceIntent` reads back everywhere. `setServiceIntent`
   *      re-reads the config INSIDE its own write chain (at execution time,
   *      not at this method's call time), so it can still resolve null here
   *      — a second, later no-app-config refusal, guarded the same way
   *      detachService's own two call sites are.
   *   7. Restart, so the freshly-provisioned var is actually injected.
   *      Resolves only once that restart resolves.
   */
  async attachService(
    appName: string,
    serviceId: AttachableServiceId
  ): Promise<AttachServiceResult> {
    if (this.appsInProgress.has(appName)) {
      throw new AppInProgressError(appName);
    }
    this.appsInProgress.add(appName);
    // `appsInProgress` is keyed per APP; the quota it protects is per USER.
    // Two attaches on two apps owned by the same person therefore both pass
    // the per-app guard, both read `used = N` before either provisioner call
    // registers, and both provision — so an owner with a limit of 3 and six
    // apps can exceed it in one burst. The rate-limit bucket bounds the rate,
    // not the race. Serialise the whole check-then-provision span per owner so
    // the second caller reads the first's result.
    const releaseOwnerLock = await this.acquireOwnerAttachLock(appName);
    try {
      if (!this.appConfigService || !this.stateManager) {
        throw new Error('Platform is not fully initialized');
      }

      const config = this.appConfigService.getConfig(appName);
      const state = this.stateManager.getApp(appName);
      if (!config && !state) {
        throw new Error(`Application not found: ${appName}`);
      }

      // Shared verbatim by both no-app-config refusals below (the up-front
      // guard and the post-provisioning setServiceIntent race) — hoisted so
      // the two can't drift apart.
      const noAppConfigDetail =
        `'${appName}' has no platform config yet, so its service attachment cannot be ` +
        'persisted safely. Deploy the app once through DROP before attaching a service.';

      // An app with runtime state but NO AppConfig must not be attached to.
      // Persisting intent means `upsertConfig`, which would mint a config
      // carrying `type: 'unknown'` and no `path`/`hostname` — and
      // `syncStateWithConfigs` iterates CONFIGS on the next boot, calling
      // `registerApp(name, config.path || <appsDirectory>/name, config.type,
      // ...)`, which overwrites those fields on the state unconditionally. So
      // attaching a database to an out-of-tree or admin-registered app would
      // silently relocate its path and reset its type at the next boot, and
      // the failure would only surface later as a broken build. Refuse
      // instead; every app deployed through the normal pipeline has a config
      // by the time it is running.
      if (!config) {
        return this.refuse('attach', appName, serviceId, {
          attached: false,
          reason: 'no-app-config',
          detail: noAppConfigDetail,
        });
      }
      // Same resolution restartApp/doRestart use — a hardcoded appsDirectory
      // join would read the wrong (or no) drop.yaml for an out-of-tree or
      // monorepo-child app and let the own-DATABASE_URL guard below pass
      // when it should refuse.
      const appPath = config?.path || state?.path || path.join(this.config.appsDirectory, appName);

      if (config?.ephemeral) {
        return this.refuse('attach', appName, serviceId, {
          attached: false,
          reason: 'ephemeral',
          detail:
            'This app is ephemeral and will be torn down on its TTL without a database backup — attach is refused to avoid unrecoverable data loss.',
        });
      }

      // Both services need this guard, not just Postgres. dbEnvVars AND
      // redisEnvVars are each spread after secretEnvVars in the start env, so
      // either one provisioned over an owner-supplied URL silently repoints
      // the app at an empty store. Building it for Postgres alone left the
      // same hazard open on Redis, where the blast radius is arguably worse:
      // an emptied session store destroys live auth state rather than just
      // losing a query.
      if (serviceId === 'postgres') {
        const ownSource = await this.appDatabaseUrlSource(appName, appPath);
        if (ownSource) {
          return this.refuse('attach', appName, serviceId, {
            attached: false,
            reason: 'has-own-database-url',
            detail: `This app already supplies its own DATABASE_URL (via ${ownSource}) — attaching would silently repoint it at a freshly-created, empty database.`,
          });
        }
      } else {
        const ownSource = await this.appRedisUrlSource(appName, appPath);
        if (ownSource) {
          return this.refuse('attach', appName, serviceId, {
            attached: false,
            reason: 'has-own-redis-url',
            detail: `This app already supplies its own REDIS_URL (via ${ownSource}) — attaching would silently repoint it at a freshly-created, empty Redis instance.`,
          });
        }
      }

      const ownerUserId = state?.userId;
      const quota = serviceId === 'postgres'
        ? this.checkDbQuota(ownerUserId)
        : this.checkRedisQuota(ownerUserId);
      if (!quota.allowed) {
        return this.refuse('attach', appName, serviceId, {
          attached: false,
          reason: 'quota-exceeded',
          detail: `${serviceId === 'postgres' ? 'Database' : 'Redis'} quota reached (${quota.used}/${quota.limit}).`,
          quota: { used: quota.used, limit: quota.limit },
        });
      }

      // Ordering note: intent is persisted AFTER provisioning succeeds, not
      // before. If provisionAppDatabase/provisionAppRedis throws here, the
      // service is simply not attached (no database, no persisted intent) —
      // consistent. The alternative (persist-then-provision) would leave a
      // dangling 'attached' intent pointing at a database that was never
      // created if the provision step then failed. The one gap this ordering
      // does NOT close: if provisioning succeeds but the process crashes (or
      // upsertConfig below throws) before intent is persisted, the app is
      // left with a real, unlabeled database appServiceIntent doesn't know
      // about — the mirror image of DROP-151's core bug, on the provisioning
      // step rather than the deploy path. provisionAppDatabase/
      // provisionAppRedis are both idempotent (re-provisioning an app that
      // already has a database/allocation returns the existing one), so a
      // retried attach recovers cleanly; nothing currently detects the gap
      // proactively.
      let envVarNames: string[];
      if (serviceId === 'postgres') {
        if (!this.dbProvisioner) {
          // A refusal, not a throw: an instance with no database layer is a
          // permanent, correct configuration — mapping it to a 500 would read
          // as a crash and alert as one on every Postgres-less install.
          return this.refuse('attach', appName, serviceId, {
            attached: false,
            reason: 'service-unavailable',
            detail: 'The database service is not available on this instance.',
          });
        }
        await this.dbProvisioner.provisionAppDatabase(appName);
        const pgSocketDir =
          this.config.isolation === 'docker'
            ? (this.postgresServer?.getSocketDir() ?? undefined)
            : undefined;
        const envVars =
          this.dbProvisioner.getEnvVars(appName, pgSocketDir ? { pgSocketDir } : undefined) || {};
        envVarNames = Object.keys(envVars);
      } else {
        if (!this.redisProvisioner) {
          // See the Postgres branch above — a refusal, not a throw. This is
          // the ordinary state of any box with managed Redis disabled or
          // absent.
          return this.refuse('attach', appName, serviceId, {
            attached: false,
            reason: 'service-unavailable',
            detail:
              'Managed Redis is not available on this instance — it may be disabled in the ' +
              'platform configuration, or it may have failed to start.',
          });
        }
        await this.redisProvisioner.provisionAppRedis(appName);
        const redisHost = this.config.isolation === 'docker' ? HOST_ALIAS : '127.0.0.1';
        const envVars = this.redisProvisioner.getEnvVars(appName, { host: redisHost }) || {};
        envVarNames = Object.keys(envVars);
      }

      // setServiceIntent, not upsertSystemConfig's snapshot-spread — it
      // reads the CURRENT config inside the write chain and merges one
      // key, so a concurrent write for this app is never lost to a stale
      // `config` closed over above. The `!config` guard above only proves
      // config was non-null when THIS call started; setServiceIntent reads
      // the config again INSIDE the write chain, at execution time, after
      // every provisioning await above — a `deleteConfig` landing in that
      // gap makes it resolve null here, same as detachService's own two call
      // sites. Guard it the same way, rather than leaving a provisioned,
      // quota-consuming service whose owner intent silently never got
      // recorded.
      const persisted = await this.appConfigService.setServiceIntent(appName, serviceId, 'attached');
      if (!persisted) {
        return this.refuse('attach', appName, serviceId, {
          attached: false,
          reason: 'no-app-config',
          detail: noAppConfigDetail,
        });
      }

      // Only report success once the restart (and its env re-injection)
      // actually resolves — a provisioned-but-not-yet-running database is
      // not what "Attach" promised.
      await this.doRestart(appName);

      return { attached: true, envVarNames };
    } finally {
      releaseOwnerLock();
      this.appsInProgress.delete(appName);
    }
  }

  /**
   * Serialise attaches by OWNER, so the per-user quota's check-then-act span
   * cannot interleave across two of that owner's apps.
   *
   * Returns the release function rather than taking a callback so the caller's
   * existing try/finally owns the lifetime — the lock must be held across the
   * quota read, the provisioner call AND the intent write, which is most of
   * `attachService`'s body.
   *
   * Ownerless apps (`userId === undefined` — a DROP_API_KEY or cli-local
   * deploy) share one bucket keyed by a sentinel. They are exempt from the
   * Postgres quota anyway (`checkDbQuota` is truthy-gated), so this only
   * serialises them against each other and never changes what they are
   * allowed to do.
   */
  private ownerAttachChains = new Map<string, Promise<void>>();

  private async acquireOwnerAttachLock(appName: string): Promise<() => void> {
    const ownerKey = this.stateManager?.getApp(appName)?.userId ?? ' ownerless';
    const previous = this.ownerAttachChains.get(ownerKey) ?? Promise.resolve();

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Chain onto the previous holder in BOTH settle directions, so one
    // caller's failure never poisons the queue behind it.
    this.ownerAttachChains.set(
      ownerKey,
      previous.then(
        () => held,
        () => held
      )
    );
    await previous.catch(() => {});

    // The map retains one entry per distinct owner, holding an already-settled
    // promise after release. That is deliberately not cleaned up: a "delete if
    // we are the tail" check races a newly-arrived waiter that has already
    // chained onto this entry, and dropping it there would let two callers run
    // concurrently — a lock that silently stops locking. One small entry per
    // user is the cheaper trade.
    return release;
  }

  /** `AppConfig.services[serviceId]` — the owner's persisted attach/detach intent, or undefined. */
  getServiceIntent(appName: string, serviceId: AttachableServiceId): 'attached' | 'detached' | undefined {
    return this.appServiceIntent(appName, serviceId);
  }

  /**
   * DROP-151 Phase 3: detach a backing service (postgres|redis) — record the
   * owner's intent durably, deprovision (postgres: verified dump then drop;
   * redis: flush then free the logical DB number), then restart the app so
   * the injected env var actually drops. See platform-ops.ts's
   * DetachServiceResult for the discriminated return shape; a refusal is a
   * RETURN VALUE (never thrown) except for "busy", which throws
   * AppInProgressError — matching attachService's own contract.
   *
   * **No owner lock**, unlike attachService. Detach only ever FREES quota, so
   * every interleaving with a concurrent attach errs toward over-refusal,
   * never over-admission — `appsInProgress` (per-app) is all the
   * serialisation this needs. See docs/plans/2026-08-16-extension-catalog.md
   * ("Phase 3 — detach: final plan") for the full guard-by-guard rationale;
   * this comment only summarises the ordering, which is deliberate and
   * pinned by platform.detach-service.test.ts:
   *   1. busy (AppInProgressError, spans the WHOLE operation)
   *   2. not-found (both config and state absent)
   *   3. group-app (monorepo container OR child — refused outright; children
   *      never consult the container's config, so a container-level detach
   *      would report destruction that never happened)
   *   4. service-unavailable (the NAMED service's provisioner, per-service —
   *      never a generic "any provisioner missing" check)
   *   5. not provisioned: postgres + an orphaned (unregistered) live database
   *      -> 'credentials-missing'; otherwise NOT a refusal — persist
   *      'detached' and return early with `restart: 'not-needed'` (distinct
   *      from `'not-restarted'`: nothing was ever stopped here, so reporting
   *      liveness would be beside the point, and the old literal read as a
   *      false "was running, but chose not to restart"). Nothing to
   *      stop/drop, so guards 6-7 and the destructive steps below never run
   *      for this branch.
   *   6. detach-limit: per-SERVICE cooldown (keyed on
   *      `AppConfig.lastDetachAt[serviceId]`, not one shared per-app value —
   *      see that field's own doc, app-config.ts — so detaching postgres can
   *      no longer 429 an unrelated redis detach for the same app; skipped
   *      when intent is already 'detached' and still provisioned — a retry
   *      is not abuse), then (postgres only, and skipped entirely for an
   *      ephemeral app — its dump is about to be skipped too, so nothing is
   *      charged against a budget it will never write to) the owner's
   *      pre-delete dump-byte budget.
   *   7. manifest conflict — NOT a refusal; carried into the result so the UI
   *      can show owner-intent-wins without a second round trip.
   *   8. Persist 'detached' + lastDetachAt via setServiceIntent — BEFORE any
   *      destruction (the plan's core invariant: persist-first, so a crash or
   *      a partial deprovision still leaves a retriable, honest state).
   *      Returning null here (no AppConfig) is the 'no-app-config' refusal,
   *      enforced at the write site rather than as an up-front guard.
   *   9. Stop, properly: liveness from the RUNTIME (not state status) — an
   *      'errored'/'crash-looping' app can still hold a live process whose
   *      stale env and open connections must die before a Redis number frees
   *      or a `DROP ... FORCE` fires. Both `wasRunning` (STATE, before the
   *      stop) and `wasLive` (RUNTIME, the same read that decides whether to
   *      stop) feed step 11 — see the inline comment just above the try
   *      block (step 9-10's code) for why both are needed and why this
   *      liveness read and the stop itself are inside the SAME try/catch as
   *      step 10.
   *  10. Deprovision (dump-then-drop / flush-then-free), wrapped — together
   *      with step 9 above — so EVERY exit (a reported failure, a THROWN
   *      error from either step, or success) resolves to a result shape
   *      first and restarts exactly once after, at a single call site. A
   *      previously-live app must never be left stopped with no restart
   *      attempt just because the stop or the deprovision step threw instead
   *      of returning a failure. The 'detached' intent stays persisted
   *      either way (already written in step 8 — that IS the design). A
   *      redis flush that FAILS but still freed+tombstoned the allocation is
   *      a SUCCESS (`deprovisioned: true, flushed: false`), not a refusal —
   *      see `RedisProvisioner.deprovisionAppRedis`'s own doc for why.
   *      `reason: 'deprovision-failed'` is what's left for a THROWN error
   *      (either step, either service); the old `flush-failed` refusal that
   *      used to cover the REPORTED-failure arm is gone, not renamed — that
   *      arm is a success now.
   *  11. Restart iff `wasLive || wasRunning`, via doRestart — never a
   *      hand-rolled runtime.start (PM2 merges env on a bare start, so a
   *      removed DATABASE_URL would keep being injected under
   *      isolation:none).
   *  12. Refusals are logged via the platform logger, never ActivityLog (see
   *      logServiceRefusal) — the route slice adds ActivityLog for outcomes.
   */
  async detachService(
    appName: string,
    serviceId: AttachableServiceId
  ): Promise<DetachServiceResult> {
    if (this.appsInProgress.has(appName)) {
      throw new AppInProgressError(appName);
    }
    this.appsInProgress.add(appName);
    try {
      if (!this.appConfigService || !this.stateManager || !this.runtime) {
        throw new Error('Platform is not fully initialized');
      }

      const config = this.appConfigService.getConfig(appName);
      const state = this.stateManager.getApp(appName);

      // Shared verbatim by both no-app-config refusals below (the
      // not-provisioned branch and the main persist-before-destruction step)
      // — hoisted so the two can't drift apart.
      const noAppConfigDetail = `'${appName}' has no platform config yet, so its detach intent cannot be persisted safely.`;

      // 2. not-found
      if (!config && !state) {
        return this.refuse('detach', appName, serviceId, {
          detached: false,
          reason: 'not-found',
          detail: `Application '${appName}' not found.`,
        });
      }

      // 3. group-app. Containers carry isGroupContainer:true; children carry
      // only `group` — refuse both (see the method doc; attach has the same
      // gap).
      if (state?.isGroupContainer || state?.group) {
        return this.refuse('detach', appName, serviceId, {
          detached: false,
          reason: 'group-app',
          detail: `'${appName}' is part of a monorepo group. Group children never consult the container's own config, so a group-level detach could report a service removed that was never actually attached to this app — detach the individual app's own database/Redis outside the group tooling, or contact an operator.`,
        });
      }

      // 4. service-unavailable — per-service, never a generic null check.
      const provisioner: DatabaseProvisioner | RedisProvisioner | null =
        serviceId === 'postgres' ? this.dbProvisioner : this.redisProvisioner;
      if (!provisioner) {
        return this.refuse('detach', appName, serviceId, {
          detached: false,
          reason: 'service-unavailable',
          detail:
            serviceId === 'postgres'
              ? 'The database service is not available on this instance.'
              : 'Managed Redis is not available on this instance.',
        });
      }

      // Same resolution attachService/doRestart use.
      const appPath = config?.path || state?.path || path.join(this.config.appsDirectory, appName);
      // Not a refusal (guard 7) — its position can't be observed since it
      // never blocks anything. Lazy and memoised: a parse+validate of
      // drop.yaml on every call would be paid even by refusals below that
      // never carry it (guard 5's credentials-missing, guard 6/7's
      // detach-limit) — the cooldown refusal in particular is the
      // cheap-to-hammer path (~20/min). `getManifestConflict()` awaits the
      // parse at most once, on first read from whichever success arm reaches it.
      let manifestConflictPromise: Promise<boolean> | undefined;
      const getManifestConflict = (): Promise<boolean> => {
        if (!manifestConflictPromise) {
          manifestConflictPromise = this.detachManifestConflict(appPath, serviceId);
        }
        return manifestConflictPromise;
      };

      // 5. not provisioned
      if (!provisioner.isProvisioned(appName)) {
        if (serviceId === 'postgres' && (await this.dbProvisioner!.orphanDatabaseExists(appName))) {
          return this.refuse('detach', appName, serviceId, {
            detached: false,
            reason: 'credentials-missing',
            detail: `'${appName}' has a live database on the server with no tracked credentials for it — "nothing to detach" would be dishonest. Contact an operator to recover or clear the orphaned database.`,
          });
        }

        // Not a refusal: record the owner's intent even against a manifest
        // they don't control, and make a double-click idempotent.
        const persisted = await this.appConfigService.setServiceIntent(appName, serviceId, 'detached');
        if (!persisted) {
          return this.refuse('detach', appName, serviceId, {
            detached: false,
            reason: 'no-app-config',
            detail: noAppConfigDetail,
          });
        }
        // 'not-needed', not 'not-restarted': nothing was ever stopped on
        // this branch, so a liveness-based restart value would either be a
        // needless bounce (running) or, worse, the old dishonest "was not
        // running, so it was not restarted" for an app that WAS running the
        // whole time — its service was just never provisioned in the first
        // place.
        return {
          detached: true,
          deprovisioned: false,
          manifestConflict: await getManifestConflict(),
          restart: 'not-needed',
        };
      }

      // Hoisted above guard 6: an ephemeral app's dump is always skipped at
      // step 10, so charging its owner's byte budget for a dump that will
      // never be written would refuse a detach over nothing — mirrors the
      // delete route's own ephemeral skip (apps.ts).
      const skipBackup = config?.ephemeral === true;

      // 6. detach-limit. Retry exemption: intent already 'detached' while
      // still provisioned (established above) is a repair, not abuse — skip
      // the COOLDOWN only, never the byte budget.
      const isRetry = this.appServiceIntent(appName, serviceId) === 'detached';
      if (!isRetry) {
        // Per-SERVICE, not one shared per-app epoch — see AppConfig.
        // lastDetachAt's own doc (app-config.ts) for why. Keyed here the
        // same way `services` is (by AttachableServiceId) — see
        // `setServiceIntent`'s own per-service merge.
        const cooldown = checkDetachCooldown({ lastDetachAt: config?.lastDetachAt?.[serviceId] });
        if (!cooldown.allowed) {
          return this.refuse(
            'detach',
            appName,
            serviceId,
            {
              detached: false,
              reason: 'detach-limit',
              limit: 'cooldown',
              retryAfterSeconds: cooldown.retryAfterSeconds,
              detail: `'${appName}' had its ${serviceId} service detached too recently — retry in ${cooldown.retryAfterSeconds}s.`,
            },
            'detach-limit (cooldown)'
          );
        }
      }
      if (serviceId === 'postgres' && !skipBackup) {
        // Per-OWNER, not global (a global ceiling is a cross-tenant DoS).
        // Dump attribution is now keyed on a per-owner DIRECTORY, fixed at
        // write time (`DatabaseProvisioner.ownerDumpDir`) — not re-derived
        // from the live app list, which is what let a deleted app's dumps
        // evade metering. Ownerless apps share the fixed `_ownerless`
        // bucket, same as before.
        const ownerDir = this.dbProvisioner!.ownerDumpDir(state?.userId);
        const budget = await checkDumpByteBudget(ownerDir);
        if (!budget.allowed) {
          return this.refuse(
            'detach',
            appName,
            serviceId,
            {
              detached: false,
              reason: 'detach-limit',
              limit: 'dump-budget',
              detail: `This owner's pre-delete dump budget is exhausted (${Math.round(budget.usedBytes / (1024 * 1024))}MB used of ${Math.round(budget.limitBytes / (1024 * 1024))}MB) — an operator must prune old dumps before another Postgres detach can proceed.`,
            },
            'detach-limit (dump budget)'
          );
        }
      }

      // 8. Persist 'detached' + lastDetachAt — the converging-retry pivot —
      // BEFORE any destruction below.
      const persisted = await this.appConfigService.setServiceIntent(appName, serviceId, 'detached', {
        lastDetachAt: Date.now(),
      });
      if (!persisted) {
        return this.refuse('detach', appName, serviceId, {
          detached: false,
          reason: 'no-app-config',
          detail: noAppConfigDetail,
        });
      }

      // 9-10. Stop, then deprovision — ONE try/catch wrapping BOTH: the try
      // used to open only at step 10, so a `runtime.stop` that RETHROWS
      // (ContainerManager does, for anything that isn't not-found/not-
      // running) escaped detachService entirely on a docker-isolation box —
      // intent already 'detached', database still provisioned and counting
      // quota, watches disarmed, state said 'stopped', no restart attempted,
      // no audit, an opaque 500. Both steps now funnel into the same
      // `outcome` and the single `restartAfterDetach` call at step 11.
      // `deprovisionStarted` lets the one catch below tell a stop failure
      // (nothing destructive was even attempted) from a deprovision failure
      // (which needs a service-specific reason) without a second try block.
      //
      // `wasRunning` is read from STATE, before either step; `wasLive` is
      // the RUNTIME read, inside the try, that decides whether to stop — an
      // 'errored'/'crash-looping' app can still hold a live process. Both
      // feed step 11: restarting on `wasRunning` alone would leave a
      // live-but-errored app dead after detach while reporting the
      // dishonest "was not running, so it was not restarted".
      const freshState = this.stateManager.getApp(appName);
      const wasRunning = freshState?.status === 'running';
      // DetachServiceOutcome (platform-ops.ts / services-wire.types.ts) is
      // this same shape — imported rather than hand-mirrored here, so the two
      // can no longer drift apart.
      let outcome: DetachServiceOutcome;
      let wasLive = false;
      let deprovisionStarted = false;
      try {
        const runtimeStatus = await this.runtime.getStatus(appName);
        wasLive = runtimeStatus?.status === 'running';
        if (wasLive) {
          this.stopHealthProber(appName);
          this.stopCrashLoopWatch(appName);
          await this.stateManager.setAppStatus(appName, 'stopped');
          await this.runtime.stop(appName);
        }

        deprovisionStarted = true;
        if (serviceId === 'postgres') {
          // Attributed to the SAME owner directory the byte-budget gate
          // above measured (`this.dbProvisioner!.ownerDumpDir(state?.userId)`)
          // — without this the budget bounded nothing: every dump landed in
          // the shared `_ownerless` bucket while the gate kept reading the
          // owner's own, perpetually-empty directory, so a create->attach->
          // fill->detach loop was unbounded. Matches the delete route's own
          // `ownerUserId: app.userId` (apps.ts).
          const result = await this.dbProvisioner!.backupAndDeleteAppDatabase(appName, {
            skipBackup,
            ownerUserId: state?.userId ?? null,
          });
          if (!result.databaseDropped) {
            // Full reason/dumpPath (may embed pg_dump stderr) — server log only.
            this.logger.warn(`detach: postgres backup/drop failed for '${appName}': ${result.reason ?? 'unknown'}`, 'SERVICES');
            outcome = {
              detached: false,
              reason: 'backup-failed',
              detail:
                'The database backup could not be completed, so nothing was dropped. The detach intent has been recorded — retry once the underlying issue is resolved.',
            };
          } else {
            outcome = {
              detached: true,
              deprovisioned: true,
              databaseDropped: result.databaseDropped,
              roleDropped: result.roleDropped,
              backup: {
                written: Boolean(result.dumpPath),
                file: result.dumpPath ? path.basename(result.dumpPath) : undefined,
              },
              manifestConflict: await getManifestConflict(),
            };
          }
        } else {
          const result = await this.redisProvisioner!.deprovisionAppRedis(appName);
          if (!result.removed && !result.hadAllocation) {
            // The allocation vanished between guard 5's isProvisioned check
            // and this call — a race, not a failure. The owner's intent is
            // already persisted and there is genuinely nothing left to
            // flush, so this is a SUCCESSFUL no-op detach, not a "retry once
            // Redis is healthy" refusal about a healthy Redis.
            outcome = { detached: true, deprovisioned: false, manifestConflict: await getManifestConflict() };
          } else if (!result.removed) {
            // A failed FLUSHDB is still a successful detach, not a refusal —
            // see `RedisProvisioner.deprovisionAppRedis`'s own doc for why
            // (the allocation is freed and the number tombstoned either
            // way). `flushed: false` is the honest signal the result
            // already carries; the tenant's keys sit in the tombstoned DB
            // until it is next flushed (provisionAppRedis's fail-hard
            // reflush).
            this.logger.warn(`detach: redis flush failed for '${appName}' — number tombstoned pending flush, allocation freed (detach succeeded)`, 'SERVICES');
            outcome = {
              detached: true,
              deprovisioned: true,
              flushed: false,
              manifestConflict: await getManifestConflict(),
            };
          } else {
            outcome = {
              detached: true,
              deprovisioned: true,
              flushed: result.flushed,
              manifestConflict: await getManifestConflict(),
            };
          }
        }
      } catch (err) {
        if (!deprovisionStarted) {
          this.logger.error(`detach: failed to stop '${appName}' before deprovisioning could run (${serviceId})`, 'SERVICES', err);
          outcome = {
            detached: false,
            reason: 'deprovision-failed',
            detail: `'${appName}' could not be safely stopped, so its ${serviceId === 'postgres' ? 'database' : 'Redis data'} was left untouched. The detach intent has been recorded — retry once the app can be stopped.`,
          };
        } else {
          this.logger.error(`detach: deprovision threw for '${appName}' (${serviceId})`, 'SERVICES', err);
          outcome = {
            detached: false,
            reason: serviceId === 'postgres' ? 'backup-failed' : 'deprovision-failed',
            detail:
              serviceId === 'postgres'
                ? 'The database backup could not be completed, so nothing was dropped. The detach intent has been recorded — retry once the underlying issue is resolved.'
                : 'The Redis data could not be flushed. The detach intent has been recorded — retry once Redis is healthy.',
          };
        }
      }
      const shouldRestart = wasLive || wasRunning;

      // 11. Restart iff `shouldRestart` — the one call site every branch
      // above (a stop failure, a deprovision failure/throw, or success)
      // funnels through.
      const restartOutcome = await this.restartAfterDetach(appName, shouldRestart);
      return { ...outcome, ...restartOutcome };
    } finally {
      this.appsInProgress.delete(appName);
    }
  }

  /**
   * True when drop.yaml still declares this service (`database:` for
   * postgres, `redis:` for redis) — informational only (guard 7): owner
   * intent always wins, this just lets the UI say so without a second round
   * trip. Fails soft to false on any parse error, matching
   * appDatabaseUrlSource/appRedisUrlSource's own posture.
   */
  private async detachManifestConflict(
    appPath: string,
    serviceId: AttachableServiceId
  ): Promise<boolean> {
    try {
      const dropYaml = await parseDropYaml(appPath);
      if (!dropYaml.success) return false;
      return serviceId === 'postgres' ? Boolean(dropYaml.config?.database) : Boolean(dropYaml.config?.redis);
    } catch {
      return false;
    }
  }

  /**
   * Step 11 of detachService: restart iff `shouldRestart` (`wasLive ||
   * wasRunning` at the call site — see step 9's doc comment), always via
   * `doRestart` — never a hand-rolled `runtime.start(spec)` (PM2 merges env
   * on a bare start over an existing process entry, so a removed
   * DATABASE_URL/REDIS_URL would keep being injected under isolation:none).
   * `doRestart` itself already parks the app in 'needs-config' or 'errored'
   * on failure — this only translates that outcome into the detach result
   * shape, it does not duplicate the state write.
   */
  private async restartAfterDetach(
    appName: string,
    shouldRestart: boolean
  ): Promise<DetachServiceRestartOutcome> {
    if (!shouldRestart) {
      return { restart: 'not-restarted' };
    }
    try {
      await this.doRestart(appName);
      return { restart: 'restarted' };
    } catch (error) {
      if (error instanceof AppNeedsConfigError) {
        return { restart: 'needs-config', missingSecrets: error.missingSecrets };
      }
      this.logger.error(`detach: restart failed for '${appName}' after a successful detach`, 'SERVICES', error);
      return { restart: 'failed' };
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
  private async teardownApp(
    name: string,
    opts: { keepData?: boolean; skipDatabaseBackup?: boolean } = {}
  ): Promise<void> {
    // Resolve the on-disk path BEFORE removing config/state — both are the
    // only places it's recorded, and both get deleted below.
    const appPath =
      this.appConfigService?.getConfig(name)?.path ??
      this.stateManager?.getApp(name)?.path ??
      path.join(this.config.appsDirectory, name);
    // Same source detachService's byte-budget gate and dump call both key
    // on: omitting it here attributed every group-child dump to the shared
    // `_ownerless` bucket regardless of the app's real owner — matches the
    // delete route's own `ownerUserId: app.userId` (apps.ts).
    const ownerUserId = this.stateManager?.getApp(name)?.userId;

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
        await this.dbProvisioner?.backupAndDeleteAppDatabase(name, {
          skipBackup: opts.skipDatabaseBackup === true,
          ownerUserId: ownerUserId ?? null,
        });
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

    // Deploy DETAILS are deliberately NOT purged here. They are retained for a
    // window instead (purgeAppArtifacts -> retainForApp), which is the whole
    // point of D4: a deploy that failed and was then torn down is exactly the
    // one a caller still wants to ask about. Hard-purging here would also run
    // BEFORE purgeAppArtifacts, so retention would find nothing left to copy.

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

    await this.purgeAppArtifacts(name, opts);
  }

  /**
   * Remove the name-keyed artifacts that live OUTSIDE the app folder.
   *
   * Deleting an app frees its name, and all three of these are addressed by
   * name, so leaving them behind hands the next registrant the previous
   * tenant's data:
   *  - `data/logs/webapps/<name>/` and `data/logs/builds/<name>/` —
   *    `/logs/:name` and `/logs/:name/build[s]` authorize against the LIVE app
   *    and then read by name (npm/pip output, `build_env` values, source
   *    fragments, app stdout/stderr).
   *  - `data/appdata/<name>/` — the app's `DROP_DATA_DIR`: SQLite files,
   *    uploads, cached credentials, read-write to whoever gets the name next.
   *
   * Logs go unconditionally: `keepData` protects the user's DATA (database,
   * Redis, and appdata), whereas logs are DROP-generated diagnostics about an
   * app that no longer exists.
   *
   * Shared with `DELETE /apps/:name` through the platform-ops seam — that
   * route runs its own inline teardown rather than calling `teardownApp`
   * (which only `removeGroup` uses), so a fix applied here alone would miss
   * essentially every real deletion. Best-effort; never throws.
   */
  async purgeAppArtifacts(name: string, opts: { keepData?: boolean } = {}): Promise<void> {
    // BEFORE the deletes below, not after. Deploy details hold byte offsets
    // into the very log files this is about to remove, and those paths are
    // keyed on the app NAME — which this teardown frees for anyone to
    // re-register. Copying each retained deploy's slice out first is what
    // stops a retained record later resolving to the NEXT tenant's output
    // (SEC-3). Hooked here rather than at the two delete call sites because
    // this method is the single funnel both of them go through.
    try {
      await getDeployDetailStore().retainForApp(name, opts);
    } catch (error) {
      // Never block a delete that is already happening.
      this.logger.warn(`Failed to retain deploy details for ${name}`, 'CLEANUP', error);
    }

    const targets = [
      path.join(this.config.dropRoot, 'data', 'logs', 'webapps', name),
      path.join(this.config.dropRoot, 'data', 'logs', 'builds', name),
      ...(opts.keepData ? [] : [path.join(this.config.dropRoot, 'data', 'appdata', name)]),
    ];
    for (const dir of targets) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch (error) {
        this.logger.warn(`Failed to remove ${dir}`, 'CLEANUP', error);
      }
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
    // The container's own state entry carries the group tag too (expandMonorepo
    // marks it) — it is torn down separately below, not as a child.
    const groupApps = this.stateManager?.getAllApps().filter((a) => a.group === groupName) ?? [];
    const children = groupApps.filter((a) => !a.isGroupContainer);
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

    // Tear down the container's own state entry (registered by the
    // deploy-from-git path, tagged by expandMonorepo). teardownApp also
    // removes the cloned repo folder via the entry's real path — which covers
    // the case where the folder name (repo name) differs from the group name
    // and the name-derived rm below would miss it.
    for (const container of groupApps.filter((a) => a.isGroupContainer)) {
      try {
        await this.teardownApp(container.name);
      } catch (err) {
        this.logger.error(
          `Failed to tear down container '${container.name}' of group '${groupName}'`,
          'MONOREPO',
          err
        );
      }
    }

    // The name-derived sweep, for an UNMARKED PHANTOM: a container folder left
    // by an older platform version with no state entry of its own. Every
    // container that HAS an entry was already removed above through its own
    // recorded path, and `teardownApp` deregisters state + config — so by this
    // point a legitimately torn-down container no longer holds its name.
    //
    // `groupName` is TENANT-AUTHORED (drop.yaml `group:`, validated only as a
    // non-empty string) and `<appsDirectory>/<groupName>` is exactly where every
    // other app lives. Deleting that path on the NAME alone let one tenant
    // declare another tenant's app as their group and have the folder recursively
    // removed — reachable with no interactive step at all from the ephemeral
    // reaper, which calls this on a timer.
    //
    // The character-class check is CONTAINMENT, never authorization: it proves
    // the path cannot escape the webapps directory and proves nothing about who
    // owns it. So refuse whenever the name still resolves to something
    // REGISTERED — that is someone's app. If it belonged to this group it was
    // torn down above via its own entry; if it did not, it is not ours to touch.
    // Fails CLOSED. If the registry cannot be consulted there is no way to tell
    // whose folder this is, and an unverifiable recursive delete of a path built
    // from a tenant string is precisely what this guard exists to prevent.
    const claimedByAnApp =
      !this.stateManager ||
      !this.appConfigService ||
      this.stateManager.hasApp(groupName) ||
      this.appConfigService.hasConfig(groupName);

    if (!/^[a-zA-Z0-9_-]+$/.test(groupName)) {
      this.logger.warn(
        `Refusing to remove container folder for group '${groupName}': unsafe name`,
        'MONOREPO'
      );
    } else if (claimedByAnApp) {
      this.logger.warn(
        `Refusing name-derived container-folder removal for group '${groupName}': ` +
          'a registered app holds that name',
        'MONOREPO'
      );
    } else {
      try {
        await fs.rm(path.join(this.config.appsDirectory, groupName), { recursive: true, force: true });
      } catch (err) {
        this.logger.warn(`Failed to remove group container folder for '${groupName}'`, 'MONOREPO', err);
      }
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
   * One bounded, single-shot probe of a boot-reconciliation SKIP candidate
   * (M1 review item 1, round-2 diff pass — CRITICAL). Deliberately NOT
   * awaitReadiness: that's a per-deploy 60s polling loop, and running it here
   * — serially per app, on the boot path — would reintroduce exactly the
   * blocking-startup problem item 9 exists to bound. This mirrors only
   * awaitReadiness's TAIL classification (a bound alone satisfies PM2, but
   * not Docker, whose userland proxy accepts connections before the
   * in-container app listens; an unbound port with no declared healthCheck
   * is the same "background worker" exemption), with no retry — the app is
   * already believed running, so one answer (or one silence) is the verdict.
   * Converts "the runtime says it's up" into "it answers": restartApp and
   * handleAppUpdate write status 'running' immediately after runtime.start()
   * with no readiness gate of their own, so a wedged app can otherwise carry
   * a matching signature straight through to a routing-only skip that never
   * actually checks it.
   */
  private async probeSkipReadiness(port: number, healthCheckPath: string | undefined): Promise<boolean> {
    const isDocker = this.config.isolation === 'docker';
    const bound = await probePort('127.0.0.1', port, 1000);
    if (bound) {
      const r = await probeHttp('127.0.0.1', port, healthCheckPath || '/', 3000);
      if (r.responded) return true;
      // Bound but no HTTP answer: PM2 accepts a bare bind (awaitReadiness's
      // own leniency for a slow-booting app); Docker's userland proxy
      // accepts connections before the in-container app listens, so a bind
      // alone proves nothing there — the HTTP answer is required.
      return !isDocker;
    }
    // Not bound: a declared healthCheck means this app is expected to serve
    // HTTP, so an unbound port is a real failure. No healthCheck at all is
    // awaitReadiness's own "background worker" exemption — never expected to
    // bind, so absence proves nothing.
    return !healthCheckPath;
  }

  /**
   * Arm the two watches that keep an already-running app supervised: the
   * health prober (PM2 mode only, and only when the app declares a
   * healthCheckPath — Docker uses its own HEALTHCHECK mechanism) and the
   * crash-loop watch (both modes, unconditional — see startCrashLoopWatch,
   * which re-baselines the restart count each time this is called, so a
   * fresh process/container always starts its crash-loop watch from zero).
   * Shared by every path that leaves an app running and must supervise it:
   * handleStartApp (a fresh deploy), handleAppUpdate (hot-reload),
   * restartApp, and reconcileAppsOnBoot's skip path (M1: an app left
   * running, unbuilt, across a restart) — a boot-skipped app is never
   * watched worse than a freshly deployed one, and neither a hot-reloaded
   * nor a restarted app is left with a prober but no crash-loop watch. A
   * skip (or any of these) with no crash-loop watch would silently stop
   * noticing a dead or crash-looping app for the rest of the process's life.
   */
  private armPostDeployWatches(appName: string, port: number, healthCheckPath: string | undefined): void {
    if (healthCheckPath && this.runtime?.type === 'pm2') {
      this.startHealthProber(appName, port, healthCheckPath);
    }
    this.startCrashLoopWatch(appName);
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
   *
   * SCOPE of the `{ ok: true, warning }` branch — narrower than it looks, and
   * the reason AppState.readinessUnverified does not catch every wrong-port
   * app. It is reachable only for:
   *   - docker + port bound + no HTTP answer, or
   *   - a declared `healthCheckPath` whose port never bound.
   * Under PM2 with no declared health check, an app listening on the WRONG
   * port hits the background-worker exemption above and resolves to a plain
   * `{ ok: true }` with no warning at all — so it is reported as verified.
   * Any test asserting wrong-port detection must therefore run in docker mode
   * or declare a healthCheck, or it asserts nothing.
   */
  private async awaitReadiness(
    appName: string,
    port: number,
    spec: AppStartSpec
  ): Promise<{
    ok: boolean;
    reason?: string;
    /**
     * DROP-generated category for the failure, alongside the human `reason`
     * string. Consumers must key on this, never parse `reason` — that text is
     * diagnostic and free to change.
     */
    failure?: DeployFailureReason;
    warning?: string;
  }> {
    if (!this.runtime) return { ok: true };
    const windowMs = this.readinessTimeoutMs;
    const isDocker = this.config.isolation === 'docker';
    const healthPath = spec.healthCheckPath || '/';
    const baselineRestarts = (await this.runtime.getStatus(appName))?.restarts ?? 0;
    const start = Date.now();

    /**
     * Whether the process died or restarted (crash-loop) since start, and
     * whether the runtime CONFIRMED an OOM kill.
     *
     * `oomKilled` rides on the `dead` branch only, and that is not an
     * oversight: DROP runs containers with `RestartPolicy: on-failure`, and
     * Docker clears `State.OOMKilled` on the new run — so a container that is
     * back up after an OOM reports `false`. The flag is therefore readable
     * exactly when the app has stopped for good, which is the `dead` case.
     * A crash-loop that happens to be OOM is reported as `crash-looped`,
     * because at that moment nothing can prove otherwise.
     */
    const liveness = async (): Promise<{ dead: boolean; crashed: boolean; oomKilled: boolean }> => {
      const info = await this.runtime?.getStatus(appName);
      if (!info || info.status === 'stopped' || info.status === 'errored') {
        return { dead: true, crashed: false, oomKilled: info?.oomKilled === true };
      }
      return { dead: false, crashed: info.restarts > baselineRestarts, oomKilled: false };
    };

    /** The configured ceiling, named in the reason so the app owner can act. */
    const limitText = spec.limits?.memory ? ` (memory limit ${spec.limits.memory})` : '';
    const oomVerdict = () => ({
      ok: false,
      reason: `killed for exceeding its memory limit${limitText}`,
      failure: 'oom-killed' as const,
    });

    // Poll: succeed as soon as an HTTP probe answers; fail as soon as the
    // process dies or crash-loops.
    while (Date.now() - start < windowMs) {
      const l = await liveness();
      if (l.dead) {
        if (l.oomKilled) return oomVerdict();
        return { ok: false, reason: 'process exited during startup', failure: 'process-exited' };
      }
      if (l.crashed)
        return {
          ok: false,
          reason: 'process crash-looped during startup',
          failure: 'crash-looped',
        };
      if (await probePort('127.0.0.1', port, 1000)) {
        const r = await probeHttp('127.0.0.1', port, healthPath, 3000);
        if (r.responded) return { ok: true };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(500, windowMs)));
    }

    // Window elapsed with no HTTP success — classify the (stable) process.
    const l = await liveness();
    if (l.dead) {
      if (l.oomKilled) return oomVerdict();
      return { ok: false, reason: 'process exited during startup', failure: 'process-exited' };
    }
    if (l.crashed)
      return { ok: false, reason: 'process crash-looped during startup', failure: 'crash-looped' };
    const bound = await probePort('127.0.0.1', port, 1000);
    if (!bound && !spec.healthCheckPath) return { ok: true }; // worker: no port, no health check
    if (bound && !isDocker) return { ok: true }; // PM2: a bind proves it's listening

    // Alive, never crash-looped, but it didn't answer HTTP in time. At the
    // deadline "still booting" and "hung" are indistinguishable, so this is a
    // choice about which way to be wrong. Failing here declared healthy apps
    // dead whenever they booted slower than the window (migrations, big
    // dependency graphs, connection warm-up) — the deploy reported failure
    // for an app that was seconds away from serving, and did so while the
    // process kept running. Being wrong the other way shows the app as
    // running and its URL answers late, which is self-evident and recovers on
    // its own. Only a process that died or crash-looped is a real failure,
    // and both return above, well before this point.
    return {
      ok: true,
      warning: `no HTTP response on :${port} within ${Math.round(windowMs / 1000)}s — treating as slow start`,
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
          // Docker clears OOMKilled on the next run, so this is true only on a
          // tick that catches the app down. When it does, say so — "restarting
          // repeatedly" sends an operator looking for a crash bug, and raising
          // the memory limit is a different fix entirely.
          const oom = info.oomKilled === true;
          this.logger.appEvent(
            'error',
            appName,
            oom
              ? `crash-looping — killed for exceeding its memory limit ` +
                  `(${info.restarts - baseline} restarts since deploy)`
              : `crash-looping (${info.restarts - baseline} restarts since deploy)`
          );
          await this.stateManager?.setAppStatus(appName, 'crash-looping', {
            error: oom
              ? 'Killed for exceeding its memory limit'
              : 'Process is restarting repeatedly',
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

  /**
   * Periodic per-app disk accounting (Step 8c).
   *
   * Its own timer rather than riding the log-retention sweep: that one runs
   * DAILY, and a day of unchecked growth is most of a disk. Hourly bounds the
   * overshoot to what an app can write in an hour.
   */
  private startDiskCeilingSweep(): void {
    if (this.diskSweepTimer) return;
    if (configuredCeilingBytes() <= 0) {
      this.logger.debug('Disk ceiling disabled (DROP_MAX_APP_DISK_MB=0)', 'DISK');
      return;
    }
    void this.sweepDiskCeiling();
    this.diskSweepTimer = setInterval(() => void this.sweepDiskCeiling(), DISK_SWEEP_INTERVAL_MS);
    this.diskSweepTimer.unref?.();
  }

  /**
   * Measure every app and park the ones over their ceiling.
   *
   * PARK = stop + an explicit reason, never a delete. The whole point is to
   * stop growth while leaving the evidence — and the data — in place for an
   * operator to look at. A ceiling that deleted would turn a misconfigured
   * limit into data loss.
   */
  private async sweepDiskCeiling(): Promise<void> {
    if (!this.stateManager || !this.runtime) return;
    try {
      const apps = this.stateManager.getAllApps().filter((a) => !a.isGroupContainer);
      const targets = apps.map((app) => ({
        name: app.name,
        // Both trees the app can grow: its own source/build output, and its
        // persistent data dir. Logs are excluded — those are DROP-generated and
        // already bounded by log retention, and charging an app for DROP's own
        // diagnostics would park apps for being verbose.
        paths: [
          app.path,
          path.join(this.config.dropRoot, 'data', 'appdata', app.name),
        ],
        maxDiskMb: this.appConfigService?.getConfig(app.name)?.maxDiskMb,
      }));

      const over = await findOverCeiling(targets);
      for (const verdict of over) {
        const app = this.stateManager.getApp(verdict.name);
        // Only a LIVE app is worth stopping. Parking something already stopped
        // would rewrite its reason on every sweep and bury the real one.
        if (!app || (app.status !== 'running' && app.status !== 'crash-looping')) continue;

        const reason =
          `Over its disk ceiling: ${toMb(verdict.bytes)} MB used of ` +
          `${toMb(verdict.ceilingBytes)} MB allowed` +
          (verdict.truncated ? ' (measured tree was truncated, so usage is at least this)' : '');
        this.logger.warn(`Parking ${verdict.name} — ${reason}`, 'DISK');

        this.stopHealthProber(verdict.name);
        this.stopCrashLoopWatch(verdict.name);
        try {
          await this.runtime.stop(verdict.name);
        } catch {
          // Already down, or the runtime is unhappy. Record the park anyway —
          // the operator still needs to know why, and a stop that failed is not
          // a reason to leave the reason unwritten.
        }
        await this.stateManager.setAppStatus(verdict.name, 'stopped', { parkedReason: reason });
        await tryLogActivity({
          action: 'disk-park',
          appName: verdict.name,
          userId: app.userId,
          detail: reason,
        });
      }
    } catch (err) {
      this.logger.debug(
        `Disk ceiling sweep failed: ${err instanceof Error ? err.message : 'unknown'}`,
        'DISK'
      );
    }
  }

  /**
   * Hold a finished build when the app is set to manual promotion.
   *
   * Returns true when the caller must NOT start or swap. The running version is
   * left exactly as it is — see managers/guardrail/promotion.ts for why the
   * hold is here rather than at a port swap.
   */
  private async holdForPromotion(
    appName: string,
    outputPath?: string,
    deployId?: string
  ): Promise<boolean> {
    const mode: PromotionMode = promotionModeFor(
      this.appConfigService?.getConfig(appName)?.promotion
    );
    if (!shouldHoldForPromotion(mode)) return false;

    const pending = {
      deployId,
      builtAt: new Date().toISOString(),
      outputDirectory: outputPath,
    };
    await this.appConfigService?.updateConfig(appName, { pendingPromotion: pending });

    const app = this.stateManager?.getApp(appName);
    // Status is left ALONE on purpose. A running app keeps `running` because
    // the old version really is still serving; a new app keeps whatever it had
    // because nothing has ever served. Overwriting it would make the flag lie
    // about what is running.
    await this.stateManager?.updateApp(appName, { awaitingPromotion: true });

    this.logger.info(
      `Build for ${appName} is held awaiting promotion (POST /api/v1/apps/${appName}/promote)`,
      'PROMOTE'
    );
    await tryLogActivity({
      action: 'promotion-held',
      appName,
      userId: app?.userId,
      detail: `Build held; promotion is manual`,
    });
    return true;
  }

  /**
   * Put a held build in front of traffic. Owner/admin only — see the route.
   *
   * Starts exactly what was built rather than rebuilding: a rebuild could pick
   * up source that changed since the operator looked, which would promote
   * something nobody approved.
   */
  async promoteApp(appName: string): Promise<void> {
    const config = this.appConfigService?.getConfig(appName);
    const pending = config?.pendingPromotion;
    if (!pending) {
      throw new Error(`No build is awaiting promotion for '${appName}'`);
    }

    await this.appConfigService?.updateConfig(appName, { pendingPromotion: undefined });
    await this.stateManager?.updateApp(appName, { awaitingPromotion: false });

    const app = this.stateManager?.getApp(appName);
    await tryLogActivity({
      action: 'promote',
      appName,
      userId: app?.userId,
      detail: `Promoted build from ${pending.builtAt}`,
    });

    // The swap itself is the ordinary start path, so promotion has no second
    // implementation of starting an app to drift from the first.
    this.appsInProgress.add(appName);
    try {
      await this.handleStartApp(appName, pending.outputDirectory);
    } finally {
      this.appsInProgress.delete(appName);
    }
  }

  /**
   * Idle reaper (Step 9). Sweeps every 15 minutes so a CPU delta reflects a
   * useful slice of time — an hourly sample would miss short bursts of work
   * and a one-minute sample is mostly noise.
   */
  private startIdleReaper(): void {
    if (this.idleSweepTimer) return;
    // NOT gated on idleWindowMs: disabling idle reaping must not also disable
    // ephemeral expiry, which is a deadline the caller explicitly asked for.
    // planIdleSweep itself no-ops when the window is 0.
    if (idleWindowMs() <= 0) {
      this.logger.debug('Idle reaping disabled; ephemeral expiry still runs', 'REAP');
    }
    this.idleSweepTimer = setInterval(() => {
      void this.sweepExpiredEphemerals().then(() => this.sweepIdleApps());
    }, 15 * 60 * 1000);
    this.idleSweepTimer.unref?.();
  }

  /**
   * Reap agent-created apps that are demonstrably doing nothing.
   *
   * This DELETES, database included, so for each app the first
   * `DROP_IDLE_REAP_DRY_RUNS` sweeps that would have reaped IT only log what
   * they would have done. A signal that is subtly wrong should surface as
   * would-have-reaped lines, not as a fleet that is gone.
   */
  private async sweepIdleApps(): Promise<void> {
    if (!this.stateManager || !this.runtime) return;
    try {
      const apps = this.stateManager.getAllApps().filter((a) => !a.isGroupContainer);
      const candidates = [];
      for (const app of apps) {
        const info = await this.runtime.getStatus(app.name).catch(() => null);
        const config = this.appConfigService?.getConfig(app.name);
        candidates.push({
          name: app.name,
          agentCreated: config?.agentCreated,
          noReap: config?.noReap,
          createdAt: app.createdAt,
          cpuTotalNs: info?.cpuTotalNs,
          status: app.status,
        });
      }

      const { reap, abortReason } = planIdleSweep(candidates, this.idleState, Date.now());
      if (abortReason) {
        this.logger.debug(`Idle sweep took no action: ${abortReason}`, 'REAP');
        return;
      }

      if (reap.length === 0) {
        // Distinguishable from a dead timer when someone asks "is the reaper
        // alive?" — which matters, because a healthy sweep reaps nothing the
        // overwhelming majority of the time.
        this.logger.debug('Idle sweep: no candidates', 'REAP');
        return;
      }

      // The budget is PER APP, and counts only the sweeps in which that app was
      // actually a reap candidate.
      //
      // Two defects are being avoided here. A budget counted per SWEEP was
      // spent on no-ops: nothing is reapable until the platform has been up for
      // a full idle window (the first sweep after a restart re-baselines
      // lastActive to now) while sweeps run every 15 minutes, so it was gone
      // ~93 sweeps before the first candidate could exist. A budget counted
      // once per PROCESS is spent by the first app that legitimately qualifies,
      // leaving nothing for the app reaped months later on a signal that has
      // since broken — the case the guard was written for. Per app, per
      // candidate sweep, every deletion is preceded by exactly N logged
      // would-reap lines, forever.
      for (const name of reap) {
        const seen = (this.idleDryRuns.get(name) ?? 0) + 1;
        if (seen <= dryRunSweeps()) {
          this.idleDryRuns.set(name, seen);
          this.logger.info(
            `[dry run ${seen}/${dryRunSweeps()}] would reap idle app '${name}'`,
            'REAP'
          );
          // Also recorded durably: a log line nobody was tailing at 3am is not
          // the operator warning this guard is supposed to be.
          await tryLogActivity({
            action: 'idle-reap-dryrun',
            appName: name,
            userId: this.stateManager.getApp(name)?.userId,
            detail: `Idle beyond the reap window (dry run ${seen}/${dryRunSweeps()})`,
          });
          continue;
        }
        const app = this.stateManager.getApp(name);
        this.logger.info(`Reaping idle agent-created app '${name}'`, 'REAP');
        await tryLogActivity({
          action: 'idle-reap',
          appName: name,
          userId: app?.userId,
          detail: 'Idle beyond the reap window',
        });
        // The existing teardown, not a second one — it is the only path that
        // knows about routes, the database, secrets and deploy history.
        await this.teardownApp(name).catch((err) => {
          this.logger.warn(
            `Idle reap of '${name}' failed: ${err instanceof Error ? err.message : 'unknown'}`,
            'REAP'
          );
        });
        // Forget it, or a name reused later inherits this app's history —
        // including its spent dry-run budget, which would let a NEW app of the
        // same name be deleted with no warning at all.
        this.idleState.lastCpu.delete(name);
        this.idleState.lastActive.delete(name);
        this.idleDryRuns.delete(name);
      }
    } catch (err) {
      this.logger.debug(
        `Idle sweep failed: ${err instanceof Error ? err.message : 'unknown'}`,
        'REAP'
      );
    }
  }

  /**
   * Reap ephemerals whose lifetime has run out (Step 10).
   *
   * Runs on the idle sweep's timer rather than its own: both tear apps down,
   * and two timers racing to delete the same app is a needless hazard.
   *
   * Deliberately NOT subject to the idle reaper's liveness precondition. That
   * exists because idleness is INFERRED and a broken signal looks like a dead
   * fleet; an expiry is a recorded deadline the caller asked for, so there is
   * no inference to get wrong.
   */
  private async sweepExpiredEphemerals(): Promise<void> {
    if (!this.appConfigService) return;
    const now = Date.now();
    try {
      const expired = this.appConfigService
        .getAllConfigs()
        .filter((c) => c.ephemeral === true && isExpired({ expiresAt: c.expiresAt }, now));

      for (const config of expired) {
        const app = this.stateManager?.getApp(config.name);
        this.logger.info(`Reaping expired ephemeral app '${config.name}'`, 'REAP');
        await tryLogActivity({
          action: 'ephemeral-reap',
          appName: config.name,
          userId: app?.userId,
          detail: `Expired at ${config.expiresAt}`,
        });
        // A monorepo container is not a single app. Only the CONTAINER carries
        // the ephemeral flag (it is the app that was deployed; the children are
        // synthesized later by expandMonorepo), so tearing down just the
        // container would leave every child service running and routed, with
        // nothing left that any sweep could ever collect them by. removeGroup
        // is the existing group-aware path — children first, then the
        // container, then the container folder. The sibling sweeps sidestep
        // this by excluding containers outright; an expiry is a deadline the
        // caller asked for, so the group goes instead of nothing going.
        //
        // removeGroup takes no skipDatabaseBackup, so a group's children keep
        // their dump. That errs toward keeping data on the rarer path.
        // The group cascade only when the WHOLE group is this owner's.
        //
        // `group` is tenant-authored, and removeGroup destroys every app
        // carrying that tag. Without this check a tenant could name another
        // tenant's group in their own throwaway app's drop.yaml and have the
        // reaper tear down that group's children and databases. An automatic,
        // timer-driven destructive path must be gated at least as tightly as
        // the interactive one — DELETE /apps/:name checks ownership across
        // every entry it would destroy, and this had no check at all.
        const groupEntries =
          app?.isGroupContainer && app.group
            ? (this.stateManager?.getAllApps().filter(a => a.group === app.group) ?? [])
            : [];
        const wholeGroupIsOwnedByThisApp =
          groupEntries.length > 0 && groupEntries.every(a => a.userId === app?.userId);

        if (app?.isGroupContainer && app.group && !wholeGroupIsOwnedByThisApp) {
          this.logger.warn(
            `Ephemeral '${config.name}' is tagged group '${app.group}' whose members are not all ` +
              'its owner\'s; reaping only this app.',
            'REAP'
          );
        }

        const reap =
          app?.isGroupContainer && app.group && wholeGroupIsOwnedByThisApp
            ? this.removeGroup(app.group).then(() => undefined)
            : // skipDatabaseBackup: an ephemeral's data is throwaway by
              // construction, and dumping it on the way out would fill the box
              // with backups of scratch databases nobody will ever read.
              this.teardownApp(config.name, { skipDatabaseBackup: true });
        await reap.catch((err) => {
          this.logger.warn(
            `Ephemeral reap of '${config.name}' failed: ${err instanceof Error ? err.message : 'unknown'}`,
            'REAP'
          );
        });
        this.idleState.lastCpu.delete(config.name);
        this.idleState.lastActive.delete(config.name);
        this.idleDryRuns.delete(config.name);
      }
    } catch (err) {
      this.logger.debug(
        `Ephemeral sweep failed: ${err instanceof Error ? err.message : 'unknown'}`,
        'REAP'
      );
    }
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

    // Secret preflight — generation (PRD-051). Auto-fill any declared
    // `generate` secret that isn't set yet, BEFORE reading the secret env below
    // so the generated value is injected. Names (never values) are logged.
    if (this.config.enableSecretPreflight && this.secretManager) {
      const declaredSecrets = dropYamlCfg.success ? dropYamlCfg.config?.secrets : undefined;
      if (declaredSecrets) {
        // "Already provided" for generation = secrets set to a NON-EMPTY value.
        // Presence alone (list()) is not enough: a `generate` secret that exists
        // with an empty-string value must be (re)generated, never accepted — it
        // would otherwise boot the app with an empty signing/session key.
        const setSecrets = this.secretManager.hasSecrets(appName)
          ? this.secretManager.getAll(appName)
          : {};
        const nonEmptyKeys = Object.entries(setSecrets)
          .filter(([, value]) => value.length > 0)
          .map(([key]) => key);
        const { toGenerate } = planSecretPreflight(declaredSecrets, nonEmptyKeys);
        for (const decl of toGenerate) {
          await this.secretManager.set(appName, decl.name, generateSecretValue(decl.generate));
        }
        if (toGenerate.length > 0) {
          this.logger.info(
            `Generated ${toGenerate.length} declared secret(s): ${toGenerate.map(d => d.name).join(', ')}`,
            'SECURITY'
          );
        }
      }
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
    // DROP-072 follow-up (security review item 2): gated on the app actually
    // HAVING a database (dbEnvVars carries a DATABASE_URL), not merely on
    // isolation mode — without this, every docker container (a static site,
    // a Go binary, anything with no DB at all) got a direct bind-mounted
    // channel to the bundled Postgres and could attempt to authenticate as
    // any role, the same least-privilege gap this ticket set out to close,
    // one layer up. This also makes the runtimeSpecFingerprint (below,
    // recordDeploySignature/decideOneAppOnBoot) correctly diverge per-app:
    // non-DB docker apps stop being force-redeployed by a socket-dir change.
    const pgSocketDir =
      this.config.isolation === 'docker' && dbEnvVars['DATABASE_URL']
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
    // key minted and rotated on every start. Ungranted apps get no
    // DROP_API_KEY at all. Minting is best-effort: if auth isn't initialized
    // (e.g. DROP_DISABLE_AUTH), skip rather than fail the deploy.
    const grantedScopes = this.appConfigService?.getConfig(appName)?.grantedApiScopes ?? [];
    // M1 review item 8 (round-2 diff pass): delete the previous key
    // UNCONDITIONALLY, before the grant check — not just when re-minting.
    // Revoking a capability (PUT .../capabilities with an empty scope list)
    // must actually invalidate the old key; with the delete nested inside
    // `if (grantedScopes.length > 0)` a revocation to `[]` never reached this
    // branch at all, so the previous key stayed valid indefinitely — and the
    // app is skip-eligible on top of that (grantedApiScopesCount is now 0).
    try {
      await deleteApiKeysByName(`app:${appName}:provision`);
    } catch (err) {
      this.logger.warn(`Could not delete previous provisioning key for ${appName}`, 'SECURITY', err);
    }
    let dropApiKey: string | undefined;
    if (grantedScopes.length > 0) {
      try {
        const { key } = await createApiKey(`app:${appName}:provision`, 'none', undefined, grantedScopes);
        dropApiKey = key;
      } catch (err) {
        this.logger.warn(`Could not mint provisioning key for ${appName}`, 'SECURITY', err);
      }
    }

    // Everything that is NOT tenant-authored free text: the app's own secrets
    // plus every value DROP derives for it. Assembled as one object so the
    // `depends_on` filter below has something concrete to compare against.
    const platformEnv: Record<string, string> = {
      ...secretEnvVars,
      NODE_ENV: 'production',
      PORT: port.toString(),
      DROP_DATA_DIR: dataDir,
      DROP_API_URL: dropApiUrl,
      ...(dropApiKey ? { DROP_API_KEY: dropApiKey } : {}),
      ...dbEnvVars,
      ...redisEnvVars,
    };

    // DROP-150 / B1: resolved `depends_on` URLs used to be spread LAST, so
    // whatever name a manifest chose silently won. A reserved-NAME list cannot
    // make that safe, because the hijackable set includes every owner-set
    // secret and those names are unbounded: on the deploy_from_git path (where
    // the manifest author is not the app owner) `depends_on: [{name: <any
    // registered app>, env: SESSION_SECRET}]` replaced the owner's encrypted
    // secret with a fully predictable `http://<dep>` URL.
    //
    // So refuse POSITIONALLY instead — a dependency may fill a gap, never
    // overwrite something already assembled. That is complete by construction:
    // a provisioner variable added later (REDIS_DB, a future DB_SSLMODE) is
    // covered the day it appears, with no list to keep in sync.
    //
    // This also keeps the required-secret gate below honest. `providedKeys` is
    // read from the MERGED env, so a dependency overwriting a declared secret
    // used to satisfy the preflight with an attacker-chosen value — the app
    // booted with a known signing key instead of parking in `needs-config`.
    //
    // Skip-and-warn, never throw: one collision must not fail a deploy that is
    // otherwise valid.
    const safeDepEnvVars: Record<string, string> = {};
    for (const [key, value] of Object.entries(depEnvVars)) {
      if (key in platformEnv) {
        this.logger.warn(
          `${appName}: depends_on claims '${key}', which DROP already sets for this app — ` +
            `refusing to override it`,
          'DEPS'
        );
        continue;
      }
      safeDepEnvVars[key] = value;
    }

    // Static/SPA apps get the dependency URLs written into a browser-served
    // config file. It gets the FILTERED set, so what the browser reads matches
    // what the app actually runs with.
    if (
      (detection.type === 'static' || detection.type === 'spa') &&
      Object.keys(safeDepEnvVars).length > 0
    ) {
      await this.generateStaticConfig(appPath, safeDepEnvVars);
    }

    const env: Record<string, string> = {
      // drop.yaml `env` (tenant config) is the base layer — now injected at
      // START as well as build, so `env:` is honored end-to-end. Placed
      // FIRST so secrets and every platform-authoritative var (PORT,
      // DROP_DATA_DIR, DROP_API_URL/KEY, DATABASE_URL) still override it and
      // a tenant cannot hijack them. `build_env` is intentionally NOT
      // injected here — it is build-only by design.
      //
      // `dropYaml.env` is deliberately outside `platformEnv`, so a dependency
      // still overrides it — that precedence predates this change and is the
      // point of `depends_on` (a build must see the current dependency URL,
      // not a stale default baked into `env:`).
      ...this.coerceEnvRecord(dropYamlCfg.success ? dropYamlCfg.config?.env : undefined),
      ...platformEnv,
      ...safeDepEnvVars,
    };

    // Secret preflight — gate (PRD-051). A declared-required secret that is
    // neither auto-generated above nor present (non-empty) in the assembled
    // env — after set secrets, drop.yaml `env`, and every platform-injected
    // var (DATABASE_URL, REDIS_URL, depends_on URLs, ...) — parks the app in
    // `needs-config`. Throwing here (caught by the start/restart path) prevents
    // the process from ever starting, so a missing secret becomes an actionable
    // state instead of a runtime crash-loop.
    if (this.config.enableSecretPreflight) {
      const declaredSecrets = dropYamlCfg.success ? dropYamlCfg.config?.secrets : undefined;
      const providedKeys = Object.entries(env)
        .filter(([, value]) => value.length > 0)
        .map(([key]) => key);
      const { missing } = planSecretPreflight(declaredSecrets, providedKeys);
      if (missing.length > 0) {
        throw new AppNeedsConfigError(appName, missing.map(m => m.name));
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
      env,
    };
  }

  /**
   * Record where this deploy's runtime output begins, immediately before the
   * process starts.
   *
   * The one part of deploy-detail capture that cannot be a bus subscriber: it
   * reads file sizes that `runtime.start()` is about to change, so it has to
   * run inline, at every start site. Runtime logs are per-app and per-DAY, so
   * the path alone cannot identify one deploy's output — the offset is what
   * separates this deploy's lines from the previous one's.
   *
   * Best-effort and never throws: this is observability, and it sits directly
   * in front of the start it must not be able to break.
   */
  private async noteRuntimeLogStart(appName: string): Promise<void> {
    try {
      const { outFile, errorFile } = await this.getAppLogPaths(appName);
      const sizeOf = async (file: string): Promise<number> => {
        try {
          return (await fs.stat(file)).size;
        } catch {
          // Not created yet — this deploy's output starts at byte 0.
          return 0;
        }
      };
      const [outStartOffset, errStartOffset] = await Promise.all([
        sizeOf(outFile),
        sizeOf(errorFile),
      ]);
      getDeployDetailStore().noteRuntimeLog(appName, {
        outFile,
        errFile: errorFile,
        outStartOffset,
        errStartOffset,
      });
    } catch {
      // Store not initialised (isolated tests), or the log dir is unreadable.
      // A missing offset costs a log tail, never a deploy.
    }
  }

  /**
   * Record where this deploy's runtime output ENDS. Mirror of
   * noteRuntimeLogStart, called on the failure path — the only path that
   * produces a retained record. Best-effort; a missing end just means the
   * copy falls back to its byte cap.
   */
  private async noteRuntimeLogEnd(appName: string): Promise<void> {
    try {
      const { outFile, errorFile } = await this.getAppLogPaths(appName);
      const sizeOf = async (file: string): Promise<number> => {
        try {
          return (await fs.stat(file)).size;
        } catch {
          return 0;
        }
      };
      const [outEndOffset, errEndOffset] = await Promise.all([
        sizeOf(outFile),
        sizeOf(errorFile),
      ]);
      getDeployDetailStore().noteRuntimeLogEnd(appName, { outEndOffset, errEndOffset });
    } catch {
      // Store not initialised, or the log dir is unreadable.
    }
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
  /**
   * Honour a `port:` declared in the app's own drop.yaml, as a PREFERENCE.
   *
   * The field has always been accepted and validated by the parser and then
   * silently ignored — it never reached this allocator, so an operator who
   * declared one got an arbitrary port anyway. That matters wherever something
   * outside DROP hardcodes the port (the apex Caddy host file being the case
   * that prompted this): a remembered port is stable in practice, but a
   * declared one is stable by construction.
   *
   * Deliberately a preference, not a claim. drop.yaml is tenant-authored, and
   * on the deploy_from_git path it is attacker-authored, so a hard claim would
   * let a tenant contend for the control plane's own port or evict another
   * app. Anything unavailable or out of bounds falls through to normal
   * allocation with a warning rather than failing the deploy.
   */
  private preferredPortFor(appName: string, declared: number | undefined): number | undefined {
    if (!declared) return undefined;

    // The control plane's own port is never available, whatever the range says.
    if (declared === this.config.apiPort) {
      this.logger.warn(
        `Ignoring declared port ${declared} for ${appName}: it is the DROP API port`,
        'PORT'
      );
      return undefined;
    }
    if (declared < this.config.portRangeStart || declared > this.config.portRangeEnd) {
      this.logger.warn(
        `Ignoring declared port ${declared} for ${appName}: outside the configured range ` +
          `${this.config.portRangeStart}-${this.config.portRangeEnd}`,
        'PORT'
      );
      return undefined;
    }
    const owner = this.usedPorts.get(declared);
    if (owner && owner !== appName) {
      this.logger.warn(
        `Ignoring declared port ${declared} for ${appName}: already used by ${owner}`,
        'PORT'
      );
      return undefined;
    }
    return declared;
  }

  private allocatePort(appName?: string, declaredPort?: number): number {
    // A port the app declared in its own drop.yaml wins over a previously
    // auto-allocated one — otherwise adding `port:` to an existing app would
    // never take effect, since the persisted port below always matched first.
    // Passed in rather than read from AppConfig: the declaration must apply on
    // the SAME deploy that introduces it, and updateConfig silently no-ops
    // before an app's config exists, so a persist-then-read round trip would
    // lag by one deploy and do nothing at all on the first.
    if (appName) {
      const preferred = this.preferredPortFor(appName, declaredPort);
      if (preferred !== undefined) {
        this.logger.debug(`Using declared port ${preferred} for ${appName}`, 'PORT');
        this.usedPorts.set(preferred, appName);
        return preferred;
      }
    }

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
