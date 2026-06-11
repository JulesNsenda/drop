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

export type { AppRuntime } from './app-runtime';
export { Pm2Runtime } from './pm2-runtime';
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
 * Get the platform's app runtime. Defaults to PM2; 'docker' arrives with
 * the v2 ContainerManager (PRD-029).
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
      throw new Error("Runtime 'docker' is not available yet (PRD-029)");
    }
    runtimeInstance = new Pm2Runtime();
  }
  return runtimeInstance;
}

export function resetAppRuntime(): void {
  if (runtimeInstance) {
    runtimeInstance.disconnect();
  }
  runtimeInstance = null;
  // The PM2 adapter wraps the ProcessManager singleton — reset it too so
  // tests and platform.stop() get a clean slate.
  resetProcessManager();
}
