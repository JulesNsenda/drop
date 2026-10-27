/**
 * The explicit-redeploy platform surface (#359 Item 2): the hold object, the
 * admission (`admitExplicitUpdate`) and the start (`startExplicitUpdate`).
 *
 * Driven against the real DropPlatform with the same private-seam stubs as
 * platform.update-exit-trace.test.ts: a fake builder (so the slot and the
 * build context are visible), a fake state manager, and the post-build swap
 * stubbed. Nothing here goes through handleAppUpdate.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
jest.mock('../utils/disk', () => ({
  ...jest.requireActual('../utils/disk'),
  hasEnoughDisk: jest.fn().mockResolvedValue({ ok: true, freeMb: 999999 }),
}));

import { DropPlatform, createPlatform } from './platform';
import { eventBus } from './event-bus';
import * as breakerModule from '../managers/guardrail/deploy-breaker';
import { getDeployBreaker, resetDeployBreaker } from '../managers/guardrail/deploy-breaker';
import { getPrincipalQuota, resetPrincipalQuota } from '../managers/guardrail/principal-quota';
import { getDeployTracker, resetDeployTracker } from '../managers/deploy-tracker';
import { hasEnoughDisk } from '../utils/disk';
import type { UpdateHold } from '../api/platform-ops';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('explicit redeploy: hold, admission, start', () => {
  let tempDir: string;
  let appPath: string;
  let platform: DropPlatform;
  let appState: any;
  let buildCtxs: any[];
  let buildGate: Promise<void> | undefined;
  let reserveEffect: (() => void) | undefined;
  let detectThrows: Error | undefined;
  let unsubs: Array<() => void>;
  const appName = `explicit-app-${Date.now()}`;
  const actor = { principalId: 'p-1', actorUserId: 'u-1' };

  const p = () => platform as any;
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 200 && (p().appsInProgress.has(appName) || p().holdOwners.has(appName)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  beforeEach(async () => {
    resetDeployBreaker();
    resetDeployTracker();
    process.env.DROP_MIN_FREE_DISK_MB = '500';
    (hasEnoughDisk as jest.Mock).mockResolvedValue({ ok: true, freeMb: 999999 });
    tempDir = path.join(os.tmpdir(), `drop-explicit-redeploy-${Date.now()}-${Math.random()}`);
    appPath = path.join(tempDir, 'apps', appName);
    fs.mkdirSync(appPath, { recursive: true });
    // The admission charges the caller's quota: a store of its own, or it is the real one.
    resetPrincipalQuota();
    getPrincipalQuota(path.join(tempDir, 'principal-quotas.json'));
    buildCtxs = [];
    buildGate = undefined;
    reserveEffect = undefined;
    detectThrows = undefined;

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      isolation: 'none',
    });
    appState = { name: appName, status: 'running', port: 3005, path: appPath };
    p().toolchainBackfilled = true;
    p().builder = {
      reserveSlot: jest.fn(async () => {
        reserveEffect?.();
        return () => undefined;
      }),
      build: jest.fn(async (ctx: unknown) => {
        buildCtxs.push(ctx);
        await buildGate;
        return { success: true, duration: 12, outputPath: null };
      }),
    };
    p().runtime = {
      type: 'pm2',
      stop: jest.fn().mockResolvedValue(undefined),
      start: jest.fn().mockResolvedValue({ pid: 4242 }),
    };
    p().detector = {
      detect: jest.fn(async () => {
        if (detectThrows) throw detectThrows;
        return { type: 'rust', framework: null, suggestedConfig: {} };
      }),
    };
    p().buildLogService = {
      startBuild: jest.fn().mockResolvedValue('log-1'),
      writeLine: jest.fn(),
      finishBuild: jest.fn().mockResolvedValue(undefined),
    };
    p().appConfigService = {
      updateConfig: jest.fn().mockResolvedValue(undefined),
      getConfig: jest.fn().mockReturnValue(undefined),
    };
    p().stateManager = {
      getApp: jest.fn(() => appState),
      getAllApps: jest.fn(() => (appState ? [appState] : [])),
      setAppStatus: jest.fn(async (_n: string, status: string, details?: Record<string, unknown>) => {
        appState = { name: appName, port: appState?.port, path: appPath, status, ...details };
      }),
      updateApp: jest.fn().mockResolvedValue(undefined),
    };
    jest.spyOn(p(), 'holdForPromotion').mockResolvedValue(false);
    jest.spyOn(p(), 'tryCutover').mockResolvedValue(false);
    jest.spyOn(p(), 'buildFreshStartSpec').mockResolvedValue({ spec: {}, port: 3005 });
    jest.spyOn(p(), 'noteRuntimeLogStart').mockResolvedValue(undefined);
    jest.spyOn(p(), 'recordDeploySignature').mockResolvedValue(undefined);
    jest.spyOn(p(), 'commitServedPath').mockResolvedValue(undefined);
    jest.spyOn(p(), 'armPostDeployWatches').mockImplementation(() => undefined);
    jest.spyOn(p(), 'stopHealthProber').mockImplementation(() => undefined);
    jest.spyOn(p(), 'hasLiveBuildContainer').mockResolvedValue(false);

    const tracker = getDeployTracker(path.join(tempDir, 'deploys.json'));
    await tracker.initialize();
    unsubs = [tracker.subscribe(eventBus)];
  });

  afterEach(async () => {
    delete process.env.DROP_MIN_FREE_DISK_MB;
    resetPrincipalQuota();
    unsubs.forEach((u) => u());
    jest.restoreAllMocks();
    if (platform.isActive()) await platform.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('the hold (reserveForUpdate)', () => {
    it('claims the slot without marking a git land', () => {
      const hold = p().reserveForUpdate(appName) as UpdateHold;
      expect(hold.app).toBe(appName);
      expect(p().appsInProgress.has(appName)).toBe(true);
      expect(p().isBusy(appName)).toBe(true);
      expect(p().gitReserved.has(appName)).toBe(false);
    });

    it('release frees the claim, once', () => {
      const hold = p().reserveForUpdate(appName) as UpdateHold;
      hold.release();
      expect(p().appsInProgress.has(appName)).toBe(false);
      expect(p().holdOwners.has(appName)).toBe(false);
      const next = p().reserveForUpdate(appName) as UpdateHold;
      hold.release(); // the stale second release is a no-op
      expect(p().appsInProgress.has(appName)).toBe(true);
      next.release();
    });

    it('release after consume is a no-op', () => {
      const hold = p().reserveForUpdate(appName) as UpdateHold;
      const giveBack = hold.consume()!;
      hold.release();
      expect(p().appsInProgress.has(appName)).toBe(true);
      giveBack();
      expect(p().appsInProgress.has(appName)).toBe(false);
    });

    it('consume is one-shot', () => {
      const hold = p().reserveForUpdate(appName) as UpdateHold;
      expect(hold.consume()).toEqual(expect.any(Function));
      expect(hold.consume()).toBeNull();
    });

    it('a released hold cannot be consumed', () => {
      const hold = p().reserveForUpdate(appName) as UpdateHold;
      hold.release();
      expect(hold.consume()).toBeNull();
    });

    it("a hold cannot release a later owner's claim", () => {
      const first = p().reserveForUpdate(appName) as UpdateHold;
      const giveBack = first.consume()!;
      giveBack();
      const second = p().reserveForUpdate(appName) as UpdateHold;
      first.release();
      giveBack(); // the consumed callback, called again
      expect(p().appsInProgress.has(appName)).toBe(true);
      expect(second.consume()).toEqual(expect.any(Function));
    });

    it('reserveForUpdate and tryReserveApp exclude each other, both ways', () => {
      const hold = p().reserveForUpdate(appName) as UpdateHold;
      expect(p().tryReserveApp(appName)).toBeNull();
      expect(p().reserveForUpdate(appName)).toBeNull();
      hold.release();

      const releaseGit = p().tryReserveApp(appName) as () => void;
      expect(releaseGit).toEqual(expect.any(Function));
      expect(p().gitReserved.has(appName)).toBe(true);
      expect(p().reserveForUpdate(appName)).toBeNull();
      releaseGit();
      expect(p().appsInProgress.has(appName)).toBe(false);
      expect(p().gitReserved.has(appName)).toBe(false);
    });

    it("tryReserveApp's release cannot free a hold's claim", () => {
      const releaseGit = p().tryReserveApp(appName) as () => void;
      releaseGit();
      const hold = p().reserveForUpdate(appName) as UpdateHold;
      releaseGit(); // stale
      expect(p().appsInProgress.has(appName)).toBe(true);
      hold.release();
    });

    it('is refused while quiesced and while an upload is writing the folder', () => {
      jest.spyOn(p(), 'isQuiesced').mockReturnValue(true);
      expect(p().reserveForUpdate(appName)).toBeNull();
      (p().isQuiesced as jest.Mock).mockReturnValue(false);
      p().uploadDeployService = { isUploading: jest.fn().mockReturnValue(true) };
      expect(p().reserveForUpdate(appName)).toBeNull();
    });
  });

  describe('admitExplicitUpdate', () => {
    /** After a refusal nothing is held: no claim, no owner, no keys. */
    const expectNothingHeld = (): void => {
      expect(p().appsInProgress.has(appName)).toBe(false);
      expect(p().holdOwners.has(appName)).toBe(false);
      expect(p().breakerKeys.has(appName)).toBe(false);
    };

    it('admits a files app: holds the slot, sets the keys, carries the entry snapshot and the trigger', async () => {
      const out = await p().admitExplicitUpdate(appName, actor);
      expect(out.hold.app).toBe(appName);
      expect(out.admitted).toMatchObject({
        appPath,
        statusAtEntry: 'running',
        wasRunning: true,
        originalPort: 3005,
        trigger: 'deploy',
      });
      expect(p().appsInProgress.has(appName)).toBe(true);
      expect(p().breakerKeys.get(appName)).toEqual(p().guardrailKeys(appName, false, actor));
      out.hold.release();
    });

    it('charges ONE admission, with the one actor', async () => {
      const admit = jest.spyOn(breakerModule, 'admitDeploy');
      const out = await p().admitExplicitUpdate(appName, actor);
      expect(admit).toHaveBeenCalledTimes(1);
      expect(admit).toHaveBeenCalledWith(appName, false, actor);
      out.hold.release();
    });

    it('refuses an unknown app, releasing the hold', async () => {
      appState = undefined;
      const out = await p().admitExplicitUpdate(appName, actor);
      expect(out.refused).toMatchObject({ code: 'NOT_FOUND' });
      expectNothingHeld();
    });

    it('refuses a git-backed app, pointing at /git/redeploy', async () => {
      appState = { ...appState, gitSource: { repoUrl: 'https://example.com/r.git', branch: 'main' } };
      const out = await p().admitExplicitUpdate(appName, actor);
      expect(out.refused.code).toBe('REDEPLOY_NOT_SUPPORTED_YET');
      expect(out.refused.message).toContain(`/git/redeploy/${appName}`);
      expectNothingHeld();
    });

    it('refuses a child of a git-deployed group', async () => {
      appState = { ...appState, group: 'g' };
      p().stateManager.getAllApps.mockReturnValue([
        appState,
        { name: 'g-container', isGroupContainer: true, group: 'g', gitSource: { repoUrl: 'x', branch: 'main' } },
      ]);
      const out = await p().admitExplicitUpdate(appName, actor);
      expect(out.refused.code).toBe('REDEPLOY_NOT_SUPPORTED_YET');
      expectNothingHeld();
    });

    it('refuses a monorepo container, by flag and by its drop.yaml', async () => {
      appState = { ...appState, isGroupContainer: true };
      let out = await p().admitExplicitUpdate(appName, actor);
      expect(out.refused.code).toBe('REDEPLOY_NOT_SUPPORTED_YET');
      expectNothingHeld();

      appState = { name: appName, status: 'running', port: 3005, path: appPath };
      fs.writeFileSync(path.join(appPath, 'drop.yaml'), 'services:\n  web:\n    path: web\n    type: static\n');
      out = await p().admitExplicitUpdate(appName, actor);
      expect(out.refused.code).toBe('REDEPLOY_NOT_SUPPORTED_YET');
      expectNothingHeld();
    });

    it('refuses a stopped app', async () => {
      appState = { ...appState, status: 'stopped' };
      jest.spyOn(p(), 'dependenciesAreStale').mockResolvedValue(false);
      const out = await p().admitExplicitUpdate(appName, actor);
      expect(out.refused.code).toBe('APP_STOPPED');
      expectNothingHeld();
    });

    it('rebuilds a stopped app only for a stale tree, and never for an agent', async () => {
      appState = { ...appState, status: 'stopped' };
      jest.spyOn(p(), 'dependenciesAreStale').mockResolvedValue(true);

      const agent = await p().admitExplicitUpdate(appName, { ...actor, agent: true });
      expect(agent.refused.code).toBe('APP_STOPPED');
      expectNothingHeld();

      const human = await p().admitExplicitUpdate(appName, actor);
      expect(human.hold).toBeDefined();
      human.hold.release();
    });

    it('refuses a busy app with APP_BUSY and leaves the other holder alone', async () => {
      const other = p().reserveForUpdate(appName) as UpdateHold;
      const out = await p().admitExplicitUpdate(appName, actor);
      expect(out.refused.code).toBe('APP_BUSY');
      expect(p().appsInProgress.has(appName)).toBe(true);
      expect(other.consume()).toEqual(expect.any(Function));
    });

    it('refuses while quiesced with SERVICE_UNAVAILABLE', async () => {
      jest.spyOn(p(), 'isQuiesced').mockReturnValue(true);
      const out = await p().admitExplicitUpdate(appName, actor);
      expect(out.refused.code).toBe('SERVICE_UNAVAILABLE');
      expectNothingHeld();
    });

    it('refuses while a build container is still running', async () => {
      p().hasLiveBuildContainer.mockResolvedValue(true);
      const out = await p().admitExplicitUpdate(appName, actor);
      expect(out.refused.code).toBe('APP_BUSY');
      expectNothingHeld();
    });

    it('refuses a tripped breaker with RATE_LIMITED and a retry hint', async () => {
      const [{ key, threshold }] = p().guardrailKeys(appName, false, actor);
      for (let i = 0; i < threshold; i++) getDeployBreaker().recordFailure(key, Date.now(), threshold);
      const out = await p().admitExplicitUpdate(appName, actor);
      expect(out.refused.code).toBe('RATE_LIMITED');
      expect(out.refused.retryAfterSeconds).toBeGreaterThan(0);
      expectNothingHeld();
    });

    it('refuses a full disk with INSUFFICIENT_DISK', async () => {
      (hasEnoughDisk as jest.Mock).mockResolvedValue({ ok: false, freeMb: 1 });
      const out = await p().admitExplicitUpdate(appName, actor);
      expect(out.refused.code).toBe('INSUFFICIENT_DISK');
      expectNothingHeld();
    });

    it('releases the hold when an unexpected error escapes the checks', async () => {
      jest.spyOn(breakerModule, 'admitDeploy').mockRejectedValue(new Error('quota store down'));
      await expect(p().admitExplicitUpdate(appName, actor)).rejects.toThrow('quota store down');
      expectNothingHeld();
    });
  });

  describe('startExplicitUpdate', () => {
    it('resolves with the minted deploy id while the build is still running, then gives the claim back', async () => {
      let open!: () => void;
      buildGate = new Promise<void>((resolve) => (open = resolve));
      const { hold, admitted } = await p().admitExplicitUpdate(appName, actor);
      const handleAppUpdate = jest.spyOn(p(), 'handleAppUpdate');

      const out = await p().startExplicitUpdate(hold, admitted);
      expect(out.started).toMatch(UUID);
      // The id is the one the build runs under and the tracker adopts.
      for (let i = 0; i < 200 && buildCtxs.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(buildCtxs[0].deployId).toBe(out.started);
      expect(buildCtxs[0].trigger).toBe('deploy');
      expect(p().appsInProgress.has(appName)).toBe(true);

      open();
      await settle();
      expect(p().appsInProgress.has(appName)).toBe(false);
      expect(p().breakerKeys.has(appName)).toBe(false);
      expect(p().runtime.start).toHaveBeenCalledTimes(1);
      expect(handleAppUpdate).not.toHaveBeenCalled();
    });

    it('a hold that was released starts nothing', async () => {
      const { hold, admitted } = await p().admitExplicitUpdate(appName, actor);
      hold.release();
      const out = await p().startExplicitUpdate(hold, admitted);
      expect(out.refused.code).toBe('APP_BUSY');
      expect(p().builder.build).not.toHaveBeenCalled();
      expect(p().builder.reserveSlot).not.toHaveBeenCalled();
    });

    it('a hold can start once', async () => {
      const { hold, admitted } = await p().admitExplicitUpdate(appName, actor);
      const first = await p().startExplicitUpdate(hold, admitted);
      expect(first.started).toBeDefined();
      await settle();
      const second = await p().startExplicitUpdate(hold, admitted);
      expect(second.refused.code).toBe('APP_BUSY');
      expect(buildCtxs).toHaveLength(1);
    });

    it.each([
      ['quiesced', 'SERVICE_UNAVAILABLE', () => (reserveEffect = () => jest.spyOn(p(), 'isQuiesced').mockReturnValue(true))],
      ['busy', 'APP_BUSY', () => (reserveEffect = () => p().gitReserved.add(appName))],
      ['gone', 'NOT_FOUND', () => (reserveEffect = () => (appState = undefined))],
      ['stopped', 'APP_STOPPED', () => (reserveEffect = () => (appState = { ...appState, status: 'stopped' }))],
      ['disk', 'INSUFFICIENT_DISK', () => (hasEnoughDisk as jest.Mock).mockResolvedValue({ ok: false, freeMb: 1 })],
    ])('maps a %s refusal after the slot wait to %s, giving everything back', async (_reason, code, setup) => {
      const { hold, admitted } = await p().admitExplicitUpdate(appName, actor);
      (hasEnoughDisk as jest.Mock).mockResolvedValue({ ok: true, freeMb: 999999 });
      setup();
      const out = await p().startExplicitUpdate(hold, admitted);
      expect(out.refused.code).toBe(code);
      expect(p().appsInProgress.has(appName)).toBe(false);
      expect(p().holdOwners.has(appName)).toBe(false);
      expect(p().breakerKeys.has(appName)).toBe(false);
      expect(p().builder.build).not.toHaveBeenCalled();
    });

    it('maps a breaker that tripped while it waited to RATE_LIMITED with the retry hint', async () => {
      const { hold, admitted } = await p().admitExplicitUpdate(appName, actor);
      jest.spyOn(p(), 'checkGuardrails').mockReturnValue({ allowed: false, failures: 3, retryAfterSeconds: 9 });
      const out = await p().startExplicitUpdate(hold, admitted);
      expect(out.refused).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 9 });
      expect(p().appsInProgress.has(appName)).toBe(false);
    });

    it('a pre-build failure carries the trigger on its episode', async () => {
      detectThrows = new Error('detect blew up');
      const { hold, admitted } = await p().admitExplicitUpdate(appName, actor);
      const out = await p().startExplicitUpdate(hold, admitted);
      await settle();
      const [episode] = getDeployTracker().getEpisodes(appName, 1);
      expect(episode.deployId).toBe(out.started);
      expect(episode.trigger).toBe('deploy');
      expect(episode.status).toBe('failed');
      expect(p().appsInProgress.has(appName)).toBe(false);
    });

    it('logs, rather than leaves unhandled, a failure handler that throws', async () => {
      detectThrows = new Error('detect blew up');
      p().stateManager.setAppStatus.mockImplementation(async (_n: string, status: string) => {
        if (status === 'errored') throw new Error('state store down');
      });
      const logged = jest.spyOn(p().logger, 'error').mockImplementation(() => undefined);
      const { hold, admitted } = await p().admitExplicitUpdate(appName, actor);
      const out = await p().startExplicitUpdate(hold, admitted);
      expect(out.started).toMatch(UUID);
      await settle();
      for (let i = 0; i < 100 && logged.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(logged).toHaveBeenCalledTimes(1);
      expect(p().appsInProgress.has(appName)).toBe(false);
    });

    it('a slot wait that throws gives the claim back and surfaces', async () => {
      p().builder.reserveSlot.mockRejectedValue(new Error('slot wait blew up'));
      const { hold, admitted } = await p().admitExplicitUpdate(appName, actor);
      await expect(p().startExplicitUpdate(hold, admitted)).rejects.toThrow('slot wait blew up');
      expect(p().appsInProgress.has(appName)).toBe(false);
      expect(p().holdOwners.has(appName)).toBe(false);
    });
  });
});
