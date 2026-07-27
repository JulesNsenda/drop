/**
 * Event Bus Type Definitions
 *
 * Defines all event types, payloads, and handlers for the DROP event system.
 */

// Type-only, and acyclic: builder.types imports from detector only, never from
// here. The build stage is genuinely a builder concept and the event carries
// it, so the alternative — restating the union here — would just create a
// second definition to drift.
import type { BuildStage } from '../builder/builder.types';

// Platform events
export type PlatformEventType =
  | 'platform:starting'
  | 'platform:started'
  | 'platform:stopping'
  | 'platform:stopped'
  | 'platform:error';

// App lifecycle events
export type AppEventType =
  | 'app:detected'
  | 'app:created'
  | 'app:updated'
  | 'app:update'
  | 'app:removed'
  | 'app:deleted'
  | 'app:starting'
  | 'app:started'
  | 'app:stopping'
  | 'app:stopped'
  | 'app:error';

// Build events
export type BuildEventType =
  | 'build:queued'
  | 'build:started'
  | 'build:progress'
  | 'build:completed'
  | 'build:failed';

// Deploy-outcome events (distinct from the legacy Deployment* family below,
// which nothing currently publishes).
export type DeployEventType = 'deploy:failed';

// Deployment events
export type DeploymentEventType =
  | 'deployment:started'
  | 'deployment:completed'
  | 'deployment:failed'
  | 'deployment:rolledback';

// Watcher events
export type WatcherEventType =
  | 'watcher:started'
  | 'watcher:stopped'
  | 'watcher:change';

// All event types
export type EventType =
  | PlatformEventType
  | AppEventType
  | BuildEventType
  | DeployEventType
  | DeploymentEventType
  | WatcherEventType;

// Base event structure
export interface BaseEvent {
  timestamp: Date;
  source?: string;
}

// Platform event payloads
export interface PlatformStartingPayload extends BaseEvent {
  config: Record<string, unknown>;
}

export interface PlatformStartedPayload extends BaseEvent {}

export interface PlatformStoppingPayload extends BaseEvent {}

export interface PlatformStoppedPayload extends BaseEvent {}

export interface PlatformErrorPayload extends BaseEvent {
  error: Error;
  context?: string;
}

// App event payloads
export interface AppDetectedPayload extends BaseEvent {
  name: string;
  path: string;
  type?: string;
  /** Set when detection was triggered by an upload-deploy (PRD-039), not the file watcher. */
  origin?: 'upload';
  /**
   * Who asked for this deploy, for guardrail keying — NOT for authorization,
   * which happened at the route or tool boundary before this was published.
   *
   * Absent when DROP triggered the deploy itself (the file watcher, boot
   * reconciliation), which is why the breaker has a separate automation key
   * rather than lumping those in with an anonymous caller.
   */
  principalId?: string;
  /**
   * The human the principal is acting for, for the coarser backstop window.
   *
   * Deliberately NOT read off the app's own state: a NEW app has no state yet,
   * so keying the backstop on the app owner would put every user's first-deploy
   * failures in one shared bucket and let any user lock out every other.
   */
  actorUserId?: string;
}

export interface AppCreatedPayload extends BaseEvent {
  appId: string;
  name: string;
  type: string;
}

export interface AppUpdatedPayload extends BaseEvent {
  appId: string;
  changes: Record<string, unknown>;
}

export interface AppUpdatePayload extends BaseEvent {
  name: string;
  path: string;
  reason: string;
  /** See AppDetectedPayload.principalId. */
  principalId?: string;
  /** See AppDetectedPayload.actorUserId. */
  actorUserId?: string;
  /**
   * Set when DROP triggered this itself. Kept distinct from "no principal" so a
   * looping webhook cannot consume the app owner's guardrail quota.
   */
  automationSource?: 'webhook';
  /** Set by an explicit redeploy (git pull / webhook) so the anti-loop cooldown doesn't swallow it. */
  bypassCooldown?: boolean;
}

export interface AppRemovedPayload extends BaseEvent {
  appId: string;
  name: string;
}

export interface AppDeletedPayload extends BaseEvent {
  appId: string;
  name: string;
}

export interface AppStartingPayload extends BaseEvent {
  appId: string;
  name: string;
}

export interface AppStartedPayload extends BaseEvent {
  appId: string;
  name: string;
  port: number;
  pid?: number;
}

export interface AppStoppingPayload extends BaseEvent {
  appId: string;
  name: string;
}

export interface AppStoppedPayload extends BaseEvent {
  appId: string;
  name: string;
  exitCode?: number;
}

export interface AppErrorPayload extends BaseEvent {
  appId: string;
  name: string;
  error: Error;
  context?: string;
}

// Build event payloads
export interface BuildQueuedPayload extends BaseEvent {
  appId: string;
  buildId: string;
}

/**
 * The platform-minted deploy id, threaded from the call site that began this
 * deploy through the build to DeployTracker, so one deploy is addressable end
 * to end (build log file, episode, structured result).
 *
 * OPTIONAL on purpose. DeployTracker keeps its mint-a-fresh-one fallback for
 * any publisher that doesn't supply it — tests constructing payloads by hand,
 * and any future publisher — so the fallback stays live code rather than
 * becoming unreachable. The tracker logs when it takes that path.
 */
export interface BuildStartedPayload extends BaseEvent {
  appId: string;
  buildId: string;
  deployId?: string;
}

export interface BuildProgressPayload extends BaseEvent {
  appId: string;
  buildId: string;
  step: string;
  progress: number; // 0-100
  message?: string;
}

export interface BuildCompletedPayload extends BaseEvent {
  appId: string;
  buildId: string;
  durationMs: number;
  /** Whether the build succeeded. Subscribers must not start the app when false. */
  success: boolean;
  /**
   * Build output directory relative to the app root (e.g. 'dist'), as reported
   * by the build strategy. Carried in the payload because dispatch is
   * synchronous inside build(): the start handler runs before the builder's
   * caller can persist anything, so this is the only race-free way for the
   * start path to learn where a static build's output landed.
   */
  outputPath?: string;
  /** See BuildStartedPayload.deployId. */
  deployId?: string;
}

export interface BuildFailedPayload extends BaseEvent {
  appId: string;
  buildId: string;
  error: Error;
  logs?: string;
  /** See BuildStartedPayload.deployId. */
  deployId?: string;
  /**
   * The builder's own BuildError code when it has one — 'NO_STRATEGY',
   * 'MAX_BUILDS', 'EXCEPTION'. DROP-generated. Lets a consumer tell a
   * genuinely unbuildable app type apart from any other pre-build failure,
   * which `stage` alone cannot ('pre-build' covers both).
   */
  code?: string;
  /**
   * Which stage failed. REQUIRED, unlike the other additions here: the builder
   * has always known this and simply never published it, so DeployTracker
   * hardcoded `category: 'build-failed'` while its type documented three
   * values — a constant that `GET /api/v1/deploys` reported as if it
   * discriminated. Requiring it means a publisher cannot reintroduce that by
   * omission.
   */
  stage: BuildStage;
  /** Process exit code, when the failing stage ran a command that reported one. */
  exitCode?: number;
  /**
   * The failing command, truncated by the publisher. DROP-generated (composed
   * from the strategy and the app's drop.yaml `build`), NOT process output —
   * which is what makes it safe to persist alongside a deploy row, where
   * `error.message` is not.
   */
  command?: string;
}

/**
 * Where a deploy died, for failures AFTER the build. `build:failed` already
 * covers the build phase and carries its own stage.
 */
export type DeployFailurePhase = 'boot';

/**
 * Why a post-build deploy failed. A CLOSED SET of DROP-generated categories,
 * never free-form text: this rides into a persisted record, and the
 * never-store-a-raw-error-message rule (deploy-tracker.ts) applies to
 * everything that lands there.
 *
 * These are exactly the two verdicts `awaitReadiness` can actually reach on
 * its failure path. There is deliberately no 'never-answered' member: an app
 * that binds but never answers HTTP is NOT a failure — it resolves
 * `{ ok: true, warning }` and becomes `AppState.readinessUnverified` (DROP-063
 * leniency for slow starters). Adding a member no publisher can produce would
 * be the same unreachable-value defect as a constant field.
 */
export type DeployFailureReason = 'process-exited' | 'crash-looped' | 'oom-killed';

/**
 * A deploy that got past the build and then failed. Widens the boot-failure
 * signal the way Step 1 widened build:failed, so ONE bus subscriber covers
 * every start path instead of six write sites duplicated across
 * handleStartApp / handleAppUpdate / restartApp.
 *
 * Carries no deployId: subscribers correlate by app name against the episode
 * opened at build:started, exactly as DeployTracker already does. The boot
 * phase runs in a different handler from the one that minted the id, so
 * threading it here would mean plumbing it through the start spec for no gain.
 */
export interface DeployFailedPayload extends BaseEvent {
  appId: string;
  phase: DeployFailurePhase;
  reason: DeployFailureReason;
}

// Deployment event payloads
export interface DeploymentStartedPayload extends BaseEvent {
  appId: string;
  deploymentId: string;
  version?: string;
}

export interface DeploymentCompletedPayload extends BaseEvent {
  appId: string;
  deploymentId: string;
  durationMs: number;
}

export interface DeploymentFailedPayload extends BaseEvent {
  appId: string;
  deploymentId: string;
  error: Error;
}

export interface DeploymentRolledbackPayload extends BaseEvent {
  appId: string;
  deploymentId: string;
  previousVersion: string;
}

// Watcher event payloads
export interface WatcherStartedPayload extends BaseEvent {
  path: string;
}

export interface WatcherStoppedPayload extends BaseEvent {
  path: string;
}

export interface WatcherChangePayload extends BaseEvent {
  path: string;
  changeType: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';
  relativePath: string;
}

// Event payload type mapping
export interface EventPayloadMap {
  'platform:starting': PlatformStartingPayload;
  'platform:started': PlatformStartedPayload;
  'platform:stopping': PlatformStoppingPayload;
  'platform:stopped': PlatformStoppedPayload;
  'platform:error': PlatformErrorPayload;
  'app:detected': AppDetectedPayload;
  'app:created': AppCreatedPayload;
  'app:updated': AppUpdatedPayload;
  'app:update': AppUpdatePayload;
  'app:removed': AppRemovedPayload;
  'app:deleted': AppDeletedPayload;
  'app:starting': AppStartingPayload;
  'app:started': AppStartedPayload;
  'app:stopping': AppStoppingPayload;
  'app:stopped': AppStoppedPayload;
  'app:error': AppErrorPayload;
  'build:queued': BuildQueuedPayload;
  'build:started': BuildStartedPayload;
  'build:progress': BuildProgressPayload;
  'build:completed': BuildCompletedPayload;
  'build:failed': BuildFailedPayload;
  'deploy:failed': DeployFailedPayload;
  'deployment:started': DeploymentStartedPayload;
  'deployment:completed': DeploymentCompletedPayload;
  'deployment:failed': DeploymentFailedPayload;
  'deployment:rolledback': DeploymentRolledbackPayload;
  'watcher:started': WatcherStartedPayload;
  'watcher:stopped': WatcherStoppedPayload;
  'watcher:change': WatcherChangePayload;
}

// Generic event payload type
export type EventPayload<T extends EventType> = T extends keyof EventPayloadMap
  ? EventPayloadMap[T]
  : BaseEvent;

// Handler types
export type EventHandler<T extends EventType> = (payload: EventPayload<T>) => void | Promise<void>;

export type GlobalEventHandler = (event: DropEvent) => void | Promise<void>;

// Unsubscribe function type
export type Unsubscribe = () => void;

// Full event object (for history and global handlers)
export interface DropEvent<T extends EventType = EventType> {
  id: string;
  type: T;
  payload: EventPayload<T>;
  timestamp: Date;
}

// Event history query options
export interface EventHistoryOptions {
  limit?: number;
  eventType?: EventType;
  since?: Date;
  appId?: string;
}
