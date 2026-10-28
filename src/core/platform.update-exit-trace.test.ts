/**
 * handleAppUpdate's EXIT TRACE: every way out of the method is driven once and
 * the full ordered trace is asserted - the return value, every appsInProgress
 * add/delete, the breaker-key release/record calls, the episode-closing calls,
 * the status transitions, the build slot release, and (inline per test) what
 * was logged and published. Each exit releases the app's claim EXACTLY once,
 * and the tests say so by listing the single `inprogress.delete` in the trace.
 *
 * The tests NOT tagged DEVIATION pin behaviour the split of #359 preserved; they
 * pass unchanged against the pre-split platform.ts. The DEVIATION tests pin what
 * the split deliberately fixed (a throw leaking the claim; a breaker that tripped
 * while the update queued) and the direct contracts of the stages.
 *
 * The builder is a fake so the slot release is countable; the post-build swap
 * is stubbed at the platform's own private seams (same shape as
 * platform.update-admission.test.ts), except tryCutover/failCutover, which are
 * real so the cutover exits are traced through them.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
jest.mock('../utils/disk', () => ({
  ...jest.requireActual('../utils/disk'),
  hasEnoughDisk: jest.fn().mockResolvedValue({ ok: true, freeMb: 999999 }),
}));

import { DropPlatform, createPlatform } from './platform';
import { loadEmptySuspensionStore } from './__testutils__/suspension';

// An unloaded suspension store fails closed; these tests never start the platform that loads it.
beforeEach(loadEmptySuspensionStore);
import { eventBus } from './event-bus';
import { AppNeedsConfigError } from '../api/platform-ops';
import { getDeployBreaker, resetDeployBreaker } from '../managers/guardrail/deploy-breaker';
import { getDeployTracker, resetDeployTracker } from '../managers/deploy-tracker';
import { hasEnoughDisk } from '../utils/disk';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

class TracingSet extends Set<string> {
  constructor(private readonly log: (e: string) => void) {
    super();
  }
  add(v: string): this {
    this.log(`inprogress.add:${v}`);
    return super.add(v);
  }
  delete(v: string): boolean {
    this.log(`inprogress.delete:${v}`);
    return super.delete(v);
  }
}

describe('handleAppUpdate exit trace', () => {
  let tempDir: string;
  let appPath: string;
  let platform: DropPlatform;
  let trace: string[];
  let logs: string[];
  let appState: any;
  let slotReleased: boolean;
  let reserveEffect: (() => void) | undefined;
  let buildResult: any;
  let buildThrows: Error | undefined;
  let startThrows: Error | undefined;
  let detectThrows: Error | undefined;
  let quiesced: boolean;
  let buildEffect: (() => void) | undefined;
  let unsubs: Array<() => void>;
  const appName = `trace-app-${Date.now()}`;

  const p = () => platform as any;
  const log = (e: string) => trace.push(e);

  beforeEach(async () => {
    resetDeployBreaker();
    resetDeployTracker();
    process.env.DROP_MIN_FREE_DISK_MB = '500';
    (hasEnoughDisk as jest.Mock).mockResolvedValue({ ok: true, freeMb: 999999 });
    tempDir = path.join(os.tmpdir(), `drop-update-exit-trace-${Date.now()}-${Math.random()}`);
    appPath = path.join(tempDir, 'apps', appName);
    fs.mkdirSync(appPath, { recursive: true });
    trace = [];
    logs = [];
    slotReleased = false;
    reserveEffect = undefined;
    buildThrows = undefined;
    startThrows = undefined;
    detectThrows = undefined;
    quiesced = false;
    buildEffect = undefined;
    buildResult = { success: true, duration: 12, outputPath: null };

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      isolation: 'none',
    });
    appState = { name: appName, status: 'running', port: 3005 };
    p().appsInProgress = new TracingSet(log);
    p().toolchainBackfilled = true;
    p().builder = {
      reserveSlot: jest.fn(async () => {
        reserveEffect?.();
        return () => {
          if (!slotReleased) log('slot.release');
          slotReleased = true;
        };
      }),
      build: jest.fn(async (ctx: { deployId?: string }) => {
        log(`builder.build:${ctx.deployId}`);
        buildEffect?.();
        if (buildThrows) throw buildThrows;
        return buildResult;
      }),
    };
    p().runtime = {
      type: 'pm2',
      stop: jest.fn(async () => log('runtime.stop')),
      delete: jest.fn(async () => log('runtime.delete')),
      getStatus: jest.fn(async () => null),
      start: jest.fn(async () => {
        log('runtime.start');
        if (startThrows) throw startThrows;
        return { pid: 4242 };
      }),
    };
    p().detector = {
      detect: jest.fn(async () => {
        if (detectThrows) throw detectThrows;
        return { type: 'rust', framework: null, suggestedConfig: {} };
      }),
    };
    p().buildLogService = {
      startBuild: jest.fn(async (_n: string, _d: Date, id: string) => {
        log(`buildlog.start:${id}`);
        return 'log-1';
      }),
      writeLine: jest.fn(),
      finishBuild: jest.fn().mockResolvedValue(undefined),
    };
    p().appConfigService = {
      updateConfig: jest.fn().mockResolvedValue(undefined),
      getConfig: jest.fn().mockReturnValue(undefined),
    };
    p().stateManager = {
      getApp: jest.fn(() => appState),
      setAppStatus: jest.fn(async (_n: string, status: string, details?: Record<string, unknown>) => {
        log(`status:${status}${details?.error ? `:${String(details.error).slice(0, 40)}` : ''}`);
        appState = { name: appName, port: appState?.port, status, ...details };
      }),
      updateApp: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(p(), 'isQuiesced').mockImplementation(() => quiesced);
    jest.spyOn(p(), 'holdForPromotion').mockResolvedValue(false);
    jest.spyOn(p(), 'tryCutover').mockResolvedValue(false);
    jest.spyOn(p(), 'buildFreshStartSpec').mockResolvedValue({ spec: {}, port: 3005 });
    jest.spyOn(p(), 'noteRuntimeLogStart').mockResolvedValue(undefined);
    jest.spyOn(p(), 'noteRuntimeLogEnd').mockResolvedValue(undefined);
    jest.spyOn(p(), 'recordDeploySignature').mockResolvedValue(undefined);
    jest.spyOn(p(), 'commitServedPath').mockImplementation(async () => log('commitServedPath'));
    jest.spyOn(p(), 'armPostDeployWatches').mockImplementation(() => log('armPostDeployWatches'));
    jest.spyOn(p(), 'stopHealthProber').mockImplementation(() => undefined);
    const realRelease = p().releaseGuardrailKeys.bind(platform);
    jest.spyOn(p(), 'releaseGuardrailKeys').mockImplementation((...a: any[]) => {
      const n = a[0] as string;
      if (p().breakerKeys.has(n)) log('keys.release');
      realRelease(n);
    });
    const realOutcome = p().recordDeployOutcome.bind(platform);
    jest.spyOn(p(), 'recordDeployOutcome').mockImplementation((...a: any[]) => {
      const [n, ok] = a as [string, boolean];
      log(`outcome:${ok}${p().breakerKeys.has(n) ? '' : '(none)'}`);
      realOutcome(n, ok);
    });
    const realFail = p().failDeployEpisode.bind(platform);
    jest.spyOn(p(), 'failDeployEpisode').mockImplementation((...a: any[]) => {
      log(`episode.fail:${a[1].message.slice(0, 40)}:${a[2]}:${a[3] ?? '-'}`);
      realFail(...a);
    });
    const realDiscard = p().discardDeployTarget.bind(platform);
    jest.spyOn(p(), 'discardDeployTarget').mockImplementation(async (...a: any[]) => {
      const n = a[0] as string;
      log('discard');
      await realDiscard(n);
    });
    // A real tracker, or failDeployEpisode's publish is swallowed by its catch.
    const tracker = getDeployTracker(path.join(tempDir, 'deploys.json'));
    await tracker.initialize();
    unsubs = [
      tracker.subscribe(eventBus),
      eventBus.subscribe('build:started', (e: any) => {
        if (e.appId === appName) logs.push(`bus:build:started:${e.deployId}`);
      }),
      eventBus.subscribe('build:failed', (e: any) => {
        if (e.appId === appName) logs.push(`bus:build:failed:${e.stage}:${e.code ?? '-'}:${e.deployId}`);
      }),
    ];
    // What was said, not just what was done: message and category per call.
    jest.spyOn(p().logger, 'info').mockImplementation((...a: any[]) => void logs.push(`info:${a[1]}:${a[0]}`));
    jest.spyOn(p().logger, 'warn').mockImplementation((...a: any[]) => void logs.push(`warn:${a[1]}:${a[0]}`));
    jest.spyOn(p().logger, 'appEvent').mockImplementation((...a: any[]) => void logs.push(`app:${a[0]}:${a[2]}`));
  });

  afterEach(async () => {
    delete process.env.DROP_MIN_FREE_DISK_MB;
    unsubs.forEach((u) => u());
    jest.restoreAllMocks();
    if (platform.isActive()) await platform.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Run one update through handleAppUpdate. */
  async function update(opts: { bypass?: boolean; actor?: object; reason?: string } = {}): Promise<{
    result: boolean;
    trace: string[];
    logs: string[];
  }> {
    const result = await p().handleAppUpdate(
      appName,
      appPath,
      opts.reason ?? 'file change',
      opts.bypass ?? true,
      opts.actor
    );
    // Let fire-and-forget bus handlers settle before the trace is read.
    await new Promise((resolve) => setImmediate(resolve));
    return { result, ...snapshot() };
  }

  /** The trace and the logs so far; ids become ID1, ID2... by first appearance, the app `<app>` in logs. */
  function snapshot(): { trace: string[]; logs: string[] } {
    const ids = new Map<string, string>();
    const sub = (e: string) =>
      e.replace(UUID, (m) => {
        if (!ids.has(m)) ids.set(m, `ID${ids.size + 1}`);
        return ids.get(m)!;
      });
    return {
      trace: trace.map(sub),
      logs: logs.map((l) => sub(l).split(appName).join('<app>')),
    };
  }

  /** Post-condition shared by every exit: nothing held, no key left, slot freed. */
  function expectReleased(): void {
    expect(p().appsInProgress.has(appName)).toBe(false);
    expect(p().breakerKeys.has(appName)).toBe(false);
    expect(trace.filter((e) => e === `inprogress.delete:${appName}`)).toHaveLength(1);
  }

  describe('refused before the claim (unchanged by the split)', () => {
    it('quiesced at entry', async () => {
      quiesced = true;
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:BACKUP:Deferring update for <app> — deploys are quiesced for a backup',
      ]);
      expect(r.trace).toEqual([]);
      expect(p().breakerKeys.has(appName)).toBe(false);
    });

    it('guardrail refusal: keys released before the episode is failed, app never claimed', async () => {
      jest.spyOn(p(), 'checkGuardrails').mockReturnValue({ allowed: false, failures: 3, retryAfterSeconds: 9 });
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'warn:UPDATE:Redeploy of <app> refused by guardrail: Too many failed deploys (3). Retry in 9s.',
        'bus:build:started:ID1',
        'bus:build:failed:pre-build:GUARDRAIL_TRIPPED:ID1',
      ]);
      expect(r.trace).toEqual([
        'episode.fail:Too many failed deploys (3). Retry in 9s:ID1:GUARDRAIL_TRIPPED',
        'outcome:false(none)',
      ]);
      expect(p().appsInProgress.has(appName)).toBe(false);
      expect(p().breakerKeys.has(appName)).toBe(false);
    });
  });

  describe('refused after the slot wait', () => {
    it('quiesced during the wait', async () => {
      reserveEffect = () => (quiesced = true);
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        'info:BACKUP:Deferring update for <app> — deploys are quiesced for a backup',
      ]);
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'slot.release',
        'keys.release',
        `inprogress.delete:${appName}`,
      ]);
      expectReleased();
      expect(slotReleased).toBe(true);
      expect(appState.status).toBe('running');
    });

    it('a git reservation began during the wait', async () => {
      reserveEffect = () => p().gitReserved.add(appName);
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        'info:UPDATE:Dropped redeploy for <app> - a git pull/upload began while waiting for a build slot',
      ]);
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'slot.release',
        'keys.release',
        `inprogress.delete:${appName}`,
      ]);
      expectReleased();
      expect(p().gitReserved.has(appName)).toBe(true); // not ours to clear
    });

    it('a git clone began during the wait', async () => {
      p().gitDeployService = { isCloning: jest.fn().mockReturnValueOnce(false).mockReturnValue(true) };
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        'info:UPDATE:Dropped redeploy for <app> - a git pull/upload began while waiting for a build slot',
      ]);
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'slot.release',
        'keys.release',
        `inprogress.delete:${appName}`,
      ]);
      expectReleased();
    });

    it('an upload began during the wait', async () => {
      let uploading = false;
      p().uploadDeployService = { isUploading: jest.fn(() => uploading) };
      reserveEffect = () => (uploading = true);
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        'info:UPDATE:Dropped redeploy for <app> - a git pull/upload began while waiting for a build slot',
      ]);
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'slot.release',
        'keys.release',
        `inprogress.delete:${appName}`,
      ]);
      expectReleased();
    });

    it('the app was removed during the wait', async () => {
      reserveEffect = () => (appState = undefined);
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        'info:UPDATE:Dropped redeploy for <app> - app was removed while waiting for a build slot',
      ]);
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'slot.release',
        'keys.release',
        `inprogress.delete:${appName}`,
      ]);
      expectReleased();
    });

    it('the user stopped the app during the wait', async () => {
      reserveEffect = () => (appState = { ...appState, status: 'stopped' });
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        'info:UPDATE:Dropped redeploy for <app> - app was stopped by user while waiting for a build slot',
      ]);
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'slot.release',
        'keys.release',
        `inprogress.delete:${appName}`,
      ]);
      expectReleased();
      expect(appState.status).toBe('stopped');
    });

    it('insufficient disk', async () => {
      (hasEnoughDisk as jest.Mock).mockResolvedValue({ ok: false, freeMb: 1 });
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        'warn:UPDATE:Skipping hot-reload of <app>: insufficient disk (1 MB free, need 500 MB)',
      ]);
      // The only exit whose cleanup order changed (slot, keys, claim here; keys,
      // claim, slot before the split): three synchronous calls, so unobservable.
      expect(r.trace[0]).toBe(`inprogress.add:${appName}`);
      expect([...r.trace.slice(1)].sort()).toEqual(
        [`inprogress.delete:${appName}`, 'keys.release', 'slot.release'].sort()
      );
      expectReleased();
      expect(appState.status).toBe('running');
      expect(p().builder.build).not.toHaveBeenCalled();
    });
  });

  describe('past the mint', () => {
    it('a pre-build throw closes the episode under the minted deployId', async () => {
      detectThrows = new Error('detect blew up');
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        'app:error:detect blew up',
        'bus:build:started:ID1',
        'bus:build:failed:pre-build:-:ID1',
      ]);
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'status:building',
        'slot.release',
        'discard',
        'status:errored:detect blew up',
        'episode.fail:detect blew up:ID1:-',
        'outcome:false',
        'outcome:false(none)',
        `inprogress.delete:${appName}`,
      ]);
      expectReleased();
    });

    it('build failure on a running app restores running with the error', async () => {
      buildResult = { success: false, duration: 1, errors: [{ message: 'tsc exploded' }] };
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        'app:error:tsc exploded',
      ]);
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'status:building',
        'buildlog.start:ID1',
        'discard',
        'builder.build:ID1',
        'slot.release',
        'status:running:Build failed: tsc exploded',
        'discard',
        'outcome:false',
        `inprogress.delete:${appName}`,
      ]);
      expectReleased();
    });

    it('build failure on a not-running app leaves it errored', async () => {
      appState = { ...appState, status: 'errored' };
      buildResult = { success: false, duration: 1, errors: [{ message: 'tsc exploded' }] };
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        'app:error:tsc exploded',
      ]);
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'status:building',
        'buildlog.start:ID1',
        'discard', // prepareDeployTarget clears any stale target first
        'builder.build:ID1',
        'slot.release',
        'status:errored:tsc exploded',
        'discard',
        'outcome:false',
        `inprogress.delete:${appName}`,
      ]);
      expectReleased();
    });

    it('a throw from builder.build does not open a second episode', async () => {
      buildThrows = new Error('strategy threw');
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        'app:error:strategy threw',
      ]);
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'status:building',
        'buildlog.start:ID1',
        'discard', // prepareDeployTarget clears any stale target first
        'builder.build:ID1',
        'slot.release',
        'discard',
        'status:errored:strategy threw',
        'outcome:false',
        `inprogress.delete:${appName}`,
      ]);
      expectReleased();
    });

    it('start failure', async () => {
      startThrows = new Error('port in use');
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        "info:UPDATE:Replacing <app>'s process (if any) with the new build...",
        'app:built:rebuilt in 12ms',
        'app:error:port in use',
      ]);
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'status:building',
        'buildlog.start:ID1',
        'discard', // prepareDeployTarget clears any stale target first
        'builder.build:ID1',
        'slot.release',
        'runtime.delete',
        'status:starting',
        'runtime.start',
        'discard',
        'status:errored:port in use',
        'outcome:false',
        `inprogress.delete:${appName}`,
      ]);
      expectReleased();
    });

    it('a start that needs config parks the app and counts the failure', async () => {
      p().buildFreshStartSpec.mockRejectedValue(new AppNeedsConfigError(appName, ['API_KEY']));
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        "info:UPDATE:Replacing <app>'s process (if any) with the new build...",
        'app:built:rebuilt in 12ms',
        'warn:SECURITY:<app> parked in needs-config on hot-reload — set required secret(s): API_KEY, then restart',
      ]);
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'status:building',
        'buildlog.start:ID1',
        'discard', // prepareDeployTarget clears any stale target first
        'builder.build:ID1',
        'slot.release',
        'runtime.delete',
        'status:starting',
        'discard',
        'status:needs-config',
        'outcome:false',
        `inprogress.delete:${appName}`,
      ]);
      expectReleased();
    });

    it('success', async () => {
      const r = await update({ actor: { automationSource: 'webhook' } });
      expect(r.result).toBe(true);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        "info:UPDATE:Replacing <app>'s process (if any) with the new build...",
        'app:built:rebuilt in 12ms',
        'app:started:PID 4242, port 3005 (hot-reloaded)',
      ]);
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'status:building',
        'buildlog.start:ID1',
        'discard', // prepareDeployTarget clears any stale target first
        'builder.build:ID1',
        'slot.release',
        'runtime.delete',
        'status:starting',
        'runtime.start',
        'status:running',
        'armPostDeployWatches',
        'commitServedPath',
        'outcome:true',
        `inprogress.delete:${appName}`,
      ]);
      expectReleased();
    });

    it('success on an app stopped at entry that needs its tree rebuilt still redeploys: the delete of its absent process is a safe no-op', async () => {
      appState = { ...appState, status: 'stopped' };
      jest.spyOn(p(), 'dependenciesAreStale').mockResolvedValue(true);
      const r = await update();
      expect(r.result).toBe(true);
      expect(r.logs).toEqual([
        'info:UPDATE:Redeploying stopped <app> to rebuild dependencies for the current Node runtime',
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        "info:UPDATE:Replacing <app>'s process (if any) with the new build...",
        'app:built:rebuilt in 12ms',
        'app:started:PID 4242, port 3005 (hot-reloaded)',
      ]);
      expect(p().runtime.stop).not.toHaveBeenCalled();
      // delete of an absent process is a safe no-op, and the redeploy still lands.
      expect(p().runtime.delete).toHaveBeenCalledTimes(1);
      expect(p().runtime.start).toHaveBeenCalledTimes(1);
      expect(r.trace[r.trace.length - 1]).toBe(`inprogress.delete:${appName}`);
      expectReleased();
    });

    it('a crash-looping app whose stored status is not running is still removed before the start', async () => {
      // PM2 'launching' maps to 'starting': neither 'running' nor 'errored', so
      // the old stored-status gate skipped the removal and ProcessManager.start
      // no-opped on the live process while success was recorded.
      appState = { ...appState, status: 'starting' };
      const r = await update();
      expect(r.result).toBe(true);
      const t = r.trace;
      expect(t).toContain('runtime.delete');
      expect(t.indexOf('runtime.delete')).toBeLessThan(t.indexOf('runtime.start'));
      expect(p().runtime.stop).not.toHaveBeenCalled();
    });

    it('an old process that survives delete fails the swap visibly and never starts the new one', async () => {
      // ProcessManager.delete swallows its errors; start over a survivor would
      // no-op and record success.
      p().runtime.getStatus.mockResolvedValue({ status: 'running' });
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.trace).toContain('runtime.delete');
      expect(r.trace).not.toContain('runtime.start');
      expect(appState.status).toBe('errored');
      expect(appState.error).toMatch(/still present after delete/);
    });

    it('a survivor of delete leaves the status/outcome trace of a failed swap, closing nothing as success', async () => {
      p().runtime.getStatus.mockResolvedValue({ status: 'running' });
      const r = await update();
      const t = r.trace;
      expect(r.result).toBe(false);
      expect(t.some((e: string) => e.startsWith('status:errored:The previous instance of'))).toBe(true);
      expect(t).toContain('outcome:false');
      expect(t.some((e: string) => e === 'status:running' || e.startsWith('status:running'))).toBe(false);
      expect(t[t.length - 1]).toBe(`inprogress.delete:${appName}`);
      expectReleased();
    });

    it('a build held for promotion releases the keys without charging the window', async () => {
      p().holdForPromotion.mockResolvedValue(true);
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
      ]);
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'status:building',
        'buildlog.start:ID1',
        'discard', // prepareDeployTarget clears any stale target first
        'builder.build:ID1',
        'slot.release',
        'keys.release',
        'status:running',
        `inprogress.delete:${appName}`,
      ]);
      expectReleased();
      expect(p().runtime.stop).not.toHaveBeenCalled();
    });
  });

  describe('DEVIATION: a throw no longer leaks the claim, and every exit closes an outcome', () => {
    it('a throw from the slot wait closes the episode under a fresh id and surfaces', async () => {
      p().builder.reserveSlot.mockRejectedValue(new Error('slot wait blew up'));
      await expect(p().handleAppUpdate(appName, appPath, 'file change', true)).rejects.toThrow('slot wait blew up');
      const r = snapshot();
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'keys.release',
        'episode.fail:slot wait blew up:ID1:-',
        'outcome:false(none)',
        `inprogress.delete:${appName}`,
      ]);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        'warn:UPDATE:Redeploy of <app> failed before its build: slot wait blew up',
        'bus:build:started:ID1',
        'bus:build:failed:pre-build:-:ID1',
      ]);
      expectReleased();
      expect(p().builder.build).not.toHaveBeenCalled();
    });

    it('a failure handler that throws before the build still closes the episode under the minted id', async () => {
      detectThrows = new Error('detect blew up');
      (p().stateManager.setAppStatus as jest.Mock).mockImplementation(async (_n: string, status: string) => {
        if (status === 'errored') throw new Error('state store down');
      });
      await expect(p().handleAppUpdate(appName, appPath, 'file change', true)).rejects.toThrow('state store down');
      const r = snapshot();
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'slot.release',
        'discard',
        'episode.fail:state store down:ID1:-',
        'outcome:false',
        `inprogress.delete:${appName}`,
      ]);
      expectReleased();
    });

    it('a failure handler that throws after the build was paid for charges the window', async () => {
      buildThrows = new Error('strategy threw');
      (p().stateManager.setAppStatus as jest.Mock).mockImplementation(async (_n: string, status: string) => {
        if (status === 'errored') throw new Error('state store down');
      });
      await expect(p().handleAppUpdate(appName, appPath, 'file change', true)).rejects.toThrow('state store down');
      // The build opened its own episode, so none is synthesised here; the paid-for
      // build is charged to the key it was admitted under.
      expect(trace.filter((e) => e.startsWith('episode.fail'))).toEqual([]);
      expect(trace).toContain('outcome:false');
      expectReleased();
      const watcherKey = p().guardrailKeys(appName, false, {})[0].key as string;
      expect(getDeployBreaker().peek(watcherKey).failures).toBe(1);
    });

    it('refuses, closing the outcome unpaid, when the breaker tripped while the update waited for its slot', async () => {
      jest
        .spyOn(p(), 'checkGuardrails')
        .mockReturnValueOnce({ allowed: true, failures: 0 })
        .mockReturnValue({ allowed: false, failures: 3, retryAfterSeconds: 9 });
      const r = await update();
      expect(r.result).toBe(false);
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'slot.release',
        'keys.release',
        'episode.fail:Too many failed deploys (3). Retry in 9s:ID1:GUARDRAIL_TRIPPED',
        'outcome:false(none)',
        `inprogress.delete:${appName}`,
      ]);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        'warn:UPDATE:Redeploy of <app> refused by guardrail: Too many failed deploys (3). Retry in 9s.',
        'bus:build:started:ID1',
        'bus:build:failed:pre-build:GUARDRAIL_TRIPPED:ID1',
      ]);
      expect(p().appDeployTimes.has(appName)).toBe(true);
      expect(p().builder.build).not.toHaveBeenCalled();
      expectReleased();
    });

    it('a failure handler that throws with the builder\'s episode still open closes it under the minted id', async () => {
      buildEffect = () =>
        eventBus.publish('build:started', { appId: appName, buildId: 'b-1', deployId: 'D1' } as never);
      buildThrows = new Error('strategy threw');
      (p().stateManager.setAppStatus as jest.Mock).mockImplementation(async (_n: string, status: string) => {
        if (status === 'errored') throw new Error('state store down');
      });
      await expect(p().handleAppUpdate(appName, appPath, 'file change', true)).rejects.toThrow('state store down');
      expect(trace.filter((e) => e.startsWith('episode.fail'))).toHaveLength(1);
      expectReleased();
    });
  });

  describe('DEVIATION: the stage contracts', () => {
    const admitted = () => ({
      appPath,
      statusAtEntry: 'running',
      appState,
      wasRunning: true,
      originalPort: 3005,
    });
    const claim = () => p().breakerKeys.set(appName, p().guardrailKeys(appName, false, {}));

    const refusals: Array<[string, () => void]> = [
      ['quiesced', () => (reserveEffect = () => (quiesced = true))],
      ['busy', () => (reserveEffect = () => p().gitReserved.add(appName))],
      ['gone', () => (reserveEffect = () => (appState = undefined))],
      ['stopped', () => (reserveEffect = () => (appState = { ...appState, status: 'stopped' }))],
      ['disk', () => (hasEnoughDisk as jest.Mock).mockResolvedValue({ ok: false, freeMb: 1 })],
      ['guardrail', () => jest.spyOn(p(), 'checkGuardrails').mockReturnValue({ allowed: false, failures: 3, retryAfterSeconds: 9 })],
    ];
    it.each(refusals)('acquireSlotAndRecheck: refuses %s, releasing only the slot it took', async (reason, setup) => {
      claim();
      p().appsInProgress.add(appName);
      trace.length = 0;
      setup();
      // The guardrail refusal also says how long to wait.
      expect(await p().acquireSlotAndRecheck(appName, admitted())).toEqual(
        reason === 'guardrail' ? { refused: reason, retryAfterSeconds: 9 } : { refused: reason }
      );
      const guardrail = reason === 'guardrail';
      // The guardrail refusal also closes its outcome, as the entry gate does.
      expect(trace.filter((e) => !guardrail || e === 'slot.release')).toEqual(['slot.release']);
      expect(p().appsInProgress.has(appName)).toBe(true);
      expect(p().breakerKeys.has(appName)).toBe(guardrail ? false : true);
    });

    it('acquireSlotAndRecheck: success hands back the live slot', async () => {
      const got = await p().acquireSlotAndRecheck(appName, admitted());
      expect(slotReleased).toBe(false);
      got.releaseSlot();
      expect(slotReleased).toBe(true);
      expect(trace).toEqual(['slot.release']);
    });

    it('runClaimedUpdate: a refusal gives back the keys and calls releaseClaim once', async () => {
      claim();
      reserveEffect = () => (quiesced = true);
      const releaseClaim = jest.fn();
      expect(await p().runClaimedUpdate(appName, admitted(), releaseClaim)).toEqual({ refused: 'quiesced' });
      expect(releaseClaim).toHaveBeenCalledTimes(1);
      expect(p().breakerKeys.has(appName)).toBe(false);
      expect(trace).toEqual(['slot.release', 'keys.release']);
    });

    it('neither stage touches appsInProgress', async () => {
      claim();
      const releaseClaim = jest.fn();
      const r = await p().runClaimedUpdate(appName, admitted(), releaseClaim);
      expect(await r.done).toBe(true);
      expect(trace.filter((e) => e.startsWith('inprogress'))).toEqual([]);
      expect(releaseClaim).toHaveBeenCalledTimes(1);
    });

    it('runClaimedUpdate: resolves started at the mint, with the build still running and the claim still held', async () => {
      claim();
      let finishBuild!: () => void;
      p().builder.build.mockImplementation(
        (ctx: { deployId?: string }) =>
          new Promise((resolve) => {
            log(`builder.build:${ctx.deployId}`);
            finishBuild = () => resolve(buildResult);
          })
      );
      const releaseClaim = jest.fn();
      const r = await p().runClaimedUpdate(appName, admitted(), releaseClaim);
      expect(r.started).toMatch(UUID);
      expect(releaseClaim).not.toHaveBeenCalled();
      expect(p().breakerKeys.has(appName)).toBe(true);
      for (let i = 0; i < 500 && !finishBuild; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(trace).toContain(`builder.build:${r.started}`);
      finishBuild();
      expect(await r.done).toBe(true);
      expect(releaseClaim).toHaveBeenCalledTimes(1);
      expect(p().breakerKeys.has(appName)).toBe(false);
    });

    it('runClaimedUpdate: a failure handler that throws rejects done and logs nothing itself', async () => {
      claim();
      detectThrows = new Error('detect blew up');
      (p().stateManager.setAppStatus as jest.Mock).mockImplementation(async (_n: string, status: string) => {
        if (status === 'errored') throw new Error('state store down');
      });
      const logged = jest.spyOn(p().logger, 'error').mockImplementation(() => undefined);
      const releaseClaim = jest.fn();
      const r = await p().runClaimedUpdate(appName, admitted(), releaseClaim);
      await expect(r.done).rejects.toThrow('state store down');
      expect(logged).not.toHaveBeenCalled();
      expect(releaseClaim).toHaveBeenCalledTimes(1);
    });

    const exits: Array<[string, () => void, boolean | object | 'throws']> = [
      ['success', () => undefined, true],
      ['a refusal', () => (reserveEffect = () => (quiesced = true)), { refused: 'quiesced' }],
      ['a failed build', () => (buildResult = { success: false, duration: 1, errors: [{ message: 'x' }] }), false],
      ['a failed start', () => (startThrows = new Error('port in use')), false],
      ['a pre-build throw', () => (detectThrows = new Error('detect blew up')), false],
      ['a throwing slot wait', () => p().builder.reserveSlot.mockRejectedValue(new Error('slot')), 'throws'],
      [
        'a throwing failure handler',
        () => {
          detectThrows = new Error('detect blew up');
          (p().stateManager.setAppStatus as jest.Mock).mockImplementation(async (_n: string, status: string) => {
            if (status === 'errored') throw new Error('state store down');
          });
        },
        'throws',
      ],
    ];
    it.each(exits)('runClaimedUpdate: releaseClaim runs exactly once on %s, with the keys gone', async (_n, setup, expected) => {
      claim();
      setup();
      const releaseClaim = jest.fn();
      const run = (async () => {
        const r = await p().runClaimedUpdate(appName, admitted(), releaseClaim);
        return 'started' in r ? r.done : r;
      })();
      if (expected === 'throws') await expect(run).rejects.toThrow();
      else expect(await run).toEqual(expected);
      expect(releaseClaim).toHaveBeenCalledTimes(1);
      expect(p().breakerKeys.has(appName)).toBe(false);
    });
  });

  describe('zero-downtime cutover', () => {
    beforeEach(() => {
      p().tryCutover.mockRestore();
      jest.spyOn(p(), 'cutoverEligibility').mockResolvedValue(3005);
    });

    it('a cutover that lands returns true and releases once', async () => {
      jest.spyOn(p(), 'cutoverTo').mockResolvedValue({ ok: true, port: 3006 });
      const r = await update();
      expect(r.result).toBe(true);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
      ]);
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'status:building',
        'buildlog.start:ID1',
        'discard', // prepareDeployTarget clears any stale target first
        'builder.build:ID1',
        'slot.release',
        'outcome:true',
        `inprogress.delete:${appName}`,
      ]);
      expectReleased();
      expect(p().runtime.stop).not.toHaveBeenCalled();
      expect(p().runtime.start).not.toHaveBeenCalled();
    });

    it('a cutover that fails returns false, fails the deploy and releases once', async () => {
      jest.spyOn(p(), 'cutoverTo').mockResolvedValue({ ok: false, error: new Error('never ready'), healthCheckPath: '/h' });
      const bus: unknown[] = [];
      const off = eventBus.subscribe('deploy:failed', (e: any) => {
        if (e.appId === appName) bus.push(e.phase);
      });
      const r = await update();
      off();
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: file change',
        'warn:CUTOVER:Zero-downtime deploy of <app> failed; previous version still serving: never ready',
      ]);
      expect(r.trace).toEqual([
        `inprogress.add:${appName}`,
        'status:building',
        'buildlog.start:ID1',
        'discard', // prepareDeployTarget clears any stale target first
        'builder.build:ID1',
        'slot.release',
        'discard',
        'outcome:false',
        'status:errored:New version was not deployed (never read',
        'status:running:New version was not deployed (never read',
        'armPostDeployWatches',
        `inprogress.delete:${appName}`,
      ]);
      expect(bus).toEqual(['boot']);
      expectReleased();
    });
  });

  describe('the monorepo container branch (explicit redeploy re-expansion)', () => {
    beforeEach(() => {
      fs.writeFileSync(
        path.join(appPath, 'drop.yaml'),
        'services:\n  web:\n    path: web\n    type: static\n'
      );
    });

    it('re-expands, records success and releases once', async () => {
      const expand = jest.spyOn(p(), 'expandMonorepo').mockResolvedValue(undefined);
      const r = await update({ reason: 'git redeploy' });
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        "info:MONOREPO:Re-expanding monorepo container '<app>' (explicit redeploy)",
      ]);
      expect(expand).toHaveBeenCalledTimes(1);
      expect(r.trace).toEqual([`inprogress.add:${appName}`, 'outcome:true', `inprogress.delete:${appName}`]);
      expect(p().breakerKeys.has(appName)).toBe(false);
    });

    it('records the failure, releases once and rethrows', async () => {
      jest.spyOn(p(), 'expandMonorepo').mockRejectedValue(new Error('expand failed'));
      await expect(update({ reason: 'git redeploy' })).rejects.toThrow('expand failed');
      expect(trace).toEqual([`inprogress.add:${appName}`, 'outcome:false', `inprogress.delete:${appName}`]);
      expect(p().breakerKeys.has(appName)).toBe(false);
    });
  });

  describe('the expandMonorepo child call', () => {
    const container = 'trace-container';

    it('builds the child while the CONTAINER holds appsInProgress, and releases only the child', async () => {
      // expandMonorepo holds the container in appsInProgress for the whole
      // expansion and calls handleAppUpdate(child, path, 'monorepo re-expansion',
      // true, actor) for an existing child.
      p().appsInProgress.add(container);
      trace.length = 0;
      const actor = { automationSource: 'webhook' };
      const r = await update({ reason: 'monorepo re-expansion', actor });
      expect(r.result).toBe(true);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: monorepo re-expansion',
        "info:UPDATE:Replacing <app>'s process (if any) with the new build...",
        'app:built:rebuilt in 12ms',
        'app:started:PID 4242, port 3005 (hot-reloaded)',
      ]);
      expect(r.trace[0]).toBe(`inprogress.add:${appName}`);
      expect(r.trace[r.trace.length - 1]).toBe(`inprogress.delete:${appName}`);
      expect(p().appsInProgress.has(container)).toBe(true);
      expect(p().appsInProgress.has(appName)).toBe(false);
      expect(p().breakerKeys.has(appName)).toBe(false);
      expect(trace.filter((e) => e === `inprogress.delete:${appName}`)).toHaveLength(1);
      // The key the child was admitted under is the actor's, not the watcher's.
      expect(r.trace).toContain('outcome:true');
    });

    it('charges a failed child build to the ACTOR key it was admitted under, not the watcher bucket', async () => {
      const webhookKey = p().guardrailKeys(appName, false, { automationSource: 'webhook' })[0].key as string;
      const watcherKey = p().guardrailKeys(appName, false, {})[0].key as string;
      buildResult = { success: false, duration: 1, errors: [{ message: 'child build failed' }] };
      const r = await update({ reason: 'monorepo re-expansion', actor: { automationSource: 'webhook' } });
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: monorepo re-expansion',
        'app:error:child build failed',
      ]);
      expect(getDeployBreaker().peek(webhookKey).failures).toBe(1);
      expect(getDeployBreaker().peek(watcherKey).failures).toBe(0);
    });

    it('a child that fails to build reports false to its container, which keeps its claim', async () => {
      p().appsInProgress.add(container);
      buildResult = { success: false, duration: 1, errors: [{ message: 'child build failed' }] };
      const r = await update({ reason: 'monorepo re-expansion' });
      expect(r.result).toBe(false);
      expect(r.logs).toEqual([
        'info:UPDATE:Hot-reload triggered for <app>: monorepo re-expansion',
        'app:error:child build failed',
      ]);
      expect(p().appsInProgress.has(container)).toBe(true);
      expect(p().appsInProgress.has(appName)).toBe(false);
    });
  });
});
