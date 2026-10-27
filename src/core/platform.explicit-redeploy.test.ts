/**
 * The explicit-redeploy platform surface (#359 Item 2): the reservation
 * (`reserve`, and `tryReserveApp` built on it), `isGroupBusy`, and the one
 * operation `redeployApp`.
 *
 * Driven against the real DropPlatform with the same private-seam stubs as
 * platform.update-exit-trace.test.ts: a fake builder (so the slot wait and the
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
import {
  getDeployTracker,
  resetDeployTracker,
  getDeployDetailStore,
  resetDeployDetailStore,
} from '../managers/deploy-tracker';
import { hasEnoughDisk } from '../utils/disk';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('explicit redeploy: reservation, group rule, redeployApp', () => {
  let tempDir: string;
  let appPath: string;
  let platform: DropPlatform;
  let appState: any;
  let allApps: any[] | undefined;
  let buildCtxs: any[];
  let buildGate: Promise<void> | undefined;
  let slotGate: Promise<void> | undefined;
  let reserveEffect: (() => void) | undefined;
  let detectThrows: Error | undefined;
  let unsubs: Array<() => void>;
  const appName = `explicit-app-${Date.now()}`;
  const actor = { principalId: 'p-1', actorUserId: 'u-1' };

  const p = () => platform as any;
  const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Until the deploy has settled: nothing held. */
  const settle = async (): Promise<void> => {
    for (
      let i = 0;
      i < 300 && (p().appsInProgress.has(appName) || p().holdOwners.has(appName));
      i++
    ) {
      await tick();
    }
  };
  /** After a refusal or a settled deploy nothing is held: no claim, no owner, no keys. */
  const expectNothingHeld = (): void => {
    expect(p().appsInProgress.has(appName)).toBe(false);
    expect(p().holdOwners.has(appName)).toBe(false);
    expect(p().gitReserved.has(appName)).toBe(false);
    expect(p().breakerKeys.has(appName)).toBe(false);
  };
  const episodeOf = (deployId: string) => getDeployTracker().getEpisodes().find((e) => e.deployId === deployId);

  beforeEach(async () => {
    resetDeployBreaker();
    resetDeployTracker();
    resetDeployDetailStore();
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
    slotGate = undefined;
    reserveEffect = undefined;
    detectThrows = undefined;
    allApps = undefined;

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      isolation: 'none',
    });
    appState = { name: appName, status: 'running', port: 3005, path: appPath, userId: 'owner-1' };
    p().toolchainBackfilled = true;
    p().builder = {
      reserveSlot: jest.fn(async () => {
        await slotGate;
        reserveEffect?.();
        return () => undefined;
      }),
      build: jest.fn(async (ctx: { deployId?: string; trigger?: string }) => {
        buildCtxs.push(ctx);
        // What the real BuilderService publishes once it holds the slot.
        eventBus.publish('build:started', {
          appId: appName,
          buildId: 'b-1',
          deployId: ctx.deployId,
          trigger: ctx.trigger as 'deploy',
        });
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
      getApp: jest.fn((name: string) =>
        name === appName ? appState : (allApps ?? []).find((a: any) => a.name === name)
      ),
      getAllApps: jest.fn(() => allApps ?? (appState ? [appState] : [])),
      setAppStatus: jest.fn(async (_n: string, status: string, details?: Record<string, unknown>) => {
        appState = { name: appName, port: appState?.port, path: appPath, userId: 'owner-1', status, ...details };
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
    const details = getDeployDetailStore(path.join(tempDir, 'deploy-details.json'));
    await details.initialize();
    unsubs = [tracker.subscribe(eventBus), details.subscribe(eventBus)];
  });

  afterEach(async () => {
    delete process.env.DROP_MIN_FREE_DISK_MB;
    resetPrincipalQuota();
    unsubs.forEach((u) => u());
    // The tracker persists in the background: let it finish before the folder goes.
    await getDeployTracker().flush();
    jest.restoreAllMocks();
    if (platform.isActive()) await platform.stop();
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('the reservation (reserve)', () => {
    it('claims the slot without marking a git land', () => {
      const hold = p().reserve(appName);
      expect(hold.app).toBe(appName);
      expect(p().appsInProgress.has(appName)).toBe(true);
      expect(p().isBusy(appName)).toBe(true);
      expect(p().gitReserved.has(appName)).toBe(false);
    });

    it('beginLand and endLand mark and clear the land, while the hold is held', () => {
      const hold = p().reserve(appName);
      hold.beginLand();
      expect(p().gitReserved.has(appName)).toBe(true);
      hold.endLand();
      expect(p().gitReserved.has(appName)).toBe(false);
      hold.beginLand();
      hold.release();
      expect(p().gitReserved.has(appName)).toBe(false);
      expect(p().appsInProgress.has(appName)).toBe(false);
    });

    it('release frees the claim, once', () => {
      const hold = p().reserve(appName);
      hold.release();
      expect(p().appsInProgress.has(appName)).toBe(false);
      expect(p().holdOwners.has(appName)).toBe(false);
      const next = p().reserve(appName);
      hold.release(); // the stale second release is a no-op
      expect(p().appsInProgress.has(appName)).toBe(true);
      next.release();
    });

    it('release after consume is a no-op', () => {
      const hold = p().reserve(appName);
      const giveBack = hold.consume()!;
      hold.release();
      expect(p().appsInProgress.has(appName)).toBe(true);
      giveBack();
      expect(p().appsInProgress.has(appName)).toBe(false);
    });

    it('consume is one-shot, and a released hold cannot be consumed', () => {
      const hold = p().reserve(appName);
      expect(hold.consume()).toEqual(expect.any(Function));
      expect(hold.consume()).toBeNull();
      p().appsInProgress.delete(appName);
      p().holdOwners.delete(appName);
      const other = p().reserve(appName);
      other.release();
      expect(other.consume()).toBeNull();
    });

    it("a hold cannot release a later owner's claim", () => {
      const first = p().reserve(appName);
      const giveBack = first.consume()!;
      giveBack();
      const second = p().reserve(appName);
      first.release();
      giveBack(); // the consumed callback, called again
      first.beginLand(); // and a stale land marker
      expect(p().appsInProgress.has(appName)).toBe(true);
      expect(p().gitReserved.has(appName)).toBe(false);
      expect(second.consume()).toEqual(expect.any(Function));
    });

    it('is refused while quiesced and while an upload is writing the folder', () => {
      jest.spyOn(p(), 'isQuiesced').mockReturnValue(true);
      expect(p().reserve(appName)).toBeNull();
      (p().isQuiesced as jest.Mock).mockReturnValue(false);
      p().uploadDeployService = { isUploading: jest.fn().mockReturnValue(true) };
      expect(p().reserve(appName)).toBeNull();
    });
  });

  describe("tryReserveApp keeps its external contract (git-deploy and the DELETE route)", () => {
    it('returns a plain release function, with the land marked from the moment of the claim', () => {
      const release = p().tryReserveApp(appName);
      expect(typeof release).toBe('function');
      expect(p().appsInProgress.has(appName)).toBe(true);
      expect(p().gitReserved.has(appName)).toBe(true);
      release();
      expect(p().appsInProgress.has(appName)).toBe(false);
      expect(p().gitReserved.has(appName)).toBe(false);
    });

    it('releases idempotently, and never frees a later owner', () => {
      const release = p().tryReserveApp(appName);
      release();
      const next = p().tryReserveApp(appName);
      release();
      expect(p().appsInProgress.has(appName)).toBe(true);
      expect(p().gitReserved.has(appName)).toBe(true);
      next();
    });

    it('is null while busy, quiesced or uploading, and excludes a reserve, both ways', () => {
      const hold = p().reserve(appName);
      expect(p().tryReserveApp(appName)).toBeNull();
      hold.release();
      const release = p().tryReserveApp(appName);
      expect(p().reserve(appName)).toBeNull();
      release();
      jest.spyOn(p(), 'isQuiesced').mockReturnValue(true);
      expect(p().tryReserveApp(appName)).toBeNull();
      (p().isQuiesced as jest.Mock).mockReturnValue(false);
      p().uploadDeployService = { isUploading: jest.fn().mockReturnValue(true) };
      expect(p().tryReserveApp(appName)).toBeNull();
    });
  });

  describe('isGroupBusy', () => {
    const child = { name: 'g-child', group: 'g', status: 'running' };
    const container = { name: 'g-container', group: 'g', isGroupContainer: true, status: 'running' };
    const sibling = { name: 'g-sibling', group: 'g', status: 'running' };

    beforeEach(() => {
      allApps = [container, child, sibling];
    });

    it('is true for a container while any child is busy', () => {
      expect(p().isGroupBusy('g-container')).toBe(false);
      p().appsInProgress.add('g-child');
      expect(p().isGroupBusy('g-container')).toBe(true);
    });

    it('is true for a child while its container is busy, but not while only a sibling is', () => {
      p().appsInProgress.add('g-sibling');
      expect(p().isGroupBusy('g-child')).toBe(false);
      p().appsInProgress.delete('g-sibling');
      p().gitReserved.add('g-container');
      expect(p().isGroupBusy('g-child')).toBe(true);
    });

    it('is false for an app outside any group', () => {
      allApps = [{ name: appName, status: 'running' }, container];
      p().appsInProgress.add('g-container');
      expect(p().isGroupBusy(appName)).toBe(false);
    });
  });

  describe('redeployApp: refusals give everything back', () => {
    it('refuses an unknown app', async () => {
      appState = undefined;
      const out = await p().redeployApp(appName, actor);
      expect(out.refused).toMatchObject({ code: 'NOT_FOUND' });
      expectNothingHeld();
    });

    it('refuses a git-backed app, pointing at /git/redeploy', async () => {
      appState = { ...appState, gitSource: { repoUrl: 'https://example.com/r.git', branch: 'main' } };
      const out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('REDEPLOY_NOT_SUPPORTED_YET');
      expect(out.refused.message).toContain(`/git/redeploy/${appName}`);
      expectNothingHeld();
    });

    it('refuses a child of a git-deployed group', async () => {
      appState = { ...appState, group: 'g' };
      allApps = [
        appState,
        { name: 'g-container', isGroupContainer: true, group: 'g', gitSource: { repoUrl: 'x', branch: 'main' } },
      ];
      const out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('REDEPLOY_NOT_SUPPORTED_YET');
      expectNothingHeld();
    });

    it('refuses a monorepo container, by flag and by its drop.yaml', async () => {
      appState = { ...appState, isGroupContainer: true };
      let out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('REDEPLOY_NOT_SUPPORTED_YET');
      expectNothingHeld();

      appState = { name: appName, status: 'running', port: 3005, path: appPath };
      fs.writeFileSync(path.join(appPath, 'drop.yaml'), 'services:\n  web:\n    path: web\n    type: static\n');
      out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('REDEPLOY_NOT_SUPPORTED_YET');
      expectNothingHeld();
    });

    it('refuses a stopped app', async () => {
      appState = { ...appState, status: 'stopped' };
      jest.spyOn(p(), 'dependenciesAreStale').mockResolvedValue(false);
      const out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('APP_STOPPED');
      expectNothingHeld();
    });

    it('rebuilds a stopped app only for a stale tree, and never for an agent', async () => {
      appState = { ...appState, status: 'stopped' };
      jest.spyOn(p(), 'dependenciesAreStale').mockResolvedValue(true);

      const agent = await p().redeployApp(appName, { ...actor, agent: true });
      expect(agent.refused.code).toBe('APP_STOPPED');
      expectNothingHeld();

      const human = await p().redeployApp(appName, actor);
      expect(human.started).toMatch(UUID);
      await settle();
    });

    it('refuses a busy app with APP_BUSY and leaves the other holder alone', async () => {
      const other = p().reserve(appName);
      const out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('APP_BUSY');
      expect(p().appsInProgress.has(appName)).toBe(true);
      expect(other.consume()).toEqual(expect.any(Function));
    });

    it('refuses while quiesced with SERVICE_UNAVAILABLE', async () => {
      jest.spyOn(p(), 'isQuiesced').mockReturnValue(true);
      const out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('SERVICE_UNAVAILABLE');
      expectNothingHeld();
    });

    it('refuses while its monorepo group is busy', async () => {
      appState = { ...appState, group: 'g' };
      allApps = [appState, { name: 'g-container', isGroupContainer: true, group: 'g' }];
      p().appsInProgress.add('g-container');
      const out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('APP_BUSY');
      expect(p().appsInProgress.has(appName)).toBe(false);
      expect(p().holdOwners.has(appName)).toBe(false);
    });

    it('refuses while a build container is still running', async () => {
      p().hasLiveBuildContainer.mockResolvedValue(true);
      const out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('APP_BUSY');
      expectNothingHeld();
    });

    it('refuses a tripped breaker with RATE_LIMITED and a retry hint', async () => {
      const [{ key, threshold }] = p().guardrailKeys(appName, false, actor);
      for (let i = 0; i < threshold; i++) getDeployBreaker().recordFailure(key, Date.now(), threshold);
      const out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('RATE_LIMITED');
      expect(out.refused.retryAfterSeconds).toBeGreaterThan(0);
      expectNothingHeld();
    });

    it('refuses a full disk with INSUFFICIENT_DISK, BEFORE the admission so no quota is burned', async () => {
      (hasEnoughDisk as jest.Mock).mockResolvedValue({ ok: false, freeMb: 1 });
      const admit = jest.spyOn(breakerModule, 'admitDeploy');
      const out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('INSUFFICIENT_DISK');
      expect(admit).not.toHaveBeenCalled();
      expectNothingHeld();
    });

    it('releases the hold when an unexpected error escapes the checks', async () => {
      jest.spyOn(breakerModule, 'admitDeploy').mockRejectedValue(new Error('quota store down'));
      await expect(p().redeployApp(appName, actor)).rejects.toThrow('quota store down');
      expectNothingHeld();
    });
  });

  describe('redeployApp: accepted before the wait for a builder slot', () => {
    it('charges ONE admission, with the one actor, and never touches handleAppUpdate', async () => {
      const admit = jest.spyOn(breakerModule, 'admitDeploy');
      const handleAppUpdate = jest.spyOn(p(), 'handleAppUpdate');
      const out = await p().redeployApp(appName, actor);
      expect(out.started).toMatch(UUID);
      expect(admit).toHaveBeenCalledTimes(1);
      expect(admit).toHaveBeenCalledWith(appName, false, actor);
      await settle();
      expect(handleAppUpdate).not.toHaveBeenCalled();
    });

    it('answers with the minted id while another build still holds the only slot', async () => {
      let freeSlot!: () => void;
      slotGate = new Promise<void>((resolve) => (freeSlot = resolve));
      const out = await p().redeployApp(appName, actor);
      expect(out.started).toMatch(UUID);

      // Accepted, claimed and keyed - and nothing has started building. The
      // tracker already has the episode, under the id just handed out.
      expect(p().appsInProgress.has(appName)).toBe(true);
      expect(p().breakerKeys.has(appName)).toBe(true);
      expect(buildCtxs).toHaveLength(0);
      const queued = episodeOf(out.started)!;
      expect(queued.status).toBe('queued');
      expect(queued.trigger).toBe('deploy');
      expect(queued.stages.map((s) => s.stage)).toEqual(['queued']);
      expect(getDeployTracker().hasOpenEpisode(appName)).toBe(true);

      freeSlot();
      for (let i = 0; i < 300 && buildCtxs.length === 0; i++) await tick();
      // The very id handed out is the one the build runs, and the tracker adopts, under.
      expect(buildCtxs[0].deployId).toBe(out.started);
      expect(buildCtxs[0].trigger).toBe('deploy');
      await settle();
      expectNothingHeld();
      expect(p().runtime.start).toHaveBeenCalledTimes(1);
    });

    it('build:started continues the SAME episode: building, not queued, one episode', async () => {
      let open!: () => void;
      buildGate = new Promise<void>((resolve) => (open = resolve));
      slotGate = new Promise<void>((resolve) => setTimeout(resolve, 20));
      const out = await p().redeployApp(appName, actor);
      expect(episodeOf(out.started)!.status).toBe('queued');

      for (let i = 0; i < 300 && buildCtxs.length === 0; i++) await tick();
      const building = episodeOf(out.started)!;
      expect(building.status).toBe('in-progress');
      expect(building.stages.map((s) => s.stage)).toEqual(['queued', 'build-started']);
      expect(getDeployTracker().getEpisodes(appName)).toHaveLength(1);
      // The episode began when it was accepted, not when the slot freed.
      expect(new Date(building.startedAt).getTime()).toBeLessThan(new Date(building.stages[1].at).getTime() + 1);

      open();
      await settle();
    });

    it('holds the claim while the build runs, and gives it back when it settles', async () => {
      let open!: () => void;
      buildGate = new Promise<void>((resolve) => (open = resolve));
      const out = await p().redeployApp(appName, actor);
      for (let i = 0; i < 300 && buildCtxs.length === 0; i++) await tick();
      expect(p().appsInProgress.has(appName)).toBe(true);
      expect(episodeOf(out.started)!.status).toBe('in-progress');
      open();
      await settle();
      expectNothingHeld();
    });

    it('sets the breaker keys once the hold is consumed, and a refusal before that sets none', async () => {
      let slotHeld!: () => void;
      slotGate = new Promise<void>((resolve) => (slotHeld = resolve));
      const out = await p().redeployApp(appName, actor);
      expect(p().breakerKeys.get(appName)).toEqual(p().guardrailKeys(appName, false, actor));
      slotHeld();
      await settle();
      expect(out.started).toMatch(UUID);

      (hasEnoughDisk as jest.Mock).mockResolvedValue({ ok: false, freeMb: 1 });
      const refused = await p().redeployApp(appName, actor);
      expect(refused.refused.code).toBe('INSUFFICIENT_DISK');
      expect(p().breakerKeys.has(appName)).toBe(false);
    });

    it.each([
      ['quiesced', () => (reserveEffect = () => jest.spyOn(p(), 'isQuiesced').mockReturnValue(true))],
      ['busy', () => (reserveEffect = () => p().gitReserved.add(appName))],
      ['group-busy', () => (reserveEffect = () => jest.spyOn(p(), 'isGroupBusy').mockReturnValue(true))],
      ['gone', () => (reserveEffect = () => (appState = undefined))],
      ['stopped', () => (reserveEffect = () => (appState = { ...appState, status: 'stopped' }))],
      [
        'disk',
        () =>
          (hasEnoughDisk as jest.Mock)
            .mockResolvedValueOnce({ ok: true, freeMb: 999999 })
            .mockResolvedValue({ ok: false, freeMb: 1 }),
      ],
      [
        'guardrail',
        () => jest.spyOn(p(), 'checkGuardrails').mockReturnValue({ allowed: false, failures: 3, retryAfterSeconds: 9 }),
      ],
    ])('a %s refusal after the wait closes the episode under the SAME id', async (_reason: string, setup: () => unknown) => {
      setup();
      const out = await p().redeployApp(appName, actor);
      expect(out.started).toMatch(UUID);
      await settle();

      const episode = episodeOf(out.started);
      expect(episode).toBeDefined();
      expect(episode!.status).toBe('failed');
      expect(episode!.trigger).toBe('deploy');
      expect(episode!.stages.map((s) => s.stage)).toEqual(['queued', 'build-failed']);
      expect(getDeployTracker().getEpisodes(appName)).toHaveLength(1);
      // A refusal has its own code - not PREBUILD_FAILED, whose hint sends the caller to drop.yaml.
      expect(getDeployDetailStore().getDetail(out.started)?.errorCode).toBe(
        _reason === 'guardrail' ? 'GUARDRAIL_TRIPPED' : 'DEPLOY_REFUSED'
      );
      expect(p().builder.build).not.toHaveBeenCalled();
      expect(p().holdOwners.has(appName)).toBe(false);
      expect(p().appsInProgress.has(appName)).toBe(false);
      expect(p().breakerKeys.has(appName)).toBe(false);
      // Not charged: a refusal is not a failed build.
      const [{ key }] = p().guardrailKeys(appName, false, actor);
      expect(getDeployBreaker().peek(key).failures).toBe(0);
    });

    it('an old open episode (a parked app\'s) does not swallow the new id\'s failure', async () => {
      // A previous deploy that never closed: build:started with no terminal event.
      eventBus.publish('build:started', { appId: appName, buildId: 'old-b', deployId: 'old-deploy' });
      expect(episodeOf('old-deploy')!.status).toBe('in-progress');
      reserveEffect = () => (appState = undefined); // refused after the wait: gone

      const out = await p().redeployApp(appName, actor);
      await settle();

      expect(episodeOf(out.started)!.status).toBe('failed');
      expect(getDeployDetailStore().getDetail(out.started)?.errorCode).toBe('DEPLOY_REFUSED');
      // The old one was superseded, not closed by this failure.
      expect(episodeOf('old-deploy')!.status).toBe('superseded');
      expect(getDeployDetailStore().getDetail('old-deploy')).toBeUndefined();
    });

    it('a pre-build failure carries the trigger on its episode', async () => {
      detectThrows = new Error('detect blew up');
      const out = await p().redeployApp(appName, actor);
      await settle();
      const episode = episodeOf(out.started);
      expect(episode!.trigger).toBe('deploy');
      expect(episode!.status).toBe('failed');
      expect(p().appsInProgress.has(appName)).toBe(false);
    });

    it('logs, rather than leaves unhandled, a failure handler that throws', async () => {
      detectThrows = new Error('detect blew up');
      p().stateManager.setAppStatus.mockImplementation(async (_n: string, status: string) => {
        if (status === 'errored') throw new Error('state store down');
      });
      const logged = jest.spyOn(p().logger, 'error').mockImplementation(() => undefined);
      const out = await p().redeployApp(appName, actor);
      expect(out.started).toMatch(UUID);
      await settle();
      for (let i = 0; i < 100 && logged.mock.calls.length === 0; i++) await tick();
      expect(logged).toHaveBeenCalledTimes(1);
      expect(p().appsInProgress.has(appName)).toBe(false);
    });

    it('a slot wait that throws is reported under the id handed out, and everything is given back', async () => {
      p().builder.reserveSlot.mockRejectedValue(new Error('slot wait blew up'));
      const logged = jest.spyOn(p().logger, 'error').mockImplementation(() => undefined);
      const out = await p().redeployApp(appName, actor);
      expect(out.started).toMatch(UUID);
      await settle();
      expect(episodeOf(out.started)!.status).toBe('failed');
      expect(logged).toHaveBeenCalledTimes(1);
      expectNothingHeld();
    });
  });
});
