/**
 * POST /apps/:name/redeploy end to end (#359 Item 2): the real route, the real
 * DropPlatform admission and start (with the post-build swap stubbed at its
 * private seams), and the REAL deploy tracker - so what the caller is told to
 * follow is actually followed.
 *
 *  - slot free: 202 with a deployId; following it yields that deploy's outcome;
 *  - slot held past the wait: 202 `accepted`; following it yields the outcome
 *    once the slot frees;
 *  - a refusal after the wait: the follow shows a failed deploy.
 *
 * Both follows are the app + since stream: the by-id stream 404s between the
 * mint and the build's first event.
 */

import * as path from 'path';
import * as fsp from 'fs/promises';
import * as fs from 'fs';
jest.mock('../../utils/disk', () => ({
  ...jest.requireActual('../../utils/disk'),
  hasEnoughDisk: jest.fn().mockResolvedValue({ ok: true, freeMb: 999999 }),
}));

import { createUser } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { createTestApiServer, teardownTestApiServer, type TestApiServer } from '../__testutils__/api-server';
import { makePlatformOpsStub } from '../__testutils__/platform-ops';
import { setPlatformOps, resetPlatformOps } from '../platform-ops';
import { createPlatform, type DropPlatform } from '../../core/platform';
import { loadEmptySuspensionStore } from '../../core/__testutils__/suspension';

// An unloaded suspension store fails closed; this test never starts the platform that loads it.
beforeEach(loadEmptySuspensionStore);
import { eventBus } from '../../core/event-bus';
import { getStateManager } from '../../managers/app/state-manager';
import { getDeployTracker, resetDeployTracker } from '../../managers/deploy-tracker';
import { getPrincipalQuota, resetPrincipalQuota } from '../../managers/guardrail/principal-quota';
import { resetDeployBreaker } from '../../managers/guardrail/deploy-breaker';

interface SseEvent {
  event: string;
  data: Record<string, any>;
}

async function readAll(res: Response, limitMs = 8000): Promise<SseEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buf = '';
  const deadline = Date.now() + limitMs;
  for (;;) {
    const next = await Promise.race([
      reader.read(),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), Math.max(0, deadline - Date.now()))),
    ]);
    if (next === 'timeout') {
      await reader.cancel();
      throw new Error(`stream did not close; saw ${JSON.stringify(events)}`);
    }
    if (next.done) return events;
    buf += decoder.decode(next.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (block.startsWith(':')) continue;
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
      events.push({ event, data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}') });
    }
  }
}

describe('POST /apps/:name/redeploy, followed', () => {
  let t: TestApiServer;
  let platform: DropPlatform;
  let token: string;
  let slotGate: Promise<void> | undefined;
  let afterSlot: (() => void) | undefined;
  let unsub: () => void;
  const appName = 'site';

  const p = () => platform as any;
  const post = () =>
    t.hono.request(`/api/v1/apps/${appName}/redeploy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
  const follow = (url: string) => t.hono.request(url, { headers: { Authorization: `Bearer ${token}` } });

  beforeEach(async () => {
    process.env.DROP_MIN_FREE_DISK_MB = '500';
    // A short wait, so "held past the wait" does not take ten seconds.
    process.env.DROP_REDEPLOY_START_WAIT_MS = '80';
    t = await createTestApiServer({ port: 3113, tempPrefix: 'drop-redeploy-integration-', activityLog: true });
    resetDeployTracker();
    resetDeployBreaker();
    resetPrincipalQuota();
    getPrincipalQuota(path.join(t.tempDir, 'principal-quotas.json'));
    slotGate = undefined;
    afterSlot = undefined;

    const owner = await createUser({ username: 'owner', role: 'user', credential: { password: 'password123' } });
    token = await getTestToken('owner', 'password123');
    const appPath = path.join(t.tempDir, 'apps', appName);
    fs.mkdirSync(appPath, { recursive: true });
    const sm = getStateManager();
    await sm.registerApp(appName, appPath);
    await sm.updateApp(appName, { userId: owner.id, status: 'running', port: 3005 });

    const tracker = getDeployTracker(path.join(t.tempDir, 'deploys.json'));
    await tracker.initialize();
    unsub = tracker.subscribe(eventBus);

    platform = createPlatform({
      dropRoot: t.tempDir,
      appsDirectory: path.join(t.tempDir, 'apps'),
      logLevel: 'error',
      isolation: 'none',
    });
    p().toolchainBackfilled = true;
    p().stateManager = sm;
    p().builder = {
      reserveSlot: jest.fn(async () => {
        await slotGate;
        afterSlot?.();
        return () => undefined;
      }),
      build: jest.fn(async (ctx: { deployId?: string }) => {
        eventBus.publish('build:started', { appId: appName, buildId: 'b', deployId: ctx.deployId, trigger: 'deploy' });
        return { success: true, duration: 5, outputPath: null };
      }),
    };
    p().runtime = {
      type: 'pm2',
      stop: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      getStatus: jest.fn().mockResolvedValue(null),
      start: jest.fn().mockResolvedValue({ pid: 4242 }),
    };
    p().detector = { detect: jest.fn().mockResolvedValue({ type: 'rust', framework: null, suggestedConfig: {} }) };
    p().buildLogService = {
      startBuild: jest.fn().mockResolvedValue('log-1'),
      writeLine: jest.fn(),
      finishBuild: jest.fn().mockResolvedValue(undefined),
    };
    p().appConfigService = {
      updateConfig: jest.fn().mockResolvedValue(undefined),
      getConfig: jest.fn().mockReturnValue(undefined),
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

    setPlatformOps(
      makePlatformOpsStub({
        redeployApp: (name, actor, options) => p().redeployApp(name, actor, options),
        isGroupBusy: (name: string) => p().isGroupBusy(name),
      })
    );
  });

  afterEach(async () => {
    delete process.env.DROP_MIN_FREE_DISK_MB;
    delete process.env.DROP_REDEPLOY_START_WAIT_MS;
    resetPlatformOps();
    resetPrincipalQuota();
    unsub();
    await getDeployTracker().flush();
    jest.restoreAllMocks();
    await teardownTestApiServer(t);
    await fsp.rm(t.tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  });

  it('slot free: 202 with a deployId, and following it yields that deploy outcome', async () => {
    const res = await post();
    expect(res.status).toBe(202);
    const json = (await res.json()) as any;
    expect(json.data.deployId).toMatch(/^[0-9a-f-]{36}$/);
    expect(json.data.accepted).toBeUndefined();

    const events = await readAll(await follow(json.data.follow));
    const end = events[events.length - 1];
    expect(end).toMatchObject({ event: 'end', data: { status: 'succeeded', deployId: json.data.deployId } });
  });

  it('slot held past the wait: 202 accepted, and following it yields the outcome once the slot frees', async () => {
    let freeSlot!: () => void;
    slotGate = new Promise<void>((resolve) => (freeSlot = resolve));

    const res = await post();
    expect(res.status).toBe(202);
    const json = (await res.json()) as any;
    expect(json.data.accepted).toBe(true);
    expect(json.data.deployId).toBeUndefined();

    const following = readAll(await follow(json.data.follow));
    setTimeout(freeSlot, 100);
    const events = await following;
    const end = events[events.length - 1];
    expect(end).toMatchObject({ event: 'end', data: { status: 'succeeded' } });
    expect(p().builder.build).toHaveBeenCalledTimes(1);
  });

  it('an app held for promotion (its episode left open): the refusal gets its OWN failed episode on the follow', async () => {
    // The held deploy: started, built, never closed (nothing is serving it yet).
    eventBus.publish('build:started', { appId: appName, buildId: 'held-b', deployId: 'held-1' });
    await getStateManager().updateApp(appName, { awaitingPromotion: true });

    let freeSlot!: () => void;
    slotGate = new Promise<void>((resolve) => (freeSlot = resolve));
    afterSlot = () => jest.spyOn(p(), 'isQuiesced').mockReturnValue(true);

    const res = await post();
    const json = (await res.json()) as any;
    expect(json.data.accepted).toBe(true);

    const following = readAll(await follow(json.data.follow));
    setTimeout(freeSlot, 100);
    const events = await following;

    const end = events[events.length - 1];
    expect(end).toMatchObject({ event: 'end', data: { status: 'failed' } });
    expect(end.data.deployId).not.toBe('held-1');
    // The held episode was superseded, not marked failed in the refusal's place.
    const held = getDeployTracker().getEpisodes(appName).find((e) => e.deployId === 'held-1')!;
    expect(held.status).toBe('superseded');
  });

  it('a refusal after the wait shows up as a failed deploy on the follow', async () => {
    let freeSlot!: () => void;
    slotGate = new Promise<void>((resolve) => (freeSlot = resolve));
    afterSlot = () => jest.spyOn(p(), 'isQuiesced').mockReturnValue(true); // paused for a backup meanwhile

    const res = await post();
    const json = (await res.json()) as any;
    expect(json.data.accepted).toBe(true);

    const following = readAll(await follow(json.data.follow));
    setTimeout(freeSlot, 100);
    const events = await following;
    expect(events[events.length - 1]).toMatchObject({ event: 'end', data: { status: 'failed' } });
    expect(p().builder.build).not.toHaveBeenCalled();
  });
});
