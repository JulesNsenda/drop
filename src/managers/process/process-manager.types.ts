/**
 * Process Manager Type Definitions
 *
 * Types for process management and PM2 integration.
 */

/**
 * Process execution mode
 */
export type ExecMode = 'fork' | 'cluster';

/**
 * Process status values
 */
export type ProcessStatusValue =
  | 'online'
  | 'stopping'
  | 'stopped'
  | 'errored'
  | 'launching'
  | 'one-launch-status';

/**
 * Configuration for starting a process
 */
export interface ProcessConfig {
  /** Application name (unique identifier) */
  name: string;
  /** Script or command to run */
  script: string;
  /** Working directory */
  cwd: string;
  /** Number of instances or 'max' for CPU count */
  instances?: number | 'max';
  /** Execution mode: fork or cluster */
  execMode?: ExecMode;
  /** Max memory before restart (e.g., '512M') */
  maxMemoryRestart?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Auto restart on crash */
  autorestart?: boolean;
  /** Kill timeout in milliseconds */
  killTimeout?: number;
  /** Node arguments */
  nodeArgs?: string[];
  /** Script arguments */
  args?: string[];
  /** Interpreter (e.g., 'node', 'python') */
  interpreter?: string;
  /** Watch for file changes */
  watch?: boolean;
  /** Ignore watch patterns */
  ignoreWatch?: string[];
  /** Log file path */
  logFile?: string;
  /** Error log file path */
  errorFile?: string;
  /** Output log file path */
  outFile?: string;
  /** Merge stdout and stderr */
  mergeLogs?: boolean;
  /** Cron restart pattern */
  cron?: string;
  /** Max restarts within time window */
  maxRestarts?: number;
  /** Restart delay in milliseconds */
  restartDelay?: number;
  /** Port for the application */
  port?: number;
}

/**
 * Process metrics
 */
export interface ProcessMetrics {
  /** Memory usage in bytes */
  memory: number;
  /** CPU percentage */
  cpu: number;
  /** Heap used in bytes */
  heapUsed?: number;
  /** Heap total in bytes */
  heapTotal?: number;
  /** Event loop latency in ms */
  eventLoopLatency?: number;
}

/**
 * Status of a running process
 */
export interface ProcessStatus {
  /** Application name */
  name: string;
  /** Current status */
  status: ProcessStatusValue;
  /** Process ID (null if not running) */
  pid: number | null;
  /** PM2 process ID */
  pmId: number | null;
  /** Number of running instances */
  instances: number;
  /** Memory usage in bytes */
  memory: number;
  /** CPU percentage */
  cpu: number;
  /** Uptime in milliseconds */
  uptime: number;
  /** Number of restarts */
  restarts: number;
  /** Execution mode */
  execMode: ExecMode;
  /** Whether process is watching for changes */
  watching: boolean;
  /** Process created timestamp */
  createdAt: Date | null;
  /** Last restart timestamp */
  restartedAt: Date | null;
}

/**
 * Process log entry
 */
export interface ProcessLog {
  timestamp: Date;
  type: 'out' | 'err';
  message: string;
}

/**
 * Process Manager configuration
 */
export interface ProcessManagerConfig {
  /** PM2 home directory */
  pm2Home?: string;
  /** Default kill timeout */
  defaultKillTimeout: number;
  /** Default max restarts */
  defaultMaxRestarts: number;
  /** Default restart delay */
  defaultRestartDelay: number;
  /** Log directory */
  logDirectory?: string;
}

/**
 * PM2 process description (from PM2 API)
 */
export interface PM2ProcessDescription {
  name?: string;
  pm_id?: number;
  pid?: number;
  monit?: {
    memory?: number;
    cpu?: number;
  };
  pm2_env?: {
    status?: string;
    pm_uptime?: number;
    restart_time?: number;
    exec_mode?: string;
    watch?: boolean;
    created_at?: number;
    pm_pid_path?: string;
    pm_out_log_path?: string;
    pm_err_log_path?: string;
    instances?: number;
    PORT?: string;
    [key: string]: unknown;
  };
}

/**
 * PM2 start options
 */
export interface PM2StartOptions {
  name: string;
  script: string;
  cwd: string;
  instances?: number;
  exec_mode?: 'fork' | 'cluster';
  max_memory_restart?: string;
  env?: Record<string, string>;
  autorestart?: boolean;
  kill_timeout?: number;
  node_args?: string[];
  args?: string[];
  interpreter?: string;
  watch?: boolean;
  ignore_watch?: string[];
  log_file?: string;
  error_file?: string;
  out_file?: string;
  merge_logs?: boolean;
  cron_restart?: string;
  max_restarts?: number;
  restart_delay?: number;
}
