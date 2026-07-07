/**
 * Authorization regression tests for app-scoped routes (M1 security spine).
 *
 * Proves the IDOR fixes: a non-admin user cannot read or mutate another user's
 * app, the PUT field allowlist drops privileged fields, and /usage reports the
 * caller's own count.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from './../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import * as diskUtils from '../../utils/disk';

describe('app route authorization', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let aliceToken: string;
  let bobToken: string;
  let aliceId: string;
  let bobId: string;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-authz-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    // The POST /apps disk preflight shells out to the OS for free space (P2-5);
    // stub it so these auth tests don't couple to the runner's real free disk.
    jest.spyOn(diskUtils, 'hasEnoughDisk').mockResolvedValue({ ok: true, freeMb: 10000 });

    resetStateManager();
    resetAuth();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    server = new ApiServer({
      port: 3099,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    const alice = await createUser('alice', 'password123', 'user');
    const bob = await createUser('bob', 'password123', 'user');
    aliceId = alice.id;
    bobId = bob.id;
    aliceToken = await getTestToken('alice', 'password123');
    bobToken = await getTestToken('bob', 'password123');

    const sm = getStateManager();
    await sm.registerApp('alice-app', path.join(tempDir, 'alice-app'));
    await sm.updateApp('alice-app', { userId: aliceId });
  });

  afterEach(async () => {
    if (server) await server.stop();
    // Flush + cancel the debounced save before removing the temp dir, or a
    // late write races with rm (ENOTEMPTY).
    await getStateManager().close();
    resetStateManager();
    jest.restoreAllMocks();
    // recursive rm doesn't retry ENOTEMPTY by default; a lagging async write
    // (e.g. the auth credentials flush) can land mid-rm and lose the race on
    // CI. maxRetries makes cleanup robust to that without chasing every writer.
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("hides another user's app on GET (404)", async () => {
    const res = await app.request('/api/v1/apps/alice-app', { headers: authHeader(bobToken) });
    expect(res.status).toBe(404);
  });

  it("blocks PUT on another user's app (IDOR)", async () => {
    const res = await app.request('/api/v1/apps/alice-app', {
      method: 'PUT',
      headers: { ...authHeader(bobToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: bobId }),
    });
    expect(res.status).toBe(404);
    // Ownership must be unchanged.
    expect(getStateManager().getApp('alice-app')?.userId).toBe(aliceId);
  });

  it('ignores privileged fields on PUT by the owner (field allowlist)', async () => {
    const res = await app.request('/api/v1/apps/alice-app', {
      method: 'PUT',
      headers: { ...authHeader(aliceToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: bobId, path: '/etc', framework: 'express' }),
    });
    expect(res.status).toBe(200);
    const updated = getStateManager().getApp('alice-app');
    expect(updated?.userId).toBe(aliceId); // not reassigned
    expect(updated?.path).not.toBe('/etc'); // not redirected
    expect(updated?.framework).toBe('express'); // allowed field applied
  });

  it("blocks reading another user's logs (IDOR)", async () => {
    const res = await app.request('/api/v1/logs/alice-app', { headers: authHeader(bobToken) });
    expect(res.status).toBe(404);
  });

  it('reports the caller\'s own usage count', async () => {
    const res = await app.request('/api/v1/usage', { headers: authHeader(bobToken) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: { used: number } };
    expect(json.data.used).toBe(0); // bob owns no apps

    const aliceRes = await app.request('/api/v1/usage', { headers: authHeader(aliceToken) });
    const aliceJson = (await aliceRes.json()) as { data: { used: number } };
    expect(aliceJson.data.used).toBe(1); // alice owns one
  });

  it('rejects an invalid app name on POST /apps (P0-9)', async () => {
    await createUser('root', 'password123', 'admin');
    const adminToken = await getTestToken('root', 'password123');
    const dir = path.join(tempDir, 'validdir');
    await fs.mkdir(dir, { recursive: true });

    // Admin bypasses path containment, so we reach the name-validation step.
    const bad = await app.request('/api/v1/apps', {
      method: 'POST',
      headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir, name: 'bad name!!' }),
    });
    expect(bad.status).toBe(400);

    const ok = await app.request('/api/v1/apps', {
      method: 'POST',
      headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir, name: 'good-name' }),
    });
    expect(ok.status).toBe(201);
  });

  it('rejects POST /apps with 507 when disk is below the watermark (P2-5)', async () => {
    await createUser('root', 'password123', 'admin');
    const adminToken = await getTestToken('root', 'password123');
    const dir = path.join(tempDir, 'lowdiskdir');
    await fs.mkdir(dir, { recursive: true });
    (diskUtils.hasEnoughDisk as jest.Mock).mockResolvedValueOnce({ ok: false, freeMb: 10 });

    const res = await app.request('/api/v1/apps', {
      method: 'POST',
      headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir, name: 'low-disk-app' }),
    });
    expect(res.status).toBe(507);
  });
});
