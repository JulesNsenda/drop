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

/**
 * Thrown by the start path (PRD-051) when an app declares required secrets in
 * its drop.yaml that are neither already set nor auto-generatable. The platform
 * catches it and parks the app in the `needs-config` state instead of starting
 * it — turning a runtime crash-loop into an actionable "set these secrets" step.
 */
export class AppNeedsConfigError extends Error {
  readonly code = 'APP_NEEDS_CONFIG';

  constructor(
    readonly appName: string,
    readonly missingSecrets: string[],
  ) {
    super(
      `Application '${appName}' is missing required secret(s): ${missingSecrets.join(', ')}`,
    );
    this.name = 'AppNeedsConfigError';
  }
}

/** Backing services attachable through POST /apps/:name/services/:id (DROP-151 Phase 2). */
export type AttachableServiceId = 'postgres' | 'redis';

/**
 * Result of `PlatformOps.attachService`. A refusal is a returned value, not a
 * thrown error — the caller (the route) must be able to map it to a specific
 * HTTP response without string-matching a message. Busy (`AppInProgressError`)
 * is the one exception: it is thrown, matching `restartApp`'s existing
 * contract and the route-level catch both already share.
 *
 * `envVarNames` is deliberately NAMES ONLY — the Postgres binding is a DSN
 * containing the role's plaintext password, and this result crosses the wire.
 */
export type AttachServiceResult =
  | { attached: true; envVarNames: string[] }
  | {
      attached: false;
      reason:
        | 'ephemeral'
        | 'has-own-database-url'
        /**
         * The Redis counterpart. Both exist because `dbEnvVars` and
         * `redisEnvVars` are each spread after `secretEnvVars`, so either one
         * provisioned over an owner-supplied URL silently repoints the app at
         * an empty store — for Redis, that means destroying live session state.
         */
        | 'has-own-redis-url'
        | 'quota-exceeded'
        /**
         * The app has runtime state but no AppConfig (an out-of-tree or
         * admin-registered app). Refused rather than attached because
         * `upsertConfig` would mint a skeleton config with `type: 'unknown'`
         * and no `path` — and `syncStateWithConfigs` iterates CONFIGS on the
         * next boot and calls `registerApp(name, config.path || <webapps>/name,
         * config.type, ...)`, which overwrites the app's real path, type and
         * hostname. Attaching a database would silently relocate the app at
         * the next restart.
         */
        | 'no-app-config'
        /**
         * The provisioner for this service is absent on this instance (Redis
         * disabled or failed to start; the database layer never booted). A
         * permanent, correct configuration state — a refusal the route maps to
         * 503, NOT a thrown error mapped to 500, which would read as a crash
         * and alert as one on every Postgres-less install.
         */
        | 'service-unavailable';
      detail: string;
      /** Present only for `reason: 'quota-exceeded'`. */
      quota?: { used: number; limit: number };
    };

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
   * Attach a backing service (postgres|redis) to an app: quota check,
   * provision, persist the owner's explicit intent (`AppConfig.services`,
   * DROP-151), then restart so the env var is actually injected. Resolves
   * only once that restart resolves — a caller that gets `attached: true`
   * back has a running app with the var set, not just a provisioned service.
   *
   * Rejects with AppInProgressError when the app already has a deploy/build/
   * restart in flight — the whole operation is guarded, not just the restart
   * at the end, so provisioning can never race a concurrent deploy for the
   * same app.
   */
  attachService(appName: string, serviceId: AttachableServiceId): Promise<AttachServiceResult>;

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
   * Put a held (built-but-unpromoted) build in front of traffic.
   *
   * Starts exactly what was built rather than rebuilding — a rebuild could pick
   * up source that changed since the operator looked at it, promoting something
   * nobody approved. Rejects when nothing is held.
   */
  promoteApp(appName: string): Promise<void>;

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

  /**
   * Remove the name-keyed artifacts a deleted app leaves outside its own
   * folder: `data/logs/webapps/<name>/`, `data/logs/builds/<name>/`, and —
   * unless `keepData` — `data/appdata/<name>/`.
   *
   * Exists on the seam because only the platform knows `dropRoot`, while
   * `DELETE /apps/:name` performs its own inline teardown and would otherwise
   * leave all three behind. That matters because deletion FREES THE APP NAME:
   * `/logs/:name` authorizes against the live app and then reads by name, and
   * `DROP_DATA_DIR` is derived from the name, so whoever registers it next
   * inherits the previous tenant's logs and persistent data.
   *
   * Best-effort and never throws — callers treat it as cleanup, not as part of
   * the delete's success condition.
   */
  purgeAppArtifacts(appName: string, opts?: { keepData?: boolean }): Promise<void>;
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
