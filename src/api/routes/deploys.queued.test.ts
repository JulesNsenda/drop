/**
 * A deploy accepted but not yet building (#359), through the routes, against
 * the REAL deploy tracker.
 *
 * POST /apps/:name/redeploy answers with its id BEFORE the wait for a builder
 * slot. The tracker opens the episode under that id at `build:queued`
 * (`queued`), `build:started` continues it (`in-progress`), and a refusal
 * after the wait closes it. The routes add nothing of their own: the list, the
 * by-id stream and the `?since=` stream just follow the tracker, with the same
 * owner-snapshot tenant filter as ever - except that `?since=` follows the
 * deploy that STARTED, never one still waiting for its slot.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { eventBus } from '../../core/event-bus';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { getDeployTracker, resetDeployTracker } from '../../managers/deploy-tracker';

interface SseEvent {
  event: string;
  data: Record<string, any>;
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

describe('a queued deploy on the deploys routes (#359)', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let aliceId: string;
  let aliceToken: string;
  let bobToken: string;
  let unsub: () => void;

  const get = (url: string, token: string) => app.request(url, { headers: { Authorization: `Bearer ${token}` } });
  const queue = (id: string, appId = 'web') =>
    eventBus.publish('build:queued', { appId, buildId: 'b', deployId: id, trigger: 'deploy' });
  const start = (id: string, appId = 'web') =>
    eventBus.publish('build:started', { appId, buildId: 'b', deployId: id, trigger: 'deploy' });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-deploys-queued-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    resetAuth();
    resetStateManager();
    resetDeployTracker();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    const tracker = getDeployTracker(path.join(tempDir, 'deploys.json'));
    await tracker.initialize();
    unsub = tracker.subscribe(eventBus);

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

    const sm = getStateManager();
    await sm.registerApp('web', path.join(tempDir, 'web'));
    await sm.updateApp('web', { userId: aliceId });
  });

  afterEach(async () => {
    delete process.env.DROP_DEPLOY_STREAM_APPEAR_MS;
    delete process.env.DROP_DEPLOY_STREAM_RECHECK_MS;
    unsub();
    await getDeployTracker().flush();
    await server.stop();
    await getStateManager().close();
    resetStateManager();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('GET /deploys?app=', () => {
    it('lists the accepted deploy as queued, then building (not queued) once its build starts', async () => {
      queue('d1');
      let rows = ((await (await get('/api/v1/deploys?app=web', aliceToken)).json()) as any).data;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ deployId: 'd1', status: 'queued', trigger: 'deploy' });
      expect(rows[0].stages.map((s: any) => s.stage)).toEqual(['queued']);

      start('d1');
      rows = ((await (await get('/api/v1/deploys?app=web', aliceToken)).json()) as any).data;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ deployId: 'd1', status: 'in-progress' });
      expect(rows[0].stages.map((s: any) => s.stage)).toEqual(['queued', 'build-started']);
    });

    it('does not show a queued deploy to another tenant', async () => {
      queue('d1');
      const res = await get('/api/v1/deploys?app=web', bobToken);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /deploys/:deployId/stream', () => {
    it('follows an accepted id from queued, through building, to its end', async () => {
      queue('d1');
      const res = await get('/api/v1/deploys/d1/stream', aliceToken);
      expect(res.status).toBe(200);

      const events = await readAll(res, (e) => {
        if (e.event === 'episode' && e.data.status === 'queued') {
          start('d1');
        } else if (e.event === 'episode' && e.data.status === 'in-progress') {
          eventBus.publish('app:updated', { appId: 'web', changes: { status: 'running' } } as never);
        }
      });

      expect(events.filter((e) => e.event === 'episode').map((e) => e.data.status)).toEqual([
        'queued',
        'in-progress',
        'succeeded',
      ]);
      expect(events[events.length - 1]).toMatchObject({ event: 'end', data: { status: 'succeeded', deployId: 'd1' } });
    });

    it('ends as failed when a refusal after the wait closes the SAME id', async () => {
      queue('d1');
      const res = await get('/api/v1/deploys/d1/stream', aliceToken);
      const events = await readAll(res, (e) => {
        if (e.event === 'episode' && e.data.status === 'queued') {
          eventBus.publish('build:failed', {
            appId: 'web',
            buildId: 'b',
            error: new Error('declined'),
            deployId: 'd1',
            stage: 'pre-build',
            code: 'DEPLOY_REFUSED',
          });
        }
      });
      expect(events[events.length - 1]).toMatchObject({ event: 'end', data: { status: 'failed', deployId: 'd1' } });
    });

    it('answers someone else\'s queued id exactly like an unknown one', async () => {
      queue('d1');
      const foreign = await get('/api/v1/deploys/d1/stream', bobToken);
      const unknown = await get('/api/v1/deploys/never-issued/stream', bobToken);
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
    });
  });

  describe('GET /deploys/stream?app=&since= follows the deploy that STARTED', () => {
    it('does not pick up a queued-only episode', async () => {
      process.env.DROP_DEPLOY_STREAM_APPEAR_MS = '150';
      process.env.DROP_DEPLOY_STREAM_RECHECK_MS = '50';
      const since = new Date(Date.now() - 1000).toISOString();
      queue('d-queued');

      const res = await get(`/api/v1/deploys/stream?app=web&since=${encodeURIComponent(since)}`, aliceToken);
      const events = await readAll(res, () => undefined);

      expect(events.map((e) => e.event)).toEqual(['end']);
      expect(events[0].data).toEqual({ status: 'not-found' });
    });

    it('picks it up once it has built', async () => {
      process.env.DROP_DEPLOY_STREAM_APPEAR_MS = '2000';
      const since = new Date(Date.now() - 1000).toISOString();
      queue('d-queued');
      start('d-queued');
      eventBus.publish('app:updated', { appId: 'web', changes: { status: 'running' } } as never);

      const res = await get(`/api/v1/deploys/stream?app=web&since=${encodeURIComponent(since)}`, aliceToken);
      const events = await readAll(res, () => undefined);
      expect(events[events.length - 1]).toMatchObject({ event: 'end', data: { status: 'succeeded', deployId: 'd-queued' } });
    });
  });
});
