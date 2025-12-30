/**
 * CLI Type Definitions
 */

/**
 * Global CLI options
 */
export interface GlobalOptions {
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

/**
 * Deploy command options
 */
export interface DeployOptions extends GlobalOptions {
  name?: string;
  port?: number;
  env?: string[];
  build?: boolean;
}

/**
 * List command options
 */
export interface ListOptions extends GlobalOptions {
  status?: string;
  all?: boolean;
}

/**
 * Logs command options
 */
export interface LogsOptions extends GlobalOptions {
  follow?: boolean;
  lines?: number;
  error?: boolean;
}

/**
 * Process control command options
 */
export interface ProcessOptions extends GlobalOptions {
  force?: boolean;
}

/**
 * Remove command options
 */
export interface RemoveOptions extends GlobalOptions {
  force?: boolean;
  keepData?: boolean;
}

/**
 * Config command options
 */
export interface ConfigOptions extends GlobalOptions {
  global?: boolean;
}

/**
 * App info for display
 */
export interface AppInfo {
  name: string;
  status: string;
  type: string;
  port?: number;
  pid?: number;
  memory?: number;
  cpu?: number;
  uptime?: number;
  restarts?: number;
  path?: string;
}
