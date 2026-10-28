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
import { loadEmptySuspensionStore } from './__testutils__/suspension';

// An unloaded suspension store fails closed; these tests never start the platform that loads it.
beforeEach(loadEmptySuspensionStore);
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
    process.env.DROP_REDEPLOY_START_WAIT_MS = '50'; // "held past the wait" without a ten-second test
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
      delete: jest.fn().mockResolvedValue(undefined),
      getStatus: jest.fn().mockResolvedValue(null),
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
        // What the real state manager publishes: it is what closes an episode.
        eventBus.publish('app:updated', { appId: appName, changes: { status } } as never);
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
    delete process.env.DROP_REDEPLOY_START_WAIT_MS;
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

    it('beginLand marks the land while the hold is held, and release clears it', () => {
      const hold = p().reserve(appName);
      hold.beginLand();
      expect(p().gitReserved.has(appName)).toBe(true);
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

  describe('redeployApp: git-backed apps and monorepo containers', () => {
    const gitSource = { repoUrl: 'https://github.com/user/repo', branch: 'main' };
    const servicesYaml = 'services:\n  web:\n    path: web\n    type: static\n';
    const caller = { admin: false as const, userId: 'owner-1' };
    let land: jest.Mock;
    let supersede: jest.Mock;

    beforeEach(() => {
      appState = { ...appState, gitSource };
      land = jest.fn().mockResolvedValue({ appName, repoUrl: gitSource.repoUrl, branch: 'main' });
      supersede = jest.fn();
      p().gitDeployService = {
        isAvailable: () => true,
        isCloning: () => false,
        recordedCloneUrl: jest.fn().mockReturnValue(gitSource.repoUrl),
        supersedeQueued: supersede,
        landUnderHold: land,
      };
    });

    const updates = (): any[] => {
      const seen: any[] = [];
      unsubs.push(eventBus.subscribe('app:update', (payload) => void seen.push(payload)));
      return seen;
    };

    it("a git app's redeploy is answered before the clone: accepted, the land runs in the background under the hold, then it builds", async () => {
      const order: string[] = [];
      const admit = jest.spyOn(breakerModule, 'admitDeploy').mockImplementation(async () => {
        order.push('admit');
      });
      let openLand!: () => void;
      let duringLand: { claimed: boolean; landMarked: boolean } | undefined;
      land.mockImplementation(async () => {
        order.push('land');
        duringLand = { claimed: p().appsInProgress.has(appName), landMarked: p().gitReserved.has(appName) };
        await new Promise<void>((resolve) => (openLand = resolve));
        return { appName };
      });

      const out = await p().redeployApp(appName, actor, { caller });
      // Answered while the land is still running; the hold is the background's.
      expect(out).toEqual({ accepted: true });
      expect(p().appsInProgress.has(appName)).toBe(true);
      expect(p().gitReserved.has(appName)).toBe(true);
      expect(buildCtxs).toHaveLength(0);

      openLand();
      await settle();
      // Charged once, BEFORE the clone; the land ran claimed and marked, and the
      // marker is gone by the time the hold builds (or the build would be refused).
      expect(order).toEqual(['admit', 'land']);
      expect(admit).toHaveBeenCalledTimes(1);
      expect(duringLand).toEqual({ claimed: true, landMarked: true });
      const [landedApp, landActor, landCaller] = land.mock.calls[0];
      expect(landedApp).toMatchObject({ name: appName, gitSource });
      // No token choice on this surface: the stored token only.
      expect(landActor).toEqual({ principalId: 'p-1', userId: 'u-1', automation: undefined });
      expect('tokenId' in landActor).toBe(false);
      expect(landCaller).toBe(caller);
      expect(buildCtxs).toHaveLength(1);
      expect(episodeOf(buildCtxs[0].deployId)!.status).toBe('succeeded');
      expectNothingHeld();
    });

    it('passes no caller through as null (the token then resolves as attached only)', async () => {
      await p().redeployApp(appName, actor);
      await settle();
      expect(land.mock.calls[0][2]).toBeNull();
    });

    it('a failed land releases the hold and records its own failed deploy, which the since-stream sees', async () => {
      land.mockRejectedValue(new Error('clone failed: repository not found'));
      jest.spyOn(p().logger, 'error').mockImplementation(() => undefined);
      const before = Date.now();
      // The failure is not the request's: it was answered.
      const out = await p().redeployApp(appName, actor, { caller });
      expect(out).toEqual({ accepted: true });
      await settle();
      expectNothingHeld();
      const episodes = getDeployTracker().getEpisodes(appName);
      expect(episodes).toHaveLength(1);
      expect(episodes[0].status).toBe('failed');
      expect(new Date(episodes[0].startedAt).getTime()).toBeGreaterThanOrEqual(before - 1);
      expect(buildCtxs).toHaveLength(0);
      expect(p().runtime.start).not.toHaveBeenCalled();
      // A failed deploy counts toward the breaker, as any other.
      const [{ key }] = p().guardrailKeys(appName, false, actor);
      expect(getDeployBreaker().peek(key).failures).toBe(1);
    });

    it('a caller over quota or over the breaker gets no clone', async () => {
      const [{ key, threshold }] = p().guardrailKeys(appName, false, actor);
      for (let i = 0; i < threshold; i++) getDeployBreaker().recordFailure(key, Date.now(), threshold);
      const out = await p().redeployApp(appName, actor, { caller });
      expect(out.refused.code).toBe('RATE_LIMITED');
      expect(land).not.toHaveBeenCalled();
      expectNothingHeld();
    });

    it('refuses a git app when the git service is missing, before any admission', async () => {
      const admit = jest.spyOn(breakerModule, 'admitDeploy');
      p().gitDeployService = null;
      const out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('SERVICE_UNAVAILABLE');
      expect(admit).not.toHaveBeenCalled();
      expectNothingHeld();
    });

    it('refuses an invalid recorded repository URL BEFORE the charge, as a structured refusal', async () => {
      const admit = jest.spyOn(breakerModule, 'admitDeploy');
      p().gitDeployService.recordedCloneUrl.mockImplementation(() => {
        throw new Error(`Invalid recorded repository URL for ${appName}`);
      });
      const out = await p().redeployApp(appName, actor);
      expect(out.refused).toMatchObject({ code: 'INVALID_GIT_SOURCE' });
      expect(admit).not.toHaveBeenCalled();
      expect(land).not.toHaveBeenCalled();
      expectNothingHeld();
    });

    it('refuses a service of a git-deployed group: its container holds the repository, not the child', async () => {
      appState = { name: appName, status: 'running', port: 3005, path: appPath, userId: 'owner-1', group: 'g' };
      allApps = [
        appState,
        { name: 'g-container', isGroupContainer: true, group: 'g', gitSource: { repoUrl: 'x', branch: 'main' } },
      ];
      const admit = jest.spyOn(breakerModule, 'admitDeploy');
      const out = await p().redeployApp(appName, actor, { caller });
      expect(out.refused.code).toBe('REDEPLOY_VIA_CONTAINER');
      expect(out.refused.message).not.toContain('g-container');
      expect(admit).not.toHaveBeenCalled();
      expect(land).not.toHaveBeenCalled();
      expectNothingHeld();
    });

    it('supersedes a queued redeploy before the land, as git\'s own redeploy does', async () => {
      const order: string[] = [];
      supersede.mockImplementation(() => void order.push('supersede'));
      land.mockImplementation(async () => {
        order.push('land');
        return { appName };
      });
      await p().redeployApp(appName, actor, { caller });
      await settle();
      expect(order).toEqual(['supersede', 'land']);
    });

    it('a git app whose folder is gone lands it again; a files app whose folder is gone is refused', async () => {
      fs.rmSync(appPath, { recursive: true, force: true });
      const out = await p().redeployApp(appName, actor, { caller });
      expect(out).toEqual({ accepted: true });
      await settle();
      expect(land).toHaveBeenCalledTimes(1);

      appState = { name: appName, status: 'running', port: 3005, path: appPath, userId: 'owner-1' };
      const files = await p().redeployApp(appName, actor);
      expect(files.refused.code).toBe('APP_SOURCE_MISSING');
      expectNothingHeld();
    });

    it('a lost hold after the land still publishes the update, so the landed commit builds', async () => {
      const seen = updates();
      land.mockImplementation(async () => {
        // What a platform stop does to every hold.
        p().holdOwners.clear();
        p().appsInProgress.delete(appName);
        p().gitReserved.delete(appName);
        return { appName };
      });
      const out = await p().redeployApp(appName, actor, { caller });
      expect(out).toEqual({ accepted: true });
      for (let i = 0; i < 300 && seen.length === 0; i++) await tick();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        name: appName,
        reason: 'git redeploy',
        bypassCooldown: true,
        principalId: 'p-1',
        actorUserId: 'u-1',
      });
      expect(buildCtxs).toHaveLength(0);
    });

    it('a container answers group and re-expands UNDER THE CLAIM, publishing no update and charging once', async () => {
      appState = { name: appName, status: 'running', port: 3005, path: appPath, userId: 'owner-1' };
      fs.writeFileSync(path.join(appPath, 'drop.yaml'), servicesYaml);
      const admit = jest.spyOn(breakerModule, 'admitDeploy');
      const seen = updates();
      let claimedDuringExpand = false;
      const expand = jest.spyOn(p(), 'expandMonorepo').mockImplementation(async () => {
        claimedDuringExpand = p().appsInProgress.has(appName);
      });

      const out = await p().redeployApp(appName, actor, { caller });
      expect(out).toEqual({ group: { container: appName } });
      await settle();

      expect(expand).toHaveBeenCalledTimes(1);
      expect(expand.mock.calls[0][3]).toMatchObject({ principalId: 'p-1', actorUserId: 'u-1' });
      expect(claimedDuringExpand).toBe(true);
      expect(seen).toHaveLength(0);
      expect(buildCtxs).toHaveLength(0);
      expect(admit).toHaveBeenCalledTimes(1);
      expect(land).not.toHaveBeenCalled();
      expectNothingHeld();
    });

    it('a container refused after admission (a service became busy) records a failed deploy under its name', async () => {
      appState = { name: appName, status: 'running', path: appPath, userId: 'owner-1', isGroupContainer: true, group: 'g' };
      allApps = [appState, { name: 'g-web', group: 'g', status: 'running' }];
      fs.writeFileSync(path.join(appPath, 'drop.yaml'), servicesYaml);
      const expand = jest.spyOn(p(), 'expandMonorepo').mockResolvedValue(undefined);
      jest.spyOn(breakerModule, 'admitDeploy').mockImplementation(async () => {
        p().appsInProgress.add('g-web');
      });
      const out = await p().redeployApp(appName, actor);
      expect(out).toEqual({ group: { container: appName } });
      await settle();
      expect(expand).not.toHaveBeenCalled();
      expect(getDeployTracker().getEpisodes(appName)[0]).toMatchObject({ status: 'failed' });
      expectNothingHeld();
    });

    it('a failing re-expansion records a failed deploy and gives the claim back', async () => {
      appState = { name: appName, status: 'running', path: appPath, userId: 'owner-1' };
      fs.writeFileSync(path.join(appPath, 'drop.yaml'), servicesYaml);
      jest.spyOn(p(), 'expandMonorepo').mockRejectedValue(new Error('copy failed'));
      jest.spyOn(p().logger, 'error').mockImplementation(() => undefined);
      await p().redeployApp(appName, actor);
      await settle();
      expect(getDeployTracker().getEpisodes(appName)[0]).toMatchObject({ status: 'failed' });
      expectNothingHeld();
    });

    it('a container is never refused as stopped, decided by what the folder IS (its drop.yaml), not by a state flag', async () => {
      appState = { name: appName, status: 'stopped', path: appPath, userId: 'owner-1' };
      fs.writeFileSync(path.join(appPath, 'drop.yaml'), servicesYaml);
      jest.spyOn(p(), 'dependenciesAreStale').mockResolvedValue(false);
      jest.spyOn(p(), 'expandMonorepo').mockResolvedValue(undefined);
      const out = await p().redeployApp(appName, actor);
      expect(out).toEqual({ group: { container: appName } });
      await settle();
      expectNothingHeld();
    });

    it('a git repo that gained services: is re-expanded as a group after the land, not built', async () => {
      land.mockImplementation(async () => {
        fs.writeFileSync(path.join(appPath, 'drop.yaml'), servicesYaml);
        return { appName };
      });
      const expand = jest.spyOn(p(), 'expandMonorepo').mockResolvedValue(undefined);
      const seen = updates();

      const out = await p().redeployApp(appName, actor, { caller });
      // Not known before the clone: accepted.
      expect(out).toEqual({ accepted: true });
      await settle();

      expect(land).toHaveBeenCalledTimes(1);
      expect(expand).toHaveBeenCalledTimes(1);
      expect(seen).toHaveLength(0);
      expect(buildCtxs).toHaveLength(0);
      expect(p().runtime.start).not.toHaveBeenCalled();
      expectNothingHeld();
    });

    it('a git container is answered group at once, lands, and re-expands', async () => {
      appState = { ...appState, isGroupContainer: true, group: 'g' };
      fs.writeFileSync(path.join(appPath, 'drop.yaml'), servicesYaml);
      const expand = jest.spyOn(p(), 'expandMonorepo').mockResolvedValue(undefined);
      const out = await p().redeployApp(appName, actor, { caller });
      expect(out).toEqual({ group: { container: appName } });
      await settle();
      expect(land).toHaveBeenCalledTimes(1);
      expect(expand).toHaveBeenCalledTimes(1);
      expectNothingHeld();
    });
  });

  describe('redeployApp: starting', () => {
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

    it('with the slot free answers started: the id the build runs, and the tracker adopts, under', async () => {
      const out = await p().redeployApp(appName, actor);
      expect(out.started).toMatch(UUID);
      await settle();
      expect(buildCtxs[0].deployId).toBe(out.started);
      expect(buildCtxs[0].trigger).toBe('deploy');
      expect(episodeOf(out.started)!.status).toBe('succeeded');
      expect(episodeOf(out.started)!.trigger).toBe('deploy');
      expectNothingHeld();
      expect(p().runtime.start).toHaveBeenCalledTimes(1);
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

    it('with no slot inside the wait answers accepted, holding the claim and the keys, and carries on', async () => {
      let freeSlot!: () => void;
      slotGate = new Promise<void>((resolve) => (freeSlot = resolve));
      const out = await p().redeployApp(appName, actor);
      expect(out).toEqual({ accepted: true });
      expect(buildCtxs).toHaveLength(0);
      expect(p().appsInProgress.has(appName)).toBe(true);
      expect(p().breakerKeys.has(appName)).toBe(true);
      expect(getDeployTracker().getEpisodes(appName)).toEqual([]);

      freeSlot();
      await settle();
      expect(buildCtxs).toHaveLength(1);
      const [episode] = getDeployTracker().getEpisodes(appName);
      expect(episode.status).toBe('succeeded');
      expect(episode.deployId).toBe(buildCtxs[0].deployId);
      expectNothingHeld();
    });

    it('sets the breaker keys once the hold is consumed, and a refusal before that sets none', async () => {
      let slotHeld!: () => void;
      slotGate = new Promise<void>((resolve) => (slotHeld = resolve));
      const out = await p().redeployApp(appName, actor);
      expect(out).toEqual({ accepted: true });
      expect(p().breakerKeys.get(appName)).toEqual(p().guardrailKeys(appName, false, actor));
      slotHeld();
      await settle();

      (hasEnoughDisk as jest.Mock).mockResolvedValue({ ok: false, freeMb: 1 });
      const refused = await p().redeployApp(appName, actor);
      expect(refused.refused.code).toBe('INSUFFICIENT_DISK');
      expect(p().breakerKeys.has(appName)).toBe(false);
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

    it('a slot wait that throws surfaces when in time, with everything given back', async () => {
      p().builder.reserveSlot.mockRejectedValue(new Error('slot wait blew up'));
      await expect(p().redeployApp(appName, actor)).rejects.toThrow('slot wait blew up');
      expectNothingHeld();
      // And is recorded as a failed deploy the caller could follow.
      expect(getDeployTracker().getEpisodes(appName)[0].status).toBe('failed');
    });

    it('a slot wait that throws after the answer was accepted is logged, and recorded', async () => {
      let boom!: () => void;
      slotGate = new Promise<void>((resolve) => (boom = resolve));
      const failing = p().builder.reserveSlot;
      failing.mockImplementation(async () => {
        await slotGate;
        throw new Error('slot wait blew up');
      });
      const logged = jest.spyOn(p().logger, 'error').mockImplementation(() => undefined);
      const out = await p().redeployApp(appName, actor);
      expect(out).toEqual({ accepted: true });
      boom();
      await settle();
      for (let i = 0; i < 100 && logged.mock.calls.length === 0; i++) await tick();
      expect(logged).toHaveBeenCalledTimes(1);
      expect(getDeployTracker().getEpisodes(appName)[0].status).toBe('failed');
      expectNothingHeld();
    });
  });

  describe('redeployApp: a refusal after the wait', () => {
    const refusals: Array<[string, string, () => unknown]> = [
      ['quiesced', 'SERVICE_UNAVAILABLE', () => (reserveEffect = () => jest.spyOn(p(), 'isQuiesced').mockReturnValue(true))],
      ['busy', 'APP_BUSY', () => (reserveEffect = () => p().gitReserved.add(appName))],
      ['group-busy', 'APP_BUSY', () => (reserveEffect = () => jest.spyOn(p(), 'isGroupBusy').mockReturnValue(true))],
      ['gone', 'NOT_FOUND', () => (reserveEffect = () => (appState = undefined))],
      ['stopped', 'APP_STOPPED', () => (reserveEffect = () => (appState = { ...appState, status: 'stopped' }))],
      [
        'disk',
        'INSUFFICIENT_DISK',
        () =>
          (hasEnoughDisk as jest.Mock)
            .mockResolvedValueOnce({ ok: true, freeMb: 999999 })
            .mockResolvedValue({ ok: false, freeMb: 1 }),
      ],
      [
        'guardrail',
        'RATE_LIMITED',
        () => jest.spyOn(p(), 'checkGuardrails').mockReturnValue({ allowed: false, failures: 3, retryAfterSeconds: 9 }),
      ],
    ];

    it.each(refusals)('in time, a %s refusal is returned as %s and records no deploy', async (reason, code, setup) => {
      setup();
      const out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe(code);
      if (reason === 'guardrail') {
        expect(out.refused.retryAfterSeconds).toBe(9);
      }
      expect(p().builder.build).not.toHaveBeenCalled();
      expectNothingHeld();
      // The caller was answered, so there is no orphan failed deploy to follow -
      // except the guardrail refusal, which has always reported itself.
      expect(getDeployTracker().getEpisodes(appName)).toHaveLength(reason === 'guardrail' ? 1 : 0);
    });

    it.each(refusals)(
      'after an accepted answer, a %s refusal becomes a failed deploy with its own code, not charged',
      async (reason, _code, setup) => {
        let freeSlot!: () => void;
        slotGate = new Promise<void>((resolve) => (freeSlot = resolve));
        setup();
        const out = await p().redeployApp(appName, actor);
        expect(out).toEqual({ accepted: true });
        expect(getDeployTracker().getEpisodes(appName)).toEqual([]);

        freeSlot();
        await settle();

        const [episode] = getDeployTracker().getEpisodes(appName);
        expect(episode.status).toBe('failed');
        expect(episode.trigger).toBe('deploy');
        expect(getDeployTracker().getEpisodes(appName)).toHaveLength(1);
        expect(getDeployDetailStore().getDetail(episode.deployId)?.errorCode).toBe(
          reason === 'guardrail' ? 'GUARDRAIL_TRIPPED' : 'DEPLOY_REFUSED'
        );
        expect(p().builder.build).not.toHaveBeenCalled();
        expectNothingHeld();
        // A refusal is not a failed build.
        const [{ key }] = p().guardrailKeys(appName, false, actor);
        expect(getDeployBreaker().peek(key).failures).toBe(0);
      }
    );
  });

  describe('redeployApp: the admission is the last step', () => {
    it('comes after disk and the stopped rule, and a lost hold is found BEFORE it charges anything', async () => {
      const admit = jest.spyOn(breakerModule, 'admitDeploy');
      // The reservation is lost while the checks run (stop() clears the owner map).
      (hasEnoughDisk as jest.Mock).mockImplementation(async () => {
        p().holdOwners.clear();
        return { ok: true, freeMb: 999999 };
      });
      const out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('APP_BUSY');
      expect(admit).not.toHaveBeenCalled();
      expect(p().builder.reserveSlot).not.toHaveBeenCalled();
      expect(p().breakerKeys.has(appName)).toBe(false);
    });

    it('is called once the disk has passed, and not at all when the disk refuses', async () => {
      const admit = jest.spyOn(breakerModule, 'admitDeploy');
      await p().redeployApp(appName, actor);
      await settle();
      expect((hasEnoughDisk as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(admit.mock.invocationCallOrder[0]);
    });
  });

  describe('a container update does not rewrite a busy child', () => {
    const containerName = 'g-container';
    let containerPath: string;

    beforeEach(() => {
      containerPath = path.join(tempDir, 'apps', containerName);
      fs.mkdirSync(containerPath, { recursive: true });
      fs.writeFileSync(path.join(containerPath, 'drop.yaml'), 'services:\n  web:\n    path: web\n    type: static\n');
      const container = { name: containerName, group: 'g', isGroupContainer: true, status: 'running', path: containerPath };
      appState = { ...appState, group: 'g' };
      allApps = [container, appState];
      p().stateManager.getApp.mockImplementation((n: string) => allApps!.find((a: any) => a.name === n));
    });

    it('drops the re-expansion while a child redeploy holds its claim, then expands once it is free', async () => {
      const expand = jest.spyOn(p(), 'expandMonorepo').mockResolvedValue(undefined);
      let freeSlot!: () => void;
      slotGate = new Promise<void>((resolve) => (freeSlot = resolve));
      const out = await p().redeployApp(appName, actor);
      expect(out).toEqual({ accepted: true });

      const during = await p().handleAppUpdate(containerName, containerPath, 'upload deploy', true);
      expect(during).toBe(false);
      expect(expand).not.toHaveBeenCalled();

      freeSlot();
      await settle();
      await p().handleAppUpdate(containerName, containerPath, 'upload deploy', true);
      expect(expand).toHaveBeenCalledTimes(1);
    });
  });

  describe('redeployApp: the source folder', () => {
    it('a missing source folder is APP_SOURCE_MISSING (409), checked before the disk probe', async () => {
      fs.rmSync(appPath, { recursive: true, force: true });
      (hasEnoughDisk as jest.Mock).mockClear();
      const out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('APP_SOURCE_MISSING');
      expect(hasEnoughDisk).not.toHaveBeenCalled();
      expectNothingHeld();
    });

    it('a source that is a file, not a folder, is the same refusal', async () => {
      fs.rmSync(appPath, { recursive: true, force: true });
      fs.writeFileSync(appPath, 'not a folder');
      const out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('APP_SOURCE_MISSING');
      expectNothingHeld();
    });
  });

  describe('redeployApp: stopping and the quota store', () => {
    afterEach(() => {
      p().stopping = false;
    });

    it('a platform that began stopping during the slot wait refuses, releasing only the slot it took', async () => {
      const slotReleased = jest.fn();
      p().builder.reserveSlot.mockImplementation(async () => {
        p().stopping = true;
        return slotReleased;
      });
      p().holdOwners.set(appName, {});
      expect(await p().acquireSlotAndRecheck(appName, { appPath, statusAtEntry: 'running' })).toEqual({
        refused: 'stopping',
      });
      expect(slotReleased).toHaveBeenCalledTimes(1);
      expect(p().holdOwners.has(appName)).toBe(true); // not the stage's to clear
      p().holdOwners.clear();
    });

    it('through redeployApp, in time: SERVICE_UNAVAILABLE and nothing held', async () => {
      reserveEffect = () => (p().stopping = true);
      const out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('SERVICE_UNAVAILABLE');
      expect(p().builder.build).not.toHaveBeenCalled();
      expectNothingHeld();
    });

    it("loads the quota's store BEFORE checking the hold, so a hold lost meanwhile charges nothing", async () => {
      const admit = jest.spyOn(breakerModule, 'admitDeploy');
      const quota = getPrincipalQuota();
      jest.spyOn(quota, 'initialize').mockImplementation(async () => {
        p().holdOwners.clear(); // the reservation is lost while the store loads
      });
      const out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('APP_BUSY');
      expect(admit).not.toHaveBeenCalled();
      expect(p().builder.reserveSlot).not.toHaveBeenCalled();
    });
  });

  describe('a refusal or failure after acceptance gets its OWN episode', () => {
    /** A deploy left open the way a held or parked app's is: started, never closed. */
    const leaveOpen = () => eventBus.publish('build:started', { appId: appName, buildId: 'held-b', deployId: 'held-1' });
    const statuses = () =>
      Object.fromEntries(getDeployTracker().getEpisodes(appName).map((e) => [e.deployId, e.status]));

    it('a detached DEPLOY_REFUSED does not close the held episode in its place', async () => {
      leaveOpen();
      let freeSlot!: () => void;
      slotGate = new Promise<void>((resolve) => (freeSlot = resolve));
      reserveEffect = () => (appState = undefined);
      expect(await p().redeployApp(appName, actor)).toEqual({ accepted: true });
      freeSlot();
      await settle();

      const byId = statuses();
      expect(byId['held-1']).toBe('superseded');
      const own = getDeployTracker().getEpisodes(appName).find((e) => e.deployId !== 'held-1')!;
      expect(own.status).toBe('failed');
      expect(getDeployDetailStore().getDetail(own.deployId)?.errorCode).toBe('DEPLOY_REFUSED');
      expect(getDeployDetailStore().getDetail('held-1')).toBeUndefined();
    });

    it('the post-wait guardrail refusal gets its own episode too', async () => {
      leaveOpen();
      jest.spyOn(p(), 'checkGuardrails').mockReturnValue({ allowed: false, failures: 3, retryAfterSeconds: 9 });
      const out = await p().redeployApp(appName, actor);
      expect(out.refused.code).toBe('RATE_LIMITED');
      const byId = statuses();
      expect(byId['held-1']).toBe('superseded');
      expect(Object.values(byId).filter((st) => st === 'failed')).toHaveLength(1);
    });

    it('a slot wait that throws gets its own episode', async () => {
      leaveOpen();
      p().builder.reserveSlot.mockRejectedValue(new Error('slot wait blew up'));
      await expect(p().redeployApp(appName, actor)).rejects.toThrow('slot wait blew up');
      const byId = statuses();
      expect(byId['held-1']).toBe('superseded');
      expect(Object.values(byId).filter((st) => st === 'failed')).toHaveLength(1);
    });

    it('without newEpisode an open episode still takes the failure (the anonymous path is unchanged)', () => {
      leaveOpen();
      p().failDeployEpisode(appName, new Error('boom'), 'anon-1');
      expect(statuses()['held-1']).toBe('failed');
    });
  });

  describe('the monorepo group guards', () => {
    const containerName = 'g-container';
    let containerPath: string;

    beforeEach(() => {
      containerPath = path.join(tempDir, 'apps', containerName);
      fs.mkdirSync(containerPath, { recursive: true });
      fs.writeFileSync(path.join(containerPath, 'drop.yaml'), 'services:\n  web:\n    path: web\n    type: static\n');
      const container = { name: containerName, group: 'g', isGroupContainer: true, status: 'running', path: containerPath };
      appState = { ...appState, group: 'g' };
      allApps = [container, appState];
      p().stateManager.getApp.mockImplementation((n: string) => allApps!.find((a: any) => a.name === n));
    });

    it('an explicit update to a service is dropped while its container is busy, but the expansion\'s own call passes', async () => {
      p().appsInProgress.add(containerName);
      expect(await p().handleAppUpdate(appName, appPath, 'upload deploy', true)).toBe(false);
      expect(p().builder.reserveSlot).not.toHaveBeenCalled();

      // expandMonorepo holds the container's claim and updates each child with this reason.
      expect(await p().handleAppUpdate(appName, appPath, 'monorepo re-expansion', true)).toBe(true);
      expect(p().builder.build).toHaveBeenCalledTimes(1);
    });

    it('the watcher\'s interception does not expand a container while a service is busy', async () => {
      const expand = jest.spyOn(p(), 'expandMonorepo').mockResolvedValue(undefined);
      const payload = { name: containerName, path: containerPath, timestamp: new Date() };
      p().appsInProgress.add(appName); // a service is being redeployed
      await p().handleAppDetected(payload);
      expect(expand).not.toHaveBeenCalled();

      p().appsInProgress.delete(appName);
      await p().handleAppDetected(payload);
      expect(expand).toHaveBeenCalledTimes(1);
    });

    it('an explicit re-expansion dropped by the guard is recorded as a failed deploy', async () => {
      jest.spyOn(p(), 'expandMonorepo').mockResolvedValue(undefined);
      p().appsInProgress.add(appName);
      expect(await p().handleAppUpdate(containerName, containerPath, 'upload deploy', true)).toBe(false);
      const [episode] = getDeployTracker().getEpisodes(containerName);
      expect(episode.status).toBe('failed');
      expect(getDeployDetailStore().getDetail(episode.deployId)?.errorCode).toBe('DEPLOY_REFUSED');
    });
  });
});
