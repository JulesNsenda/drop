/**
 * Caddy Server Type Definitions
 *
 * Types for managing the Caddy web server process.
 */

/**
 * Configuration for CaddyServer
 */
export interface CaddyServerConfig {
  /** Base directory for DROP */
  dropRoot: string;
  /** HTTP port (default: 80) */
  port?: number;
  /** Admin API port (default: 2019) */
  adminPort?: number;
  /** Path to Caddyfile */
  caddyfilePath: string;
  /** Callback for log messages */
  onLog?: (message: string) => void;
}

/**
 * Caddy server operational status
 */
export type CaddyServerStatus =
  | 'stopped'      // Not running
  | 'starting'     // In process of starting
  | 'running'      // Running and healthy
  | 'stopping'     // In process of stopping
  | 'error'        // Failed to start or crashed
  | 'unavailable'; // Caddy binary not installed

/**
 * Caddy version information
 */
export interface CaddyVersionInfo {
  /** Full version string */
  version: string;
  /** Major version number */
  major: number;
  /** Minor version number */
  minor: number;
  /** Patch version number */
  patch: number;
}
