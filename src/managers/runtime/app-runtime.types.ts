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
  /**
   * Detected app type — used by the container runtime to pick the correct
   * base image.  PM2 runtime ignores it.
   */
  appType?: string;
  /**
   * Override the base image for the container runtime (must be an absolute
   * image reference from the DROP-approved image list; arbitrary tenant
   * values are validated by ContainerManager before use).
   * Only honoured when isolation === 'docker' and appType === 'docker'.
   */
  runtimeImage?: string;
  /**
   * HTTP path for health checking (e.g. "/health").  When set:
   * - Docker mode: injected as HEALTHCHECK CMD.
   * - PM2 mode: platform prober polls this path and restarts on failure.
   */
  healthCheckPath?: string;
  /**
   * Absolute path to the Postgres unix-domain socket directory on the host.
   * When set (docker isolation mode) the container runtime bind-mounts this
   * directory read-only at the same absolute path inside the container so the
   * app can reach the bundled Postgres without TCP.
   */
  pgSocketDir?: string;
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
  /**
   * Whether the kernel OOM-killed this app, from `State.OOMKilled`.
   *
   * DOCKER ONLY, and only while the container is actually down. DROP runs
   * containers with `RestartPolicy: on-failure` (max 5), and Docker clears the
   * flag on the new run — so an app that is up again after an OOM reads
   * `false`, not `true`. It is authoritative when true and says nothing when
   * false.
   *
   * Always `undefined` under PM2, which cannot report this at all:
   * `max_memory_restart` RESTARTS on exceed rather than capping, so an OOM is
   * indistinguishable from any other crash-loop. Left undefined rather than
   * `false` so the two cases stay distinguishable — "not OOM" vs "cannot know".
   */
  oomKilled?: boolean;
  /**
   * CUMULATIVE CPU time consumed by this app, in nanoseconds.
   *
   * Monotonic for the life of one process, which is what makes it usable as an
   * "did this app do any work since the last sweep?" signal — `cpu` above is an
   * instantaneous percentage, and a request served between two samples leaves
   * no trace in it at all.
   *
   * DOCKER ONLY. PM2 reports only an instantaneous percentage, so it is left
   * `undefined` rather than 0 — "cannot know" must stay distinguishable from
   * "did no work", or an idle reaper would read every PM2 app as permanently
   * idle and delete the fleet.
   */
  cpuTotalNs?: number;
}

/**
 * Log file locations for an app.
 */
export interface AppLogPaths {
  out?: string;
  err?: string;
}
