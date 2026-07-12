/**
 * Redis Server
 *
 * Manages the ONE managed Redis instance DROP runs, mirroring PostgresServer:
 * a single server that RedisProvisioner hands per-app logical databases on.
 *
 * - **docker isolation:** run a single long-lived `redis:7-alpine` container.
 *   The docker host may not have a `redis-server` binary, and Redis has no
 *   EnterpriseDB-style cross-platform prebuilt to bundle like Postgres, so a
 *   container is the pragmatic single instance. Its TCP port is published on the
 *   host (0.0.0.0) so app containers reach it via the `drop-host` ExtraHosts
 *   alias — the same reachability path the DROP API uses — while `--requirepass`
 *   authenticates every connection (defense-in-depth for the 0.0.0.0 publish;
 *   operators should still firewall the port from the public internet).
 * - **non-docker (PM2/dev):** spawn the system `redis-server` bound to loopback.
 *   No bundled binary download in v1 — dev boxes install redis themselves.
 *
 * Fail-soft: if Redis can't start, the caller logs and continues; apps that need
 * Redis simply get no REDIS_URL (same posture as Postgres-unavailable).
 *
 * NOT persistent in v1 (`--save "" --appendonly no`): a cache/queue that resets
 * on platform restart. Durable persistence is a documented non-goal (PRD-050).
 */

import Docker from 'dockerode';
import { spawn, ChildProcess } from 'child_process';
import { Readable } from 'stream';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  CONTAINER_CAP_DROP,
  CONTAINER_SECURITY_OPT,
} from '../runtime/container-config';

export type RedisServerStatus = 'stopped' | 'starting' | 'running' | 'errored';

export interface RedisServerConfig {
  /** DROP root, for persisting the generated requirepass. */
  dropRoot: string;
  /** Host TCP port the instance is reachable on (default 6380 — avoids a system Redis on 6379). */
  port?: number;
  /** Run the instance as a docker container (true) or a host process (false). */
  useDocker: boolean;
  /** Base image for the container path (default redis:7-alpine). */
  image?: string;
  /** Injected docker client (container path). Defaults to a new Docker() when omitted. */
  docker?: Docker;
  /** Optional log sink. */
  onLog?: (msg: string) => void;
}

const CONTAINER_NAME = 'drop-redis';
const DEFAULT_IMAGE = 'redis:7-alpine';
const DEFAULT_PORT = 6380;
/** Non-root user shipped by the redis image; avoids the entrypoint's gosu (needs CAP_SETUID, which we drop). */
const REDIS_IMAGE_USER = 'redis';

export class RedisServer {
  private readonly dropRoot: string;
  private readonly port: number;
  private readonly useDocker: boolean;
  private readonly image: string;
  private readonly onLog?: (msg: string) => void;
  private docker: Docker | null;
  private password = '';
  private process: ChildProcess | null = null;
  private status: RedisServerStatus = 'stopped';

  constructor(config: RedisServerConfig) {
    this.dropRoot = config.dropRoot;
    this.port = config.port ?? DEFAULT_PORT;
    this.useDocker = config.useDocker;
    this.image = config.image ?? DEFAULT_IMAGE;
    this.onLog = config.onLog;
    this.docker = config.docker ?? null;
  }

  getPort(): number {
    return this.port;
  }

  getPassword(): string {
    return this.password;
  }

  getStatus(): RedisServerStatus {
    return this.status;
  }

  /** Start the managed Redis instance. Throws on failure (caller is fail-soft). */
  async start(): Promise<void> {
    if (this.status === 'running') {
      return;
    }
    this.status = 'starting';
    try {
      this.password = await this.loadOrCreatePassword();
      if (this.useDocker) {
        await this.startContainer();
      } else {
        await this.startProcess();
      }
      this.status = 'running';
      this.log(`Managed Redis running on port ${this.port} (${this.useDocker ? 'container' : 'process'})`);
    } catch (err) {
      this.status = 'errored';
      throw err;
    }
  }

  /** Stop the instance. Best-effort; never throws. */
  async stop(): Promise<void> {
    try {
      if (this.useDocker && this.docker) {
        await this.removeContainerIfExists();
      } else if (this.process) {
        this.process.kill('SIGTERM');
        this.process = null;
      }
    } catch (err) {
      this.log(`Error stopping Redis: ${String(err)}`);
    }
    this.status = 'stopped';
  }

  // ============ Container path (docker isolation) ============

  private async startContainer(): Promise<void> {
    const docker = this.ensureDocker();
    await this.ensureImage(docker);
    await this.removeContainerIfExists();

    const container = await docker.createContainer({
      name: CONTAINER_NAME,
      Image: this.image,
      // Run redis-server directly with no persistence and a required password.
      Cmd: ['redis-server', '--requirepass', this.password, '--save', '', '--appendonly', 'no'],
      // Run as the image's non-root redis user so the entrypoint never needs
      // the gosu setuid (CAP_SETUID is dropped below).
      User: REDIS_IMAGE_USER,
      ExposedPorts: { '6379/tcp': {} },
      HostConfig: {
        // Publish so app containers reach it via drop-host:<port>. Auth via
        // --requirepass gates the 0.0.0.0 bind.
        PortBindings: { '6379/tcp': [{ HostIp: '0.0.0.0', HostPort: String(this.port) }] },
        RestartPolicy: { Name: 'unless-stopped' },
        CapDrop: CONTAINER_CAP_DROP,
        SecurityOpt: CONTAINER_SECURITY_OPT,
      },
      Labels: { 'drop.managed': 'true', 'drop.service': 'redis' },
    });

    await container.start();
  }

  private async removeContainerIfExists(): Promise<void> {
    const docker = this.ensureDocker();
    try {
      const c = docker.getContainer(CONTAINER_NAME);
      await c.remove({ force: true });
    } catch (err: unknown) {
      // 404 = not present; anything else is unexpected but non-fatal for start
      // (createContainer will surface a real conflict).
      if (!this.isNotFound(err)) {
        this.log(`Could not remove existing ${CONTAINER_NAME}: ${String(err)}`);
      }
    }
  }

  private async ensureImage(docker: Docker): Promise<void> {
    try {
      await docker.getImage(this.image).inspect();
    } catch {
      await new Promise<void>((resolve, reject) => {
        docker.pull(this.image, (err: Error | null, stream: Readable) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (err2: Error | null) => {
            if (err2) reject(err2);
            else resolve();
          });
        });
      });
    }
  }

  private ensureDocker(): Docker {
    if (!this.docker) {
      this.docker = new Docker();
    }
    return this.docker;
  }

  private isNotFound(err: unknown): boolean {
    const status = (err as { statusCode?: number })?.statusCode;
    return status === 404;
  }

  // ============ Process path (non-docker/dev) ============

  private async startProcess(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(
        'redis-server',
        [
          '--port',
          String(this.port),
          '--bind',
          '127.0.0.1',
          '--requirepass',
          this.password,
          '--save',
          '',
          '--appendonly',
          'no',
        ],
        { stdio: 'ignore' }
      );

      let settled = false;
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `Failed to spawn 'redis-server' (${err.message}). Install Redis on the host, ` +
              `disable managed Redis (DROP_ENABLE_REDIS=false), or run under docker isolation.`
          )
        );
      };
      child.once('error', onError);

      // No readiness handshake for the dev path — give it a short grace period,
      // then assume it bound (redis-server starts near-instantly). A real bind
      // failure surfaces as a connection error when the provisioner first uses it.
      const t = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.process = child;
        child.removeListener('error', onError);
        child.once('error', () => {
          /* post-start crash — the app-facing connection error will report it */
        });
        resolve();
      }, 300);
      t.unref?.();
    });
  }

  // ============ Password persistence ============

  /** Load the persisted requirepass, or generate + persist one on first run. */
  private async loadOrCreatePassword(): Promise<string> {
    const pwPath = path.join(this.dropRoot, 'data', 'drop-svc', 'redis-password');
    try {
      const existing = (await fs.readFile(pwPath, 'utf-8')).trim();
      if (existing) {
        return existing;
      }
    } catch {
      // Not present yet — generate below.
    }
    const password = crypto.randomBytes(24).toString('base64').replace(/[/+=]/g, 'x');
    await fs.mkdir(path.dirname(pwPath), { recursive: true });
    await fs.writeFile(pwPath, password, { mode: 0o600 });
    return password;
  }

  private log(msg: string): void {
    this.onLog?.(msg);
  }
}

// ============ Module singleton (mirrors getPostgresServer) ============

let instance: RedisServer | null = null;

export function getRedisServer(config?: RedisServerConfig): RedisServer {
  if (!instance) {
    if (!config) {
      throw new Error('RedisServer not initialized — first call must pass a config');
    }
    instance = new RedisServer(config);
  }
  return instance;
}

export function resetRedisServer(): void {
  instance = null;
}
