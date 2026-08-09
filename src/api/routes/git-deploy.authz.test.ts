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
  let deploy: jest.Mock;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-git-redeploy-authz-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    redeploy = jest.fn().mockResolvedValue({ appName: 'alice-app', repoUrl: 'https://github.com/acme/app' });
    deploy = jest.fn().mockResolvedValue({ appName: 'fresh-app', repoUrl: 'https://github.com/acme/app' });
    jest.spyOn(gitDeployModule, 'getGitDeployService').mockReturnValue({
      isAvailable: () => true,
      redeploy,
      deploy,
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
    expect(redeploy).toHaveBeenCalledWith('alice-app', expect.anything());
  });

  it("admin can redeploy any user's app", async () => {
    const res = await app.request('/api/v1/git/redeploy/alice-app', {
      method: 'POST',
      headers: bearer(adminToken),
    });
    expect(res.status).toBe(200);
    expect(redeploy).toHaveBeenCalledWith('alice-app', expect.anything());
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
    expect(redeploy).toHaveBeenCalledWith('legacy-app', expect.anything());
  });

  describe('monorepo group child resolution', () => {
    // A monorepo deploy registers a hidden container (carries the gitSource)
    // plus visible children (carry only the `group` tag, no gitSource). Redeploy
    // on a child must resolve to the container so the whole group re-pulls.
    beforeEach(async () => {
      const sm = getStateManager();
      // Alice's git-backed group: container `grp-repo` + child `grp-backend`.
      await sm.registerApp('grp-repo', path.join(tempDir, 'grp-repo'));
      await sm.updateApp('grp-repo', {
        userId: aliceId,
        group: 'grp',
        isGroupContainer: true,
        gitSource: {
          repoUrl: 'https://github.com/acme/grp',
          branch: 'main',
          autoRedeploy: true,
        },
      });
      await sm.registerApp('grp-backend', path.join(tempDir, 'grp-backend'));
      await sm.updateApp('grp-backend', { userId: aliceId, group: 'grp' });
    });

    it('owner redeploying a group child resolves to the container', async () => {
      const res = await app.request('/api/v1/git/redeploy/grp-backend', {
        method: 'POST',
        headers: bearer(aliceToken),
      });
      expect(res.status).toBe(200);
      // Resolved to the container, not the child (child has no gitSource).
      expect(redeploy).toHaveBeenCalledWith('grp-repo', expect.anything());
    });

    it('admin redeploying a group child resolves to the container', async () => {
      const res = await app.request('/api/v1/git/redeploy/grp-backend', {
        method: 'POST',
        headers: bearer(adminToken),
      });
      expect(res.status).toBe(200);
      expect(redeploy).toHaveBeenCalledWith('grp-repo', expect.anything());
    });

    it("crafted group collision cannot redeploy another tenant's container (IDOR)", async () => {
      // Bob owns a child whose `group` tag collides with Alice's group name.
      // He can reach his own child, but the resolved container is Alice's — the
      // recheck on the resolved container must block it. Same 404 as any miss.
      const sm = getStateManager();
      const bobId = (await createUser('mallory', 'password123', 'user')).id;
      const malloryToken = await getTestToken('mallory', 'password123');
      await sm.registerApp('evil-backend', path.join(tempDir, 'evil-backend'));
      await sm.updateApp('evil-backend', { userId: bobId, group: 'grp' });

      const res = await app.request('/api/v1/git/redeploy/evil-backend', {
        method: 'POST',
        headers: bearer(malloryToken),
      });
      expect(res.status).toBe(404);
      expect(redeploy).not.toHaveBeenCalled();
    });
  });

  describe('redeploy tokenId attach (DROP-142)', () => {
    // POST /redeploy/:name has never taken a body before this — every current
    // caller (the dashboard's redeploy button, every test above) sends none,
    // so an unguarded c.req.json() would 500 them all.
    it('a request with no body at all still redeploys (regression: no 500 on empty body)', async () => {
      const res = await app.request('/api/v1/git/redeploy/alice-app', {
        method: 'POST',
        headers: bearer(aliceToken),
      });
      expect(res.status).toBe(200);
      expect(redeploy).toHaveBeenCalledWith('alice-app', expect.objectContaining({ tokenId: undefined }));
    });

    it('a tokenId in the body is forwarded to the resolved app', async () => {
      const res = await app.request('/api/v1/git/redeploy/alice-app', {
        method: 'POST',
        headers: { ...bearer(aliceToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenId: 'git_abc123' }),
      });
      expect(res.status).toBe(200);
      expect(redeploy).toHaveBeenCalledWith('alice-app', expect.objectContaining({ tokenId: 'git_abc123' }));
    });

    it('tokenId: null is forwarded as-is to clear the stored token', async () => {
      const res = await app.request('/api/v1/git/redeploy/alice-app', {
        method: 'POST',
        headers: { ...bearer(aliceToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenId: null }),
      });
      expect(res.status).toBe(200);
      expect(redeploy).toHaveBeenCalledWith('alice-app', expect.objectContaining({ tokenId: null }));
    });

    it('a malformed tokenId 400s and never reaches the service', async () => {
      const res = await app.request('/api/v1/git/redeploy/alice-app', {
        method: 'POST',
        headers: { ...bearer(aliceToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenId: 'DROP TABLE apps' }),
      });
      expect(res.status).toBe(400);
      expect(redeploy).not.toHaveBeenCalled();
    });

    it('a non-string, non-null tokenId 400s and never reaches the service', async () => {
      const res = await app.request('/api/v1/git/redeploy/alice-app', {
        method: 'POST',
        headers: { ...bearer(aliceToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenId: 12345 }),
      });
      expect(res.status).toBe(400);
      expect(redeploy).not.toHaveBeenCalled();
    });

    it('other body keys are ignored', async () => {
      const res = await app.request('/api/v1/git/redeploy/alice-app', {
        method: 'POST',
        headers: { ...bearer(aliceToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenId: 'git_abc123', role: 'admin', userId: 'someone-else' }),
      });
      expect(res.status).toBe(200);
      expect(redeploy).toHaveBeenCalledWith(
        'alice-app',
        expect.objectContaining({ tokenId: 'git_abc123', userId: aliceId })
      );
    });

    describe('monorepo group child resolution', () => {
      beforeEach(async () => {
        const sm = getStateManager();
        await sm.registerApp('tok-grp-repo', path.join(tempDir, 'tok-grp-repo'));
        await sm.updateApp('tok-grp-repo', {
          userId: aliceId,
          group: 'tok-grp',
          isGroupContainer: true,
          gitSource: {
            repoUrl: 'https://github.com/acme/tok-grp',
            branch: 'main',
            autoRedeploy: true,
          },
        });
        await sm.registerApp('tok-grp-backend', path.join(tempDir, 'tok-grp-backend'));
        await sm.updateApp('tok-grp-backend', { userId: aliceId, group: 'tok-grp' });
      });

      it('a tokenId attached while redeploying a group CHILD is forwarded to the CONTAINER, not the child', async () => {
        const res = await app.request('/api/v1/git/redeploy/tok-grp-backend', {
          method: 'POST',
          headers: { ...bearer(aliceToken), 'Content-Type': 'application/json' },
          body: JSON.stringify({ tokenId: 'git_abc123' }),
        });
        expect(res.status).toBe(200);
        expect(redeploy).toHaveBeenCalledWith(
          'tok-grp-repo',
          expect.objectContaining({ tokenId: 'git_abc123' })
        );
      });
    });
  });

  describe('caller identity is never read from the request body', () => {
    // POST /git/deploy parses the client body AS GitDeployRequest, and that
    // type carries the two identity fields. A caller that can name its own
    // principalId picks a fresh, empty guardrail bucket on every request —
    // which defeats the deploy breaker completely — and one that can name its
    // own userId assigns ownership of the app it is creating.

    it('overwrites a forged principalId with the authenticated caller', async () => {
      const res = await app.request('/api/v1/git/deploy', {
        method: 'POST',
        headers: { ...bearer(aliceToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl: 'https://github.com/acme/app',
          principalId: 'oauth:victim::fresh-and-empty',
        }),
      });

      expect(res.status).toBe(201);
      expect(deploy).toHaveBeenCalledTimes(1);
      const sent = deploy.mock.calls[0][0];
      expect(sent.principalId).not.toBe('oauth:victim::fresh-and-empty');
      expect(sent.principalId).toBe(`jwt:${aliceId}`);
    });

    it('overwrites a forged userId with the authenticated caller', async () => {
      const res = await app.request('/api/v1/git/deploy', {
        method: 'POST',
        headers: { ...bearer(aliceToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoUrl: 'https://github.com/acme/app',
          userId: 'some-other-user',
        }),
      });

      expect(res.status).toBe(201);
      expect(deploy.mock.calls[0][0].userId).toBe(aliceId);
    });
  });
});
