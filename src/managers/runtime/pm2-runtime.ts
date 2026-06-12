/**
 * PM2 Runtime Adapter
 *
 * Implements AppRuntime on top of the existing ProcessManager (PM2).
 * Pure delegation: ProcessManager keeps its PM2 semantics and EventBus
 * emissions; this adapter only translates between the runtime-agnostic
 * types and PM2's.
 */

import { ProcessManager, getProcessManager } from '../process';
import {
  ProcessConfig,
  ProcessStatus,
  ProcessStatusValue,
} from '../process/process-manager.types';
import { AppRuntime } from './app-runtime';
import {
  AppLogPaths,
  AppProcessInfo,
  AppRuntimeState,
  AppStartSpec,
} from './app-runtime.types';

const PM2_STATE_MAP: Record<ProcessStatusValue, AppRuntimeState> = {
  online: 'running',
  launching: 'starting',
  stopping: 'stopping',
  stopped: 'stopped',
  errored: 'errored',
  'one-launch-status': 'unknown',
};

export class Pm2Runtime implements AppRuntime {
  readonly type = 'pm2' as const;

  private readonly processManager: ProcessManager;

  constructor(processManager?: ProcessManager) {
    this.processManager = processManager ?? getProcessManager();
  }

  async start(spec: AppStartSpec): Promise<AppProcessInfo> {
    const status = await this.processManager.start(this.toProcessConfig(spec));
    return this.toProcessInfo(status);
  }

  async stop(name: string): Promise<void> {
    await this.processManager.stop(name);
  }

  async restart(name: string): Promise<AppProcessInfo> {
    const status = await this.processManager.restart(name);
    return this.toProcessInfo(status);
  }

  async delete(name: string): Promise<void> {
    await this.processManager.delete(name);
  }

  async getStatus(name: string): Promise<AppProcessInfo | null> {
    const status = await this.processManager.getStatus(name);
    return status ? this.toProcessInfo(status) : null;
  }

  async getAllStatus(): Promise<AppProcessInfo[]> {
    const statuses = await this.processManager.getAllStatus();
    return statuses.map((s) => this.toProcessInfo(s));
  }

  getLogs(name: string, lines?: number): Promise<string> {
    return this.processManager.getLogs(name, lines);
  }

  streamLogs(
    name: string,
    onLine: (line: string, type: 'out' | 'err') => void,
    onError?: (error: Error) => void
  ): Promise<() => void> {
    return this.processManager.streamLogs(name, onLine, onError);
  }

  getLogPaths(name: string): Promise<AppLogPaths> {
    return this.processManager.getLogPaths(name);
  }

  disconnect(): void {
    this.processManager.disconnect();
  }

  private toProcessConfig(spec: AppStartSpec): ProcessConfig {
    return {
      name: spec.name,
      script: spec.script,
      cwd: spec.cwd,
      interpreter: spec.interpreter,
      args: spec.args,
      port: spec.port,
      env: spec.env,
      autorestart: spec.autorestart,
      killTimeout: spec.killTimeout,
      outFile: spec.outFile,
      errorFile: spec.errorFile,
      // PM2 can't hard-cap memory; max_memory_restart restarts on exceed,
      // which is the closest degraded equivalent. CPU limits need Docker.
      maxMemoryRestart: spec.limits?.memory,
    };
  }

  private toProcessInfo(status: ProcessStatus): AppProcessInfo {
    return {
      name: status.name,
      status: PM2_STATE_MAP[status.status] ?? 'unknown',
      runtime: this.type,
      pid: status.pid,
      port: status.port,
      memory: status.memory,
      cpu: status.cpu,
      uptime: status.uptime,
      restarts: status.restarts,
      createdAt: status.createdAt,
      restartedAt: status.restartedAt,
    };
  }
}
