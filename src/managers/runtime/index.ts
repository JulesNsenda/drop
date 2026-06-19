/**
 * App Runtime Module
 *
 * The runtime seam: consumers (platform, API, CLI) get an AppRuntime via
 * getAppRuntime() and never touch PM2/Docker specifics directly.
 *
 * Singleton pattern matches the other managers: get*() returns/creates,
 * reset*() tears down (used by platform.stop() and tests).
 */

import { resetProcessManager } from '../process';
import { AppRuntime } from './app-runtime';
import { RuntimeType } from './app-runtime.types';
import { Pm2Runtime } from './pm2-runtime';
import { ContainerManager, resetContainerManager } from './container-manager';

export type { AppRuntime } from './app-runtime';
export { Pm2Runtime } from './pm2-runtime';
export { ContainerManager, getContainerManager, resetContainerManager } from './container-manager';
export type {
  AppLogPaths,
  AppProcessInfo,
  AppResourceLimits,
  AppRuntimeState,
  AppStartSpec,
  RuntimeType,
} from './app-runtime.types';

let runtimeInstance: AppRuntime | null = null;

/**
 * Get the platform's app runtime.
 * - 'pm2'    — host processes via PM2; the v1 runtime.
 * - 'docker' — container isolation via ContainerManager; required for multi-user.
 *
 * The platform initializes the runtime once with an explicit type (from the
 * isolation config). All other consumers (API routes, CLI) call this with no
 * argument and get whatever runtime is active — they must not force a type,
 * otherwise they'd throw under docker isolation. When `type` is given and an
 * instance of a different type already exists, that's a real misconfiguration
 * and we throw. With no instance yet, we create one (defaulting to PM2).
 */
export function getAppRuntime(type?: RuntimeType): AppRuntime {
  if (runtimeInstance) {
    if (type && runtimeInstance.type !== type) {
      throw new Error(
        `App runtime already initialized as '${runtimeInstance.type}'; ` +
          `cannot switch to '${type}' without resetAppRuntime()`
      );
    }
    return runtimeInstance;
  }
  runtimeInstance = type === 'docker' ? new ContainerManager() : new Pm2Runtime();
  return runtimeInstance;
}

export function resetAppRuntime(): void {
  if (runtimeInstance) {
    runtimeInstance.disconnect();
  }
  runtimeInstance = null;
  // Reset both underlying singletons unconditionally — whichever was active.
  resetProcessManager();
  resetContainerManager();
}
