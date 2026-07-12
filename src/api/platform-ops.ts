/**
 * Platform operations exposed to API routes.
 *
 * The platform registers these when it starts the API server so route
 * handlers (which are imported as singletons and don't receive a platform
 * reference) can invoke platform-level orchestration. A direct import of
 * DropPlatform from a route file would be circular (platform → api → routes),
 * hence this seam — same pattern as runtime-config.ts.
 *
 * Unlike runtime-config there is no fallback: routes that need an operation
 * must 503 when it is unwired (standalone ApiServer in tests). Falling back
 * to raw runtime calls would silently reintroduce the stale-env restart bug
 * these ops exist to fix.
 */

import { AppProcessInfo } from '../managers/runtime';

/** Thrown by platform ops when the app has a deploy/build/restart in flight. */
export class AppInProgressError extends Error {
  readonly code = 'APP_IN_PROGRESS';

  constructor(appName: string) {
    super(`Application '${appName}' has an operation in progress`);
    this.name = 'AppInProgressError';
  }
}

export interface PlatformOps {
  /**
   * Stop-if-running, rebuild the start spec from current state (secrets,
   * DATABASE_URL, DROP_DATA_DIR, dependency env), and start the app on its
   * existing port. Resolves once the app is running again.
   *
   * Serves both the start and restart routes: on a stopped app it degenerates
   * to a fresh start. Rejects with AppInProgressError when the app is busy.
   */
  restartApp(appName: string): Promise<AppProcessInfo>;

  /**
   * Synchronous check for whether the app currently has a build/restart/
   * deploy in flight (backed by the platform's `appsInProgress` set). Unlike
   * `restartApp`, callers that find this unwired (null platform-ops) should
   * treat it as "not in progress" rather than 503 — it's a defense-in-depth
   * guard (e.g. the upload-deploy route), not the operation itself, and the
   * caller's own concurrency guard (e.g. UploadDeployService's activeUploads)
   * remains the real backstop.
   */
  isAppInProgress(appName: string): boolean;

  /**
   * Tear down every app belonging to a monorepo group (M4): stop+delete each
   * child's runtime process, remove its Caddy routes, dump-then-drop its
   * database, and remove its state/secrets/deploy-history/config/folder —
   * then remove the group's container folder so deleted children don't
   * regenerate on the watcher's next scan. Per-child failures are isolated
   * (one bad child doesn't abort the rest). Resolves with the names of the
   * children that were successfully removed.
   */
  removeGroup(groupName: string): Promise<{ removed: string[] }>;
}

let platformOps: PlatformOps | null = null;

export function setPlatformOps(ops: PlatformOps): void {
  platformOps = ops;
}

/** Null when no platform is wired (e.g. ApiServer constructed directly in tests). */
export function getPlatformOps(): PlatformOps | null {
  return platformOps;
}

/** Called from platform.stop() and test teardown so ops never leak across instances. */
export function resetPlatformOps(): void {
  platformOps = null;
}
