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
