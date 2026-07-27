/**
 * DeployTracker Types
 *
 * Frozen public contract for the deploy-observability feature (P2-4). A
 * deploy is recorded as a set of flat, append-only `DeployRow`s correlated by
 * an observer-minted `deployId`. `DeployEpisode` (and its `status`) is never
 * persisted — it is derived at read time from the rows.
 */

/**
 * Why a build failed, derived from the failing build stage.
 *
 * Was documented as an inline three-value comment while the producer
 * hardcoded a single constant — so `GET /api/v1/deploys` reported a fixed
 * string as though it discriminated. Now a real type with a real mapping (see
 * `categoryForStage`), and 'postbuild-failed' is added because the optimize /
 * post-build / validate stages fit none of the original three.
 */
export type DeployFailureCategory =
  | 'prebuild-failed'
  | 'install-failed'
  | 'build-failed'
  | 'postbuild-failed';

export type DeployStageName =
  | 'triggered'
  | 'build-started'
  | 'build'
  | 'build-failed'
  | 'running'
  | 'errored';

export interface DeployRow {
  deployId: string;
  appName: string;
  userId?: string; // owner snapshot at build:started (undefined = unowned/legacy)
  stage: DeployStageName;
  at: string; // ISO
  ok?: boolean; // for 'build' stage = payload.success
  category?: DeployFailureCategory; // set on the 'build-failed' stage only
  detail?: string; // SANITIZED: relative paths only, NEVER raw error.message
  /** Exit code of the failing command, when it reported one. */
  exitCode?: number;
  /**
   * The failing command, truncated by the publisher. Safe to persist: it is
   * DROP-composed, not process output. `detail`'s never-raw-message rule is
   * unaffected — this is a separate, structured field.
   */
  command?: string;
}

export type DeployStatus = 'in-progress' | 'succeeded' | 'failed' | 'superseded' | 'interrupted';

export interface DeployStage {
  stage: DeployStageName;
  at: string;
  durationMs?: number; // from previous stage
  ok?: boolean;
  category?: DeployFailureCategory;
  exitCode?: number;
  command?: string;
}

export interface DeployEpisode {
  // DERIVED at read time from rows
  deployId: string;
  appName: string;
  /**
   * Owner snapshot taken at build:started (from the episode's rows), NOT a
   * live lookup. Callers MUST tenant-filter on this snapshot — filtering by a
   * live `getApp(appName).userId` leaks a deleted tenant's history to whoever
   * re-registers the freed app name. Strip this before returning to clients.
   */
  userId?: string;
  trigger: 'deploy' | 'hot-reload' | 'upload' | 'unknown';
  status: DeployStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  stages: DeployStage[];
}
