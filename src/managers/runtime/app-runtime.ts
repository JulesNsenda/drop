/**
 * AppRuntime Interface
 *
 * The seam between the platform and whatever executes deployed apps.
 * PM2 (process on the host) and Docker (container) each implement this;
 * the platform, API routes, and CLI consume only this interface.
 *
 * Contract notes for implementors:
 * - Adapters must emit the same EventBus events the pipeline relies on:
 *   'app:starting'/'app:started' on start, 'app:stopping'/'app:stopped' on
 *   stop, and 'app:error' (with context) on failures.
 * - `start` resolves only once the app is actually running, and rejects on
 *   timeout or error — callers treat a resolved promise as "app is up".
 * - App stdout/stderr must be written to the spec's outFile/errorFile so
 *   the logs API/CLI/dashboard work identically across runtimes.
 * - Native status strings must be mapped to AppRuntimeState; they are an
 *   implementation detail.
 */

import {
  AppLogPaths,
  AppProcessInfo,
  AppStartSpec,
  RuntimeType,
} from './app-runtime.types';

export interface AppRuntime {
  /** Which runtime this is */
  readonly type: RuntimeType;

  /** Start an app; resolves when it is running */
  start(spec: AppStartSpec): Promise<AppProcessInfo>;

  /** Stop an app (no-op if not running) */
  stop(name: string): Promise<void>;

  /** Restart an app; resolves when it is running again */
  restart(name: string): Promise<AppProcessInfo>;

  /** Remove an app from the runtime entirely (stopped or not) */
  delete(name: string): Promise<void>;

  /** Status of one app, or null if the runtime doesn't know it */
  getStatus(name: string): Promise<AppProcessInfo | null>;

  /** Status of every app this runtime knows about */
  getAllStatus(): Promise<AppProcessInfo[]>;

  /**
   * Cheap liveness check: is the runtime reachable, and how many apps does it
   * know about? Returns the count; throws if the runtime cannot be reached.
   *
   * Deliberately NOT `getAllStatus().length`. Under docker isolation
   * getAllStatus fetches live CPU/memory for EVERY container, and
   * `container.stats({stream:false})` samples twice so precpu_stats is valid —
   * ~1s per container even run concurrently. The health endpoint's probe
   * budget is 2s, so a five-container fleet sat exactly on the boundary and
   * flapped between healthy and degraded on ±30ms of jitter, returning
   * intermittent 503s. It also got monotonically worse per app added.
   *
   * Liveness does not need performance telemetry. Implementations must answer
   * this without collecting per-app stats.
   */
  countManaged(): Promise<number>;

  /** Last `lines` lines of combined logs */
  getLogs(name: string, lines?: number): Promise<string>;

  /** Follow logs; returns a stop function */
  streamLogs(
    name: string,
    onLine: (line: string, type: 'out' | 'err') => void,
    onError?: (error: Error) => void
  ): Promise<() => void>;

  /** Where this app's log files live */
  getLogPaths(name: string): Promise<AppLogPaths>;

  /** Release runtime connections (PM2 daemon link, Docker client) */
  disconnect(): void;
}
