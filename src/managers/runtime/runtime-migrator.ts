/**
 * Runtime Migrator (M2e)
 *
 * Handles moving an app from one runtime (PM2 / Docker) to another.
 * Two entry points:
 *
 *  migrateAppRuntime()  — single-app migration; used by the admin API.
 *  migrateAllToDocker() — bulk first-boot migration; used by platform.ts
 *                         before the watcher starts so existing PM2 processes
 *                         are cleared before containers try to bind the same ports.
 *
 * Both functions only stop the old runtime and update appconf.  The caller is
 * responsible for triggering a redeploy (e.g. the watcher startup scan or an
 * app:detected event).
 */

import { getProcessManager } from '../process';
import { getContainerManager } from './container-manager';
import { getAppConfigService, AppConfig } from '../app/app-config';
import type { RuntimeType } from './app-runtime.types';

export interface MigrateRuntimeResult {
  appName: string;
  from: RuntimeType;
  to: RuntimeType;
  /** Set when migration failed (app config was not changed). */
  error?: string;
}

/**
 * Migrate a single app to `targetRuntime`.
 *
 * - If the app is already on the target runtime, returns immediately.
 * - Stops the current runtime process/container (best-effort; ignores errors
 *   for missing processes).
 * - Atomically updates `runtime` in the app's appconf file.
 *
 * @throws if the app config is not found.
 */
export async function migrateAppRuntime(
  appName: string,
  targetRuntime: RuntimeType
): Promise<MigrateRuntimeResult> {
  const configService = getAppConfigService();
  const config = configService.getConfig(appName);
  if (!config) {
    throw new Error(`No app config found for '${appName}'`);
  }

  const fromRuntime: RuntimeType = config.runtime ?? 'pm2';

  if (fromRuntime === targetRuntime) {
    return { appName, from: fromRuntime, to: targetRuntime };
  }

  await stopCurrentRuntime(appName, fromRuntime);

  await configService.updateConfig(appName, { runtime: targetRuntime });

  return { appName, from: fromRuntime, to: targetRuntime };
}

/**
 * Migrate every app whose runtime is 'pm2' (or unset) to 'docker'.
 *
 * Errors on individual apps are collected and returned rather than thrown so
 * that a single failed app does not block the migration of the rest.
 */
export async function migrateAllToDocker(configs: AppConfig[]): Promise<MigrateRuntimeResult[]> {
  const pm2Apps = configs.filter((c) => (c.runtime ?? 'pm2') === 'pm2');
  const results: MigrateRuntimeResult[] = [];

  for (const config of pm2Apps) {
    try {
      const result = await migrateAppRuntime(config.name, 'docker');
      results.push(result);
    } catch (err) {
      results.push({
        appName: config.name,
        from: config.runtime ?? 'pm2',
        to: 'docker',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

// ── Private helpers ───────────────────────────────────────────────────────────

async function stopCurrentRuntime(appName: string, fromRuntime: RuntimeType): Promise<void> {
  if (fromRuntime === 'pm2') {
    try {
      await getProcessManager().stop(appName);
    } catch {
      // PM2 process may not exist — that's fine.
    }
  } else if (fromRuntime === 'docker') {
    try {
      await getContainerManager().stop(appName);
    } catch {
      // Container may not exist — that's fine.
    }
  }
}
