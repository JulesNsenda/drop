/**
 * PM2 Runtime Adapter
 *
 * Implements AppRuntime on top of the existing ProcessManager (PM2).
 * Pure delegation: ProcessManager keeps its PM2 semantics and EventBus
 * emissions; this adapter only translates between the runtime-agnostic
 * types and PM2's.
 */

import * as path from 'path';
import { RESERVED_ENV_PREFIXES, withReservedEnvBlanked } from '../../utils/reserved-env';
import { ProcessManager, getProcessManager } from '../process';
import {
  ProcessConfig,
  ProcessStatus,
  ProcessStatusValue,
} from '../process/process-manager.types';
import { AppRuntime } from './app-runtime';
import { LiveInstances, InstanceSlot, appNameOfInstance } from './instance';
import {
  AppLogPaths,
  AppProcessInfo,
  AppRuntimeState,
  AppStartSpec,
} from './app-runtime.types';

const PM2_STATE_MAP: Record<ProcessStatusValue, AppRuntimeState> = {
  online: 'running',
  launching: 'starting',
  'waiting restart': 'starting',
  stopping: 'stopping',
  stopped: 'stopped',
  errored: 'errored',
  'one-launch-status': 'unknown',
};

export class Pm2Runtime implements AppRuntime {
  readonly type = 'pm2' as const;

  private readonly processManager: ProcessManager;
  /** App name → live slot. The PM2 process name IS the instance name. */
  private readonly live = new LiveInstances();

  constructor(processManager?: ProcessManager) {
    this.processManager = processManager ?? getProcessManager();
  }

  /** Directories a DROP process runs from (the apps directory, the release store's root). */
  private managedRoots: string[] = [];

  setManagedRoots(roots: string[]): void {
    this.managedRoots = roots.map((root) => path.resolve(root));
  }

  /** Strictly under a managed root; a process with no working directory is not ours. */
  private isManagedCwd(cwd: string | undefined): boolean {
    if (!cwd) return false;
    return this.managedRoots.some((root) => {
      const rel = path.relative(root, path.resolve(cwd));
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  }

  setLiveInstance(appName: string, slot: InstanceSlot): void {
    this.live.set(appName, slot);
  }

  getLiveInstance(appName: string): InstanceSlot {
    return this.live.slotOf(appName);
  }

  async start(spec: AppStartSpec): Promise<AppProcessInfo> {
    const status = await this.processManager.start(this.toProcessConfig(spec));
    return this.toProcessInfo(status);
  }

  async stop(name: string): Promise<void> {
    await this.processManager.stop(this.live.resolve(name));
  }

  async restart(name: string): Promise<AppProcessInfo> {
    const status = await this.processManager.restart(this.live.resolve(name));
    return this.toProcessInfo(status);
  }

  async delete(name: string): Promise<void> {
    await this.processManager.delete(this.live.resolve(name));
  }

  async getStatus(name: string): Promise<AppProcessInfo | null> {
    const status = await this.processManager.getStatus(this.live.resolve(name));
    return status ? this.toProcessInfo(status) : null;
  }

  /**
   * Liveness only. PM2's list is already cheap (no per-process sampling), so
   * this simply counts it — but it stays a separate method so the health probe
   * never depends on whatever getAllStatus grows into. See the AppRuntime docs.
   */
  async countManaged(): Promise<number> {
    return (await this.getAllStatus()).length;
  }

  async getAllStatus(): Promise<AppProcessInfo[]> {
    const statuses = await this.processManager.getAllStatus();
    return statuses.map((s) => this.toProcessInfo(s));
  }

  getLogs(name: string, lines?: number): Promise<string> {
    return this.processManager.getLogs(this.live.resolve(name), lines);
  }

  streamLogs(
    name: string,
    onLine: (line: string, type: 'out' | 'err') => void,
    onError?: (error: Error) => void
  ): Promise<() => void> {
    return this.processManager.streamLogs(this.live.resolve(name), onLine, onError);
  }

  getLogPaths(name: string): Promise<AppLogPaths> {
    return this.processManager.getLogPaths(this.live.resolve(name));
  }

  disconnect(): void {
    this.processManager.disconnect();
  }

  private toProcessConfig(spec: AppStartSpec): ProcessConfig {
    return {
      name: spec.instance ?? spec.name,
      script: spec.script,
      cwd: spec.cwd,
      interpreter: spec.interpreter,
      args: spec.args,
      port: spec.port,
      // PM2 starts the app with the platform's OWN environment underneath
      // spec.env. Two layers keep the platform's secrets (DROP_*, AWS_*, CF_*)
      // out of tenant code, because PM2 has two start paths and only one of
      // them honours the first: `filter_env` removes them on a fresh start,
      // and an explicit empty value for each inherited one wins on a restart
      // over an existing entry. Whatever the app was explicitly given in
      // spec.env (DROP_DATA_DIR, its secrets, an attached bucket's AWS_*) is
      // kept by both.
      env: withReservedEnvBlanked(process.env, spec.env ?? {}),
      filterEnv: RESERVED_ENV_PREFIXES,
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
      name: appNameOfInstance(status.name),
      instance: status.name,
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
      managed: this.isManagedCwd(status.cwd),
    };
  }
}
