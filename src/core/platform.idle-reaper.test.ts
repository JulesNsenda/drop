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

import * as path from 'path';
import { DropPlatform, createPlatform } from './platform';
import { tryLogActivity } from '../managers/activity';

jest.mock('../managers/activity', () => ({
  tryLogActivity: jest.fn().mockResolvedValue(undefined),
  getActivityLog: jest.fn(),
  resetActivityLog: jest.fn(),
  ActivityLog: class {},
}));

const HOUR_MS = 60 * 60 * 1000;

describe('idle reaper dry-run budget', () => {
  let platform: DropPlatform;
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
  const seedApps = (dormantCreatedHoursAgo: number, extra: string[] = []) => {
    const now = Date.now();
    const dormant = ['dormant', ...extra];
    (platform as any).stateManager = {
      getAllApps: () => [
        { name: 'busy', status: 'running', createdAt: new Date(now - 100 * HOUR_MS).toISOString() },
        ...dormant.map((name) => ({
          name,
          status: 'running',
          userId: 'u1',
          createdAt: new Date(now - dormantCreatedHoursAgo * HOUR_MS).toISOString(),
        })),
      ],
      getApp: (name: string) => ({ name, status: 'running', userId: 'u1' }),
    };
    (platform as any).appConfigService = {
      // `busy` is deliberately NOT agentCreated: it is the human's app, and the
      // reaper must never touch it.
      getConfig: (name: string) => (name === 'busy' ? {} : { agentCreated: true }),
    };
    (platform as any).runtime = {
      getStatus: async (name: string) => ({ cpuTotalNs: name === 'busy' ? busyCpu : 5_000 }),
    };
  };

  /** Make the dormant apps look motionless for well over the window. */
  const seedIdleHistory = (lastActiveHoursAgo: number, names: string[] = ['dormant']) => {
    const now = Date.now();
    for (const name of names) {
      (platform as any).idleState.lastCpu.set(name, 5_000);
      (platform as any).idleState.lastActive.set(name, now - lastActiveHoursAgo * HOUR_MS);
    }
  };

  const sweep = async () => {
    busyCpu += 500_000_000; // comfortably over ACTIVITY_THRESHOLD_NS
    await (platform as any).sweepIdleApps();
  };

  beforeEach(() => {
    process.env.DROP_IDLE_REAP_DRY_RUNS = '3';
    process.env.DROP_IDLE_REAP_HOURS = '24';
    busyCpu = 1_000_000_000;
    (tryLogActivity as jest.Mock).mockClear();

    // No temp directory: the constructor assembles config and a logger and
    // touches no filesystem, and every collaborator this drives is stubbed.
    const root = path.join('C:', 'drop-reaper-test-unused');
    platform = createPlatform({
      dropRoot: root,
      appsDirectory: path.join(root, 'apps'),
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

  afterEach(() => {
    if (savedDryRuns === undefined) delete process.env.DROP_IDLE_REAP_DRY_RUNS;
    else process.env.DROP_IDLE_REAP_DRY_RUNS = savedDryRuns;
    if (savedHours === undefined) delete process.env.DROP_IDLE_REAP_HOURS;
    else process.env.DROP_IDLE_REAP_HOURS = savedHours;
  });

  it('does not spend the budget on sweeps that reap nothing', async () => {
    // Nothing is reapable yet: the candidate is younger than the idle window.
    seedApps(2);
    seedIdleHistory(0.1);

    for (let i = 0; i < 5; i += 1) await sweep();

    expect(teardownApp).not.toHaveBeenCalled();
  });

  it('still dry-runs the FIRST sweep that finds a candidate, after many quiet ones', async () => {
    // This is the regression. Counting every sweep burned the whole 3-sweep
    // budget on these five no-ops, so the very first app that ever qualified
    // was deleted for real with no dry-run line ever logged.
    seedApps(2);
    seedIdleHistory(0.1);
    for (let i = 0; i < 5; i += 1) await sweep();

    // Now it becomes genuinely reapable: old enough, and motionless for longer
    // than the window.
    seedApps(100);
    seedIdleHistory(30);
    await sweep();

    expect(teardownApp).not.toHaveBeenCalled();
    // The quotes matter: `would reap idle app '<name>'` contains the bare word
    // "idle" regardless of which app it names, so an unquoted substring test
    // would pass even if the line named the wrong app.
    expect(infoLines.some((l) => l.includes('[dry run 1/3]') && l.includes("'dormant'"))).toBe(true);
  });

  it('reaps for real once that app has used its own dry runs', async () => {
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

    expect(teardownApp).toHaveBeenCalledWith('dormant');
    // Never the human's app, which is not agentCreated.
    expect(teardownApp).toHaveBeenCalledTimes(1);
  });

  it('gives a LATER app its own dry runs instead of deleting it outright', async () => {
    // The budget is per app. A single process-wide counter would be spent by
    // the first app that legitimately qualifies, so the next one — possibly
    // months later, possibly the one a broken signal produced — would be
    // deleted with no warning at all. That is the case the guard exists for.
    seedApps(100);
    for (let i = 0; i < 4; i += 1) {
      seedIdleHistory(30);
      await sweep();
    }
    expect(teardownApp).toHaveBeenCalledWith('dormant');
    expect(teardownApp).toHaveBeenCalledTimes(1);

    infoLines.length = 0;
    // A second agent-created app now goes idle.
    seedApps(100, ['latecomer']);
    seedIdleHistory(30, ['latecomer']);
    await sweep();

    expect(teardownApp).toHaveBeenCalledTimes(1); // still just the first one
    expect(infoLines.some((l) => l.includes('[dry run 1/3]') && l.includes("'latecomer'"))).toBe(
      true
    );
  });

  it('records each dry run durably, not only as a log line', async () => {
    // An operator is not tailing logs at 3am. The dashboard activity feed is
    // the reviewable record that a deletion was coming.
    seedApps(100);
    seedIdleHistory(30);
    await sweep();

    expect(tryLogActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'idle-reap-dryrun', appName: 'dormant' })
    );
  });
});

/**
 * Expired-ephemeral sweep (Step 10).
 *
 * Unlike the idle and disk sweeps, this one does NOT exclude group containers —
 * and it must not, because an expiry is a deadline the caller asked for. That
 * makes the teardown it chooses load-bearing: only the container ever carries
 * the `ephemeral` flag (expandMonorepo synthesizes the children afterwards), so
 * a per-app teardown would leave every child service running and routed with no
 * flag of its own for any later sweep to collect it by.
 */
describe('expired ephemeral sweep', () => {
  let platform: DropPlatform;
  let teardownApp: jest.Mock;
  let removeGroup: jest.Mock;

  /** One expired ephemeral config; `app` is what the state manager reports. */
  const seed = (app: Record<string, unknown>) => {
    (platform as any).appConfigService = {
      getAllConfigs: () => [
        {
          name: 'scratch',
          ephemeral: true,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        },
      ],
    };
    (platform as any).stateManager = { getApp: () => app };
  };

  beforeEach(() => {
    (tryLogActivity as jest.Mock).mockClear();
    const root = path.join('C:', 'drop-reaper-test-unused');
    platform = createPlatform({
      dropRoot: root,
      appsDirectory: path.join(root, 'apps'),
      logLevel: 'error',
    });

    teardownApp = jest.fn().mockResolvedValue(undefined);
    removeGroup = jest.fn().mockResolvedValue({ removed: [] });
    (platform as any).teardownApp = teardownApp;
    (platform as any).removeGroup = removeGroup;
    (platform as any).logger = {
      info: () => undefined,
      warn: () => undefined,
      debug: () => undefined,
      error: () => undefined,
    };
  });

  it('removes the whole group when the expired ephemeral is a monorepo container', async () => {
    seed({ name: 'scratch', userId: 'u1', isGroupContainer: true, group: 'scratch' });

    await (platform as any).sweepExpiredEphemerals();

    expect(removeGroup).toHaveBeenCalledWith('scratch');
    // The container must NOT also be torn down on its own: removeGroup already
    // does that last, and a second pass would race its own fs.rm.
    expect(teardownApp).not.toHaveBeenCalled();
  });

  it('tears down an ordinary ephemeral directly, skipping the database backup', async () => {
    // The negative control: routing everything through removeGroup would lose
    // skipDatabaseBackup and fill the box with dumps of scratch databases.
    seed({ name: 'scratch', userId: 'u1' });

    await (platform as any).sweepExpiredEphemerals();

    expect(teardownApp).toHaveBeenCalledWith('scratch', { skipDatabaseBackup: true });
    expect(removeGroup).not.toHaveBeenCalled();
  });

  it('does not route a child of a group through removeGroup', async () => {
    // A child carries `group` but is not the container. Removing its whole
    // group would delete its siblings — an expiry the caller never set on them.
    seed({ name: 'scratch', userId: 'u1', group: 'some-group' });

    await (platform as any).sweepExpiredEphemerals();

    expect(teardownApp).toHaveBeenCalledWith('scratch', { skipDatabaseBackup: true });
    expect(removeGroup).not.toHaveBeenCalled();
  });
});
