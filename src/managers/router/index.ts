/**
 * Router Manager Module
 *
 * Exports CaddyServer for managing the Caddy web server process.
 */

export {
  CaddyServer,
  getCaddyServer,
  resetCaddyServer,
} from './caddy-server';

export {
  CaddyAdminClient,
  getCaddyAdminClient,
  resetCaddyAdminClient,
} from './caddy-api';

export type {
  CaddyServerConfig,
  CaddyServerStatus,
  CaddyVersionInfo,
} from './caddy-server.types';

export type { CertificateInfo } from './caddy-api';
