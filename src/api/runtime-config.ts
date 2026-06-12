/**
 * API runtime configuration.
 *
 * The platform populates this when it constructs the API server so route
 * handlers (which are imported as singletons and don't receive config) can
 * reach authoritative values like the webapps directory. Falls back to the
 * same env/defaults the platform uses when not explicitly set.
 */

const isWindows = process.platform === 'win32';
const DEFAULT_APPS_DIR = isWindows ? 'C:\\drop\\data\\webapps' : '/var/drop/data/webapps';

interface ApiRuntimeConfig {
  appsDirectory?: string;
  enableHttps?: boolean;
  domainSuffix?: string;
}

const runtimeConfig: ApiRuntimeConfig = {};

export function setApiRuntimeConfig(config: ApiRuntimeConfig): void {
  if (config.appsDirectory) runtimeConfig.appsDirectory = config.appsDirectory;
  if (config.enableHttps !== undefined) runtimeConfig.enableHttps = config.enableHttps;
  if (config.domainSuffix !== undefined) runtimeConfig.domainSuffix = config.domainSuffix;
}

/** Resolved webapps directory: explicit config > DROP_APPS_DIR env > platform default. */
export function getAppsDirectory(): string {
  return runtimeConfig.appsDirectory || process.env.DROP_APPS_DIR || DEFAULT_APPS_DIR;
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
