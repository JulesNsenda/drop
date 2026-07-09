/**
 * Authorization regression tests for POST /git/redeploy/:name.
 *
 * Covers the IDOR fix: redeploy was gated only by authMiddleware('user') with
 * no ownership check, so any authenticated user could redeploy any other
 * tenant's git-deployed app by name. Non-owner and nonexistent-app requests
 * must both come back as the same 404 (no existence oracle).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import * as gitDeployModule from '../../core/git-deploy';

describe('git redeploy route authorization', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let aliceToken: string;
  let bobToken: string;
  let adminToken: string;
  let aliceId: string;
  let redeploy: jest.Mock;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-git-redeploy-authz-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    redeploy = jest.fn().mockResolvedValue({ appName: 'alice-app', repoUrl: 'https://github.com/acme/app' });
    jest.spyOn(gitDeployModule, 'getGitDeployService').mockReturnValue({
      isAvailable: () => true,
      redeploy,
    } as unknown as ReturnType<typeof gitDeployModule.getGitDeployService>);

    resetStateManager();
    resetAuth();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    server = new ApiServer({
      port: 3096,
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

    const stateManager = getStateManager();
    await stateManager.registerApp('alice-app', path.join(tempDir, 'alice-app'));
    await stateManager.updateApp('alice-app', { userId: aliceId });

    // folder-dropped app: no userId
    await stateManager.registerApp('legacy-app', path.join(tempDir, 'legacy-app'));
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetAuth();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("non-owner cannot redeploy another user's app (IDOR) — 404, service not called", async () => {
    const res = await app.request('/api/v1/git/redeploy/alice-app', {
      method: 'POST',
      headers: bearer(bobToken),
    });
    expect(res.status).toBe(404);
    expect(redeploy).not.toHaveBeenCalled();
  });

  it('owner can redeploy their own app', async () => {
    const res = await app.request('/api/v1/git/redeploy/alice-app', {
      method: 'POST',
      headers: bearer(aliceToken),
    });
    expect(res.status).toBe(200);
    expect(redeploy).toHaveBeenCalledWith('alice-app');
  });

  it("admin can redeploy any user's app", async () => {
    const res = await app.request('/api/v1/git/redeploy/alice-app', {
      method: 'POST',
      headers: bearer(adminToken),
    });
    expect(res.status).toBe(200);
    expect(redeploy).toHaveBeenCalledWith('alice-app');
  });

  it('nonexistent app returns 404, service not called', async () => {
    const res = await app.request('/api/v1/git/redeploy/does-not-exist', {
      method: 'POST',
      headers: bearer(aliceToken),
    });
    expect(res.status).toBe(404);
    expect(redeploy).not.toHaveBeenCalled();
  });

  it('non-admin gets 404 for folder-dropped app with no userId', async () => {
    const res = await app.request('/api/v1/git/redeploy/legacy-app', {
      method: 'POST',
      headers: bearer(aliceToken),
    });
    expect(res.status).toBe(404);
    expect(redeploy).not.toHaveBeenCalled();
  });

  it('admin can redeploy folder-dropped app with no userId', async () => {
    const res = await app.request('/api/v1/git/redeploy/legacy-app', {
      method: 'POST',
      headers: bearer(adminToken),
    });
    expect(res.status).toBe(200);
    expect(redeploy).toHaveBeenCalledWith('legacy-app');
  });
});
