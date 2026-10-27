/**
 * A deploy that was accepted but has not started building (#359): POST
 * /apps/:name/redeploy answers with its id BEFORE the wait for a builder slot,
 * so for a while the id is real and the tracker has no episode for it.
 *
 * GET /deploys/:id answers `queued` instead of 404, and the by-id stream
 * announces `queued` and then keeps waiting until the episode appears - with
 * the same owner-snapshot tenant filter episodes use, so a foreign or unknown
 * id is still one indistinguishable 404.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { makePlatformOpsStub } from '../__testutils__/platform-ops';
import { setPlatformOps, resetPlatformOps, type QueuedDeploy } from '../platform-ops';
import { eventBus } from '../../core/event-bus';
import type { DeployEpisode } from '../../managers/deploy-tracker';

let episodes: DeployEpisode[] = [];
jest.mock('../../managers/deploy-tracker', () => ({
  getDeployTracker: () => ({
    getEpisodes: (appName?: string) => episodes.filter((e) => !appName || e.appName === appName),
  }),
}));
jest.mock('../../managers/app/state-manager', () => ({
  getStateManager: () => ({ getApp: () => undefined }),
}));

function mkEpisode(deployId: string, userId: string | undefined, status: DeployEpisode['status']): DeployEpisode {
  const startedAt = '2026-09-01T00:00:10.000Z';
  return {
    deployId,
    appName: 'web',
    userId,
    trigger: 'deploy',
    status,
    startedAt,
    stages: [{ stage: 'build-started', at: startedAt }],
  };
}

function nudge(): void {
  eventBus.publish('app:started', { appName: 'web' } as never);
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

async function readAll(res: Response, onEvent: (e: SseEvent) => void, limitMs = 5000): Promise<SseEvent[]> {
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
      const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? '{}');
      events.push({ event, data });
      onEvent({ event, data });
    }
  }
}

describe('queued deploys on the deploys routes (#359)', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let aliceId: string;
  let aliceToken: string;
  let bobToken: string;
  let queued: Map<string, QueuedDeploy>;

  const get = (url: string, token: string) => app.request(url, { headers: { Authorization: `Bearer ${token}` } });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-deploys-queued-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    resetAuth();
    resetPlatformOps();
    episodes = [];
    queued = new Map();
    setPlatformOps(makePlatformOpsStub({ getQueuedDeploy: (id: string) => queued.get(id) }));

    server = new ApiServer({
      port: 3197,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    aliceId = (await createUser({ username: 'alice', role: 'user', credential: { password: 'password123' } })).id;
    await createUser({ username: 'bob', role: 'user', credential: { password: 'password123' } });
    aliceToken = await getTestToken('alice', 'password123');
    bobToken = await getTestToken('bob', 'password123');
  });

  afterEach(async () => {
    resetPlatformOps();
    await server.stop();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('GET /deploys/:deployId', () => {
    it('answers queued, not 404, for an id that was accepted and has not started building', async () => {
      queued.set('q1', { appName: 'web', userId: aliceId });
      const res = await get('/api/v1/deploys/q1', aliceToken);
      expect(res.status).toBe(200);
      expect((await res.json()) as unknown).toEqual({
        success: true,
        data: { deployId: 'q1', appName: 'web', status: 'queued' },
      });
    });

    it('answers someone else\'s queued id exactly like an unknown one', async () => {
      queued.set('q1', { appName: 'web', userId: aliceId });
      const foreign = await get('/api/v1/deploys/q1', bobToken);
      const unknown = await get('/api/v1/deploys/never-issued', bobToken);
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(((await foreign.json()) as any).error.code).toBe(((await unknown.json()) as any).error.code);
    });

    it('is a 404 once the id is no longer queued', async () => {
      const res = await get('/api/v1/deploys/q1', aliceToken);
      expect(res.status).toBe(404);
    });

    it('is a 404 when the platform operations are not wired', async () => {
      queued.set('q1', { appName: 'web', userId: aliceId });
      resetPlatformOps();
      expect((await get('/api/v1/deploys/q1', aliceToken)).status).toBe(404);
    });
  });

  describe('GET /deploys/:deployId/stream', () => {
    it('refuses a foreign or unknown id with the same 404', async () => {
      queued.set('q1', { appName: 'web', userId: aliceId });
      expect((await get('/api/v1/deploys/q1/stream', bobToken)).status).toBe(404);
      expect((await get('/api/v1/deploys/never-issued/stream', aliceToken)).status).toBe(404);
    });

    it('announces queued, keeps waiting, then follows the real episode to its end', async () => {
      queued.set('q1', { appName: 'web', userId: aliceId });
      const res = await get('/api/v1/deploys/q1/stream', aliceToken);
      expect(res.status).toBe(200);

      const events = await readAll(res, (e) => {
        if (e.event === 'queued') {
          // The builder slot frees: the episode appears under the same id.
          episodes = [mkEpisode('q1', aliceId, 'in-progress')];
          queued.delete('q1');
          nudge();
        } else if (e.event === 'episode' && e.data.status === 'in-progress') {
          episodes = [mkEpisode('q1', aliceId, 'succeeded')];
          nudge();
        }
      });

      expect(events.map((e) => e.event)).toEqual(['queued', 'episode', 'episode', 'end']);
      expect(events[0].data).toEqual({ deployId: 'q1' });
      expect(events[3].data).toMatchObject({ status: 'succeeded', deployId: 'q1' });
    });

    it('a refusal after the wait ends the stream as failed under the same id', async () => {
      queued.set('q1', { appName: 'web', userId: aliceId });
      const res = await get('/api/v1/deploys/q1/stream', aliceToken);
      const events = await readAll(res, (e) => {
        if (e.event === 'queued') {
          episodes = [mkEpisode('q1', aliceId, 'failed')];
          queued.delete('q1');
          nudge();
        }
      });
      expect(events.map((e) => e.event)).toEqual(['queued', 'episode', 'end']);
      expect(events[2].data).toMatchObject({ status: 'failed', deployId: 'q1' });
    });
  });
});
