/**
 * Idle reaper dry-run budget (Step 9 follow-up, DROP-108).
 *
 * The reaper DELETES apps and their databases, and `DROP_IDLE_REAP_DRY_RUNS` is
 * the only thing between a wrong signal and data loss. It only buys that if the
 * budget is spent on sweeps that would actually reap.
 *
 * The shipped code incremented the counter on every sweep that got past the
 * liveness precondition, including the overwhelming majority that reap nothing.
 * Because no app can be reapable until the platform has been up for a full idle
 * window — the first sweep after a restart re-baselines `lastActive` to now —
 * and sweeps run every 15 minutes, the budget was always exhausted long before
 * the first real candidate appeared. The guard could never fire.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DropPlatform, createPlatform } from './platform';

jest.mock('../managers/activity', () => ({
  tryLogActivity: jest.fn().mockResolvedValue(undefined),
  getActivityLog: jest.fn(),
  resetActivityLog: jest.fn(),
  ActivityLog: class {},
}));

const HOUR_MS = 60 * 60 * 1000;

describe('idle reaper dry-run budget', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let teardownApp: jest.Mock;
  let infoLines: string[];
  /** Bumped between sweeps so the fleet always looks alive. */
  let busyCpu: number;

  const savedDryRuns = process.env.DROP_IDLE_REAP_DRY_RUNS;
  const savedHours = process.env.DROP_IDLE_REAP_HOURS;

  /**
   * Two apps, and both are load-bearing:
   *  - `busy` moves CPU every sweep, which satisfies planIdleSweep's global
   *    liveness precondition. Without it every sweep aborts and the test proves
   *    nothing.
   *  - `idle` is the agent-created candidate, deliberately motionless.
   */
  const seedApps = (idleCreatedHoursAgo: number) => {
    const now = Date.now();
    (platform as any).stateManager = {
      getAllApps: () => [
        { name: 'busy', status: 'running', createdAt: new Date(now - 100 * HOUR_MS).toISOString() },
        {
          name: 'idle',
          status: 'running',
          userId: 'u1',
          createdAt: new Date(now - idleCreatedHoursAgo * HOUR_MS).toISOString(),
        },
      ],
      getApp: (name: string) => ({ name, status: 'running', userId: 'u1' }),
    };
    (platform as any).appConfigService = {
      getConfig: (name: string) => (name === 'idle' ? { agentCreated: true } : {}),
    };
    (platform as any).runtime = {
      getStatus: async (name: string) => ({ cpuTotalNs: name === 'busy' ? busyCpu : 5_000 }),
    };
  };

  /** Make `idle` look like it has been motionless for well over the window. */
  const seedIdleHistory = (lastActiveHoursAgo: number) => {
    const now = Date.now();
    (platform as any).idleState.lastCpu.set('idle', 5_000);
    (platform as any).idleState.lastActive.set('idle', now - lastActiveHoursAgo * HOUR_MS);
  };

  const sweep = async () => {
    busyCpu += 500_000_000; // comfortably over ACTIVITY_THRESHOLD_NS
    await (platform as any).sweepIdleApps();
  };

  beforeEach(async () => {
    process.env.DROP_IDLE_REAP_DRY_RUNS = '3';
    process.env.DROP_IDLE_REAP_HOURS = '24';
    busyCpu = 1_000_000_000;

    tempDir = path.join(os.tmpdir(), `drop-reaper-${Date.now()}-${Math.random()}`);
    await fs.mkdir(tempDir, { recursive: true });
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
    });

    teardownApp = jest.fn().mockResolvedValue(undefined);
    (platform as any).teardownApp = teardownApp;

    infoLines = [];
    (platform as any).logger = {
      info: (msg: string) => infoLines.push(msg),
      warn: () => undefined,
      debug: () => undefined,
      error: () => undefined,
    };
  });

  afterEach(async () => {
    if (savedDryRuns === undefined) delete process.env.DROP_IDLE_REAP_DRY_RUNS;
    else process.env.DROP_IDLE_REAP_DRY_RUNS = savedDryRuns;
    if (savedHours === undefined) delete process.env.DROP_IDLE_REAP_HOURS;
    else process.env.DROP_IDLE_REAP_HOURS = savedHours;
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('does not spend the budget on sweeps that reap nothing', async () => {
    // Nothing is reapable yet: the candidate is younger than the idle window.
    seedApps(2);
    seedIdleHistory(0.1);

    for (let i = 0; i < 5; i += 1) await sweep();

    expect(teardownApp).not.toHaveBeenCalled();
    expect((platform as any).idleSweepCount).toBe(0);
  });

  it('still dry-runs the FIRST sweep that finds a candidate, after many quiet ones', async () => {
    // This is the regression. Before the fix these five no-op sweeps burned the
    // whole 3-sweep budget, so the very first app that ever qualified was
    // deleted for real with no dry-run line ever logged.
    seedApps(2);
    seedIdleHistory(0.1);
    for (let i = 0; i < 5; i += 1) await sweep();

    // Now the app becomes genuinely reapable: old enough, and motionless for
    // longer than the window.
    seedApps(100);
    seedIdleHistory(30);
    await sweep();

    expect(teardownApp).not.toHaveBeenCalled();
    expect(infoLines.some((l) => l.includes('[dry run 1/3]') && l.includes('idle'))).toBe(true);
  });

  it('reaps for real once the budget is spent by reaping sweeps', async () => {
    seedApps(100);

    // Three reap-producing sweeps are dry runs...
    for (let i = 0; i < 3; i += 1) {
      seedIdleHistory(30);
      await sweep();
    }
    expect(teardownApp).not.toHaveBeenCalled();

    // ...the fourth is real.
    seedIdleHistory(30);
    await sweep();

    expect(teardownApp).toHaveBeenCalledWith('idle');
  });
});
