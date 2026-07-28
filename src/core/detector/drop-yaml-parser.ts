/**
 * DROP YAML Parser
 *
 * Parses app-level drop.yaml configuration files for custom domains,
 * TLS settings, and other per-app overrides.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as yaml from 'yaml';

/** Keys accepted at the top level of drop.yaml. Any others are rejected. */
const ALLOWED_TOP_KEYS = new Set([
  'name', 'domains', 'tls', 'env', 'build_env', 'secrets', 'depends_on', 'port',
  'build', 'start', 'healthCheck', 'maxBodySize', 'timeout',
  'group', 'services', 'type', 'database', 'redis', 'route', 'mcp',
]);

/** Keys accepted under drop.yaml#tls */
const ALLOWED_TLS_KEYS = new Set(['certFile', 'keyFile', 'disabled']);

/** Keys accepted under drop.yaml#mcp (Step 11) */
const ALLOWED_MCP_KEYS = new Set(['path', 'auth']);

/**
 * An MCP endpoint path. Tenant-authored and rendered in tool output and the
 * dashboard (inside a DROP-composed URL), so it is allowlisted rather than
 * merely length-checked: leading slash, a conservative character set, and no
 * traversal or empty segments.
 */
const MCP_PATH_REGEX = /^\/[A-Za-z0-9._~/-]{0,100}$/;

/** Keys accepted under a drop.yaml#services.<name> entry */
const ALLOWED_SERVICE_KEYS = new Set([
  'path', 'type', 'build', 'start', 'env', 'build_env', 'secrets', 'database', 'redis',
  'healthCheck', 'domains', 'depends_on', 'route',
]);

/** Keys accepted under a drop.yaml#services.<name>.route entry */
const ALLOWED_ROUTE_KEYS = new Set(['path', 'strip']);

/** Safe service name: letters, digits, hyphens, underscores only. */
const SERVICE_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * A declared secret's key must be a real environment variable name. This is a
 * security boundary, not just tidiness: the key is echoed into API errors and
 * into the MCP `needs-config` tool result, and drop.yaml is attacker-authored
 * on the `deploy_from_git` path. See validateSecretsObject.
 */
const SECRET_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

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

/** Auto-generation strategy for a declared secret (PRD-051). Only `random` in v1. */
export type SecretGenerateStrategy = 'random';

/**
 * Object form of a declared secret requirement (drop.yaml `secrets:`).
 */
export interface SecretDeclObject {
  /** The app cannot start without this secret. `generate` implies `required`. */
  required?: boolean;
  /** DROP fills a strong random value if the secret is unset at start. */
  generate?: SecretGenerateStrategy;
  /** Human-facing hint shown in the dashboard / CLI prompt. */
  description?: string;
}

/**
 * A declared secret requirement. Shorthand forms:
 * - `true` / `"required"` — required, human-supplied.
 * - `"generate"` — required and auto-generated (random).
 * - object — {@link SecretDeclObject}.
 */
export type SecretDecl = boolean | 'required' | 'generate' | SecretDeclObject;

/**
 * drop.yaml `secrets:` — a map of ENV var name -> declaration (PRD-051).
 * Declaring a secret makes DROP resolve it (auto-generate / prompt / park in
 * `needs-config`) BEFORE the app starts, rather than crash-looping at runtime.
 */
export interface AppSecretsConfig {
  [key: string]: SecretDecl;
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
 * Route configuration for a service exposed on a shared (group) hostname.
 * Consumed by M3 (same-origin `/api` routing) — parsed and stored now.
 */
export interface AppRouteConfig {
  /** Path prefix this service is mounted under on the shared hostname (e.g. "/api") */
  path?: string;
  /** Whether the matched prefix should be stripped before proxying (default: false) */
  strip?: boolean;
}

/**
 * Configuration for a single service in a monorepo `services:` map.
 */
export interface ServiceConfig {
  /** Subtree within the repo this service is materialized from (e.g. "backend") */
  path: string;
  /** Optional detector override (skips auto-detection) */
  type?: string;
  /** Build command override */
  build?: string;
  /** Start command override */
  start?: string;
  /** Environment variables (available at both build and start time) */
  env?: AppEnvConfig;
  /** Build-only environment variables (see DropYamlConfig.build_env) */
  build_env?: AppEnvConfig;
  /** Declared required secrets for this service (see DropYamlConfig.secrets) */
  secrets?: AppSecretsConfig;
  /** Provision a database for this service only (e.g. "postgres") */
  database?: string;
  /** Provision managed Redis (per-app logical DB + injected REDIS_URL) for this service. */
  redis?: boolean;
  /** Health check path */
  healthCheck?: string;
  /** Custom domains for this service */
  domains?: string[];
  /** Service dependencies */
  depends_on?: AppDependency[];
  /** Routing configuration on the shared group hostname */
  route?: AppRouteConfig;
}

/**
 * Drop YAML configuration for an app
 */
export interface DropYamlConfig {
  /** App name override */
  name?: string;
  /**
   * App-type override (e.g. "nodejs", "static"). Accepted at the top level so
   * a generated child `<group>-<service>` drop.yaml (and the existing
   * drop-test fixtures) validate; consumed by the manifest detector, not the
   * strict parser.
   */
  type?: string;
  /**
   * Database requirement (e.g. "postgres"). Accepted at the top level for the
   * same reason as `type`; drives per-app DB provisioning via the detector.
   */
  database?: string;
  /** Provision managed Redis (per-app logical DB + injected REDIS_URL). */
  redis?: boolean;
  /** Custom domains for this app */
  domains?: string[];
  /** TLS configuration */
  tls?: AppTlsConfig;
  /** Environment variables (available at both build and start time) */
  env?: AppEnvConfig;
  /**
   * Build-only environment variables — merged into the build child process
   * alongside `env`, but never injected into the running app at start time.
   * Useful for values a static-site bundler inlines at build time (e.g.
   * Vite's `VITE_*` vars) that shouldn't also linger in the runtime env.
   */
  build_env?: AppEnvConfig;
  /**
   * Declared required secrets (PRD-051). A map of ENV var name -> declaration.
   * DROP resolves these (auto-generate / prompt / park in `needs-config`) before
   * the app starts, instead of letting a missing secret crash-loop the app.
   */
  secrets?: AppSecretsConfig;
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
  /**
   * Group name for a monorepo of multiple services. Defaults to `name`.
   * Services sharing a group share a hostname (`<group>.<suffix>`).
   */
  group?: string;
  /**
   * Monorepo multi-service map. When present, the root drop.yaml describes a
   * group container (never deployed as a single app) — each entry is
   * materialized as its own top-level app (see M2 expansion).
   */
  services?: Record<string, ServiceConfig>;
  /**
   * Same-origin route mount for this app (used by monorepo children: the
   * frontend mounts at `/`, the backend at `/api`). Accepted at the top level
   * so a generated child `<group>-<service>` drop.yaml validates; applied by
   * handleConfigureRoute as a Caddy path prefix (M3).
   */
  route?: AppRouteConfig;
  /**
   * Declares this app as an MCP server (Step 11). Presence is the declaration;
   * DROP's whole-host reverse_proxy already carries `<app>.<domain><path>` to
   * the app, so this changes no routing — it labels the app so its endpoint can
   * be surfaced, and reserves the shape PR 2's per-app OAuth will extend.
   */
  mcp?: AppMcpConfig;
}

/**
 * drop.yaml `mcp:` — an app that speaks MCP over Streamable HTTP.
 */
export interface AppMcpConfig {
  /** Endpoint path on the app's own hostname. Defaults to `/mcp`. */
  path?: string;
  /**
   * Who guards the endpoint.
   *
   * `none` is the ONLY accepted value today, and it means the endpoint is
   * PUBLIC unless the app authenticates callers itself. `drop` is rejected
   * rather than accepted-and-ignored: silently treating it as `none` would tell
   * a tenant DROP guards their endpoint while it is open to the internet, and a
   * schema that lies about a security property is worse than one that changes
   * twice.
   */
  auth?: 'none';
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

    // Validate the parsed config (pass appPath for TLS path containment)
    const validationResult = validateDropYamlConfig(parsed, appPath);
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
 * Validate a parsed drop.yaml configuration.
 *
 * @param config  The parsed YAML value (may be any type).
 * @param appPath Optional: absolute path to the app directory.  When provided,
 *                tls.certFile and tls.keyFile must reside inside it (prevents
 *                reading arbitrary host files via a tenant-controlled drop.yaml).
 */
export function validateDropYamlConfig(
  config: unknown,
  appPath?: string,
): { valid: boolean; error?: string } {
  if (config === null || config === undefined) {
    return { valid: true }; // Empty config is valid
  }

  if (typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, error: 'Configuration must be an object' };
  }

  const cfg = config as Record<string, unknown>;

  // Strict schema: reject unknown top-level keys
  for (const key of Object.keys(cfg)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      return { valid: false, error: `Unknown field '${key}' in drop.yaml` };
    }
  }

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

  // Validate mcp (Step 11)
  if (cfg.mcp !== undefined) {
    if (typeof cfg.mcp !== 'object' || cfg.mcp === null || Array.isArray(cfg.mcp)) {
      return { valid: false, error: 'mcp must be an object' };
    }
    const mcp = cfg.mcp as Record<string, unknown>;

    for (const key of Object.keys(mcp)) {
      if (!ALLOWED_MCP_KEYS.has(key)) {
        return { valid: false, error: `Unknown field 'mcp.${key}' in drop.yaml` };
      }
    }

    if (mcp.path !== undefined) {
      if (typeof mcp.path !== 'string') {
        return { valid: false, error: 'mcp.path must be a string' };
      }
      // Traversal and empty segments are rejected explicitly: the allowlist
      // permits '.' and '/', so "/a/../b" and "/a//b" match it on their own.
      if (
        !MCP_PATH_REGEX.test(mcp.path) ||
        mcp.path.includes('..') ||
        mcp.path.includes('//')
      ) {
        return {
          valid: false,
          error: `Invalid mcp.path '${mcp.path}': must start with '/' and contain only letters, digits, '.', '_', '~', '-' or '/'`,
        };
      }
    }

    if (mcp.auth !== undefined) {
      if (mcp.auth === 'drop') {
        // Rejected, NOT accepted-and-ignored. See AppMcpConfig.auth.
        return {
          valid: false,
          error:
            "mcp.auth: 'drop' is not supported yet — DROP does not guard app MCP endpoints. " +
            "Use 'none' and authenticate callers in the app itself; DROP-managed OAuth is coming separately.",
        };
      }
      if (mcp.auth !== 'none') {
        return { valid: false, error: `Invalid mcp.auth '${String(mcp.auth)}': must be 'none'` };
      }
    }
  }

  // Validate tls
  if (cfg.tls !== undefined) {
    if (typeof cfg.tls !== 'object' || cfg.tls === null || Array.isArray(cfg.tls)) {
      return { valid: false, error: 'tls must be an object' };
    }
    const tls = cfg.tls as Record<string, unknown>;

    // Strict schema: reject unknown tls keys
    for (const key of Object.keys(tls)) {
      if (!ALLOWED_TLS_KEYS.has(key)) {
        return { valid: false, error: `Unknown field 'tls.${key}' in drop.yaml` };
      }
    }

    if (tls.certFile !== undefined) {
      if (typeof tls.certFile !== 'string') {
        return { valid: false, error: 'tls.certFile must be a string' };
      }
      if (appPath) {
        const resolved = path.resolve(appPath, tls.certFile as string);
        if (!resolved.startsWith(path.resolve(appPath) + path.sep) && resolved !== path.resolve(appPath)) {
          return { valid: false, error: 'tls.certFile must be inside the app directory' };
        }
      }
    }
    if (tls.keyFile !== undefined) {
      if (typeof tls.keyFile !== 'string') {
        return { valid: false, error: 'tls.keyFile must be a string' };
      }
      if (appPath) {
        const resolved = path.resolve(appPath, tls.keyFile as string);
        if (!resolved.startsWith(path.resolve(appPath) + path.sep) && resolved !== path.resolve(appPath)) {
          return { valid: false, error: 'tls.keyFile must be inside the app directory' };
        }
      }
    }
    if (tls.disabled !== undefined && typeof tls.disabled !== 'boolean') {
      return { valid: false, error: 'tls.disabled must be a boolean' };
    }
  }

  // Validate port
  if (cfg.port !== undefined) {
    if (typeof cfg.port !== 'number' || cfg.port < 1 || cfg.port > 65535) {
      return { valid: false, error: 'port must be a number between 1 and 65535' };
    }
  }

  // Validate string fields
  for (const field of ['name', 'type', 'database', 'build', 'start', 'healthCheck', 'maxBodySize'] as const) {
    if (cfg[field] !== undefined && typeof cfg[field] !== 'string') {
      return { valid: false, error: `${field} must be a string` };
    }
  }

  // Validate boolean fields
  if (cfg.redis !== undefined && typeof cfg.redis !== 'boolean') {
    return { valid: false, error: 'redis must be a boolean' };
  }

  if (cfg.timeout !== undefined) {
    if (typeof cfg.timeout !== 'number' || cfg.timeout <= 0) {
      return { valid: false, error: 'timeout must be a positive number' };
    }
  }

  // Validate env
  if (cfg.env !== undefined) {
    const result = validateEnvObject(cfg.env, 'env');
    if (!result.valid) return result;
  }

  // Validate build_env (same shape/rules as env)
  if (cfg.build_env !== undefined) {
    const result = validateEnvObject(cfg.build_env, 'build_env');
    if (!result.valid) return result;
  }

  // Validate secrets (declared required secrets — PRD-051)
  if (cfg.secrets !== undefined) {
    const result = validateSecretsObject(cfg.secrets, 'secrets');
    if (!result.valid) return result;
  }

  // Validate depends_on
  if (cfg.depends_on !== undefined) {
    const result = validateDependsOn(cfg.depends_on, 'depends_on');
    if (!result.valid) return result;
  }

  // Validate group
  if (cfg.group !== undefined) {
    if (typeof cfg.group !== 'string' || !cfg.group) {
      return { valid: false, error: 'group must be a non-empty string' };
    }
  }

  // Validate services (monorepo multi-service map)
  if (cfg.services !== undefined) {
    if (typeof cfg.services !== 'object' || cfg.services === null || Array.isArray(cfg.services)) {
      return { valid: false, error: 'services must be an object' };
    }
    const services = cfg.services as Record<string, unknown>;
    const serviceNames = Object.keys(services);
    if (serviceNames.length === 0) {
      return { valid: false, error: 'services must contain at least one entry' };
    }
    for (const name of serviceNames) {
      if (!SERVICE_NAME_REGEX.test(name)) {
        return {
          valid: false,
          error: `Invalid service name '${name}': must contain only letters, digits, hyphens, and underscores`,
        };
      }
      const result = validateServiceConfig(name, services[name], appPath);
      if (!result.valid) return result;
    }
  }

  // Validate top-level route (same schema as a per-service route block)
  if (cfg.route !== undefined) {
    const result = validateRouteConfig(cfg.route, 'route');
    if (!result.valid) return result;
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
 * Validate an env-like object: a plain object whose values are each a
 * string, number, or boolean. Shared by top-level `env`/`build_env` and
 * per-service `env`/`build_env` (identical rules, different error prefix).
 */
function validateEnvObject(
  value: unknown,
  label: string,
): { valid: boolean; error?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, error: `${label} must be an object` };
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!k || typeof k !== 'string') {
      return { valid: false, error: `${label} keys must be non-empty strings` };
    }
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      return { valid: false, error: `${label}.${k} must be a string, number, or boolean` };
    }
  }
  return { valid: true };
}

/** Keys accepted under a drop.yaml `secrets.<NAME>` object declaration. */
const ALLOWED_SECRET_KEYS = new Set(['required', 'generate', 'description']);

/**
 * Cap on `secrets:` entries per block. Each declared `generate` secret triggers
 * an atomic rewrite of the shared secrets store at start, so an unbounded map
 * would let one app's drop.yaml degrade every tenant's deploy. Real apps need a
 * handful; 50 is generous headroom.
 */
const MAX_SECRET_DECLS = 50;

/**
 * Validate a `secrets:` map (PRD-051). Each key is an env var name; each value
 * is a declaration in one of these forms:
 * - boolean (`true` = required)
 * - string `"required"` or `"generate"`
 * - object `{ required?, generate?: "random", description? }`
 * Shared by the top-level `secrets` and per-service `secrets`.
 */
function validateSecretsObject(
  value: unknown,
  label: string,
): { valid: boolean; error?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, error: `${label} must be an object` };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_SECRET_DECLS) {
    return {
      valid: false,
      error: `${label} declares ${entries.length} secrets, exceeding the limit of ${MAX_SECRET_DECLS}`,
    };
  }
  for (const [name, decl] of entries) {
    if (!name || typeof name !== 'string') {
      return { valid: false, error: `${label} keys must be non-empty strings` };
    }
    // A declared secret's key is an ENV VAR NAME, but it was previously only
    // checked for being a non-empty string — so any text at all was accepted,
    // including newlines. That key is carried verbatim into
    // AppNeedsConfigError.missingSecrets, persisted onto AppState, and
    // interpolated raw into the `needs-config` MCP tool result. Since
    // deploy_from_git clones a third-party repo, the drop.yaml is
    // attacker-authored, so an unconstrained key was a direct injection path
    // into a calling agent's context — reached on the FIRST deploy attempt,
    // before any log is ever read. Constrain it to a real env var name.
    if (!SECRET_NAME_REGEX.test(name)) {
      return {
        valid: false,
        error:
          `Invalid ${label} key '${name.slice(0, 40)}': must be a valid environment ` +
          `variable name (letters, digits, underscore; not starting with a digit; max 64 chars)`,
      };
    }
    if (typeof decl === 'boolean') {
      continue;
    }
    if (typeof decl === 'string') {
      if (decl !== 'required' && decl !== 'generate') {
        return { valid: false, error: `${label}.${name} shorthand must be "required" or "generate"` };
      }
      continue;
    }
    if (typeof decl !== 'object' || decl === null || Array.isArray(decl)) {
      return { valid: false, error: `${label}.${name} must be a boolean, "required"/"generate", or an object` };
    }
    const d = decl as Record<string, unknown>;
    for (const key of Object.keys(d)) {
      if (!ALLOWED_SECRET_KEYS.has(key)) {
        return { valid: false, error: `Unknown field '${label}.${name}.${key}' in drop.yaml` };
      }
    }
    if (d.required !== undefined && typeof d.required !== 'boolean') {
      return { valid: false, error: `${label}.${name}.required must be a boolean` };
    }
    if (d.generate !== undefined && d.generate !== 'random') {
      return { valid: false, error: `${label}.${name}.generate must be "random"` };
    }
    if (d.description !== undefined && typeof d.description !== 'string') {
      return { valid: false, error: `${label}.${name}.description must be a string` };
    }
  }
  return { valid: true };
}

/**
 * Validate a `depends_on` array. Shared by the top-level `depends_on` and
 * per-service `depends_on` (identical rules, different error prefix).
 */
function validateDependsOn(
  value: unknown,
  label: string,
): { valid: boolean; error?: string } {
  if (!Array.isArray(value)) {
    return { valid: false, error: `${label} must be an array` };
  }
  for (const dep of value) {
    if (typeof dep !== 'object' || dep === null || Array.isArray(dep)) {
      return { valid: false, error: `Each entry in ${label} must be an object` };
    }
    const d = dep as Record<string, unknown>;
    if (typeof d.name !== 'string' || !d.name) {
      return { valid: false, error: `${label}[].name must be a non-empty string` };
    }
    if (typeof d.env !== 'string' || !d.env) {
      return { valid: false, error: `${label}[].env must be a non-empty string` };
    }
    if (d.path !== undefined && typeof d.path !== 'string') {
      return { valid: false, error: `${label}[].path must be a string` };
    }
  }
  return { valid: true };
}

/**
 * Validate that a relative path stays within `appPath` (when supplied):
 * rejects absolute paths and any `..` traversal outright (structural check,
 * always applied), and — mirroring the tls.certFile/keyFile containment
 * style — additionally resolves against `appPath` when available to confirm
 * real containment.
 */
function validateContainedPath(
  value: string,
  label: string,
  appPath?: string,
): { valid: boolean; error?: string } {
  // Platform-independent absolute-path check: path.isAbsolute() alone is
  // OS-specific (e.g. a Windows drive path like "C:\Windows" is NOT
  // absolute per POSIX rules, and a leading "/" is not absolute on
  // Windows' drive-relative semantics in all Node versions), so also
  // explicitly reject POSIX-root and Windows drive-letter/UNC forms
  // regardless of the host OS running validation.
  if (
    path.isAbsolute(value) ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    /^[a-zA-Z]:[\\/]/.test(value)
  ) {
    return { valid: false, error: `${label} must be a relative path` };
  }

  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    return { valid: false, error: `${label} must not contain '..' path traversal` };
  }

  if (appPath) {
    const base = path.resolve(appPath);
    const resolved = path.resolve(appPath, value);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      return { valid: false, error: `${label} must stay inside the app directory` };
    }
  }

  return { valid: true };
}

/**
 * Validate a `services.<name>.route` block.
 */
function validateRouteConfig(
  value: unknown,
  label: string,
): { valid: boolean; error?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, error: `${label} must be an object` };
  }
  const route = value as Record<string, unknown>;

  for (const key of Object.keys(route)) {
    if (!ALLOWED_ROUTE_KEYS.has(key)) {
      return { valid: false, error: `Unknown field '${label}.${key}' in drop.yaml` };
    }
  }

  if (route.path !== undefined && typeof route.path !== 'string') {
    return { valid: false, error: `${label}.path must be a string` };
  }
  if (route.strip !== undefined && typeof route.strip !== 'boolean') {
    return { valid: false, error: `${label}.strip must be a boolean` };
  }

  return { valid: true };
}

/**
 * Validate a single `services.<name>` entry.
 */
function validateServiceConfig(
  name: string,
  value: unknown,
  appPath?: string,
): { valid: boolean; error?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { valid: false, error: `services.${name} must be an object` };
  }
  const svc = value as Record<string, unknown>;

  // Strict schema: reject unknown service keys
  for (const key of Object.keys(svc)) {
    if (!ALLOWED_SERVICE_KEYS.has(key)) {
      return { valid: false, error: `Unknown field 'services.${name}.${key}' in drop.yaml` };
    }
  }

  // path is required
  if (typeof svc.path !== 'string' || !svc.path) {
    return { valid: false, error: `services.${name}.path is required and must be a non-empty string` };
  }
  const pathResult = validateContainedPath(svc.path, `services.${name}.path`, appPath);
  if (!pathResult.valid) return pathResult;

  // Optional string fields
  for (const field of ['type', 'build', 'start', 'healthCheck', 'database'] as const) {
    if (svc[field] !== undefined && typeof svc[field] !== 'string') {
      return { valid: false, error: `services.${name}.${field} must be a string` };
    }
  }

  // Optional boolean fields
  if (svc.redis !== undefined && typeof svc.redis !== 'boolean') {
    return { valid: false, error: `services.${name}.redis must be a boolean` };
  }

  // domains
  if (svc.domains !== undefined) {
    if (!Array.isArray(svc.domains)) {
      return { valid: false, error: `services.${name}.domains must be an array` };
    }
    for (const domain of svc.domains) {
      if (typeof domain !== 'string') {
        return { valid: false, error: `Each domain in services.${name}.domains must be a string` };
      }
      if (!isValidDomain(domain)) {
        return { valid: false, error: `Invalid domain in services.${name}.domains: ${domain}` };
      }
    }
  }

  // env / build_env (same rules as top-level)
  if (svc.env !== undefined) {
    const result = validateEnvObject(svc.env, `services.${name}.env`);
    if (!result.valid) return result;
  }
  if (svc.build_env !== undefined) {
    const result = validateEnvObject(svc.build_env, `services.${name}.build_env`);
    if (!result.valid) return result;
  }
  if (svc.secrets !== undefined) {
    const result = validateSecretsObject(svc.secrets, `services.${name}.secrets`);
    if (!result.valid) return result;
  }

  // depends_on (same rules as top-level)
  if (svc.depends_on !== undefined) {
    const result = validateDependsOn(svc.depends_on, `services.${name}.depends_on`);
    if (!result.valid) return result;
  }

  // route
  if (svc.route !== undefined) {
    const result = validateRouteConfig(svc.route, `services.${name}.route`);
    if (!result.valid) return result;
  }

  return { valid: true };
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
