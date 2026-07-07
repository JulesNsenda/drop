/**
 * Authorization + contract tests for GET /api/v1/deploys (P2-4).
 *
 * Proves the tenant filter is applied to the episode's owner SNAPSHOT
 * (`userId` captured at build:started), never to a live app lookup; that
 * `userId` never leaks into the response DTO; and that ?app= for a missing
 * or unowned app returns 404 (not an empty 200) so app names can't be
 * enumerated by a non-owner.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import type { DeployEpisode } from '../../managers/deploy-tracker';

// --- Mock DeployTracker: the route only needs getEpisodes(appName?, limit?). ---
const mockGetEpisodes = jest.fn<DeployEpisode[], [string | undefined, number | undefined]>();
jest.mock('../../managers/deploy-tracker', () => ({
  getDeployTracker: () => ({ getEpisodes: mockGetEpisodes }),
}));

// --- Mock the state manager's live-app lookup used only for 404 discipline. ---
// (routes/auth.ts's signup path also imports getStateManager, but signup is
// never exercised here, so overriding just getApp is sufficient.)
const liveApps = new Map<string, { userId?: string }>();
jest.mock('../../managers/app/state-manager', () => ({
  getStateManager: () => ({
    getApp: (name: string) => liveApps.get(name),
  }),
}));

function mkEpisode(appName: string, userId: string | undefined, deployId: string): DeployEpisode {
  return {
    deployId,
    appName,
    userId,
    trigger: 'deploy',
    status: 'succeeded',
    startedAt: '2026-07-06T00:00:00.000Z',
    endedAt: '2026-07-06T00:00:05.000Z',
    durationMs: 5000,
    stages: [
      { stage: 'triggered', at: '2026-07-06T00:00:00.000Z' },
      { stage: 'build-started', at: '2026-07-06T00:00:01.000Z', durationMs: 1000 },
      { stage: 'build', at: '2026-07-06T00:00:03.000Z', durationMs: 2000, ok: true },
      { stage: 'running', at: '2026-07-06T00:00:05.000Z', durationMs: 2000 },
    ],
  };
}

describe('GET /api/v1/deploys authorization (P2-4)', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let aliceId: string;
  let bobId: string;
  let aliceToken: string;
  let bobToken: string;
  let adminToken: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-deploys-authz-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetAuth();
    mockGetEpisodes.mockReset();
    liveApps.clear();

    server = new ApiServer({
      port: 3095,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    const alice = await createUser('alice', 'password123', 'readonly');
    const bob = await createUser('bob', 'password123', 'user');
    await createUser('root', 'password123', 'admin');
    aliceId = alice.id;
    bobId = bob.id;
    aliceToken = await getTestToken('alice', 'password123');
    bobToken = await getTestToken('bob', 'password123');
    adminToken = await getTestToken('root', 'password123');

    // Mixed-ownership fixtures: alice's episode, bob's episode, and a
    // legacy/unowned one (userId undefined — e.g. a folder-dropped app).
    const episodes = [
      mkEpisode('alice-app', aliceId, 'deploy-alice-1'),
      mkEpisode('bob-app', bobId, 'deploy-bob-1'),
      mkEpisode('legacy-app', undefined, 'deploy-legacy-1'),
    ];
    mockGetEpisodes.mockImplementation((appName?: string, limit?: number) => {
      let list = episodes;
      if (appName) list = list.filter((e) => e.appName === appName);
      return typeof limit === 'number' ? list.slice(0, limit) : list;
    });

    liveApps.set('alice-app', { userId: aliceId });
    liveApps.set('bob-app', { userId: bobId });
    // 'alice-empty-app' exists (owned by alice) but has no deploy episodes yet.
    liveApps.set('alice-empty-app', { userId: aliceId });
    // 'legacy-app' intentionally NOT registered live (simulates a purged app —
    // the route must still tenant-filter on the row snapshot, not a live
    // lookup, so this case is exercised via the unfiltered list below).
  });

  afterEach(async () => {
    if (server) await server.stop();
    resetAuth();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('(a) a readonly user sees only episodes whose owner snapshot matches them', async () => {
    const res = await app.request('/api/v1/deploys', { headers: bearer(aliceToken) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ appName: string }> };
    expect(json.data.map((e) => e.appName)).toEqual(['alice-app']);
  });

  it('(b) an admin sees all episodes regardless of owner', async () => {
    const res = await app.request('/api/v1/deploys', { headers: bearer(adminToken) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ appName: string }> };
    expect(json.data.map((e) => e.appName).sort()).toEqual(['alice-app', 'bob-app', 'legacy-app']);
  });

  it('(c) userId is absent from every response object (owner snapshot never leaks)', async () => {
    const res = await app.request('/api/v1/deploys', { headers: bearer(adminToken) });
    const json = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(json.data.length).toBeGreaterThan(0);
    for (const episode of json.data) {
      expect(episode).not.toHaveProperty('userId');
    }
  });

  it("(d) ?app=<name> for another tenant's app returns 404, not an empty 200", async () => {
    const res = await app.request('/api/v1/deploys?app=bob-app', { headers: bearer(aliceToken) });
    expect(res.status).toBe(404);
  });

  it('(d) ?app=<name> for a nonexistent app returns 404, not an empty 200', async () => {
    const res = await app.request('/api/v1/deploys?app=no-such-app', { headers: bearer(aliceToken) });
    expect(res.status).toBe(404);
  });

  it('(e) an owner of an app with no deploys yet gets 200 []', async () => {
    const res = await app.request('/api/v1/deploys?app=alice-empty-app', { headers: bearer(aliceToken) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: unknown[] };
    expect(json.data).toEqual([]);
  });

  it('the owner can fetch their own app deploy history by name', async () => {
    const res = await app.request('/api/v1/deploys?app=alice-app', { headers: bearer(aliceToken) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ appName: string }> };
    expect(json.data.map((e) => e.appName)).toEqual(['alice-app']);
  });

  it("a 'user'-role owner (bob) sees only their own episode too", async () => {
    const res = await app.request('/api/v1/deploys', { headers: bearer(bobToken) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ appName: string }> };
    expect(json.data.map((e) => e.appName)).toEqual(['bob-app']);
  });
});
