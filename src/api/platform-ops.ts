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
import type { RollbackSnapshotMeta } from '../managers/rollback';
import type { SuspensionRefusal } from '../managers/suspension/suspension-store';
// Only the three the PlatformOps interface below actually references —
// DetachServiceOutcome/DetachServiceRestartOutcome are re-exported (below)
// but not used in this file's own signatures.
import type { AttachableServiceId, AttachServiceResult, DetachServiceResult } from './services-wire.types';
import type { AccessGateVerdict } from '../managers/guardrail/access-gate';
import type { DeployActorInfo } from '../managers/guardrail/deploy-breaker';
import type { TokenCaller } from '../core/git-deploy/git-deploy.types';

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
 * Thrown when an administrator has suspended the app: nothing may start it
 * (a start, restart, deploy step or the health prober) until it is unsuspended.
 * Thrown by the platform's single start choke point, so no start path can skip it.
 *
 * `reason` says WHY: a `record` is an administrator's act; `store-unreadable`
 * means the suspension store cannot be read, so every app is refused until it is
 * repaired; `not-loaded` means it has not been loaded yet (early boot). They must
 * not be conflated, or an operator hunts for an administrator who suspended an
 * app that nobody suspended.
 */
export type AppSuspendedReason = SuspensionRefusal;

export class AppSuspendedError extends Error {
  readonly code = 'APP_SUSPENDED';

  constructor(
    readonly appName: string,
    readonly reason: AppSuspendedReason = 'record'
  ) {
    super(
      reason === 'record'
        ? `Application '${appName}' is suspended by an administrator`
        : reason === 'not-loaded'
          ? `Starting '${appName}' is refused: suspension store not loaded yet`
          : `The suspension store is unreadable, so starting '${appName}' is refused until it is repaired`
    );
    this.name = 'AppSuspendedError';
  }

  /**
   * What a caller who is not an administrator may be told. A `record` is an
   * administrator's act and already shows on the app; the suspension store's own
   * state (unreadable, not loaded) is the platform's, and is for admins and the
   * server log only.
   */
  get tenantMessage(): string {
    return this.reason === 'record'
      ? this.message
      : `Starting '${this.appName}' is refused right now; contact your administrator`;
  }

  /** The one renderer: the specific text for an administrator, the tenant-safe one for anyone else. */
  messageFor(isAdmin: boolean): string {
    return isAdmin ? this.message : this.tenantMessage;
  }
}

/**
 * The episode code for a suspended refusal: DEPLOY_STOPPED only for an
 * administrator's record. When the store merely cannot answer, nobody stopped
 * anything and the old instance may still be serving, so it is a refusal.
 */
export function suspensionEpisodeCode(reason: AppSuspendedReason): 'DEPLOY_STOPPED' | 'DEPLOY_REFUSED' {
  return reason === 'record' ? 'DEPLOY_STOPPED' : 'DEPLOY_REFUSED';
}

/**
 * Thrown before a start, restart, rollback, promotion or attach that would run
 * a node_modules tree built for a different Node runtime. Those entry points
 * throw it before touching anything; the start-spec backstop beneath them can
 * throw it after its caller's own side effects (see assertDependenciesCurrent).
 * An explicit redeploy rebuilds the tree, a stopped app included. The message
 * names no path, marker or Node version: it reaches tenants through the API
 * and MCP.
 */
export class StaleDependenciesError extends Error {
  readonly code = 'STALE_DEPENDENCIES';

  constructor(appName: string) {
    super(
      `Application '${appName}' was not started: this version's dependencies were built for a ` +
        'different Node runtime. Redeploy the app to rebuild them.'
    );
    this.name = 'StaleDependenciesError';
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

/** Why an explicit redeploy was refused. The route maps each code to its status. */
export type RedeployRefusalCode =
  | 'NOT_FOUND'
  | 'APP_SOURCE_MISSING'
  | 'APP_BUSY'
  | 'SERVICE_UNAVAILABLE'
  | 'APP_STOPPED'
  // An administrator suspended the app: retrying cannot help, and it is never the "start it" hint.
  | 'APP_SUSPENDED'
  // A git-backed app whose recorded repository URL no longer validates.
  | 'INVALID_GIT_SOURCE'
  // A service of a git-deployed group: its container holds the repository.
  | 'REDEPLOY_VIA_CONTAINER'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_DISK';

export type RedeployRefusal =
  | {
      code: Exclude<RedeployRefusalCode, 'APP_SUSPENDED'>;
      message: string;
      retryAfterSeconds?: number;
      suspension?: undefined;
    }
  // Why, so each surface renders it through AppSuspendedError.messageFor.
  | { code: 'APP_SUSPENDED'; message: string; retryAfterSeconds?: undefined; suspension: AppSuspendedReason };

/**
 * What an explicit redeploy came to: started (it has a builder slot and the
 * deploy id it builds under), accepted (it carries on in the background and has
 * no id yet: no slot within the wait, or a git-backed app, whose clone never
 * runs inside the request), a group (the app is a monorepo container, which is
 * re-expanded rather than built, in the background: its services deploy under
 * their own names), or refused.
 */
export type RedeployStart =
  | { started: string }
  | { accepted: true }
  | { group: { container: string } }
  | { refused: RedeployRefusal };

/** What `suspendApp` did: the app is down, or the suspension was refused. */
export type SuspendAppResult =
  /** `stopErrors` names instances still live afterwards; the suspension is recorded regardless. */
  | { suspended: true; at: string; stopErrors?: string[] }
  /** A monorepo container runs nothing itself - its services are the runtime apps. */
  | { refused: 'group-container'; services: string[] }
  /** Another existing app differs only in case; the store matches ignoring case, so it would be suspended too. */
  | { refused: 'case-collision'; names: string[] };

/** What `unsuspendApp` did: whether a record was lifted, or the same case-collision refusal. */
export type UnsuspendAppResult = { unsuspended: boolean } | { refused: 'case-collision'; names: string[] };

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
   * Suspend an app (admin): record the suspension FIRST (a failed write
   * rejects, and nothing is touched), then stop the prober and crash-loop
   * watch, delete both runtime slots, remove its routes and its minted
   * DROP_API_KEY, and leave it `stopped`. The record is name-keyed and
   * outlives the app's config; every start path refuses while it exists.
   * A monorepo container is refused (returned), naming its services.
   */
  suspendApp(appName: string, by: string, reason?: string): Promise<SuspendAppResult>;

  /**
   * Lift a suspension (admin). Writes `stopped` explicitly, so the owner then
   * starts the app deliberately. `unsuspended: false` when there was no suspension.
   */
  unsuspendApp(appName: string): Promise<UnsuspendAppResult>;

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
   * Atomically claim the app's slot in the platform's in-progress set, so no
   * build, restart or deploy can start while the caller writes its folder.
   * Returns the release function, or `null` when the app is already busy (or
   * the platform is quiesced). A build that arrives meanwhile is deferred, not
   * dropped. The holder MUST call the release.
   */
  tryReserveApp(appName: string): (() => void) | null;

  /**
   * Whether a build container for the app exists right now (running, or left
   * behind by a crash). Only meaningful under docker isolation; resolves false
   * elsewhere.
   */
  hasLiveBuildContainer(appName: string): Promise<boolean>;

  /**
   * Whether deleting the app (without keepData) would destroy an
   * object-storage bucket: `bucket` when it has one, `unknown` when the
   * allocation store cannot be read (it cannot be proven otherwise, so callers
   * treat it as `bucket`), `none` otherwise. Lets the delete route demand an
   * explicit confirmation before it stops anything.
   */
  objectStorageDeleteRisk(appName: string): Promise<'none' | 'bucket' | 'unknown'>;

  /**
   * Retire the app's object-storage allocation off its name and revoke its
   * IAM key (#301). Called by the delete route BEFORE any other teardown step,
   * so the name is free of the previous tenant's bucket the moment the app
   * stops. The bucket drains in the background unless `keepData`. Idempotent;
   * never throws for an AWS failure.
   */
  retireObjectStorage(appName: string, opts?: { keepData?: boolean }): Promise<void>;

  /**
   * Put a held (built-but-unpromoted) build in front of traffic.
   *
   * Starts exactly what was built rather than rebuilding — a rebuild could pick
   * up source that changed since the operator looked at it, promoting something
   * nobody approved. Rejects when nothing is held.
   */
  promoteApp(appName: string): Promise<void>;

  /**
   * Go back to what served before the last deploy, without rebuilding: cut
   * over to the app's previous release when it has one (#298 step 6), else
   * restore its last-good tree (captured before the redeploy that replaced
   * it) and restart it on its existing port (#296). Rejects with NoRollbackSnapshotError when nothing was captured,
   * AppInProgressError when the app is busy. Restores CODE only — see
   * `NOT_RESTORED` in managers/rollback.
   */
  rollbackApp(appName: string): Promise<{ meta: RollbackSnapshotMeta; info: AppProcessInfo }>;

  /**
   * What `rollbackApp` would go back to — the previous release (#298 step 6)
   * or the snapshot — without doing it; null when there is nothing.
   */
  describeRollback(appName: string): Promise<RollbackSnapshotMeta | null>;

  /**
   * Redeploy an app explicitly (rebuilt as it stands; a git-backed app first
   * lands its repository's newest commit). ONE operation, and the reservation
   * never leaves the platform: it takes the app's slot, decides under it that
   * the app exists, is not busy, passes the stopped rule, has disk and is
   * admitted by the deploy guardrails (once), lands a git-backed app, and
   * starts. A monorepo container is re-expanded instead of built. An admitted
   * request counts against the caller's deploy quota whatever becomes of it -
   * the quota counts volume, not outcome. `options.caller` is who is asking,
   * for the git token rules; the app's stored token is the only one used.
   *
   * Waits for a builder slot, at most DROP_REDEPLOY_START_WAIT_MS (10 seconds). In time:
   * `started`, with the id the build runs under (its episode follows within
   * moments). Not in time: `accepted` - the redeploy carries on in the
   * background, a refusal after the wait is recorded as a failed deploy
   * (DEPLOY_REFUSED) the caller can follow, and a throw is logged. Refusals are
   * returned, never thrown; the slot and the breaker keys are given back on
   * every path. Authorization is the caller's.
   */
  redeployApp(
    appName: string,
    actor: DeployActorInfo,
    options?: { caller?: TokenCaller | null }
  ): Promise<RedeployStart>;

  /**
   * Whether any app in the same monorepo group as `appName` is busy in a way
   * that forbids touching it: for a container, any of its children; for a
   * child, its container. False for an app outside any group.
   */
  isGroupBusy(appName: string): boolean;

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

  /**
   * Hold the deploy pipeline still for `durationMs` so `drop backup` can take a
   * self-consistent snapshot, then wait for in-flight deploys to drain
   * (P2-5b). Resolves with whether the drain actually completed — `false` means
   * a deploy outlived the drain window and the snapshot may straddle it.
   *
   * The duration is a LEASE with a hard ceiling, because the caller is a
   * separate process that can be killed: nothing here can wedge the platform
   * into refusing deploys indefinitely.
   */
  quiesce(durationMs: number): Promise<{ drained: boolean; until: number }>;

  /** Release the hold early — what `drop backup` calls in its `finally`. */
  resumeFromQuiesce(): void;

  /** Whether the pipeline is currently held. */
  isQuiesced(): boolean;
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
