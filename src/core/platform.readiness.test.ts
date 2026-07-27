/**
 * Readiness gate + crash-loop watch (M3) unit tests.
 *
 * Covers the two private DropPlatform methods introduced to stop declaring an
 * app 'running' the instant PM2/Docker report the process forked:
 *  - `awaitReadiness` — polls the runtime for liveness/restarts and probes the
 *    port/HTTP; called by `handleStartApp` right after `runtime.start`.
 *  - `startCrashLoopWatch` / `stopCrashLoopWatch` — a post-deploy 30s interval
 *    that flips an already-`running` app to `crash-looping` once its restart
 *    count climbs past the threshold.
 *
 * These are exercised directly via `(platform as any)` against a platform that
 * is constructed but never `start()`-ed — the constructor does no I/O (that
 * all lives in `start()`/`initializeServices()`), so `runtime`/`stateManager`
 * can be swapped for bare mocks without needing the heavier module-level mocks
 * `platform.test.ts` sets up for the full pipeline.
 */

import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { createPlatform, DropPlatform } from './platform';
import { AppStartSpec } from '../managers/runtime';

describe('DropPlatform readiness gate (M3)', () => {
  let platform: DropPlatform;
  let tempDir: string;

  beforeEach(() => {
    tempDir = path.join(
      os.tmpdir(),
      `drop-test-readiness-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
    });
  });

  afterEach(async () => {
    if (platform.isActive()) {
      await platform.stop();
    }
  });

  /** Minimal AppStartSpec — only `name`/`script`/`cwd` are required by the type. */
  const minimalSpec = (overrides: Partial<AppStartSpec> = {}): AppStartSpec => ({
    name: 'app',
    script: 'node',
    cwd: tempDir,
    ...overrides,
  });

  describe('awaitReadiness', () => {
    it('resolves { ok: true } as soon as an HTTP probe answers (happy path)', async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(200);
        res.end('ok');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as { port: number }).port;

      (platform as any).runtime = {
        getStatus: jest.fn().mockResolvedValue({ status: 'running', restarts: 0 }),
      };

      try {
        const result = await (platform as any).awaitReadiness(
          'happyapp',
          port,
          minimalSpec({ name: 'happyapp', port })
        );
        expect(result).toEqual({ ok: true });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('reports OOM as its own verdict, not as a generic exit', async () => {
      // `container-manager` read State.OOMKilled and discarded it, so an app
      // killed for exceeding its memory limit was indistinguishable from one
      // that crashed on a bug. The two need opposite fixes — raise the ceiling
      // vs fix the code — so an agent given PROCESS_EXITED debugs the wrong
      // thing.
      const getStatus = jest
        .fn()
        .mockResolvedValueOnce({ status: 'running', restarts: 0 })
        .mockResolvedValue({ status: 'errored', restarts: 0, oomKilled: true });
      (platform as any).runtime = { getStatus };

      const result = await (platform as any).awaitReadiness(
        'fatapp',
        48110,
        minimalSpec({ name: 'fatapp', port: 48110, limits: { memory: '256M' } })
      );

      expect(result.ok).toBe(false);
      expect(result.failure).toBe('oom-killed');
    });

    it('names the configured limit, so the verdict is actionable', async () => {
      const getStatus = jest
        .fn()
        .mockResolvedValueOnce({ status: 'running', restarts: 0 })
        .mockResolvedValue({ status: 'errored', restarts: 0, oomKilled: true });
      (platform as any).runtime = { getStatus };

      const result = await (platform as any).awaitReadiness(
        'fatapp',
        48111,
        minimalSpec({ name: 'fatapp', port: 48111, limits: { memory: '256M' } })
      );

      expect(result.reason).toContain('256M');
    });

    it('still reports a plain exit when the runtime did NOT confirm an OOM', async () => {
      // The flag is authoritative only when true. PM2 leaves it undefined
      // entirely, and Docker clears it on the next run — so a false must never
      // be read as "definitely not memory", nor a crash reported as OOM.
      const getStatus = jest
        .fn()
        .mockResolvedValueOnce({ status: 'running', restarts: 0 })
        .mockResolvedValue({ status: 'errored', restarts: 0 });
      (platform as any).runtime = { getStatus };

      const result = await (platform as any).awaitReadiness(
        'plainapp',
        48112,
        minimalSpec({ name: 'plainapp', port: 48112, limits: { memory: '256M' } })
      );

      expect(result.failure).toBe('process-exited');
    });

    it('does not claim OOM for a crash-loop, where the flag has already been cleared', async () => {
      // Docker's RestartPolicy is on-failure, so a container that is back up
      // after an OOM reports OOMKilled=false. Guessing there would be an
      // inference dressed as a fact.
      const getStatus = jest
        .fn()
        .mockResolvedValueOnce({ status: 'running', restarts: 0 })
        .mockResolvedValue({ status: 'running', restarts: 5, oomKilled: false });
      (platform as any).runtime = { getStatus };

      const result = await (platform as any).awaitReadiness(
        'loopapp',
        48113,
        minimalSpec({ name: 'loopapp', port: 48113, limits: { memory: '256M' } })
      );

      expect(result.failure).toBe('crash-looped');
    });

    it('fails fast with a crash-loop reason once restarts climb above the baseline', async () => {
      // First call (the baseline read, before the poll loop starts) reports 0
      // restarts; every subsequent call (inside the poll loop) reports a
      // higher count, simulating a process that crash-looped right after
      // `runtime.start` returned.
      const getStatus = jest
        .fn()
        .mockResolvedValueOnce({ status: 'running', restarts: 0 })
        .mockResolvedValue({ status: 'running', restarts: 5 });
      (platform as any).runtime = { getStatus };

      const result = await (platform as any).awaitReadiness(
        'crashloopapp',
        48100,
        minimalSpec({ name: 'crashloopapp', port: 48100 })
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/crash-looped during startup/);
    });

    it('fails fast with a process-exited reason when the runtime reports stopped/errored', async () => {
      (platform as any).runtime = {
        getStatus: jest.fn().mockResolvedValue({ status: 'errored', restarts: 0 }),
      };

      const result = await (platform as any).awaitReadiness(
        'deadapp',
        48101,
        minimalSpec({ name: 'deadapp', port: 48101 })
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/process exited during startup/);
    });

    it('does NOT falsely error a no-HTTP worker: stable process, no port bound, no healthCheckPath → ok:true', async () => {
      (platform as any).config.isolation = 'none';
      (platform as any).runtime = {
        getStatus: jest.fn().mockResolvedValue({ status: 'running', restarts: 0 }),
      };
      const port = 48102; // nothing is listening here

      const result = await (platform as any).awaitReadiness(
        'workerapp',
        port,
        minimalSpec({ name: 'workerapp', port, healthCheckPath: undefined })
      );

      expect(result).toEqual({ ok: true });
    });

    // Regression: a healthy app that simply booted slower than the window was
    // declared failed. Reproduced live as a Node app that listens after 25s —
    // build fine, process alive, URL serving 200, deploy reported 'errored'.
    // At the deadline "still booting" and "hung" are indistinguishable, so the
    // gate must not convict a process that never died and never crash-looped;
    // only the two fail-fast paths above are real failures.
    it('does not error a slow-booting app that is alive and has never crash-looped', async () => {
      (platform as any).config.isolation = 'docker'; // the stricter branch: a bind alone is not proof
      (platform as any).readinessTimeoutMs = 150;
      (platform as any).runtime = {
        getStatus: jest.fn().mockResolvedValue({ status: 'running', restarts: 0 }),
      };
      const port = 48103; // still booting — nothing listening yet

      const result = await (platform as any).awaitReadiness(
        'slowapp',
        port,
        minimalSpec({ name: 'slowapp', port, healthCheckPath: '/' })
      );

      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.warning).toMatch(/slow start/);
    });

    it.each([
      ['exited', { status: 'stopped', restarts: 0 }, /exited/],
      ['crash-looped', { status: 'running', restarts: 5 }, /crash-looped/],
    ])('still fails a process that %s, rather than waiting it out', async (_label, status, reason) => {
      (platform as any).config.isolation = 'docker';
      (platform as any).readinessTimeoutMs = 150;
      (platform as any).runtime = {
        getStatus: jest
          .fn()
          .mockResolvedValueOnce({ status: 'running', restarts: 0 }) // baseline
          .mockResolvedValue(status),
      };

      const result = await (platform as any).awaitReadiness(
        'badapp',
        48104,
        minimalSpec({ name: 'badapp', port: 48104, healthCheckPath: '/' })
      );

      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(reason);
    });
  });

  describe('startCrashLoopWatch / stopCrashLoopWatch', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('flags an already-running app crash-looping once restarts climb by the threshold', async () => {
      jest.useFakeTimers();
      let restarts = 0;
      (platform as any).runtime = {
        getStatus: jest.fn().mockImplementation(async () => ({ status: 'running', restarts })),
      };
      const setAppStatus = jest.fn().mockResolvedValue(undefined);
      (platform as any).stateManager = {
        getApp: jest.fn().mockReturnValue({ status: 'running' }),
        setAppStatus,
      };

      (platform as any).startCrashLoopWatch('flappy');

      // First tick (30s) only establishes the baseline — no flag yet.
      await jest.advanceTimersByTimeAsync(30_000);
      expect(setAppStatus).not.toHaveBeenCalled();

      // Restarts climb by >= CRASHLOOP_RESTART_THRESHOLD (3) since baseline.
      restarts = 3;
      await jest.advanceTimersByTimeAsync(30_000);

      expect(setAppStatus).toHaveBeenCalledWith(
        'flappy',
        'crash-looping',
        expect.objectContaining({ error: expect.any(String) })
      );

      (platform as any).stopCrashLoopWatch('flappy');
    });

    it('says OOM in the flag when the runtime confirms it, not "restarting repeatedly"', async () => {
      // The two need opposite fixes. "Process is restarting repeatedly" sends
      // an operator hunting a crash bug; the actual fix is a bigger ceiling.
      jest.useFakeTimers();
      let restarts = 0;
      let oomKilled = false;
      (platform as any).runtime = {
        getStatus: jest.fn().mockImplementation(async () => ({
          status: 'running',
          restarts,
          oomKilled,
        })),
      };
      const setAppStatus = jest.fn().mockResolvedValue(undefined);
      (platform as any).stateManager = {
        getApp: jest.fn().mockReturnValue({ status: 'running' }),
        setAppStatus,
      };

      (platform as any).startCrashLoopWatch('fatty');
      await jest.advanceTimersByTimeAsync(30_000); // baseline

      restarts = 3;
      oomKilled = true; // a tick that caught it down, before Docker cleared it
      await jest.advanceTimersByTimeAsync(30_000);

      expect(setAppStatus).toHaveBeenCalledWith(
        'fatty',
        'crash-looping',
        expect.objectContaining({ error: expect.stringMatching(/memory limit/i) })
      );

      (platform as any).stopCrashLoopWatch('fatty');
    });

    it('does not claim OOM when the runtime never confirmed one', async () => {
      jest.useFakeTimers();
      let restarts = 0;
      (platform as any).runtime = {
        getStatus: jest.fn().mockImplementation(async () => ({ status: 'running', restarts })),
      };
      const setAppStatus = jest.fn().mockResolvedValue(undefined);
      (platform as any).stateManager = {
        getApp: jest.fn().mockReturnValue({ status: 'running' }),
        setAppStatus,
      };

      (platform as any).startCrashLoopWatch('plain');
      await jest.advanceTimersByTimeAsync(30_000);

      restarts = 3;
      await jest.advanceTimersByTimeAsync(30_000);

      expect(setAppStatus).toHaveBeenCalledWith(
        'plain',
        'crash-looping',
        expect.objectContaining({ error: expect.not.stringMatching(/memory limit/i) })
      );

      (platform as any).stopCrashLoopWatch('plain');
    });

    it('does not flag a stable (non-climbing) app', async () => {
      jest.useFakeTimers();
      (platform as any).runtime = {
        getStatus: jest.fn().mockResolvedValue({ status: 'running', restarts: 2 }),
      };
      const setAppStatus = jest.fn().mockResolvedValue(undefined);
      (platform as any).stateManager = {
        getApp: jest.fn().mockReturnValue({ status: 'running' }),
        setAppStatus,
      };

      (platform as any).startCrashLoopWatch('stable');

      await jest.advanceTimersByTimeAsync(30_000); // baseline tick
      await jest.advanceTimersByTimeAsync(30_000); // unchanged
      await jest.advanceTimersByTimeAsync(30_000); // unchanged

      expect(setAppStatus).not.toHaveBeenCalled();

      (platform as any).stopCrashLoopWatch('stable');
    });

    it('stopCrashLoopWatch clears the interval so no further ticks fire', async () => {
      jest.useFakeTimers();
      const getStatus = jest.fn().mockResolvedValue({ status: 'running', restarts: 0 });
      (platform as any).runtime = { getStatus };
      (platform as any).stateManager = {
        getApp: jest.fn().mockReturnValue({ status: 'running' }),
        setAppStatus: jest.fn().mockResolvedValue(undefined),
      };

      (platform as any).startCrashLoopWatch('shortlived');
      await jest.advanceTimersByTimeAsync(30_000); // baseline tick fires once
      const callsBeforeStop = getStatus.mock.calls.length;

      (platform as any).stopCrashLoopWatch('shortlived');
      await jest.advanceTimersByTimeAsync(60_000);

      expect(getStatus.mock.calls.length).toBe(callsBeforeStop);
    });
  });
});
