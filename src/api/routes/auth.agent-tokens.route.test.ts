/**
 * POST /auth/agent-tokens — minting a scope-only token.
 *
 * The load-bearing property is that a requester can only grant authority they
 * already hold. Without that, the endpoint is a privilege-escalation primitive:
 * any authenticated user mints `app:<someone-elses-app>:deploy` for themselves.
 *
 * Own file: a second route-test describe block in one file hangs the Jest
 * worker.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';

describe('POST /api/v1/auth/agent-tokens', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let aliceId: string;
  let aliceToken: string;
  let bobToken: string;
  let adminToken: string;

  const bearer = (t: string) => ({ Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' });

  const mint = (token: string, body: unknown) =>
    app.request('/api/v1/auth/agent-tokens', {
      method: 'POST',
      headers: bearer(token),
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-agent-tokens-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetStateManager();
    resetAuth();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    server = new ApiServer({
      port: 3093,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    const alice = await createUser('alice', 'password123', 'user');
    await createUser('bob', 'password123', 'user');
    await createUser('root', 'password123', 'admin');
    aliceId = alice.id;
    aliceToken = await getTestToken('alice', 'password123');
    bobToken = await getTestToken('bob', 'password123');
    adminToken = await getTestToken('root', 'password123');

    const sm = getStateManager();
    await sm.registerApp('aliceapp', path.join(tempDir, 'aliceapp'), 'nodejs');
    await sm.updateApp('aliceapp', { userId: aliceId });
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetAuth();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('mints a scope-only token for an app the requester owns', async () => {
    const res = await mint(aliceToken, {
      name: 'deploy-bot',
      scopes: ['app:aliceapp:deploy'],
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      data: { key: string; scopes: string[]; expiresAt: string };
    };
    expect(body.data.key).toMatch(/^drop_/);
    expect(body.data.scopes).toEqual(['app:aliceapp:deploy']);
    expect(body.data.expiresAt).toEqual(expect.any(String));
  });

  it("REFUSES to grant another tenant's app", async () => {
    // The escalation this endpoint would otherwise be. Bob owns nothing named
    // aliceapp, so he must not be able to mint authority over it.
    const res = await mint(bobToken, {
      name: 'sneaky',
      scopes: ['app:aliceapp:deploy'],
    });

    expect(res.status).toBe(400);
  });

  it('refuses the WHOLE request when one app is not the requester\'s', async () => {
    // All-or-nothing. Dropping the bad one silently would return a token that
    // looks like it was granted what was asked for.
    await getStateManager().registerApp('bobapp', path.join(tempDir, 'bobapp'), 'nodejs');
    const res = await mint(aliceToken, {
      name: 'mixed',
      scopes: ['app:aliceapp:deploy', 'app:bobapp:deploy'],
    });

    expect(res.status).toBe(400);
  });

  it('refuses an app name that does not exist', async () => {
    // You cannot pre-grant against a name you do not hold — that would be a
    // way to stake a claim on one.
    const res = await mint(aliceToken, {
      name: 'future',
      scopes: ['app:not-yet-created:deploy'],
    });

    expect(res.status).toBe(400);
  });

  it('lets an admin grant any app', async () => {
    const res = await mint(adminToken, {
      name: 'admin-bot',
      scopes: ['app:aliceapp:deploy'],
    });

    expect(res.status).toBe(201);
  });

  it('allows apps:create, which names no app', async () => {
    const res = await mint(bobToken, { name: 'creator', scopes: ['apps:create'] });

    expect(res.status).toBe(201);
  });

  it('rejects a malformed scope', async () => {
    for (const scopes of [['admin'], ['app:aliceapp:sudo'], ['app:*:deploy'], ['*'], []]) {
      expect((await mint(aliceToken, { name: 'bad', scopes })).status).toBe(400);
    }
  });

  it('bounds the expiry, and expresses it in MINUTES', async () => {
    // A credential handed to an autonomous caller should outlive its task by
    // minutes. createApiKey only offered days, which is the difference between
    // a bounded credential and a standing one.
    const res = await mint(aliceToken, {
      name: 'short',
      scopes: ['app:aliceapp:read'],
      expiresInMinutes: 5,
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { expiresAt: string } };
    const lifeMs = Date.parse(body.data.expiresAt) - Date.now();
    expect(lifeMs).toBeGreaterThan(0);
    expect(lifeMs).toBeLessThanOrEqual(6 * 60 * 1000);
  });

  it('rejects an absurd or invalid expiry', async () => {
    for (const expiresInMinutes of [0, -1, 1.5, 60 * 24 * 400]) {
      const res = await mint(aliceToken, {
        name: 'bad-expiry',
        scopes: ['app:aliceapp:read'],
        expiresInMinutes,
      });
      expect(res.status).toBe(400);
    }
  });

  it('requires a name', async () => {
    expect((await mint(aliceToken, { scopes: ['app:aliceapp:read'] })).status).toBe(400);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await app.request('/api/v1/auth/agent-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', scopes: ['app:aliceapp:read'] }),
    });

    expect(res.status).toBe(401);
  });
});
