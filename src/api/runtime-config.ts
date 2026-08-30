/**
 * API runtime configuration.
 *
 * The platform populates this when it constructs the API server so route
 * handlers (which are imported as singletons and don't receive config) can
 * reach authoritative values like the webapps directory. Falls back to the
 * same env/defaults the platform uses when not explicitly set.
 */

import * as path from 'path';

const isWindows = process.platform === 'win32';
const DEFAULT_DROP_ROOT = isWindows ? 'C:\\drop' : '/var/drop';
const DEFAULT_APPS_DIR = isWindows ? 'C:\\drop\\data\\webapps' : '/var/drop/data/webapps';
/** Default compressed-archive upload cap (MB), matching PlatformConfig.maxUploadSizeMb's default. */
const DEFAULT_MAX_UPLOAD_SIZE_MB = 100;

interface ApiRuntimeConfig {
  appsDirectory?: string;
  enableHttps?: boolean;
  domainSuffix?: string;
  /** Directory for ephemeral build/upload staging (outside the watched webapps tree). */
  tempDirectory?: string;
  /** Cap on the compressed (as-uploaded) archive size, in MB. */
  maxUploadSizeMb?: number;
  /** Public base URL of the API (e.g. "https://drop.example.com"), used as the OAuth issuer. */
  publicUrl?: string;
  /** Per-user Postgres database cap, mirroring PlatformConfig.maxDbsPerUser. */
  maxDbsPerUser?: number;
  /** Per-user managed-Redis cap, mirroring PlatformConfig.maxRedisPerUser. */
  maxRedisPerUser?: number;
  /**
   * The DROP-152 access gate's operator kill switch (`PlatformConfig.enableAccessGate`,
   * `DROP_FEATURE_ACCESS_GATE` env, boot-time). Read by the access-gate route
   * and by platform.ts's sweep/emission paths so the flag actually withdraws
   * enforcement rather than only changing what the API reports.
   */
  accessGateEnabled?: boolean;
  /**
   * Tenant isolation mode (`PlatformConfig.isolation`, `DROP_ISOLATION` env /
   * `--isolation` flag). Already passed to `ApiServer`; snapshotted here so
   * `GET /admin/settings` can REPORT it.
   *
   * Boot-time, like `accessGateEnabled` and for a stronger reason: the platform
   * picks its `AppRuntime` implementation exactly once
   * (`getAppRuntime(isolation === 'docker' ? 'docker' : 'pm2')`) and
   * `getAppRuntime()` throws if a different type is later requested. There is
   * no runtime setter here, and there must not be one — a settings-backed
   * "switch" would report a mode the running platform is not in, which is worse
   * than not offering the switch at all.
   */
  isolation?: 'none' | 'docker';
}

const runtimeConfig: ApiRuntimeConfig = {};

export function setApiRuntimeConfig(config: ApiRuntimeConfig): void {
  if (config.appsDirectory) runtimeConfig.appsDirectory = config.appsDirectory;
  if (config.enableHttps !== undefined) runtimeConfig.enableHttps = config.enableHttps;
  if (config.domainSuffix !== undefined) runtimeConfig.domainSuffix = config.domainSuffix;
  if (config.tempDirectory) runtimeConfig.tempDirectory = config.tempDirectory;
  if (config.maxUploadSizeMb !== undefined) runtimeConfig.maxUploadSizeMb = config.maxUploadSizeMb;
  if (config.publicUrl !== undefined) runtimeConfig.publicUrl = config.publicUrl;
  if (config.maxDbsPerUser !== undefined) runtimeConfig.maxDbsPerUser = config.maxDbsPerUser;
  if (config.maxRedisPerUser !== undefined) runtimeConfig.maxRedisPerUser = config.maxRedisPerUser;
  if (config.accessGateEnabled !== undefined) runtimeConfig.accessGateEnabled = config.accessGateEnabled;
  if (config.isolation !== undefined) runtimeConfig.isolation = config.isolation;
}

/** Resolved webapps directory: explicit config > DROP_APPS_DIR env > platform default. */
export function getAppsDirectory(): string {
  return runtimeConfig.appsDirectory || process.env.DROP_APPS_DIR || DEFAULT_APPS_DIR;
}

/**
 * Resolved temp/staging directory: explicit config > DROP_ROOT env (+ data/temp)
 * > platform default. Mirrors `platform.ts`'s `getBuildWorkDir` root — outside
 * the watched webapps tree, so the watcher never sees staged upload archives.
 */
export function getTempDirectory(): string {
  if (runtimeConfig.tempDirectory) return runtimeConfig.tempDirectory;
  const dropRoot = process.env.DROP_ROOT || DEFAULT_DROP_ROOT;
  return path.join(dropRoot, 'data', 'temp');
}

/**
 * Resolved cap on the compressed (as-uploaded) archive size, in bytes:
 * explicit config > DROP_MAX_UPLOAD_SIZE_MB env > default (100 MB). This is
 * the route's own streamed byte cap (413) — distinct from
 * UploadDeployService's maxUncompressedBytes, which bounds the *decompressed*
 * size instead.
 */
export function getUploadMaxBytes(): number {
  const envMb = process.env.DROP_MAX_UPLOAD_SIZE_MB
    ? parseInt(process.env.DROP_MAX_UPLOAD_SIZE_MB, 10)
    : undefined;
  const mb = runtimeConfig.maxUploadSizeMb ?? envMb ?? DEFAULT_MAX_UPLOAD_SIZE_MB;
  return mb * 1024 * 1024;
}

/** Whether HTTPS is enabled for app routes. */
export function isHttpsEnabled(): boolean {
  if (runtimeConfig.enableHttps !== undefined) return runtimeConfig.enableHttps;
  return process.env.DROP_ENABLE_HTTPS === 'true';
}

/** Active domain suffix (e.g. "example.com" → apps get "appname.example.com"). */
export function getDomainSuffix(): string {
  return runtimeConfig.domainSuffix || process.env.DROP_DOMAIN_SUFFIX || 'localhost';
}

/**
 * Public base URL of the DROP API (e.g. "https://drop.example.com"), used as
 * the OAuth issuer/resource base. Explicit config > DROP_PUBLIC_URL env.
 *
 * Deliberately **fail-closed**: unlike `getDomainSuffix()` (which defaults to
 * "localhost"), this returns `undefined` when unset so callers can refuse to
 * serve OAuth endpoints rather than derive an issuer from a spoofable `Host`
 * header or the apps' wildcard domain suffix.
 */
export function getPublicUrl(): string | undefined {
  const raw = runtimeConfig.publicUrl || process.env.DROP_PUBLIC_URL;
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, '');
}

/**
 * Live-update the public URL override (or, with `undefined`, clear it so
 * `getPublicUrl()` falls back to the DROP_PUBLIC_URL env var). Used by the
 * admin settings route so a change takes effect immediately, without a
 * restart — separate from `setApiRuntimeConfig`, which only ever sets
 * fields when explicitly provided and can't express "clear this field".
 */
export function setPublicUrl(url: string | undefined): void {
  runtimeConfig.publicUrl = url;
}

/**
 * Per-user Postgres database cap: explicit config > DROP_MAX_DBS_PER_USER env
 * > default (3) — the same precedence `PlatformConfig.maxDbsPerUser` resolves
 * with. Read by GET /db/:name (DROP-151 Phase 2) to report quota state
 * alongside the enforcement path (`DropPlatform.checkDbQuota`), which lives on
 * the platform and is not reachable from a route file. Kept here rather than a
 * hardcoded env read in the route so the two never see different defaults.
 */
export function getMaxDbsPerUser(): number {
  if (runtimeConfig.maxDbsPerUser !== undefined) return runtimeConfig.maxDbsPerUser;
  return parseInt(process.env.DROP_MAX_DBS_PER_USER || '3', 10);
}

/** Per-user managed-Redis cap — mirrors getMaxDbsPerUser() above. */
export function getMaxRedisPerUser(): number {
  if (runtimeConfig.maxRedisPerUser !== undefined) return runtimeConfig.maxRedisPerUser;
  return parseInt(process.env.DROP_MAX_REDIS_PER_USER || '3', 10);
}

/**
 * Whether the DROP-152 access gate is enabled at all.
 *
 * Returns `true` when `setApiRuntimeConfig` has never been called with this
 * field, and that direction is the whole point. This flag has an
 * ADMIT-ON-FALSE consumer — `app-access.ts`'s `/verify` hop answers 204 with a
 * `gate-disabled` decision when the gate is switched off, so that a stale
 * Caddy guard can never lock visitors out of an app the platform reports as
 * ungated. An accessor that read "nobody wired the flag yet" as "the operator
 * turned the gate off" would therefore admit EVERY visitor to EVERY gated app
 * while the guards stayed installed — the exact inversion the kill switch
 * exists to prevent, in the dangerous direction.
 *
 * So "fail closed" here means KEEP ENFORCING, not "return false" — the
 * opposite direction to the sharing toggle (see the note below), deliberately:
 * the safe state of a security control is on, and the safe state of a product
 * feature is off. Only an explicit `false` from the platform disarms the gate.
 */
export function isAccessGateEnabled(): boolean {
  return runtimeConfig.accessGateEnabled !== false;
}

/**
 * The isolation mode the platform is ACTUALLY running, for the admin surface.
 *
 * Defaults to `'none'` when unset, matching `PlatformConfig`'s own default —
 * an ApiServer constructed directly in a test has no platform behind it, and
 * reporting `'docker'` there would be a lie in the dangerous direction.
 */
export function getIsolationMode(): 'none' | 'docker' {
  return runtimeConfig.isolation ?? 'none';
}

/*
 * There is deliberately NO `isAppSharingEnabled()` here.
 *
 * The owner-sharing toggle lives in `settings.json` precisely so an admin can
 * change it at runtime without the platform restart that redeploys the whole
 * fleet. Snapshotting it into this module at ApiServer construction — the way
 * `accessGateEnabled` is, correctly, because that one is a boot-time env
 * kill switch — would have reintroduced exactly the restart it was moved here
 * to avoid, silently: the setting would flip in the file and the API would
 * keep answering with the value captured at boot.
 *
 * Callers read `getSettingsManager().getAppSharingEnabled()` live instead. It
 * is an in-memory field read, and it already fails closed (`false`) both when
 * unset and when the settings file is corrupt.
 */
