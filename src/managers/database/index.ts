/**
 * Database Module
 *
 * Manages PostgreSQL server and database provisioning for DROP.
 */

export { PostgresBinaries } from './postgres-binaries';
export type { PostgresBinariesConfig, BinaryPaths } from './postgres-binaries';

export { PostgresServer, getPostgresServer, resetPostgresServer } from './postgres-server';
export type { PostgresServerConfig, ServerStatus } from './postgres-server';

import { PostgresServer } from './postgres-server';
import { DatabaseProvisioner } from './database-provisioner';

export { DatabaseProvisioner } from './database-provisioner';
export type { DatabaseCredentials, ProvisionedDatabase } from './database-provisioner';

let provisionerInstance: DatabaseProvisioner | null = null;

/**
 * Module-level singleton for DatabaseProvisioner, mirroring getPostgresServer.
 *
 * The platform creates the provisioner during initializeServices() by calling
 * this with (server, dropRoot). Later callers (e.g. the API DELETE route,
 * which holds no platform reference) call it with no args and get back the
 * same instance the platform created. Returns null if the provisioner was
 * never initialized (e.g. auth-disabled/test paths where the DB layer never
 * booted).
 */
export function getDatabaseProvisioner(
  server?: PostgresServer,
  dropRoot?: string
): DatabaseProvisioner | null {
  if (!provisionerInstance && server && dropRoot) {
    provisionerInstance = new DatabaseProvisioner(server, dropRoot);
  }
  return provisionerInstance;
}

export function resetDatabaseProvisioner(): void {
  provisionerInstance = null;
}
