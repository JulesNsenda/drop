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
