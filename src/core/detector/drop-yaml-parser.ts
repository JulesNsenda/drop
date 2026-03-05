/**
 * DROP YAML Parser
 *
 * Parses app-level drop.yaml configuration files for custom domains,
 * TLS settings, and other per-app overrides.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';

/**
 * Custom TLS configuration for an app
 */
export interface AppTlsConfig {
  /** Path to certificate file */
  certFile?: string;
  /** Path to private key file */
  keyFile?: string;
  /** Disable automatic HTTPS (use HTTP only) */
  disabled?: boolean;
}

/**
 * Environment variable configuration
 */
export interface AppEnvConfig {
  /** Static environment variables */
  [key: string]: string | number | boolean;
}

/**
 * Dependency configuration
 */
export interface AppDependency {
  /** Name of the dependent app */
  name: string;
  /** Environment variable to inject the dependency URL into */
  env: string;
  /** Optional path prefix for the dependency URL */
  path?: string;
}

/**
 * Drop YAML configuration for an app
 */
export interface DropYamlConfig {
  /** App name override */
  name?: string;
  /** Custom domains for this app */
  domains?: string[];
  /** TLS configuration */
  tls?: AppTlsConfig;
  /** Environment variables */
  env?: AppEnvConfig;
  /** App dependencies */
  depends_on?: AppDependency[];
  /** Port override */
  port?: number;
  /** Build command override */
  build?: string;
  /** Start command override */
  start?: string;
  /** Health check path */
  healthCheck?: string;
  /** Max request body size (e.g., "100MB") */
  maxBodySize?: string;
  /** Request timeout in seconds */
  timeout?: number;
}

/**
 * Parse result with validation info
 */
export interface DropYamlParseResult {
  /** Parsed configuration */
  config: DropYamlConfig | null;
  /** Whether the parse was successful */
  success: boolean;
  /** Error message if parsing failed */
  error?: string;
  /** Path to the drop.yaml file */
  path: string;
  /** Whether drop.yaml exists */
  exists: boolean;
}

/**
 * Standard drop.yaml file names to search for
 */
const DROP_YAML_NAMES = ['drop.yaml', 'drop.yml', '.drop.yaml', '.drop.yml'];

/**
 * Find drop.yaml file in an app directory
 */
export async function findDropYaml(appPath: string): Promise<string | null> {
  for (const name of DROP_YAML_NAMES) {
    const filePath = path.join(appPath, name);
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // File doesn't exist, try next
    }
  }
  return null;
}

/**
 * Parse a drop.yaml file
 */
export async function parseDropYaml(appPath: string): Promise<DropYamlParseResult> {
  const yamlPath = await findDropYaml(appPath);

  if (!yamlPath) {
    return {
      config: null,
      success: true, // Not having a drop.yaml is valid
      path: path.join(appPath, 'drop.yaml'),
      exists: false,
    };
  }

  try {
    const content = await fs.readFile(yamlPath, 'utf-8');
    const parsed = yaml.parse(content) as DropYamlConfig;

    // Validate the parsed config
    const validationResult = validateDropYamlConfig(parsed);
    if (!validationResult.valid) {
      return {
        config: null,
        success: false,
        error: validationResult.error,
        path: yamlPath,
        exists: true,
      };
    }

    return {
      config: parsed,
      success: true,
      path: yamlPath,
      exists: true,
    };
  } catch (error) {
    return {
      config: null,
      success: false,
      error: error instanceof Error ? error.message : 'Failed to parse drop.yaml',
      path: yamlPath,
      exists: true,
    };
  }
}

/**
 * Validate a parsed drop.yaml configuration
 */
export function validateDropYamlConfig(config: unknown): { valid: boolean; error?: string } {
  if (config === null || config === undefined) {
    return { valid: true }; // Empty config is valid
  }

  if (typeof config !== 'object') {
    return { valid: false, error: 'Configuration must be an object' };
  }

  const cfg = config as Record<string, unknown>;

  // Validate domains
  if (cfg.domains !== undefined) {
    if (!Array.isArray(cfg.domains)) {
      return { valid: false, error: 'domains must be an array' };
    }
    for (const domain of cfg.domains) {
      if (typeof domain !== 'string') {
        return { valid: false, error: 'Each domain must be a string' };
      }
      if (!isValidDomain(domain)) {
        return { valid: false, error: `Invalid domain: ${domain}` };
      }
    }
  }

  // Validate tls
  if (cfg.tls !== undefined) {
    if (typeof cfg.tls !== 'object' || cfg.tls === null) {
      return { valid: false, error: 'tls must be an object' };
    }
    const tls = cfg.tls as Record<string, unknown>;
    if (tls.certFile !== undefined && typeof tls.certFile !== 'string') {
      return { valid: false, error: 'tls.certFile must be a string' };
    }
    if (tls.keyFile !== undefined && typeof tls.keyFile !== 'string') {
      return { valid: false, error: 'tls.keyFile must be a string' };
    }
  }

  // Validate port
  if (cfg.port !== undefined) {
    if (typeof cfg.port !== 'number' || cfg.port < 1 || cfg.port > 65535) {
      return { valid: false, error: 'port must be a number between 1 and 65535' };
    }
  }

  // Validate depends_on
  if (cfg.depends_on !== undefined) {
    if (!Array.isArray(cfg.depends_on)) {
      return { valid: false, error: 'depends_on must be an array' };
    }
    for (const dep of cfg.depends_on) {
      if (typeof dep !== 'object' || dep === null) {
        return { valid: false, error: 'Each dependency must be an object' };
      }
      const d = dep as Record<string, unknown>;
      if (typeof d.name !== 'string') {
        return { valid: false, error: 'dependency.name must be a string' };
      }
      if (typeof d.env !== 'string') {
        return { valid: false, error: 'dependency.env must be a string' };
      }
    }
  }

  return { valid: true };
}

/**
 * Simple domain validation
 */
function isValidDomain(domain: string): boolean {
  // Allow wildcards
  if (domain.startsWith('*.')) {
    domain = domain.slice(2);
  }

  // Basic domain format check
  const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  return domainRegex.test(domain);
}

/**
 * Get custom domains from drop.yaml
 * Returns null if no custom domains are configured
 */
export async function getCustomDomains(appPath: string): Promise<string[] | null> {
  const result = await parseDropYaml(appPath);

  if (!result.success || !result.config) {
    return null;
  }

  return result.config.domains && result.config.domains.length > 0
    ? result.config.domains
    : null;
}

/**
 * Get TLS configuration from drop.yaml
 * Returns null if no custom TLS is configured
 */
export async function getTlsConfig(appPath: string): Promise<AppTlsConfig | null> {
  const result = await parseDropYaml(appPath);

  if (!result.success || !result.config) {
    return null;
  }

  return result.config.tls || null;
}

/**
 * Merge drop.yaml config with app defaults
 */
export function mergeWithDefaults(
  dropConfig: DropYamlConfig | null,
  defaults: {
    name: string;
    hostname: string;
    port?: number;
  }
): {
  name: string;
  domains: string[];
  port?: number;
  tls?: AppTlsConfig;
  env?: AppEnvConfig;
  depends_on?: AppDependency[];
} {
  const merged = {
    name: dropConfig?.name || defaults.name,
    domains: dropConfig?.domains || [defaults.hostname],
    port: dropConfig?.port || defaults.port,
    tls: dropConfig?.tls,
    env: dropConfig?.env,
    depends_on: dropConfig?.depends_on,
  };

  return merged;
}
