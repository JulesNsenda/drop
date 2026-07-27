/**
 * POST /apps/:name/promote.
 *
 * The gate exists to require a HUMAN decision. If an agent could promote its
 * own build, manual promotion would be a formality — so this checks the
 * credential KIND, not only the role: an agent token carries a role, and a
 * scope carries an app.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, resetAuth, createApiKey } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import * as platformOps from '../platform-ops';

describe('POST /apps/:name/promote', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let aliceToken: string;
  let bobToken: string;
  let adminToken: string;
  let aliceId: string;
  let promoteApp: jest.Mock;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-promote-route-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    promoteApp = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(platformOps, 'getPlatformOps').mockReturnValue({
      restartApp: jest.fn(),
      isAppInProgress: () => false,
      promoteApp,
    } as unknown as ReturnType<typeof platformOps.getPlatformOps>);

    resetStateManager();
    resetAuth();
    const stateManager = getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    await stateManager.initialize();

    server = new ApiServer({
      port: 3099,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    const alice = await createUser('alice', 'password123', 'user');
    await createUser('bob', 'password123', 'user');
    await createUser('sysadmin', 'password123', 'admin');
    aliceId = alice.id;
    aliceToken = await getTestToken('alice', 'password123');
    bobToken = await getTestToken('bob', 'password123');
    adminToken = await getTestToken('sysadmin', 'password123');

    await stateManager.registerApp('alice-app', path.join(tempDir, 'alice-app'), 'nodejs');
    await stateManager.updateApp('alice-app', { userId: aliceId } as Record<string, unknown>);
  });

  afterEach(async () => {
    if (server) await server.stop();
    jest.restoreAllMocks();
    resetStateManager();
    resetAuth();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const promote = (name: string, headers: Record<string, string>) =>
    app.request(`/api/v1/apps/${name}/promote`, { method: 'POST', headers });

  it('lets the owner promote', async () => {
    const res = await promote('alice-app', bearer(aliceToken));

    expect(res.status).toBe(200);
    expect(promoteApp).toHaveBeenCalledWith('alice-app');
  });

  it('lets an admin promote', async () => {
    const res = await promote('alice-app', bearer(adminToken));

    expect(res.status).toBe(200);
  });

  it('refuses another tenant with 404, not 403 — no existence oracle', async () => {
    const res = await promote('alice-app', bearer(bobToken));

    expect(res.status).toBe(404);
    expect(promoteApp).not.toHaveBeenCalled();
  });

  it('REFUSES AN AGENT CREDENTIAL, even one that owns the app', async () => {
    // The load-bearing assertion. An agent token carries its owner's identity,
    // so ownership and role checks alone would let it through — and manual
    // promotion would gate nothing at all for the caller it exists to gate.
    const key = await createApiKey('agent-key', 'user', undefined, undefined, aliceId, {
      kind: 'agent',
    });

    const res = await promote('alice-app', { 'X-API-Key': key.key });

    expect(res.status).toBe(403);
    expect(promoteApp).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await promote('alice-app', {});

    expect(res.status).toBe(401);
    expect(promoteApp).not.toHaveBeenCalled();
  });

  it('404s an app that does not exist', async () => {
    const res = await promote('no-such-app', bearer(aliceToken));

    expect(res.status).toBe(404);
  });

  it('reports 400 when nothing is held, rather than a generic failure', async () => {
    promoteApp.mockRejectedValue(new Error("No build is awaiting promotion for 'alice-app'"));

    const res = await promote('alice-app', bearer(aliceToken));

    expect(res.status).toBe(400);
  });
});
