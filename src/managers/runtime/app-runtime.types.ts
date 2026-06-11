/**
 * App Runtime Type Definitions
 *
 * Runtime-agnostic types for running deployed applications. These types are
 * owned by DROP, not by any particular runtime (PM2, Docker) — runtime
 * adapters translate their native semantics into these.
 */

/**
 * Which runtime executes an app's process.
 */
export type RuntimeType = 'pm2' | 'docker';

/**
 * DROP-owned process state. Runtime adapters must map their native status
 * values (PM2's 'online'/'launching'/…, Docker's container states) onto this
 * enum; native strings must never leak past an adapter.
 */
export type AppRuntimeState =
  | 'running'
  | 'starting'
  | 'stopping'
  | 'stopped'
  | 'errored'
  | 'unknown';

/**
 * Resource limits for a running app. PM2 can only honor `memory` (via
 * max_memory_restart, a restart-on-exceed rather than a hard cap); Docker
 * enforces both as hard limits.
 */
export interface AppResourceLimits {
  /** Max memory, e.g. '256M', '1G' */
  memory?: string;
  /** CPU share, e.g. 0.5 for half a core */
  cpus?: number;
}

/**
 * What to run and how — the runtime-agnostic start specification.
 */
export interface AppStartSpec {
  /** Application name (unique identifier) */
  name: string;
  /** Script file or command to run */
  script: string;
  /** Working directory (the app's directory) */
  cwd: string;
  /** Interpreter ('node', 'python', 'none' for binaries). Omit for default. */
  interpreter?: string;
  /** Arguments passed to the script */
  args?: string[];
  /** Port the app should listen on (injected as PORT) */
  port?: number;
  /** Environment variables */
  env?: Record<string, string>;
  /** Restart automatically on crash (default true) */
  autorestart?: boolean;
  /** Grace period before force-kill on stop, in ms */
  killTimeout?: number;
  /** stdout log file path (DROP-owned; adapters must write here) */
  outFile?: string;
  /** stderr log file path (DROP-owned; adapters must write here) */
  errorFile?: string;
  /** Resource limits */
  limits?: AppResourceLimits;
}

/**
 * A running (or known) app process as reported by a runtime.
 *
 * Field semantics are part of the public API contract (exposed via
 * /api/v1/apps and /api/v1/health):
 * - `memory` is bytes, `cpu` is percent, `uptime` is ms.
 * - `restarts` counts runtime-initiated restarts since the process was
 *   created (PM2 restart_time; Docker RestartCount).
 * - `pid` is the host PID for PM2; for containers it is the container's
 *   init PID as seen from the host, or null if unavailable.
 */
export interface AppProcessInfo {
  name: string;
  status: AppRuntimeState;
  runtime: RuntimeType;
  pid: number | null;
  port: number | null;
  memory: number;
  cpu: number;
  uptime: number;
  restarts: number;
  createdAt: Date | null;
  restartedAt: Date | null;
}

/**
 * Log file locations for an app.
 */
export interface AppLogPaths {
  out?: string;
  err?: string;
}
