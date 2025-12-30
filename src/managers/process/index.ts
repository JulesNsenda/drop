/**
 * Process Manager Module
 *
 * Exports the ProcessManager and related types.
 */

export {
  ProcessManager,
  createProcessManager,
  getProcessManager,
  resetProcessManager,
} from './process-manager';

// Re-export PM2 client for advanced usage
export * as pm2Client from './pm2-client';

export type {
  ProcessConfig,
  ProcessStatus,
  ProcessStatusValue,
  ProcessMetrics,
  ProcessLog,
  ProcessManagerConfig,
  ExecMode,
  PM2ProcessDescription,
  PM2StartOptions,
} from './process-manager.types';
