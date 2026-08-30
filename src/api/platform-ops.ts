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
// Only the three the PlatformOps interface below actually references —
// DetachServiceOutcome/DetachServiceRestartOutcome are re-exported (below)
// but not used in this file's own signatures.
import type { AttachableServiceId, AttachServiceResult, DetachServiceResult } from './services-wire.types';
import type { AccessGateVerdict } from '../managers/guardrail/access-gate';

/**
 * The attach/detach wire contract itself lives in `services-wire.types.ts` —
 * a leaf module with zero imports, so a type-only consumer (the dashboard,
 * across the package boundary) doesn't have to resolve this file's own
 * `../managers/runtime` import graph just to see the result shapes.
 * Re-exported here so every existing importer of `platform-ops.ts` is
 * unaffected by the split.
 */
export type {
  AttachableServiceId,
  AttachServiceResult,
  DetachServiceOutcome,
  DetachServiceRestartOutcome,
  DetachServiceResult,
} from './services-wire.types';

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

/**
 * Thrown by the start path when an app's `drop.yaml` EXISTS but does not parse,
 * and `strictManifest` is on (DROP-130 Q1). A subclass of the secret park
 * rather than its own error because it is the same event from the operator's
 * side — the app is not broken, its configuration is, and the fix is a config
 * edit followed by a retry. Subclassing also means every `instanceof
 * AppNeedsConfigError` site already routes it to `needs-config` instead of
 * `errored`; only the human-facing text has to distinguish the two.
 *
 * `missingSecrets` is empty and that is the honest value: once the parse has
 * failed, which secrets the manifest declared is exactly what is unknown. Use
 * `needsConfigDetail()` rather than reading `missingSecrets` when rendering
 * this to a caller.
 */
export class AppManifestInvalidError extends AppNeedsConfigError {
  constructor(
    appName: string,
    readonly reason: string,
  ) {
    super(appName, []);
    this.name = 'AppManifestInvalidError';
    this.message =
      `Application '${appName}' has a drop.yaml that does not parse, so it was not started: ${reason}`;
  }
}

/**
 * What the operator has to DO about a `needs-config` park, as a clause that
 * can be embedded in a longer sentence. One function because the two
 * subclasses park for different reasons and every site that renders one must
 * not decide that for itself: "set required secret(s): " with nothing after
 * the colon — which is what the manifest park's empty `missingSecrets`
 * produces — sends the operator looking for a secret that was never the
 * problem.
 */
export function needsConfigAction(err: AppNeedsConfigError): string {
  return err instanceof AppManifestInvalidError
    ? `fix drop.yaml (${err.reason})`
    : `set required secret(s): ${err.missingSecrets.join(', ')}`;
}

/** The whole operator-facing sentence, for handlers that render it alone. */
export function needsConfigDetail(err: AppNeedsConfigError, appName: string): string {
  return `Application '${appName}' needs configuration — ${needsConfigAction(err)}, then retry`;
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
   * Detach a backing service (postgres|redis): persist the owner's
   * 'detached' intent BEFORE any destruction (so a crash or a partial
   * deprovision still leaves a retriable, honest state — see the detach
   * plan's "persist intent first" invariant), stop the app if a runtime
   * process is actually live, dump-then-drop (postgres) or flush-then-free
   * (redis), then restart iff the app was running so the env var actually
   * drops. Resolves once that conditional restart settles (or is skipped).
   *
   * Refusals are RETURNED (see `DetachServiceResult`), never thrown — the
   * one exception is `AppInProgressError` for a concurrent operation on the
   * same app, matching `attachService`'s own contract. No owner-level lock:
   * detach only ever FREES quota, so every interleaving with a concurrent
   * attach errs toward over-refusal, never over-admission.
   */
  detachService(appName: string, serviceId: AttachableServiceId): Promise<DetachServiceResult>;

  /**
   * The owner's persisted attach/detach intent for one service on one app
   * (`AppConfig.services[serviceId]`), or undefined when no intent has ever
   * been recorded. On the seam so the secrets preflight gate and any other
   * route-level reader has one authority for the precedence rule,
   * instead of each re-deriving it from a fresh `getAppConfigService()` read.
   */
  getServiceIntent(appName: string, serviceId: AttachableServiceId): 'attached' | 'detached' | undefined;

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

  /**
   * Re-emit this app's Caddy route blocks from its CURRENT config and reload
   * Caddy — without stopping, rebuilding or restarting it (DROP-152).
   *
   * Exists because route configuration is otherwise reachable only from
   * `app:started` and boot reconciliation. A route-level policy — the browser
   * access gate — that is toggled through the API would therefore write its
   * YAML and change nothing in the running Caddyfile until the app happened to
   * be redeployed: fail-OPEN in the enable direction, with the dashboard
   * reporting the app as gated. (Revocation is unaffected either way; the
   * verify endpoint reads the policy live.)
   *
   * Deliberately not solved with a config fingerprint that forces a redeploy:
   * boot reconciliation re-emits guards anyway, so a fingerprint would buy
   * pointless full rebuilds and still leave the live toggle broken.
   *
   * A no-op (resolves) for an app with no known port — there is no route to
   * re-emit. Rejects with AppInProgressError when a deploy/build/restart is in
   * flight, so it cannot race the route write that deploy will do itself.
   */
  reconfigureRoute(appName: string): Promise<void>;

  /**
   * Whether a browser access gate (DROP-152) can be ENFORCED for this app, and
   * why not when it cannot.
   *
   * On the seam because the platform is the only thing that can answer it. The
   * route previously re-derived the same five inputs from `runtime-config` and
   * `AppConfig`, which made two sources of truth for one authorization
   * question: `authEnabled` came from `enableApiAuth` on one side and
   * `isAuthEnabled()` on the other, `httpsEffective` from `enableHttps` vs
   * `isHttpsEnabled()`, the hostnames from persisted config vs the live
   * `drop.yaml`. The claim that the route could only ever err optimistically
   * was a comment with nothing enforcing it.
   */
  assessAccessGate(appName: string): Promise<AccessGateVerdict>;
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
