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
 * - 'pm2'    (default) — host processes via PM2; the v1 runtime.
 * - 'docker' — container isolation via ContainerManager; required for multi-user.
 */
export function getAppRuntime(type: RuntimeType = 'pm2'): AppRuntime {
  if (runtimeInstance && runtimeInstance.type !== type) {
    throw new Error(
      `App runtime already initialized as '${runtimeInstance.type}'; ` +
        `cannot switch to '${type}' without resetAppRuntime()`
    );
  }
  if (!runtimeInstance) {
    if (type === 'docker') {
      runtimeInstance = new ContainerManager();
    } else {
      runtimeInstance = new Pm2Runtime();
    }
  }
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
