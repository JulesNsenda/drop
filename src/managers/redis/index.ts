/**
 * Redis Module
 *
 * Manages the one bundled Redis instance and per-app logical-database
 * provisioning for DROP. Mirrors the database module (Postgres) shape.
 */

export { RedisServer, getRedisServer, resetRedisServer } from './redis-server';
export type { RedisServerConfig, RedisServerStatus } from './redis-server';

import { RedisServer } from './redis-server';
import { RedisProvisioner } from './redis-provisioner';

export { RedisProvisioner, MIN_APP_DB, MAX_APP_DB } from './redis-provisioner';
export type { RedisAllocation } from './redis-provisioner';

let provisionerInstance: RedisProvisioner | null = null;

/**
 * Module-level singleton for RedisProvisioner, mirroring getDatabaseProvisioner.
 *
 * The platform creates the provisioner during initializeServices() by calling
 * this with (server, dropRoot). Later callers that hold no platform reference
 * (e.g. the API DELETE route) call it with no args and get the same instance.
 * Returns null if the provisioner was never initialized (e.g. Redis disabled).
 */
export function getRedisProvisioner(
  server?: RedisServer,
  dropRoot?: string
): RedisProvisioner | null {
  if (!provisionerInstance && server && dropRoot) {
    provisionerInstance = new RedisProvisioner(server, dropRoot);
  }
  return provisionerInstance;
}

export function resetRedisProvisioner(): void {
  provisionerInstance = null;
}
