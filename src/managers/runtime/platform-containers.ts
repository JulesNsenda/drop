/**
 * Containers the PLATFORM runs for itself, which share the `drop-` namespace
 * with tenant app containers (`drop-<instance>`). An app whose runtime
 * container name equalled one of these would, on start, force-remove the
 * platform's own container — so the names are reserved (`isNameTaken`) and
 * `ContainerManager` refuses to act on any container carrying
 * `PLATFORM_SERVICE_LABEL` (the second layer, for names that predate the rule).
 *
 * Kept free of imports (but the leaf service-name constant) so both the name rules
 * and the runtime can use it.
 */

import { DROP_SERVICE_NAME } from '../../utils/service-name';

/** Prefix of every DROP container name, tenant or platform. */
export const CONTAINER_NAME_PREFIX = 'drop-';

/** Label the platform stamps on its own service containers (`drop.service=redis`). */
export const PLATFORM_SERVICE_LABEL = 'drop.service';

/** The bundled Redis container. */
export const REDIS_CONTAINER_NAME = `${CONTAINER_NAME_PREFIX}redis`;

/** Every container name the platform owns. Add new service containers here. */
export const PLATFORM_CONTAINER_NAMES: readonly string[] = [REDIS_CONTAINER_NAME];

/** App names starting with this would share the `drop-build-*` build container namespace. */
export const BUILD_NAME_PREFIX = 'build-';

/**
 * Whether an app called `name` would get a container named like a platform one,
 * or one in the build container namespace (ignoring case: Docker names are
 * case-sensitive, but the app-name rules are not).
 * Slot b (`<app>.b`) yields `drop-<app>.b`, which no platform name equals.
 */
export function collidesWithPlatformContainer(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith(BUILD_NAME_PREFIX)) return true;
  const cName = `${CONTAINER_NAME_PREFIX}${lower}`;
  return PLATFORM_CONTAINER_NAMES.some((reserved) => reserved.toLowerCase() === cName);
}

/**
 * THE reserved-name rule: a name no app may have, for any caller. DROP's own
 * service name (an app by it would be taken for the platform by everything that
 * matches runtime processes by name) or one that maps onto a platform container.
 * Every create path, the folder drop and the suspension policy ask this one.
 */
/**
 * DROP's own runtime process name (PM2 daemon mode). Suspension enforcement
 * skips only this: `redis` and `build-*` apps from before the reservation
 * are still enforced, and the container allowlist already keeps the platform's
 * own containers out of reach.
 */
export function isPlatformServiceName(name: string): boolean {
  return name.toLowerCase() === DROP_SERVICE_NAME;
}

export function isReservedName(name: string): boolean {
  return name.toLowerCase() === DROP_SERVICE_NAME || collidesWithPlatformContainer(name);
}

/** A platform service container: one of our names AND the service label. */
export function isPlatformContainer(
  cName: string,
  labels: Record<string, string> | undefined
): boolean {
  return Boolean(labels?.[PLATFORM_SERVICE_LABEL]) && PLATFORM_CONTAINER_NAMES.includes(cName.replace(/^\//, ''));
}
