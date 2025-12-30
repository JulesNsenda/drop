/**
 * PM2 Client Wrapper
 *
 * Provides a promisified interface to PM2's callback-based API.
 */

import pm2 from 'pm2';
import {
  PM2ProcessDescription,
  PM2StartOptions,
  ProcessStatus,
  ProcessStatusValue,
  ExecMode,
} from './process-manager.types';

let isConnected = false;
let connectionPromise: Promise<void> | null = null;

/**
 * Connect to PM2 daemon
 */
export async function connect(): Promise<void> {
  if (isConnected) {
    return;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) {
        connectionPromise = null;
        reject(err);
      } else {
        isConnected = true;
        connectionPromise = null;
        resolve();
      }
    });
  });

  return connectionPromise;
}

/**
 * Disconnect from PM2 daemon
 */
export function disconnect(): void {
  if (isConnected) {
    pm2.disconnect();
    isConnected = false;
  }
}

/**
 * Check if connected to PM2
 */
export function isConnectedToPM2(): boolean {
  return isConnected;
}

/**
 * Start a process
 */
export async function start(options: PM2StartOptions): Promise<PM2ProcessDescription[]> {
  await connect();

  return new Promise((resolve, reject) => {
    pm2.start(options, (err, proc) => {
      if (err) {
        reject(err);
      } else {
        resolve(proc as PM2ProcessDescription[]);
      }
    });
  });
}

/**
 * Stop a process
 */
export async function stop(name: string): Promise<void> {
  await connect();

  return new Promise((resolve, reject) => {
    pm2.stop(name, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Restart a process
 */
export async function restart(name: string): Promise<void> {
  await connect();

  return new Promise((resolve, reject) => {
    pm2.restart(name, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Reload a process (zero-downtime)
 */
export async function reload(name: string): Promise<void> {
  await connect();

  return new Promise((resolve, reject) => {
    pm2.reload(name, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Delete a process from PM2
 */
export async function deleteProcess(name: string): Promise<void> {
  await connect();

  return new Promise((resolve, reject) => {
    pm2.delete(name, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Get list of all processes
 */
export async function list(): Promise<PM2ProcessDescription[]> {
  await connect();

  return new Promise((resolve, reject) => {
    pm2.list((err, list) => {
      if (err) {
        reject(err);
      } else {
        resolve(list as PM2ProcessDescription[]);
      }
    });
  });
}

/**
 * Get description of a specific process
 */
export async function describe(name: string): Promise<PM2ProcessDescription[]> {
  await connect();

  return new Promise((resolve, reject) => {
    pm2.describe(name, (err, desc) => {
      if (err) {
        reject(err);
      } else {
        resolve(desc as PM2ProcessDescription[]);
      }
    });
  });
}

/**
 * Send a signal to a process
 */
export async function sendSignal(
  signal: string | number,
  name: string
): Promise<void> {
  await connect();

  return new Promise((resolve, reject) => {
    pm2.sendSignalToProcessName(signal, name, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Flush logs for a process
 */
export async function flush(name?: string): Promise<void> {
  await connect();

  return new Promise((resolve, reject) => {
    // PM2 flush requires a process identifier, use 'all' to flush all
    const processId = name || 'all';
    pm2.flush(processId, (err: Error | null) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Convert PM2 process description to ProcessStatus
 */
export function toProcessStatus(proc: PM2ProcessDescription): ProcessStatus {
  const env = proc.pm2_env || {};
  const monit = proc.monit || {};

  let status: ProcessStatusValue = 'stopped';
  if (env.status) {
    status = env.status as ProcessStatusValue;
  }

  let execMode: ExecMode = 'fork';
  if (env.exec_mode === 'cluster_mode' || env.exec_mode === 'cluster') {
    execMode = 'cluster';
  }

  // Extract port from environment
  let port: number | null = null;
  if (env.env && typeof env.env === 'object' && 'PORT' in env.env) {
    const envPort = (env.env as Record<string, string>).PORT;
    port = envPort ? parseInt(envPort, 10) : null;
  }

  return {
    name: proc.name || 'unknown',
    status,
    pid: proc.pid || null,
    pmId: proc.pm_id ?? null,
    port,
    instances: env.instances || 1,
    memory: monit.memory || 0,
    cpu: monit.cpu || 0,
    uptime: env.pm_uptime ? Date.now() - env.pm_uptime : 0,
    restarts: env.restart_time || 0,
    execMode,
    watching: env.watch || false,
    createdAt: env.created_at ? new Date(env.created_at) : null,
    restartedAt: null,
  };
}

/**
 * Get the status of a process by name
 */
export async function getProcessStatus(name: string): Promise<ProcessStatus | null> {
  const descriptions = await describe(name);

  if (!descriptions || descriptions.length === 0) {
    return null;
  }

  // For cluster mode, aggregate all instances
  if (descriptions.length > 1) {
    const first = descriptions[0];
    const status = toProcessStatus(first);

    // Aggregate metrics from all instances
    let totalMemory = 0;
    let totalCpu = 0;
    let totalRestarts = 0;
    let onlineCount = 0;

    for (const desc of descriptions) {
      const s = toProcessStatus(desc);
      totalMemory += s.memory;
      totalCpu += s.cpu;
      totalRestarts += s.restarts;
      if (s.status === 'online') {
        onlineCount++;
      }
    }

    status.instances = descriptions.length;
    status.memory = totalMemory;
    status.cpu = totalCpu;
    status.restarts = totalRestarts;

    // Set overall status based on instance states
    if (onlineCount === descriptions.length) {
      status.status = 'online';
    } else if (onlineCount > 0) {
      status.status = 'launching';
    }

    return status;
  }

  return toProcessStatus(descriptions[0]);
}
