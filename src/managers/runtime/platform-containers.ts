/**
 * Containers the PLATFORM runs for itself, which share the `drop-` namespace
 * with tenant app containers (`drop-<instance>`). An app whose runtime
 * container name equalled one of these would, on start, force-remove the
 * platform's own container — so the names are reserved (`isNameTaken`) and
 * `ContainerManager` refuses to act on any container carrying
 * `PLATFORM_SERVICE_LABEL` (the second layer, for names that predate the rule).
 *
 * Kept free of imports so both the name rules and the runtime can use it.
 */

/** Prefix of every DROP container name, tenant or platform. */
export const CONTAINER_NAME_PREFIX = 'drop-';

/** Label the platform stamps on its own service containers (`drop.service=redis`). */
export const PLATFORM_SERVICE_LABEL = 'drop.service';

/** The bundled Redis container. */
export const REDIS_CONTAINER_NAME = `${CONTAINER_NAME_PREFIX}redis`;

/** Every container name the platform owns. Add new service containers here. */
export const PLATFORM_CONTAINER_NAMES: readonly string[] = [REDIS_CONTAINER_NAME];

/**
 * Whether an app called `name` would get a container named like a platform one
 * (ignoring case: Docker names are case-sensitive, but the app-name rules are not).
 * Slot b (`<app>.b`) yields `drop-<app>.b`, which no platform name equals.
 */
export function collidesWithPlatformContainer(name: string): boolean {
  const cName = `${CONTAINER_NAME_PREFIX}${name}`.toLowerCase();
  return PLATFORM_CONTAINER_NAMES.some((reserved) => reserved.toLowerCase() === cName);
}
