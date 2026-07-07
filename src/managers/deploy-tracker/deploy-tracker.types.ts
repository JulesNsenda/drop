/**
 * DeployTracker Types
 *
 * Frozen public contract for the deploy-observability feature (P2-4). A
 * deploy is recorded as a set of flat, append-only `DeployRow`s correlated by
 * an observer-minted `deployId`. `DeployEpisode` (and its `status`) is never
 * persisted — it is derived at read time from the rows.
 */

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
  category?: string; // for 'build-failed': 'install-failed'|'build-failed'|'prebuild-failed'
  detail?: string; // SANITIZED: relative paths only, NEVER raw error.message
}

export type DeployStatus = 'in-progress' | 'succeeded' | 'failed' | 'superseded' | 'interrupted';

export interface DeployStage {
  stage: DeployStageName;
  at: string;
  durationMs?: number; // from previous stage
  ok?: boolean;
  category?: string;
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
  trigger: 'deploy' | 'hot-reload' | 'unknown';
  status: DeployStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  stages: DeployStage[];
}
