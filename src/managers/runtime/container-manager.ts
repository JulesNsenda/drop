/**
 * Container Runtime Adapter (M2b)
 *
 * Implements AppRuntime using Docker containers via dockerode.  Each deployed
 * app becomes one named container (`drop-{appName}`) on the `drop-net` bridge.
 *
 * Security policy (enforced here, never overridden by tenant input):
 * - --cap-drop=ALL, --security-opt no-new-privileges
 * - --pids-limit 256 (default)
 * - Memory and CPU limits (defaults 256m / 0.5)
 * - Port published to loopback only: -p 127.0.0.1:{hostPort}:{containerPort}
 * - No --privileged, no --network host, no extra mounts beyond app dir + data dir
 *
 * Log contract: stdout/stderr are streamed from the container and written to
 * the DROP-owned log files (outFile / errorFile from AppStartSpec) so the
 * logs API and dashboard work identically in PM2 and Docker modes.
 */

import Docker from 'dockerode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Readable } from 'stream';
import { AppRuntime } from './app-runtime';
import {
  AppLogPaths,
  AppProcessInfo,
  AppRuntimeState,
  AppStartSpec,
} from './app-runtime.types';
import { eventBus } from '../../core/event-bus';
import {
  DROP_NETWORK,
  CONTAINER_CAP_DROP,
  CONTAINER_SECURITY_OPT,
  DEFAULT_CPUS,
  DEFAULT_MEMORY,
  DEFAULT_PIDS_LIMIT,
  selectBaseImage,
  selectImageUser,
} from './container-config';
import { AppType } from '../../core/detector/detector.types';

/** Prefix for all DROP-managed container names. */
const NAME_PREFIX = 'drop-';

/** Docker label applied to every DROP-managed container. */
const MANAGED_LABEL = 'drop.managed';

function containerName(appName: string): string {
  return `${NAME_PREFIX}${appName}`;
}

function appNameFromContainer(cName: string): string {
  return cName.startsWith(NAME_PREFIX) ? cName.slice(NAME_PREFIX.length) : cName;
}

function mapDockerState(state: Docker.ContainerInspectInfo['State']): AppRuntimeState {
  if (state.Running) return 'running';
  if (state.Restarting) return 'starting';
  if (state.Paused) return 'stopped';
  if (state.Dead || state.OOMKilled) return 'errored';
  if (state.ExitCode !== undefined && state.ExitCode !== 0) return 'errored';
  return 'stopped';
}

/**
 * Container runtime.  The dockerode client is injected so unit tests can
 * replace it with a mock — the real client is constructed when `client` is
 * omitted (production path).
 */
export class ContainerManager implements AppRuntime {
  readonly type = 'docker' as const;

  readonly docker: Docker;
  /** Per-app log-tailer stop functions, keyed by app name. */
  private readonly logTailers: Map<string, () => void> = new Map();
  /** Per-app log file paths, populated in start() and returned by getLogPaths(). */
  private readonly logPaths: Map<string, AppLogPaths> = new Map();

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(spec: AppStartSpec): Promise<AppProcessInfo> {
    const image = selectBaseImage(
      (spec.appType as AppType) ?? 'nodejs',
      spec.runtimeImage
    );

    await this.ensureImage(image);
    await this.ensureNetwork();

    const name = containerName(spec.name);
    const appName = spec.name;

    // Remove a previous container with the same name (stopped or errored).
    await this.removeIfExists(name);

    const hostPort = spec.port ?? 3000;
    const memory = spec.limits?.memory
      ? this.parseMemory(spec.limits.memory)
      : this.parseMemory(DEFAULT_MEMORY);
    const cpuQuota = spec.limits?.cpus
      ? Math.round(spec.limits.cpus * 100_000)
      : Math.round(parseFloat(DEFAULT_CPUS) * 100_000);

    const env: string[] = Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`);
    env.push(`PORT=${hostPort}`);

    const mounts: Docker.MountConfig = [
      {
        Type: 'bind',
        Source: spec.cwd,
        Target: '/app',
        ReadOnly: true,
      },
    ];

    // Bind-mount the data dir read-write if the caller provided DROP_DATA_DIR.
    const dataDir = spec.env?.['DROP_DATA_DIR'];
    if (dataDir) {
      mounts.push({
        Type: 'bind',
        Source: dataDir,
        Target: dataDir,
        ReadOnly: false,
      });
    }

    // Bind-mount the Postgres socket directory so the app can reach the bundled
    // Postgres without TCP.  The same absolute path is used inside the container
    // so DATABASE_URL (which contains this path) resolves correctly.
    if (spec.pgSocketDir) {
      mounts.push({
        Type: 'bind',
        Source: spec.pgSocketDir,
        Target: spec.pgSocketDir,
        ReadOnly: true,
      });
    }

    const cmd = this.buildCmd(spec);
    const imageUser = selectImageUser((spec.appType as AppType) ?? 'nodejs');

    // Docker HEALTHCHECK — only injected when the app declares a health path.
    const healthcheck = spec.healthCheckPath
      ? {
          Test: [
            'CMD-SHELL',
            `curl -sf http://localhost:${hostPort}${spec.healthCheckPath} || exit 1`,
          ],
          Interval: 30_000_000_000, // 30s in nanoseconds
          Timeout:  10_000_000_000, // 10s
          Retries:  3,
          StartPeriod: 15_000_000_000, // 15s grace on startup
        }
      : undefined;

    const container = await this.docker.createContainer({
      name,
      Image: image,
      Cmd: cmd,
      WorkingDir: '/app',
      Env: env,
      // Run as non-root where the base image supports it (nodejs → 'node',
      // python/go → '1000:1000').  Static/nginx is left as root in Tier A
      // because the entrypoint copies nginx config to /etc/nginx — Tier B will
      // address this with a full-nginx.conf approach.
      ...(imageUser ? { User: imageUser } : {}),
      Labels: {
        [MANAGED_LABEL]: 'true',
        'drop.app': appName,
      },
      ...(healthcheck ? { Healthcheck: healthcheck } : {}),
      HostConfig: {
        // Port binding to loopback only — preserves the appconf port assignment
        // and Caddy's localhost:port upstreams without any router rewrite.
        PortBindings: {
          [`${hostPort}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }],
        },
        // Resource limits
        Memory: memory,
        CpuQuota: cpuQuota,
        CpuPeriod: 100_000,
        PidsLimit: DEFAULT_PIDS_LIMIT,
        // Security
        CapDrop: CONTAINER_CAP_DROP,
        SecurityOpt: CONTAINER_SECURITY_OPT,
        // Networking — attach to the DROP bridge; no host networking
        NetworkMode: DROP_NETWORK,
        // Bounded restart: cap at 5 retries to prevent OOM-looping apps from
        // thrashing the box.  'unless-stopped' has no cap and can overwhelm a
        // 4 GB server with a crash-looping app.
        RestartPolicy: spec.autorestart === false
          ? { Name: 'no' }
          : { Name: 'on-failure', MaximumRetryCount: 5 },
        Mounts: mounts,
      },
      ExposedPorts: { [`${hostPort}/tcp`]: {} },
      NetworkingConfig: {
        EndpointsConfig: {
          [DROP_NETWORK]: {},
        },
      },
    });

    await container.start();

    // Remember the log paths so getLogPaths() can return them without guessing.
    if (spec.outFile || spec.errorFile) {
      this.logPaths.set(appName, { out: spec.outFile, err: spec.errorFile });
    }

    // Wire container stdout/stderr → DROP log files (best-effort).
    if (spec.outFile || spec.errorFile) {
      this.startLogTailer(appName, container, spec.outFile, spec.errorFile).catch(() => {
        // Log tailer failure is non-fatal; the app is already running.
      });
    }

    const info = this.inspectToInfo(appName, await container.inspect());

    // Publish the lifecycle event the router (handleConfigureRoute) and webhooks
    // subscribe to. The PM2 runtime emits this from ProcessManager; the container
    // runtime MUST mirror it, or under docker isolation app:started never fires —
    // so the app never gets a Caddy vhost / TLS certificate (subdomain HTTPS
    // fails) and webhooks stay silent. Matches AppStartedPayload / the PM2 path.
    eventBus.publish('app:started', {
      appId: appName,
      name: appName,
      port: hostPort,
      pid: info.pid ?? undefined,
    });

    return info;
  }

  async stop(name: string): Promise<void> {
    this.stopLogTailer(name);
    const container = this.docker.getContainer(containerName(name));
    try {
      await container.stop({ t: 10 });
    } catch (err: unknown) {
      if (!this.isNotFoundOrNotRunning(err)) throw err;
    }
  }

  async restart(name: string): Promise<AppProcessInfo> {
    this.stopLogTailer(name);
    const container = this.docker.getContainer(containerName(name));
    await container.restart({ t: 10 });
    return this.inspectToInfo(name, await container.inspect());
  }

  async delete(name: string): Promise<void> {
    this.stopLogTailer(name);
    const container = this.docker.getContainer(containerName(name));
    try {
      await container.stop({ t: 5 });
    } catch {
      // Already stopped — proceed to remove.
    }
    try {
      await container.remove({ force: true });
    } catch (err: unknown) {
      if (!this.isNotFound(err)) throw err;
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  async getStatus(name: string): Promise<AppProcessInfo | null> {
    try {
      const container = this.docker.getContainer(containerName(name));
      const info = await container.inspect();
      const base = this.inspectToInfo(name, info);
      if (base.status === 'running') {
        const stats = await this.fetchContainerStats(container);
        return { ...base, ...stats };
      }
      return base;
    } catch (err: unknown) {
      if (this.isNotFound(err)) return null;
      throw err;
    }
  }

  async getAllStatus(): Promise<AppProcessInfo[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${MANAGED_LABEL}=true`] }),
    });

    const results: AppProcessInfo[] = [];
    for (const c of containers) {
      const appName = c.Labels?.['drop.app'] ?? appNameFromContainer(c.Names?.[0] ?? '');
      try {
        const container = this.docker.getContainer(c.Id);
        const info = await container.inspect();
        results.push(this.inspectToInfo(appName, info));
      } catch {
        // Container disappeared between list and inspect — skip.
      }
    }
    return results;
  }

  // ── Logs ───────────────────────────────────────────────────────────────────

  async getLogs(name: string, lines = 100): Promise<string> {
    try {
      const container = this.docker.getContainer(containerName(name));
      const logStream = await container.logs({
        stdout: true,
        stderr: true,
        tail: lines,
        follow: false,
      });
      // dockerode returns Buffer in non-stream mode
      return logStream.toString();
    } catch (err: unknown) {
      if (this.isNotFound(err)) return '';
      throw err;
    }
  }

  async streamLogs(
    name: string,
    onLine: (line: string, type: 'out' | 'err') => void,
    onError?: (error: Error) => void
  ): Promise<() => void> {
    const container = this.docker.getContainer(containerName(name));
    const stream = await container.logs({
      stdout: true,
      stderr: true,
      follow: true,
      tail: 50,
    }) as Readable;

    let stopped = false;
    const stop = () => {
      stopped = true;
      stream.destroy();
    };

    container.modem.demuxStream(
      stream,
      {
        write: (chunk: Buffer) => {
          if (!stopped) onLine(chunk.toString(), 'out');
        },
      },
      {
        write: (chunk: Buffer) => {
          if (!stopped) onLine(chunk.toString(), 'err');
        },
      }
    );

    stream.on('error', (err: Error) => {
      if (!stopped) onError?.(err);
    });

    return stop;
  }

  async getLogPaths(name: string): Promise<AppLogPaths> {
    // Return paths stored when start() was called.  Callers (e.g. the logs API)
    // may read these before any log data arrives; returns an empty object on the
    // first call before start() has run for this app (e.g. after a crash/restart).
    return this.logPaths.get(name) ?? {};
  }

  disconnect(): void {
    for (const stop of this.logTailers.values()) {
      try { stop(); } catch { /* ignore */ }
    }
    this.logTailers.clear();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect();
    } catch {
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          this.docker.modem.followProgress(stream, (err2: Error | null) => {
            if (err2) reject(err2); else resolve();
          });
        });
      });
    }
  }

  private async ensureNetwork(): Promise<void> {
    let networkExists = false;
    let iccDisabled = false;

    try {
      const net = await this.docker.getNetwork(DROP_NETWORK).inspect() as {
        Options?: Record<string, string>;
      };
      networkExists = true;
      iccDisabled = net.Options?.['com.docker.network.bridge.enable_icc'] === 'false';
    } catch {
      // Network does not exist yet — fall through to create.
    }

    if (networkExists && iccDisabled) {
      // Already correctly configured.
      return;
    }

    if (networkExists && !iccDisabled) {
      // ICC is enabled — attempt to remove and recreate.  This may fail if
      // containers are currently attached; in that case, log and leave it —
      // the operator should restart DROP with no containers to fix ICC.
      try {
        await this.docker.getNetwork(DROP_NETWORK).remove();
        networkExists = false;
      } catch {
        // Network is in use; ICC misconfiguration persists until next clean restart.
        return;
      }
    }

    if (!networkExists) {
      await this.docker.createNetwork({
        Name: DROP_NETWORK,
        Driver: 'bridge',
        Options: {
          // Disable inter-container communication so tenants can't talk to
          // each other directly; cross-app traffic must go host→published port.
          'com.docker.network.bridge.enable_icc': 'false',
        },
      });
    }
  }

  private async removeIfExists(cName: string): Promise<void> {
    try {
      const c = this.docker.getContainer(cName);
      await c.remove({ force: true });
    } catch (err: unknown) {
      if (!this.isNotFound(err)) throw err;
    }
  }

  private buildCmd(spec: AppStartSpec): string[] {
    const parts: string[] = [];
    if (spec.interpreter && spec.interpreter !== 'none') {
      parts.push(spec.interpreter);
    }
    parts.push(spec.script);
    if (spec.args) parts.push(...spec.args);
    return parts;
  }

  private inspectToInfo(
    appName: string,
    info: Docker.ContainerInspectInfo
  ): AppProcessInfo {
    const state = info.State;
    const pid = state.Pid && state.Pid > 0 ? state.Pid : null;

    // createdAt from Docker's Created string (RFC3339)
    const createdAt = info.Created ? new Date(info.Created) : null;
    const restartedAt = state.StartedAt ? new Date(state.StartedAt) : null;

    // Uptime in ms from StartedAt
    const uptime =
      state.Running && state.StartedAt
        ? Date.now() - new Date(state.StartedAt).getTime()
        : 0;

    return {
      name: appName,
      status: mapDockerState(state),
      runtime: this.type,
      pid,
      port: null, // port lives in the appconf; not re-derived from inspect
      memory: 0,  // populated by fetchContainerStats in getStatus when running
      cpu: 0,
      uptime,
      restarts: info.RestartCount ?? 0,
      createdAt,
      restartedAt,
    };
  }

  /**
   * One-shot stats snapshot for a running container. Returns { memory, cpu }
   * in the same units as AppProcessInfo (bytes, percent). Best-effort — returns
   * zeros on any error so the caller always gets a complete AppProcessInfo.
   */
  private async fetchContainerStats(
    container: Docker.Container
  ): Promise<{ memory: number; cpu: number }> {
    try {
      const raw = await container.stats({ stream: false }) as unknown as Record<string, unknown>;
      const memStats = raw.memory_stats as Record<string, number> | undefined;
      const cpuStats = raw.cpu_stats as Record<string, unknown> | undefined;
      const preCpuStats = raw.precpu_stats as Record<string, unknown> | undefined;

      const memUsage = memStats?.usage ?? 0;

      // CPU % = (delta of container cpu ticks / delta of system cpu ticks) * numCPUs * 100
      const cpuDelta =
        ((cpuStats?.cpu_usage as Record<string, number>)?.total_usage ?? 0) -
        ((preCpuStats?.cpu_usage as Record<string, number>)?.total_usage ?? 0);
      const systemDelta =
        ((cpuStats as Record<string, number>)?.system_cpu_usage ?? 0) -
        ((preCpuStats as Record<string, number>)?.system_cpu_usage ?? 0);
      const numCpus =
        ((cpuStats?.cpu_usage as Record<string, number[]>)?.percpu_usage?.length) ?? 1;
      const cpuPercent =
        systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

      return { memory: memUsage, cpu: Math.round(cpuPercent * 10) / 10 };
    } catch {
      return { memory: 0, cpu: 0 };
    }
  }

  /** Parse a memory string ('256m', '1g', '512M') to bytes. */
  private parseMemory(mem: string): number {
    const m = mem.match(/^(\d+(?:\.\d+)?)\s*([kmgKMG]?)b?$/i);
    if (!m) return 256 * 1024 * 1024;
    const n = parseFloat(m[1]);
    switch (m[2].toLowerCase()) {
      case 'k': return Math.round(n * 1024);
      case 'm': return Math.round(n * 1024 * 1024);
      case 'g': return Math.round(n * 1024 * 1024 * 1024);
      default:  return Math.round(n);
    }
  }

  private async startLogTailer(
    appName: string,
    container: Docker.Container,
    outFile?: string,
    errFile?: string
  ): Promise<void> {
    if (outFile) await fs.mkdir(path.dirname(outFile), { recursive: true });
    if (errFile) await fs.mkdir(path.dirname(errFile), { recursive: true });

    const outStream = outFile
      ? (await import('fs')).createWriteStream(outFile, { flags: 'a' })
      : null;
    const errStream = errFile
      ? (await import('fs')).createWriteStream(errFile, { flags: 'a' })
      : null;

    const logStream = await container.logs({
      stdout: true,
      stderr: true,
      follow: true,
      tail: 0,
    }) as Readable;

    container.modem.demuxStream(
      logStream,
      outStream ?? { write: () => {} },
      errStream ?? { write: () => {} }
    );

    const stop = () => {
      logStream.destroy();
      outStream?.end();
      errStream?.end();
    };

    this.logTailers.set(appName, stop);
  }

  private stopLogTailer(appName: string): void {
    const stop = this.logTailers.get(appName);
    if (stop) {
      try { stop(); } catch { /* ignore */ }
      this.logTailers.delete(appName);
    }
  }

  private isNotFound(err: unknown): boolean {
    return (
      err instanceof Error &&
      (err.message.includes('404') || err.message.includes('No such container'))
    );
  }

  private isNotFoundOrNotRunning(err: unknown): boolean {
    if (this.isNotFound(err)) return true;
    if (!(err instanceof Error)) return false;
    const msg = err.message;
    // A container that already exited makes stop() a no-op. Docker surfaces this
    // as "not running" or, when already stopped, HTTP 304 "container already
    // stopped" — both mean the container is in the desired (stopped) state.
    return (
      msg.includes('not running') ||
      msg.includes('already stopped') ||
      msg.includes('304')
    );
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let containerManagerInstance: ContainerManager | null = null;

export function getContainerManager(docker?: Docker): ContainerManager {
  if (!containerManagerInstance) {
    containerManagerInstance = new ContainerManager(docker);
  }
  return containerManagerInstance;
}

export function resetContainerManager(): void {
  if (containerManagerInstance) {
    containerManagerInstance.disconnect();
  }
  containerManagerInstance = null;
}
