/**
 * Process Manager Implementation
 *
 * Manages application processes using PM2 for process spawning,
 * monitoring, clustering, and graceful shutdown.
 */

import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import { eventBus } from '../../core/event-bus';
import {
  ProcessConfig,
  ProcessStatus,
  ProcessManagerConfig,
  PM2StartOptions,
} from './process-manager.types';
import * as pm2Client from './pm2-client';

const DEFAULT_CONFIG: ProcessManagerConfig = {
  defaultKillTimeout: 5000,
  defaultMaxRestarts: 10,
  defaultRestartDelay: 1000,
};

export class ProcessManager {
  private readonly config: ProcessManagerConfig;
  private readonly managedProcesses: Set<string> = new Set();

  constructor(config: Partial<ProcessManagerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start a process
   */
  async start(config: ProcessConfig): Promise<ProcessStatus> {
    const { name } = config;

    // Check if already running
    const existingStatus = await this.getStatus(name);
    if (existingStatus && existingStatus.status === 'online') {
      return existingStatus;
    }

    // Convert config to PM2 options
    const pm2Options = this.configToPM2Options(config);

    // Emit starting event
    eventBus.publish('app:starting', {
      appId: name,
      name,
    });

    try {
      // Start the process
      await pm2Client.start(pm2Options);
      this.managedProcesses.add(name);

      // Wait for process to be online
      const status = await this.waitForStatus(name, 'online', 30000);

      // Emit started event
      eventBus.publish('app:started', {
        appId: name,
        name,
        port: config.port || 0,
        pid: status.pid || undefined,
      });

      return status;
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error('Failed to start process');

      eventBus.publish('app:error', {
        appId: name,
        name,
        error: errorObj,
        context: 'start',
      });

      throw errorObj;
    }
  }

  /**
   * Stop a process
   */
  async stop(name: string): Promise<void> {
    // Check if process exists
    const status = await this.getStatus(name);
    if (!status) {
      return; // Already stopped/doesn't exist
    }

    // Emit stopping event
    eventBus.publish('app:stopping', {
      appId: name,
      name,
    });

    try {
      // Stop the process
      await pm2Client.stop(name);

      // Wait for process to stop
      await this.waitForStatus(name, 'stopped', 30000);

      // Emit stopped event
      eventBus.publish('app:stopped', {
        appId: name,
        name,
      });
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error('Failed to stop process');

      eventBus.publish('app:error', {
        appId: name,
        name,
        error: errorObj,
        context: 'stop',
      });

      throw errorObj;
    }
  }

  /**
   * Restart a process
   */
  async restart(name: string): Promise<ProcessStatus> {
    // Check if process exists
    const status = await this.getStatus(name);
    if (!status) {
      throw new Error(`Process not found: ${name}`);
    }

    try {
      await pm2Client.restart(name);

      // Wait for process to be online
      const newStatus = await this.waitForStatus(name, 'online', 30000);

      return newStatus;
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error('Failed to restart process');

      eventBus.publish('app:error', {
        appId: name,
        name,
        error: errorObj,
        context: 'restart',
      });

      throw errorObj;
    }
  }

  /**
   * Reload a process (zero-downtime)
   */
  async reload(name: string): Promise<ProcessStatus> {
    // Check if process exists
    const status = await this.getStatus(name);
    if (!status) {
      throw new Error(`Process not found: ${name}`);
    }

    try {
      await pm2Client.reload(name);

      // Wait for process to be online
      const newStatus = await this.waitForStatus(name, 'online', 30000);

      return newStatus;
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error('Failed to reload process');

      eventBus.publish('app:error', {
        appId: name,
        name,
        error: errorObj,
        context: 'reload',
      });

      throw errorObj;
    }
  }

  /**
   * Get the status of a process
   */
  async getStatus(name: string): Promise<ProcessStatus | null> {
    try {
      return await pm2Client.getProcessStatus(name);
    } catch {
      return null;
    }
  }

  /**
   * Get logs for a process
   */
  async getLogs(name: string, lines: number = 100): Promise<string> {
    const status = await this.getStatus(name);
    if (!status) {
      throw new Error(`Process not found: ${name}`);
    }

    // Get log file paths from PM2
    const descriptions = await pm2Client.describe(name);
    if (!descriptions || descriptions.length === 0) {
      return '';
    }

    const env = descriptions[0].pm2_env;
    const outLogPath = env?.pm_out_log_path;
    const errLogPath = env?.pm_err_log_path;

    let logs = '';

    // Read stdout logs
    if (outLogPath) {
      try {
        const outLines = (await this.tailFile(outLogPath, lines)).slice(-lines);
        logs += outLines.map(l => `[out] ${l}`).join('\n');
      } catch {
        // Log file may not exist
      }
    }

    // Read stderr logs
    if (errLogPath) {
      try {
        const errLines = (await this.tailFile(errLogPath, lines)).slice(-lines);
        if (logs) logs += '\n';
        logs += errLines.map(l => `[err] ${l}`).join('\n');
      } catch {
        // Log file may not exist
      }
    }

    return logs;
  }

  /**
   * Read approximately the last `lines` lines of a file without loading the
   * whole thing into memory. Production log files grow to GBs; a full
   * readFile would OOM the platform process.
   */
  private async tailFile(filePath: string, lines: number): Promise<string[]> {
    // Assume a generous average line length; read a bounded tail window.
    const avgLineBytes = 512;
    const readBytes = Math.min(lines * avgLineBytes, 2 * 1024 * 1024); // cap 2MB

    const handle = await fs.open(filePath, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - readBytes);
      const length = size - start;
      if (length <= 0) return [];
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return buffer.toString('utf-8').split('\n');
    } finally {
      await handle.close();
    }
  }

  /**
   * Stream logs for a process (follow mode)
   * Returns a function to stop streaming
   */
  async streamLogs(
    name: string,
    onLine: (line: string, type: 'out' | 'err') => void,
    onError?: (error: Error) => void
  ): Promise<() => void> {
    const status = await this.getStatus(name);
    if (!status) {
      throw new Error(`Process not found: ${name}`);
    }

    const descriptions = await pm2Client.describe(name);
    if (!descriptions || descriptions.length === 0) {
      throw new Error(`No log files found for: ${name}`);
    }

    const env = descriptions[0].pm2_env;
    const outLogPath = env?.pm_out_log_path;
    const errLogPath = env?.pm_err_log_path;

    const watchers: fsSync.FSWatcher[] = [];
    const streams: fsSync.ReadStream[] = [];

    const watchFile = (filePath: string, type: 'out' | 'err'): void => {
      try {
        // Get current file size to start reading from end
        const stats = fsSync.statSync(filePath);
        let position = stats.size;

        // Watch for changes
        const watcher = fsSync.watch(filePath, (eventType) => {
          if (eventType === 'change') {
            // Read new content
            const newStats = fsSync.statSync(filePath);
            if (newStats.size > position) {
              const stream = fsSync.createReadStream(filePath, {
                start: position,
                end: newStats.size - 1,
                encoding: 'utf-8',
              });

              let buffer = '';
              stream.on('data', (chunk) => {
                buffer += chunk;
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                  if (line.trim()) {
                    onLine(line, type);
                  }
                }
              });

              stream.on('end', () => {
                if (buffer.trim()) {
                  onLine(buffer, type);
                }
                position = newStats.size;
              });

              stream.on('error', (err) => {
                onError?.(err);
              });

              streams.push(stream);
            }
          }
        });

        watchers.push(watcher);
      } catch (err) {
        // File might not exist yet
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    // Start watching both log files
    if (outLogPath) {
      watchFile(outLogPath, 'out');
    }
    if (errLogPath) {
      watchFile(errLogPath, 'err');
    }

    // Return cleanup function
    return () => {
      for (const watcher of watchers) {
        watcher.close();
      }
      for (const stream of streams) {
        stream.destroy();
      }
    };
  }

  /**
   * Get log file paths for a process
   */
  async getLogPaths(name: string): Promise<{ out?: string; err?: string }> {
    const descriptions = await pm2Client.describe(name);
    if (!descriptions || descriptions.length === 0) {
      return {};
    }

    const env = descriptions[0].pm2_env;
    return {
      out: env?.pm_out_log_path,
      err: env?.pm_err_log_path,
    };
  }

  /**
   * Delete a process from PM2
   */
  async delete(name: string): Promise<void> {
    try {
      await pm2Client.deleteProcess(name);
      this.managedProcesses.delete(name);
    } catch {
      // Ignore errors if process doesn't exist
    }
  }

  /**
   * Get all managed processes
   */
  async getAllStatus(): Promise<ProcessStatus[]> {
    const list = await pm2Client.list();
    return list.map(pm2Client.toProcessStatus);
  }

  /**
   * Flush logs for a process
   */
  async flushLogs(name?: string): Promise<void> {
    await pm2Client.flush(name);
  }

  /**
   * Disconnect from PM2
   */
  disconnect(): void {
    pm2Client.disconnect();
  }

  /**
   * Get configuration
   */
  getConfig(): ProcessManagerConfig {
    return { ...this.config };
  }

  /**
   * Convert ProcessConfig to PM2StartOptions
   */
  private configToPM2Options(config: ProcessConfig): PM2StartOptions {
    const options: PM2StartOptions = {
      name: config.name,
      script: config.script,
      cwd: config.cwd,
    };

    if (config.instances !== undefined) {
      options.instances = config.instances === 'max' ? 0 : config.instances;
    }

    if (config.execMode) {
      options.exec_mode = config.execMode;
    }

    if (config.maxMemoryRestart) {
      options.max_memory_restart = config.maxMemoryRestart;
    }

    if (config.env) {
      options.env = { ...config.env };
      if (config.port) {
        options.env.PORT = String(config.port);
      }
    } else if (config.port) {
      options.env = { PORT: String(config.port) };
    }

    if (config.autorestart !== undefined) {
      options.autorestart = config.autorestart;
    }

    if (config.killTimeout !== undefined) {
      options.kill_timeout = config.killTimeout;
    } else {
      options.kill_timeout = this.config.defaultKillTimeout;
    }

    if (config.nodeArgs) {
      options.node_args = config.nodeArgs;
    }

    if (config.args) {
      options.args = config.args;
    }

    if (config.interpreter) {
      options.interpreter = config.interpreter;
    }

    if (config.watch !== undefined) {
      options.watch = config.watch;
    }

    if (config.ignoreWatch) {
      options.ignore_watch = config.ignoreWatch;
    }

    if (config.logFile) {
      options.log_file = config.logFile;
    }

    if (config.errorFile) {
      options.error_file = config.errorFile;
    }

    if (config.outFile) {
      options.out_file = config.outFile;
    }

    if (config.mergeLogs !== undefined) {
      options.merge_logs = config.mergeLogs;
    }

    if (config.cron) {
      options.cron_restart = config.cron;
    }

    if (config.maxRestarts !== undefined) {
      options.max_restarts = config.maxRestarts;
    } else {
      options.max_restarts = this.config.defaultMaxRestarts;
    }

    if (config.restartDelay !== undefined) {
      options.restart_delay = config.restartDelay;
    } else {
      options.restart_delay = this.config.defaultRestartDelay;
    }

    return options;
  }

  /**
   * Wait for a process to reach a specific status
   */
  private async waitForStatus(
    name: string,
    targetStatus: string,
    timeout: number
  ): Promise<ProcessStatus> {
    const startTime = Date.now();
    const pollInterval = 500;

    while (Date.now() - startTime < timeout) {
      const status = await this.getStatus(name);

      if (status && status.status === targetStatus) {
        return status;
      }

      // If process errored, throw immediately
      if (status && status.status === 'errored') {
        throw new Error(`Process ${name} errored`);
      }

      await this.sleep(pollInterval);
    }

    // Timed out. Returning the last (wrong) status would let callers treat an
    // app that never started as if it had — always throw instead.
    const finalStatus = await this.getStatus(name);
    throw new Error(
      `Timeout waiting for process ${name} to reach status ${targetStatus}` +
        (finalStatus ? ` (last status: ${finalStatus.status})` : '')
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Factory function
export function createProcessManager(config?: Partial<ProcessManagerConfig>): ProcessManager {
  return new ProcessManager(config);
}

// Singleton instance
let processManagerInstance: ProcessManager | null = null;

export function getProcessManager(config?: Partial<ProcessManagerConfig>): ProcessManager {
  if (!processManagerInstance) {
    processManagerInstance = new ProcessManager(config);
  }
  return processManagerInstance;
}

export function resetProcessManager(): void {
  if (processManagerInstance) {
    processManagerInstance.disconnect();
  }
  processManagerInstance = null;
}
