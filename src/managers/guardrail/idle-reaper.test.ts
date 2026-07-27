/**
 * Idle reaper.
 *
 * This DELETES apps and their databases, so nearly every test here is about
 * something it must refuse to do. The one genuinely dangerous failure mode is a
 * broken signal reading as fleet-wide idleness.
 */

import {
  planIdleSweep,
  createIdleSweepState,
  idleWindowMs,
  dryRunSweeps,
  ACTIVITY_THRESHOLD_NS,
} from './idle-reaper';

const HOUR = 60 * 60 * 1000;
const T0 = 1_000_000_000;

const agentApp = (over: Record<string, unknown> = {}) => ({
  name: 'ephemeral',
  agentCreated: true,
  status: 'running',
  createdAt: new Date(T0 - 48 * HOUR).toISOString(),
  cpuTotalNs: 1_000_000_000,
  ...over,
});

describe('idleWindowMs', () => {
  const saved = process.env.DROP_IDLE_REAP_HOURS;

  afterEach(() => {
    if (saved === undefined) delete process.env.DROP_IDLE_REAP_HOURS;
    else process.env.DROP_IDLE_REAP_HOURS = saved;
  });

  it('defaults to 24 hours', () => {
    delete process.env.DROP_IDLE_REAP_HOURS;
    expect(idleWindowMs()).toBe(24 * HOUR);
  });

  it('treats 0 as DISABLED', () => {
    process.env.DROP_IDLE_REAP_HOURS = '0';
    expect(idleWindowMs()).toBe(0);
  });

  it('falls back to the default on nonsense rather than reaping immediately', () => {
    // A NaN window would compare false everywhere, or — read as 0 — would mean
    // "everything has been idle long enough", i.e. delete the fleet.
    process.env.DROP_IDLE_REAP_HOURS = 'soon';
    expect(idleWindowMs()).toBe(24 * HOUR);

    process.env.DROP_IDLE_REAP_HOURS = '-3';
    expect(idleWindowMs()).toBe(24 * HOUR);
  });
});

describe('dryRunSweeps', () => {
  const saved = process.env.DROP_IDLE_REAP_DRY_RUNS;

  afterEach(() => {
    if (saved === undefined) delete process.env.DROP_IDLE_REAP_DRY_RUNS;
    else process.env.DROP_IDLE_REAP_DRY_RUNS = saved;
  });

  it('defaults to a non-zero number of dry runs', () => {
    delete process.env.DROP_IDLE_REAP_DRY_RUNS;
    expect(dryRunSweeps()).toBeGreaterThan(0);
  });

  it('allows an explicit 0 for an operator who wants it live immediately', () => {
    process.env.DROP_IDLE_REAP_DRY_RUNS = '0';
    expect(dryRunSweeps()).toBe(0);
  });
});

describe('planIdleSweep', () => {
  let state: ReturnType<typeof createIdleSweepState>;

  beforeEach(() => {
    state = createIdleSweepState();
    delete process.env.DROP_IDLE_REAP_HOURS;
  });

  /**
   * A demonstrably-alive app, included in every fleet below.
   *
   * The global liveness precondition refuses to reap anything when NOTHING on
   * the box shows activity, so a fleet of one idle app is never reaped — see
   * the dedicated test for that. Every reap-positive case therefore needs a
   * living neighbour, exactly as a real box would have.
   */
  const liveNeighbour = (cpu: number) => ({
    name: 'neighbour',
    agentCreated: false,
    status: 'running',
    createdAt: new Date(T0 - 48 * HOUR).toISOString(),
    cpuTotalNs: cpu,
  });

  /** Two sweeps with an unchanged counter, far enough apart to be idle. */
  const twoIdleSweeps = (apps: Array<Record<string, unknown>>) => {
    planIdleSweep([...apps, liveNeighbour(1)] as never, state, T0);
    return planIdleSweep(
      [...apps, liveNeighbour(9_000_000_000)] as never,
      state,
      T0 + 25 * HOUR
    );
  };

  it('reaps an agent-created app whose CPU counter has not moved', () => {
    const result = twoIdleSweeps([agentApp()]);

    expect(result.reap).toEqual(['ephemeral']);
  });

  it('never reaps on the FIRST reading', () => {
    // The first sweep is a baseline. Treating it as idleness would make every
    // app reapable the moment the platform restarts.
    const result = planIdleSweep([agentApp()], state, T0);

    expect(result.reap).toEqual([]);
  });

  it('does NOT reap an app that did work between sweeps', () => {
    planIdleSweep([agentApp()], state, T0);

    const result = planIdleSweep(
      [agentApp({ cpuTotalNs: 1_000_000_000 + ACTIVITY_THRESHOLD_NS * 2 })],
      state,
      T0 + 25 * HOUR
    );

    expect(result.reap).toEqual([]);
  });

  it('ignores a trickle below the activity threshold', () => {
    // A container burns a little CPU just existing. A strict `> 0` test would
    // read every app as active forever and the reaper would never fire.
    planIdleSweep([agentApp(), liveNeighbour(1)] as never, state, T0);

    const result = planIdleSweep(
      [agentApp({ cpuTotalNs: 1_000_000_000 + 1000 }), liveNeighbour(9_000_000_000)] as never,
      state,
      T0 + 25 * HOUR
    );

    expect(result.reap).toEqual(['ephemeral']);
  });

  it('treats a counter that went BACKWARDS as a restart, not as idleness', () => {
    planIdleSweep([agentApp()], state, T0);

    const result = planIdleSweep([agentApp({ cpuTotalNs: 5 })], state, T0 + 25 * HOUR);

    expect(result.reap).toEqual([]);
  });

  it('NEVER reaps a human-created app', () => {
    const result = twoIdleSweeps([agentApp({ agentCreated: false })]);

    expect(result.reap).toEqual([]);
  });

  it('never reaps an app with no agentCreated flag at all', () => {
    // Absent must not read as true. Every app that predates this feature has
    // no flag, and they are exactly the long-lived ones.
    const result = twoIdleSweeps([agentApp({ agentCreated: undefined })]);

    expect(result.reap).toEqual([]);
  });

  it('honours the noReap opt-out', () => {
    const result = twoIdleSweeps([agentApp({ noReap: true })]);

    expect(result.reap).toEqual([]);
  });

  it('never reaps an app younger than the window', () => {
    // Created five hours before the second sweep, so it cannot have been idle
    // for a full 24-hour window however quiet its counter is.
    const result = twoIdleSweeps([
      agentApp({ createdAt: new Date(T0 + 20 * HOUR).toISOString() }),
    ]);

    expect(result.reap).toEqual([]);
  });

  it('never reaps an app whose createdAt is unparseable', () => {
    // A malformed timestamp must fail toward KEEPING the app. `new
    // Date('garbage').getTime()` is NaN and every comparison against NaN is
    // false, so a naive age check would let it straight through.
    const result = twoIdleSweeps([agentApp({ createdAt: 'not-a-date' })]);

    expect(result.reap).toEqual([]);
  });

  it('never reaps an app that is not running', () => {
    const result = twoIdleSweeps([agentApp({ status: 'stopped' })]);

    expect(result.reap).toEqual([]);
  });

  it('never reaps an app the runtime could not measure', () => {
    // PM2 reports no cumulative counter at all. Absent is "cannot know", not
    // "did no work" — reading it as idle would delete every PM2-hosted app.
    const result = twoIdleSweeps([agentApp({ cpuTotalNs: undefined })]);

    expect(result.reap).toEqual([]);
  });

  it('never reaps a fleet of ONE idle app, by design', () => {
    // A known and accepted limitation of the liveness precondition: with
    // nothing alive to prove the signal works, "everything is idle" and "the
    // signal is broken" are indistinguishable, and the cost of guessing wrong
    // is deleting the only app on the box.
    planIdleSweep([agentApp()], state, T0);

    const result = planIdleSweep([agentApp()], state, T0 + 25 * HOUR);

    expect(result.reap).toEqual([]);
    expect(result.abortReason).toMatch(/no app on the box/i);
  });

  it('ABORTS THE WHOLE SWEEP when no app anywhere reports a reading', () => {
    // The dangerous failure. A docker daemon that stopped answering, a
    // permissions change, a runtime swap — every app looks idle at once and a
    // naive reaper deletes the entire fleet in one pass.
    planIdleSweep([agentApp(), agentApp({ name: 'other' })], state, T0);

    const result = planIdleSweep(
      [agentApp({ cpuTotalNs: undefined }), agentApp({ name: 'other', cpuTotalNs: undefined })],
      state,
      T0 + 25 * HOUR
    );

    expect(result.reap).toEqual([]);
    expect(result.abortReason).toMatch(/no runtime reported/i);
  });

  it('aborts when the whole fleet is simultaneously idle, which is not a fleet', () => {
    // Every app going quiet in the same sweep is far more likely to be a broken
    // signal than a genuinely dead box, and the cost of being wrong is total.
    const apps = [agentApp(), agentApp({ name: 'other' })];
    planIdleSweep(apps, state, T0);

    const result = planIdleSweep(apps, state, T0 + 25 * HOUR);

    // Both apps are idle, so the liveness precondition refuses.
    expect(result.reap).toEqual([]);
    expect(result.abortReason).toMatch(/no app on the box/i);
  });

  it('reaps the idle one while another app is demonstrably alive', () => {
    // The precondition must not block the normal case, or the feature is inert.
    const busy = agentApp({ name: 'busy', cpuTotalNs: 1_000_000_000 });
    planIdleSweep([agentApp(), busy], state, T0);

    const result = planIdleSweep(
      [agentApp(), agentApp({ name: 'busy', cpuTotalNs: 9_000_000_000 })],
      state,
      T0 + 25 * HOUR
    );

    expect(result.reap).toEqual(['ephemeral']);
  });

  it('does nothing when reaping is disabled', () => {
    process.env.DROP_IDLE_REAP_HOURS = '0';

    const result = twoIdleSweeps([agentApp()]);

    expect(result.reap).toEqual([]);
    expect(result.abortReason).toBe('disabled');
  });

  it('counts a HUMAN app as fleet liveness even though it is never reaped', () => {
    // Otherwise a box whose only active app is human-owned reads as dead, and
    // the precondition would block every legitimate reap on it.
    const human = { name: 'human-app', agentCreated: false, status: 'running', cpuTotalNs: 1 };
    planIdleSweep([agentApp(), human], state, T0);

    const result = planIdleSweep(
      [agentApp(), { ...human, cpuTotalNs: 9_000_000_000 }],
      state,
      T0 + 25 * HOUR
    );

    expect(result.reap).toEqual(['ephemeral']);
  });
});
