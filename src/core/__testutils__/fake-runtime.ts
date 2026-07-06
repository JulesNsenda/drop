/**
 * FakeRuntime — an in-memory AppRuntime for integration tests (P2-1).
 *
 * Implements the AppRuntime contract with a Map so the real DropPlatform
 * orchestration (event wiring, port reconciliation, re-entrancy guards) runs
 * end-to-end WITHOUT spawning real processes or connecting to the PM2 daemon.
 * Faking at the getAppRuntime seam beats mocking pm2-client, which would still
 * instantiate the real Pm2Runtime and connect to the daemon.
 *
 * `fakeRuntime` is a module-level singleton. The runtime module is partial-
 * mocked so getAppRuntime() returns it and resetAppRuntime() is a no-op — so it
 * SURVIVES platform.stop(). That models PM2 outliving the platform process, and
 * is what lets the re-adoption test spin up a second DropPlatform and still see
 * the app "running". Call fakeRuntime.reset() between test cases.
 */
import type { AppRuntime } from '../../managers/runtime/app-runtime';
import type {
  AppStartSpec,
  AppProcessInfo,
  AppLogPaths,
  RuntimeType,
} from '../../managers/runtime/app-runtime.types';

export class FakeRuntime implements AppRuntime {
  readonly type: RuntimeType = 'pm2';
  private readonly apps = new Map<string, AppProcessInfo>();
  private pidSeq = 1000;
  /** Total start() calls — lets a test assert a reload ran exactly once. */
  startCount = 0;

  /** Clear all tracked apps — call between test cases, NOT between platform instances within a case. */
  reset(): void {
    this.apps.clear();
    this.pidSeq = 1000;
    this.startCount = 0;
  }

  /** Test helper: names the runtime currently reports as running. */
  runningNames(): string[] {
    return [...this.apps.values()].filter((a) => a.status === 'running').map((a) => a.name);
  }

  /** Test helper: current pid of an app (changes on each start/restart), or null. */
  pidOf(name: string): number | null {
    return this.apps.get(name)?.pid ?? null;
  }

  /** Test helper: seed a "surviving" process (e.g. to model PM2 state before a platform restart). */
  seedRunning(name: string, port: number): void {
    this.apps.set(name, this.buildInfo(name, port));
  }

  private buildInfo(name: string, port: number | null): AppProcessInfo {
    return {
      name,
      status: 'running',
      runtime: this.type,
      pid: this.pidSeq++,
      port,
      memory: 0,
      cpu: 0,
      uptime: 0,
      restarts: 0,
      createdAt: new Date(),
      restartedAt: null,
    };
  }

  async start(spec: AppStartSpec): Promise<AppProcessInfo> {
    this.startCount += 1;
    const info = this.buildInfo(spec.name, spec.port ?? null);
    this.apps.set(spec.name, info);
    return { ...info };
  }

  async stop(name: string): Promise<void> {
    const a = this.apps.get(name);
    if (a) {
      a.status = 'stopped';
      a.pid = null;
    }
  }

  async restart(name: string): Promise<AppProcessInfo> {
    const a = this.apps.get(name);
    if (!a) {
      throw new Error(`FakeRuntime: cannot restart unknown app '${name}'`);
    }
    a.status = 'running';
    a.pid = this.pidSeq++;
    a.restarts += 1;
    a.restartedAt = new Date();
    return { ...a };
  }

  async delete(name: string): Promise<void> {
    this.apps.delete(name);
  }

  async getStatus(name: string): Promise<AppProcessInfo | null> {
    const a = this.apps.get(name);
    return a ? { ...a } : null;
  }

  async getAllStatus(): Promise<AppProcessInfo[]> {
    return [...this.apps.values()].map((a) => ({ ...a }));
  }

  async getLogs(): Promise<string> {
    return '';
  }

  async streamLogs(): Promise<() => void> {
    return () => {
      /* no-op */
    };
  }

  async getLogPaths(): Promise<AppLogPaths> {
    return {};
  }

  disconnect(): void {
    /* no-op */
  }
}

/** Shared singleton — see file header for why it must survive resetAppRuntime(). */
export const fakeRuntime = new FakeRuntime();
