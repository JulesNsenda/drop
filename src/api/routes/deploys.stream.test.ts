/**
 * Deploy status streaming (#299): GET /deploys/:deployId/stream and
 * GET /deploys/stream?app=&since=.
 *
 * What matters: a client can watch one deploy to a terminal status without
 * polling; the stream closes ITSELF and releases its EventBus subscription on
 * every exit path; and ownership is the owner-snapshot rule GET /deploys uses,
 * with no way to tell a missing deploy or app from someone else's.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { eventBus } from '../../core/event-bus';
import type { DeployEpisode } from '../../managers/deploy-tracker';

let episodes: DeployEpisode[] = [];
jest.mock('../../managers/deploy-tracker', () => ({
  getDeployTracker: () => ({
    getEpisodes: (appName?: string) =>
      episodes.filter((e) => !appName || e.appName === appName),
  }),
}));

const liveApps = new Map<string, { userId?: string; status?: string; updatedAt: string; awaitingPromotion?: boolean }>();
jest.mock('../../managers/app/state-manager', () => ({
  getStateManager: () => ({ getApp: (name: string) => liveApps.get(name) }),
}));

function mkEpisode(
  deployId: string,
  userId: string | undefined,
  status: DeployEpisode['status'],
  startedAt = '2026-09-01T00:00:10.000Z'
): DeployEpisode {
  return {
    deployId,
    appName: 'web',
    userId,
    trigger: 'upload',
    status,
    startedAt,
    stages: [{ stage: 'build-started', at: startedAt }],
  };
}

/** Any event wakes the stream; the payload is irrelevant to it. */
function nudge(): void {
  eventBus.publish('app:started', { appName: 'web' } as never);
}

const globalHandlerCount = (): number =>
  (eventBus as unknown as { globalHandlers: Set<unknown> }).globalHandlers.size;

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Read SSE events until the stream ends (or `limitMs` passes — a test failure). */
async function readAll(res: Response, onEvent?: (e: SseEvent) => void, limitMs = 5000): Promise<SseEvent[]> {
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
      const e = { event, data };
      events.push(e);
      onEvent?.(e);
    }
  }
}

describe('deploy status streaming (#299)', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let aliceId: string;
  let aliceToken: string;
  let bobToken: string;
  let baseline: number;

  const get = (url: string, token: string, signal?: AbortSignal) =>
    app.request(url, { headers: { Authorization: `Bearer ${token}` }, signal });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-deploys-stream-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    resetAuth();
    episodes = [];
    liveApps.clear();

    server = new ApiServer({
      port: 3196,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    aliceId = (await createUser('alice', 'password123', 'user')).id;
    await createUser('bob', 'password123', 'user');
    aliceToken = await getTestToken('alice', 'password123');
    bobToken = await getTestToken('bob', 'password123');
    baseline = globalHandlerCount();
  });

  afterEach(async () => {
    delete process.env.DROP_DEPLOY_STREAM_APPEAR_MS;
    delete process.env.DROP_DEPLOY_STREAM_RECHECK_MS;
    await server.stop();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('GET /deploys/:deployId/stream', () => {
    it('answers a foreign deploy exactly like a missing one', async () => {
      episodes = [mkEpisode('d1', aliceId, 'in-progress')];

      const foreign = await get('/api/v1/deploys/d1/stream', bobToken);
      const missing = await get('/api/v1/deploys/nope/stream', bobToken);

      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(((await foreign.json()) as { error: { message: string } }).error.message).toBe(
        "No deploy found for 'd1'"
      );
    });

    it('streams each transition to a terminal status, then closes itself', async () => {
      const ep = mkEpisode('d1', aliceId, 'in-progress');
      episodes = [ep];
      const res = await get('/api/v1/deploys/d1/stream', aliceToken);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');

      const events = await readAll(res, (e) => {
        if (e.event !== 'episode') return;
        // Drive the deploy forward only after each transition is observed.
        if (e.data.status === 'in-progress' && (e.data.stages as unknown[]).length === 1) {
          ep.stages = [...ep.stages, { stage: 'build', at: '2026-09-01T00:00:20.000Z', ok: true }];
          nudge();
        } else if ((e.data.stages as unknown[]).length === 2 && e.data.status === 'in-progress') {
          ep.status = 'succeeded';
          ep.stages = [...ep.stages, { stage: 'running', at: '2026-09-01T00:00:25.000Z' }];
          nudge();
        }
      });

      expect(events.map((e) => [e.event, e.data.status])).toEqual([
        ['episode', 'in-progress'],
        ['episode', 'in-progress'],
        ['episode', 'succeeded'],
        ['end', 'succeeded'],
      ]);
      // The owner snapshot never reaches the client.
      expect(JSON.stringify(events)).not.toContain(aliceId);
      expect(globalHandlerCount()).toBe(baseline);
    });

    it('ends at once for a deploy that is already terminal', async () => {
      episodes = [mkEpisode('d1', aliceId, 'failed')];

      const events = await readAll(await get('/api/v1/deploys/d1/stream', aliceToken));

      expect(events.map((e) => e.event)).toEqual(['episode', 'end']);
      expect(events[1].data).toEqual({ status: 'failed', deployId: 'd1' });
      expect(globalHandlerCount()).toBe(baseline);
    });

    it('ends on a park, which never reaches a terminal deploy status', async () => {
      episodes = [mkEpisode('d1', aliceId, 'in-progress')];
      liveApps.set('web', { userId: aliceId, status: 'needs-config', updatedAt: '2026-09-01T00:00:30.000Z' });

      const events = await readAll(await get('/api/v1/deploys/d1/stream', aliceToken));

      expect(events.at(-1)?.data.status).toBe('needs-config');
    });

    it('releases its subscription when the client disconnects', async () => {
      episodes = [mkEpisode('d1', aliceId, 'in-progress')];
      const ac = new AbortController();
      const res = await get('/api/v1/deploys/d1/stream', aliceToken, ac.signal);
      const reader = res.body!.getReader();
      await reader.read(); // the first episode event
      expect(globalHandlerCount()).toBe(baseline + 1);

      ac.abort();
      await reader.cancel().catch(() => undefined);
      await new Promise((r) => setImmediate(r));

      expect(globalHandlerCount()).toBe(baseline);
    });
  });

  describe('GET /deploys/stream?app=&since=', () => {
    it('rejects a bad app name or a missing since', async () => {
      expect((await get('/api/v1/deploys/stream?app=../x&since=2026-09-01T00:00:00Z', aliceToken)).status).toBe(400);
      expect((await get('/api/v1/deploys/stream?app=web', aliceToken)).status).toBe(400);
      expect((await get('/api/v1/deploys/stream?app=web&since=yesterday', aliceToken)).status).toBe(400);
    });

    it('follows the deploy that started after `since`, ignoring an older one', async () => {
      episodes = [
        mkEpisode('new', aliceId, 'succeeded', '2026-09-01T00:00:10.000Z'),
        mkEpisode('old', aliceId, 'failed', '2026-09-01T00:00:01.000Z'),
      ];

      const events = await readAll(
        await get('/api/v1/deploys/stream?app=web&since=2026-09-01T00:00:05.000Z', aliceToken)
      );

      expect(events.at(-1)?.data).toEqual({ status: 'succeeded', deployId: 'new' });
      expect(JSON.stringify(events)).not.toContain('"old"');
    });

    it('waits for an episode that appears after the stream opens', async () => {
      const res = await get('/api/v1/deploys/stream?app=web&since=2026-09-01T00:00:05.000Z', aliceToken);
      setTimeout(() => {
        episodes = [mkEpisode('d9', aliceId, 'succeeded')];
        nudge();
      }, 20);

      const events = await readAll(res);

      expect(events.at(-1)?.data).toEqual({ status: 'succeeded', deployId: 'd9' });
    });

    it("never shows someone else's deploy: it looks exactly like no deploy at all", async () => {
      process.env.DROP_DEPLOY_STREAM_APPEAR_MS = '50';
      process.env.DROP_DEPLOY_STREAM_RECHECK_MS = '20';
      episodes = [mkEpisode('d1', aliceId, 'in-progress')];
      liveApps.set('web', { userId: aliceId, updatedAt: '2026-09-01T00:00:00.000Z' });

      const foreign = await readAll(
        await get('/api/v1/deploys/stream?app=web&since=2026-09-01T00:00:05.000Z', bobToken)
      );
      const missing = await readAll(
        await get('/api/v1/deploys/stream?app=nothing&since=2026-09-01T00:00:05.000Z', bobToken)
      );

      expect(foreign).toEqual([{ event: 'end', data: { status: 'not-found' } }]);
      expect(missing).toEqual(foreign);
      expect(globalHandlerCount()).toBe(baseline);
    });
  });
});
