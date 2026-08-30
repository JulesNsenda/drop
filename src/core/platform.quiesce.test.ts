/**
 * Deploy quiesce (P2-5b) — holding the pipeline still so `drop backup` can take
 * a self-consistent snapshot.
 *
 * The gap this closes is not "a half-written file": `writeJsonAtomic` already
 * prevents that, and each `pg_dump` is internally consistent. It is that the
 * ~12 file stores and every database were not guaranteed to describe the same
 * MOMENT. A deploy landing mid-backup leaves `apps.json` from before it and
 * `appconf/webapps/` from after, or a database dump referencing an app the
 * state file has never heard of. Restoring that is not obviously broken, which
 * is what makes it dangerous — it surfaces later as a port or database the
 * platform disagrees about.
 *
 * These exercise the platform directly on a constructed-but-never-started
 * instance, as `platform.readiness.test.ts` does: the constructor performs no
 * I/O, and quiesce touches only `quiescedUntil` and `appsInProgress`.
 */

import * as os from 'os';
import * as path from 'path';
import { createPlatform, DropPlatform } from './platform';

describe('deploy quiesce', () => {
  let platform: DropPlatform;
  let tempDir: string;

  /** Reach the private in-progress set the way the deploy pipeline populates it. */
  const inProgress = (p: DropPlatform) =>
    (p as unknown as { appsInProgress: Set<string> }).appsInProgress;

  beforeEach(() => {
    tempDir = path.join(
      os.tmpdir(),
      `drop-test-quiesce-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
    });
  });

  afterEach(async () => {
    if (platform.isActive()) await platform.stop();
  });

  it('is not quiesced by default', () => {
    expect(platform.isQuiesced()).toBe(false);
  });

  it('holds the pipeline for the requested window', async () => {
    await platform.quiesce(60_000);

    expect(platform.isQuiesced()).toBe(true);
  });

  it('releases on request', async () => {
    await platform.quiesce(60_000);

    platform.resumeFromQuiesce();

    expect(platform.isQuiesced()).toBe(false);
  });

  it('is safe to release when it was never held', () => {
    expect(() => platform.resumeFromQuiesce()).not.toThrow();
    expect(platform.isQuiesced()).toBe(false);
  });

  /**
   * The safety property, and the reason this is a deadline rather than a
   * boolean: `drop backup` is a SEPARATE process, usually run from cron. It can
   * be SIGKILLed, crash, or lose the box mid-run. A boolean would leave the
   * platform refusing every deploy until a human noticed and cleared it by
   * hand — an outage caused by the backup tool.
   */
  it('expires on its own, so a killed backup cannot freeze deploys', async () => {
    await platform.quiesce(20);

    expect(platform.isQuiesced()).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 40));
    expect(platform.isQuiesced()).toBe(false);
  });

  it('caps an over-long request rather than honouring it', async () => {
    // A backup that needs longer than the ceiling has a problem a longer lease
    // will not fix, and the cost of honouring it is a box that stops deploying
    // for as long as the caller asked.
    const { until } = await platform.quiesce(24 * 60 * 60_000);

    expect(until - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 1_000);
  });

  it('treats a zero or negative window as no hold at all', async () => {
    await platform.quiesce(0);

    expect(platform.isQuiesced()).toBe(false);
  });

  it('reports a clean drain when nothing was in flight', async () => {
    const result = await platform.quiesce(60_000);

    expect(result.drained).toBe(true);
  });

  it('reports drained: false when a deploy outlives the drain window', async () => {
    // Never hidden: the caller's snapshot may straddle that deploy, and a
    // backup that silently claims a consistency it does not have is precisely
    // the failure this mechanism exists to prevent.
    inProgress(platform).add('slow-app');

    const result = await platform.quiesce(150);

    expect(result.drained).toBe(false);
  });

  it('waits for an in-flight deploy that finishes inside the window', async () => {
    inProgress(platform).add('nearly-done');
    setTimeout(() => inProgress(platform).delete('nearly-done'), 150);

    const result = await platform.quiesce(5_000);

    expect(result.drained).toBe(true);
  });

  describe('the watcher lock it drives', () => {
    /**
     * `isDeployLocked` is the choke point for the folder-drop path. The
     * watcher's contract for a locked app is to DEFER (`scheduleRebuild`
     * re-arms once the lock clears), not to drop — so a folder dropped during a
     * backup still deploys, just after the lease.
     */
    const isDeployLocked = (p: DropPlatform, name: string) =>
      (p as unknown as { isDeployLocked: (n: string) => boolean }).isDeployLocked(name);

    it('locks every app while quiesced, not just the ones mid-deploy', async () => {
      expect(isDeployLocked(platform, 'untouched-app')).toBe(false);

      await platform.quiesce(60_000);

      expect(isDeployLocked(platform, 'untouched-app')).toBe(true);
    });

    it('unlocks again once released', async () => {
      await platform.quiesce(60_000);

      platform.resumeFromQuiesce();

      expect(isDeployLocked(platform, 'untouched-app')).toBe(false);
    });

    it('still locks an app that is mid-deploy when nothing is quiesced', () => {
      // The pre-existing behaviour this must not have replaced.
      inProgress(platform).add('building-app');

      expect(isDeployLocked(platform, 'building-app')).toBe(true);
      expect(isDeployLocked(platform, 'other-app')).toBe(false);
    });
  });
});
