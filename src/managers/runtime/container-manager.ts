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
  DROP_NET_SUBNET,
  DROP_NET_GATEWAY,
  HOST_ALIAS,
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

/** Size of Docker's per-frame stream header on a non-TTY log stream. */
const LOG_FRAME_HEADER_SIZE = 8;

/**
 * De-multiplex Docker's non-TTY log stream into PM2-shaped `[out] `/`[err] `
 * lines.
 *
 * Every frame is an 8-byte header — byte 0 is the stream, bytes 1-3 are
 * reserved zeros, bytes 4-7 a big-endian uint32 payload length — followed by
 * the payload. Layout and stream enum verified against moby's own reference
 * de-multiplexer (`api/pkg/stdcopy/stdcopy.go`: `stdWriterPrefixLen = 8`,
 * `stdWriterSizeIndex = 4`, `binary.BigEndian.Uint32`).
 *
 * Stream values are 0 = stdin, 1 = stdout, 2 = stderr, 3 = systemerr. StdCopy
 * folds stdin into stdout for backward compatibility and writes systemerr
 * nowhere, terminating the stream — both mirrored below, so daemon errors are
 * never passed off as the tenant's own output.
 *
 * Reading that with a plain `.toString()`
 * leaks the header bytes into the text AND discards the stdout/stderr
 * distinction entirely, which is the only signal the logs API carries: the
 * dashboard splits streams on the `[out] `/`[err] ` prefixes PM2 emits, so
 * under docker isolation every line parsed as stdout and the Logs tab's "err"
 * filter matched nothing, ever.
 *
 * Prefixing here (rather than teaching the dashboard that docker has no
 * prefixes) is what actually restores the filter, and it honours the
 * AppRuntime contract that both adapters present logs identically.
 */
function demuxDockerLogs(buf: Buffer): string {
  const chunks: { type: 'out' | 'err'; text: string }[] = [];
  let offset = 0;

  while (offset + LOG_FRAME_HEADER_SIZE <= buf.length) {
    const streamType = buf[offset];
    const framed =
      streamType <= 3 && buf[offset + 1] === 0 && buf[offset + 2] === 0 && buf[offset + 3] === 0;

    if (!framed) {
      // Unframed at offset 0 means the container has a TTY, so the stream was
      // never multiplexed — hand back the raw text rather than mangling it.
      // Mid-buffer it means `tail` sliced through a frame; keep what parsed.
      // (Checking the reserved zero bytes is stricter than StdCopy, which only
      // switches on byte 0 — the extra bytes are what make this a usable
      // "is this framed at all?" probe on a buffer we did not read framed.)
      if (offset === 0) return buf.toString();
      break;
    }

    // Systemerr: daemon-level errors, not app output. StdCopy writes them
    // nowhere and stops processing; anything after this is not tenant output.
    if (streamType === 3) break;

    const length = buf.readUInt32BE(offset + 4);
    const start = offset + LOG_FRAME_HEADER_SIZE;
    const end = Math.min(start + length, buf.length);
    const type: 'out' | 'err' = streamType === 2 ? 'err' : 'out';
    const text = buf.toString('utf8', start, end);

    // Merge adjacent same-stream frames before splitting: a single log line can
    // span frames, and splitting per frame would cut it in half.
    const prev = chunks[chunks.length - 1];
    if (prev && prev.type === type) prev.text += text;
    else chunks.push({ type, text });

    offset = start + length;
  }

  if (chunks.length === 0) return buf.toString();

  const lines: string[] = [];
  for (const chunk of chunks) {
    for (const line of chunk.text.split('\n')) {
      if (line.length > 0) lines.push(`[${chunk.type}] ${line}`);
    }
  }
  return lines.join('\n');
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

    // Map the in-container `drop-host` alias to drop-net's ACTUAL gateway
    // (whatever subnet the network currently has), so the control-plane is
    // reachable without depending on the network having been recreated with the
    // pinned subnet — an in-place upgrade keeps its legacy subnet and still works.
    const hostGatewayIp = await this.resolveHostGatewayIp();

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
      // Run as non-root everywhere: nodejs → 'node', python/go → '1000:1000',
      // static/spa → '101:101' (the nginx user; DROP passes a full nginx.conf
      // via -c so nothing in the container needs root).
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
        // Security — every container runs non-root with zero capabilities.
        CapDrop: CONTAINER_CAP_DROP,
        SecurityOpt: CONTAINER_SECURITY_OPT,
        // Networking — attach to the DROP bridge; no host networking
        NetworkMode: DROP_NETWORK,
        // Resolve the DROP control-plane API from inside the container via a
        // fixed name mapped to drop-net's real gateway (resolved above).
        ExtraHosts: [`${HOST_ALIAS}:${hostGatewayIp}`],
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

  /**
   * Liveness only — `listContainers` and nothing else. Crucially does NOT call
   * fetchContainerStats: that is what made the health probe cost ~1s per
   * container and time out against its 2s budget. See the AppRuntime docs.
   */
  async countManaged(): Promise<number> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${MANAGED_LABEL}=true`] }),
    });
    return containers.length;
  }

  async getAllStatus(): Promise<AppProcessInfo[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${MANAGED_LABEL}=true`] }),
    });

    // Parity with getStatus(): a RUNNING container must carry live cpu/memory.
    // inspect() alone leaves both at 0 (see inspectToInfo), and 0 is
    // indistinguishable from a genuinely idle app — so the /apps list reported
    // a whole healthy fleet as "Avg CPU 0.0%" under docker isolation while each
    // app's own detail page (getStatus) showed real numbers.
    //
    // Concurrent, not serial: container.stats({stream:false}) samples twice so
    // precpu_stats is valid, costing ~1s per container, and this endpoint is
    // polled by the dashboard. Serially, a six-app fleet would cost six seconds
    // per poll. The try/catch stays INSIDE the mapped function so one container
    // disappearing between list and inspect can't drop the rest.
    const results = await Promise.all(
      containers.map(async (c) => {
        const appName = c.Labels?.['drop.app'] ?? appNameFromContainer(c.Names?.[0] ?? '');
        try {
          const container = this.docker.getContainer(c.Id);
          const base = this.inspectToInfo(appName, await container.inspect());
          if (base.status !== 'running') return base;
          return { ...base, ...(await this.fetchContainerStats(container)) };
        } catch {
          // Container disappeared between list and inspect — skip.
          return null;
        }
      })
    );
    return results.filter((r): r is AppProcessInfo => r !== null);
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
      // dockerode returns Buffer in non-stream mode. The bytes are Docker's
      // multiplexed frames, not plain text — demux them so stderr survives the
      // trip to the logs API (see demuxDockerLogs).
      const raw = logStream as unknown;
      return demuxDockerLogs(Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)));
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
      // Already correctly configured. The subnet is deliberately NOT required to
      // match DROP_NET_SUBNET: `drop-host` is mapped to the network's ACTUAL
      // gateway at container start (resolveHostGatewayIp), so an in-place upgrade
      // keeps its legacy subnet and still reaches the control-plane — no
      // migration / clean-restart needed. Pinning only governs freshly created
      // networks below.
      return;
    }

    if (networkExists && !iccDisabled) {
      // ICC is ENABLED — a security regression (tenants could reach each other).
      // Attempt to remove and recreate with ICC disabled. This may fail if
      // containers are currently attached; warn and leave it — the operator
      // should restart DROP with no running containers to re-disable ICC.
      try {
        await this.docker.getNetwork(DROP_NETWORK).remove();
        networkExists = false;
      } catch {
        console.warn(
          `[ContainerManager] WARNING: '${DROP_NETWORK}' has inter-container ` +
            'communication ENABLED and could not be recreated because containers are ' +
            'still attached. Restart DROP with no running containers to re-disable ICC.'
        );
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
        // Pin a predictable subnet/gateway for freshly created networks. Not
        // load-bearing (ExtraHosts uses the real gateway either way) — it just
        // gives new installs a stable, uncommon range.
        IPAM: { Config: [{ Subnet: DROP_NET_SUBNET, Gateway: DROP_NET_GATEWAY }] },
      });
    }
  }

  /**
   * Resolve the gateway IP that the `drop-host` alias should map to — the ACTUAL
   * IPv4 gateway of drop-net, whatever subnet it currently has. This is what makes
   * the control-plane reachable without any migration: a box upgraded in place
   * keeps its legacy drop-net subnet, and we point `drop-host` at *that* real
   * gateway rather than a hardcoded constant that would be a dead IP (which is why
   * an upgraded box saw ECONNREFUSED turn into a connect timeout).
   *
   * Falls back to the pinned `DROP_NET_GATEWAY` only if inspection yields no
   * usable IPv4 gateway (e.g. inspect fails, or a race before the bridge is up).
   */
  private async resolveHostGatewayIp(): Promise<string> {
    try {
      const net = (await this.docker.getNetwork(DROP_NETWORK).inspect()) as {
        IPAM?: { Config?: Array<{ Subnet?: string; Gateway?: string }> };
      };
      const configs = net.IPAM?.Config ?? [];
      // Prefer an explicit IPv4 gateway (no ':' → not an IPv6 entry).
      for (const cfg of configs) {
        if (cfg.Gateway && !cfg.Gateway.includes(':')) return cfg.Gateway;
      }
      // Some auto-allocated networks omit Gateway; derive .1 from an IPv4 subnet
      // (Docker's default bridge gateway is the first usable host address).
      for (const cfg of configs) {
        if (cfg.Subnet && !cfg.Subnet.includes(':')) {
          const octets = cfg.Subnet.split('/')[0].split('.');
          if (octets.length === 4) return `${octets[0]}.${octets[1]}.${octets[2]}.1`;
        }
      }
    } catch {
      // Fall through to the pinned constant.
    }
    return DROP_NET_GATEWAY;
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

    // Host-published port (M1 review item 7, round-2 diff pass): the
    // published port lives at NetworkSettings.Ports['<containerPort>/tcp'][0]
    // .HostPort. This doesn't know the container-side port key ahead of
    // time, but DROP's own container spec always publishes exactly ONE port
    // binding, host==container (see start()'s PortBindings/ExposedPorts:
    // `${hostPort}/tcp` -> HostPort: hostPort) — so taking the first
    // published binding, whatever its key, is exactly as specific as
    // knowing the key. Previously always null ("not re-derived from
    // inspect"); this activates boot reconciliation's portDrifted check for
    // docker for the first time — it was structurally inert before.
    const publishedPort = Object.values(info.NetworkSettings?.Ports ?? {}).find(
      (bindings) => bindings && bindings.length > 0
    )?.[0]?.HostPort;
    const port = publishedPort ? parseInt(publishedPort, 10) : null;

    return {
      name: appName,
      status: mapDockerState(state),
      runtime: this.type,
      pid,
      port,
      memory: 0,  // populated by fetchContainerStats in getStatus when running
      cpu: 0,
      uptime,
      restarts: info.RestartCount ?? 0,
      createdAt,
      restartedAt,
      // Authoritative when true. Docker clears it on the next run, so it is
      // only observable while the container is down — see AppProcessInfo.
      oomKilled: state.OOMKilled === true,
    };
  }

  /**
   * One-shot stats snapshot for a running container. Returns { memory, cpu }
   * in the same units as AppProcessInfo (bytes, percent). Best-effort — returns
   * zeros on any error so the caller always gets a complete AppProcessInfo.
   */
  private async fetchContainerStats(
    container: Docker.Container
  ): Promise<{ memory: number; cpu: number; cpuTotalNs?: number }> {
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

      // The CUMULATIVE counter, not the derived percentage. Idle detection
      // needs "did any work happen between these two moments", which a sampled
      // percentage cannot answer — a request served between samples is invisible
      // to it.
      const cpuTotalNs = (cpuStats?.cpu_usage as Record<string, number>)?.total_usage;

      return {
        memory: memUsage,
        cpu: Math.round(cpuPercent * 10) / 10,
        ...(typeof cpuTotalNs === 'number' ? { cpuTotalNs } : {}),
      };
    } catch {
      // No cpuTotalNs on failure — absent means "unknown", and a 0 here would
      // read as "did no work" and count toward reaping an app we simply could
      // not measure.
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
