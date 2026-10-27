/**
 * End-to-end authorization tests for stored git tokens, through the routes and
 * the REAL service (only the pull itself is spied on).
 *
 * A stored token is bound to the user who added it: list returns only the
 * caller's own (an admin sees all), delete and "use" (a tokenId on deploy or
 * redeploy) are owner-or-admin, and a token that is not the caller's answers
 * exactly like an unknown id, so the response is not an existence oracle. A
 * legacy token with no owner is admin-only until an admin assigns one. A
 * token an app already has attached keeps working for that app -- unless the
 * app has changed hands and an admin did not hand the credential over.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, createApiKey, resetAuth } from '../middleware/auth';
import { tokenCallerOf } from '../access';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { resetSecretManager, getSecretManager } from '../../managers/secret';
import { resetRateLimits } from '../middleware/rate-limit';
import { resetAppConfigService, getAppConfigService } from '../../managers/app/app-config';
import { getPrincipalQuota, resetPrincipalQuota } from '../../managers/guardrail/principal-quota';
import { resetDeployBreaker } from '../../managers/guardrail/deploy-breaker';
import { GitDeployService, getGitDeployService, resetGitDeployService } from '../../core/git-deploy';
import { setPlatformOps, resetPlatformOps } from '../platform-ops';
import { makePlatformOpsStub } from '../__testutils__/platform-ops';

jest.setTimeout(30000);

describe('git token routes authorization', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let aliceToken: string;
  let bobToken: string;
  let adminToken: string;
  let aliceId: string;
  let bobId: string;
  let adminId: string;
  // The clone-and-land step is where a token is handed to git; spying on it
  // records which token each deploy or redeploy actually used.
  let pull: jest.SpyInstance;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const json = (token: string) => ({ ...bearer(token), 'Content-Type': 'application/json' });
  const pulledWith = () => pull.mock.calls.map((c) => c[3]);

  async function addToken(token: string, name: string): Promise<string> {
    const res = await app.request('/api/v1/git/tokens', {
      method: 'POST',
      headers: json(token),
      body: JSON.stringify({ name, token: `ghp_${name}` }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as any).data.id as string;
  }

  async function listIds(token: string): Promise<string[]> {
    const res = await app.request('/api/v1/git/tokens', { headers: bearer(token) });
    expect(res.status).toBe(200);
    return (((await res.json()) as any).data as Array<{ id: string }>).map((t) => t.id);
  }

  function redeploy(token: string, name: string, body?: object) {
    return app.request(`/api/v1/git/redeploy/${name}`, {
      method: 'POST',
      headers: json(token),
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  /** A git-deployed app owned by `ownerId`, with a real `.git` dir so redeploy proceeds. */
  async function gitApp(name: string, ownerId: string, tokenId?: string): Promise<void> {
    const dir = path.join(tempDir, 'webapps', name);
    await fs.mkdir(path.join(dir, '.git'), { recursive: true });
    const sm = getStateManager();
    await sm.registerApp(name, dir);
    await sm.updateApp(name, {
      userId: ownerId,
      gitSource: { repoUrl: `https://github.com/acme/${name}`, branch: 'main', autoRedeploy: true, tokenId },
    } as Record<string, unknown>);
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-git-token-authz-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    pull = jest
      .spyOn(GitDeployService.prototype as unknown as { cloneAndLand: (...a: unknown[]) => Promise<string> }, 'cloneAndLand')
      .mockImplementation(async (...args: unknown[]) => {
        await fs.mkdir(args[4] as string, { recursive: true });
        return 'abc123def456';
      });
    setPlatformOps(makePlatformOpsStub({ tryReserveApp: () => () => undefined }));

    resetDeployBreaker();
    resetPrincipalQuota();
    getPrincipalQuota(path.join(tempDir, 'principal-quotas.json'));

    resetSecretManager();
    await getSecretManager({ storePath: path.join(tempDir, 'secrets.json') }).initialize();

    resetStateManager();
    resetAuth();
    resetRateLimits();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    resetAppConfigService();
    await getAppConfigService({
      configDir: path.join(tempDir, 'appconf'),
      webappsDir: path.join(tempDir, 'webapps'),
    }).initialize();

    resetGitDeployService();
    await fs.mkdir(path.join(tempDir, 'webapps'), { recursive: true });
    await getGitDeployService({ appsDirectory: path.join(tempDir, 'webapps') }).initialize();

    server = new ApiServer({
      port: 3097,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    aliceId = (await createUser({ username: 'alice', role: 'user', credential: { password: 'password123' } })).id;
    bobId = (await createUser({ username: 'bob', role: 'user', credential: { password: 'password123' } })).id;
    adminId = (await createUser({ username: 'sysadmin', role: 'admin', credential: { password: 'password123' } })).id;
    aliceToken = await getTestToken('alice', 'password123');
    bobToken = await getTestToken('bob', 'password123');
    adminToken = await getTestToken('sysadmin', 'password123');
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetAuth();
    resetSecretManager();
    resetGitDeployService();
    resetPlatformOps();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('listing and deleting', () => {
    it("list returns only the caller's own tokens; an admin sees every token with its owner", async () => {
      const a = await addToken(aliceToken, 'alice-pat');
      const b = await addToken(bobToken, 'bob-pat');

      expect(await listIds(aliceToken)).toEqual([a]);
      expect(await listIds(bobToken)).toEqual([b]);
      expect((await listIds(adminToken)).sort()).toEqual([a, b].sort());

      const res = await app.request('/api/v1/git/tokens', { headers: bearer(adminToken) });
      const rows = ((await res.json()) as any).data as Array<{ id: string; ownerUserId?: string }>;
      expect(rows.find((r) => r.id === a)?.ownerUserId).toBe(aliceId);
      expect((rows.find((r) => r.id === a) as any).ownerName).toBe('alice');
      const aliceRes = await app.request('/api/v1/git/tokens', { headers: bearer(aliceToken) });
      expect(((await aliceRes.json()) as any).data[0].ownerUserId).toBeUndefined();
    });

    it("delete of another user's token answers the same 404 as an unknown id, and the token survives", async () => {
      const b = await addToken(bobToken, 'bob-pat');

      const foreign = await app.request(`/api/v1/git/tokens/${b}`, { method: 'DELETE', headers: bearer(aliceToken) });
      const unknown = await app.request('/api/v1/git/tokens/git_doesnotexist', {
        method: 'DELETE',
        headers: bearer(aliceToken),
      });
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      const norm = (v: any, id: string) => ({ code: v.error.code, message: v.error.message.replace(id, '<id>') });
      expect(norm(await foreign.json(), b)).toEqual(norm(await unknown.json(), 'git_doesnotexist'));
      expect(await listIds(bobToken)).toEqual([b]);
    });

    it('owner and admin can delete', async () => {
      const a = await addToken(aliceToken, 'alice-pat');
      const b = await addToken(bobToken, 'bob-pat');

      const own = await app.request(`/api/v1/git/tokens/${a}`, { method: 'DELETE', headers: bearer(aliceToken) });
      const admin = await app.request(`/api/v1/git/tokens/${b}`, { method: 'DELETE', headers: bearer(adminToken) });
      expect(own.status).toBe(200);
      expect(admin.status).toBe(200);
      expect(await listIds(adminToken)).toEqual([]);
    });

    it('a legacy ownerless token is admin-only to list and delete', async () => {
      const legacy = await getGitDeployService().setToken('legacy-pat', 'ghp_legacy');

      expect(await listIds(aliceToken)).toEqual([]);
      const denied = await app.request(`/api/v1/git/tokens/${legacy.id}`, { method: 'DELETE', headers: bearer(aliceToken) });
      expect(denied.status).toBe(404);
      expect(await listIds(adminToken)).toEqual([legacy.id]);
      const ok = await app.request(`/api/v1/git/tokens/${legacy.id}`, { method: 'DELETE', headers: bearer(adminToken) });
      expect(ok.status).toBe(200);
    });

    it('an API key cannot store or delete a token, even its owner\'s', async () => {
      const a = await addToken(aliceToken, 'alice-pat');
      const { key } = await createApiKey('ci', 'user', undefined, undefined, aliceId);

      const create = await app.request('/api/v1/git/tokens', {
        method: 'POST',
        headers: json(key),
        body: JSON.stringify({ name: 'x', token: 'ghp_x' }),
      });
      const del = await app.request(`/api/v1/git/tokens/${a}`, { method: 'DELETE', headers: bearer(key) });
      expect(create.status).toBe(403);
      expect(del.status).toBe(403);
      expect(await listIds(aliceToken)).toEqual([a]);
    });
  });

  describe('using a token', () => {
    it("Alice redeploying with Bob's token is a 400 shaped like an unknown id, and nothing is attached", async () => {
      const b = await addToken(bobToken, 'bob-pat');
      await gitApp('alice-app', aliceId);

      const foreign = await redeploy(aliceToken, 'alice-app', { tokenId: b });
      const unknown = await redeploy(aliceToken, 'alice-app', { tokenId: 'git_doesnotexist' });

      expect(foreign.status).toBe(400);
      expect(unknown.status).toBe(400);
      const norm = (v: any, id: string) => ({ code: v.error.code, message: v.error.message.replace(id, '<id>') });
      expect(norm(await foreign.json(), b)).toEqual(norm(await unknown.json(), 'git_doesnotexist'));
      expect(getStateManager().getApp('alice-app')?.gitSource?.tokenId).toBeUndefined();
      expect(pull).not.toHaveBeenCalled();
    });

    it("Alice deploying with Bob's token is the same 400; a malformed tokenId is a 400 too", async () => {
      const b = await addToken(bobToken, 'bob-pat');

      const foreign = await app.request('/api/v1/git/deploy', {
        method: 'POST',
        headers: json(aliceToken),
        body: JSON.stringify({ repoUrl: 'https://github.com/acme/fresh', tokenId: b }),
      });
      const malformed = await app.request('/api/v1/git/deploy', {
        method: 'POST',
        headers: json(aliceToken),
        body: JSON.stringify({ repoUrl: 'https://github.com/acme/fresh', tokenId: 'git_x:y' }),
      });
      expect(foreign.status).toBe(400);
      expect(malformed.status).toBe(400);
      expect(getStateManager().getApp('fresh')).toBeUndefined();
    });

    it('the owner can attach their own token and it is used', async () => {
      const a = await addToken(aliceToken, 'alice-pat');
      await gitApp('alice-app', aliceId);

      expect((await redeploy(aliceToken, 'alice-app', { tokenId: a })).status).toBe(200);
      expect(getStateManager().getApp('alice-app')?.gitSource?.tokenId).toBe(a);
      expect(pulledWith()).toEqual(['ghp_alice-pat']);
    });

    it('a legacy token cannot be newly attached by a user, but an app already attached to one still redeploys', async () => {
      const legacy = await getGitDeployService().setToken('legacy-pat', 'ghp_legacyvalue');
      await gitApp('plain-app', aliceId);
      await gitApp('attached-app', aliceId, legacy.id);

      expect((await redeploy(aliceToken, 'plain-app', { tokenId: legacy.id })).status).toBe(400);
      expect((await redeploy(aliceToken, 'attached-app')).status).toBe(200);
      // Naming the id it already has is not a new choice.
      expect((await redeploy(aliceToken, 'attached-app', { tokenId: legacy.id })).status).toBe(200);
      expect(pulledWith()).toEqual(['ghp_legacyvalue', 'ghp_legacyvalue']);
    });

    it('a transferred app does not carry the previous owner\'s credential along', async () => {
      const a = await addToken(aliceToken, 'alice-pat');
      await gitApp('moved-app', aliceId, a);
      await getStateManager().updateApp('moved-app', { userId: bobId } as Record<string, unknown>);

      expect((await redeploy(bobToken, 'moved-app')).status).toBe(200);
      expect(pulledWith()).toEqual([undefined]);
      // Naming the attached id does not smuggle it back in: same answer.
      expect((await redeploy(bobToken, 'moved-app', { tokenId: a })).status).toBe(400);
    });

    it('an admin grant is recorded, honoured by the owner afterwards, and gone once the credential is cleared', async () => {
      const b = await addToken(bobToken, 'bob-pat');
      await gitApp('alice-app', aliceId);

      expect((await redeploy(adminToken, 'alice-app', { tokenId: b })).status).toBe(200);
      expect(getStateManager().getApp('alice-app')?.gitSource?.tokenGrantedBy).toBe(adminId);

      expect((await redeploy(aliceToken, 'alice-app')).status).toBe(200);
      expect(pulledWith()).toEqual(['ghp_bob-pat', 'ghp_bob-pat']);

      expect((await redeploy(adminToken, 'alice-app', { tokenId: null })).status).toBe(200);
      expect(getStateManager().getApp('alice-app')?.gitSource?.tokenGrantedBy).toBeUndefined();
    });

    it('an admin API key may use only its own tokens, not another user\'s', async () => {
      const b = await addToken(bobToken, 'bob-pat');
      await gitApp('alice-app', aliceId);
      const { key } = await createApiKey('ci-admin', 'admin', undefined, undefined, adminId);

      expect((await redeploy(key, 'alice-app', { tokenId: b })).status).toBe(400);
      // A signed-in admin session still can.
      expect((await redeploy(adminToken, 'alice-app', { tokenId: b })).status).toBe(200);
    });

    it('null and "" for tokenId on deploy mean no token, not a 400', async () => {
      for (const [i, tokenId] of [null, ''].entries()) {
        const res = await app.request('/api/v1/git/deploy', {
          method: 'POST',
          headers: json(aliceToken),
          body: JSON.stringify({ repoUrl: `https://github.com/acme/none${i}`, name: `none${i}`, tokenId }),
        });
        expect(res.status).toBe(201);
      }
    });

    it('the grant fields are visible to admins only', async () => {
      const b = await addToken(bobToken, 'bob-pat');
      await gitApp('alice-app', aliceId);
      expect((await redeploy(adminToken, 'alice-app', { tokenId: b })).status).toBe(200);

      const asAdmin = (await (await app.request('/api/v1/apps/alice-app', { headers: bearer(adminToken) })).json()) as any;
      const asOwner = (await (await app.request('/api/v1/apps/alice-app', { headers: bearer(aliceToken) })).json()) as any;
      expect(asAdmin.data.gitSource.tokenGrantedBy).toBe(adminId);
      expect(asAdmin.data.gitSource.tokenGrantedFor).toBe(aliceId);
      expect(asOwner.data.gitSource.tokenGrantedBy).toBeUndefined();
      expect(asOwner.data.gitSource.tokenGrantedFor).toBeUndefined();
    });

    it('assigning an owner with cross-owner apps is a 409 naming them, and writes nothing', async () => {
      const legacy = await getGitDeployService().setToken('legacy-pat', 'ghp_legacyvalue');
      await gitApp('bobs-app', bobId, legacy.id);

      const res = await app.request(`/api/v1/git/tokens/${legacy.id}/owner`, {
        method: 'PUT',
        headers: json(adminToken),
        body: JSON.stringify({ userId: aliceId }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as any).apps).toEqual(['bobs-app']);
      expect(getStateManager().getApp('bobs-app')?.gitSource?.tokenGrantedBy).toBeUndefined();
      expect(await listIds(aliceToken)).toEqual([]);
    });

    it('keepAttached grants the named app only; the response lists who was kept and who will fail', async () => {
      const legacy = await getGitDeployService().setToken('legacy-pat', 'ghp_legacyvalue');
      await gitApp('bobs-app', bobId, legacy.id);
      await gitApp('carols-app', aliceId, legacy.id);
      await gitApp('dropped-app', bobId, legacy.id);

      const res = await app.request(`/api/v1/git/tokens/${legacy.id}/owner`, {
        method: 'PUT',
        headers: json(adminToken),
        body: JSON.stringify({ userId: aliceId, keepAttached: ['bobs-app'] }),
      });
      expect(res.status).toBe(200);
      const data = ((await res.json()) as any).data;
      expect(data.keptAttached).toEqual(['bobs-app']);
      expect(data.willFail).toEqual(['dropped-app']);
      expect(getStateManager().getApp('bobs-app')?.gitSource?.tokenGrantedBy).toBe(adminId);

      expect((await redeploy(bobToken, 'bobs-app')).status).toBe(200);
      expect((await redeploy(bobToken, 'dropped-app')).status).toBe(200);
      expect(pulledWith()).toEqual(['ghp_legacyvalue', undefined]);
    });

    it('an app left out of keepAttached loses a grant it already held', async () => {
      const legacy = await getGitDeployService().setToken('legacy-pat', 'ghp_legacyvalue');
      await gitApp('bobs-app', bobId, legacy.id);
      const assign = (keepAttached: string[]) =>
        app.request(`/api/v1/git/tokens/${legacy.id}/owner`, {
          method: 'PUT',
          headers: json(adminToken),
          body: JSON.stringify({ userId: aliceId, keepAttached }),
        });

      expect((await assign(['bobs-app'])).status).toBe(200);
      expect(getStateManager().getApp('bobs-app')?.gitSource?.tokenGrantedBy).toBe(adminId);

      const res = await assign([]);
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).data.willFail).toEqual(['bobs-app']);
      expect(getStateManager().getApp('bobs-app')?.gitSource?.tokenGrantedBy).toBeUndefined();
      expect(getStateManager().getApp('bobs-app')?.gitSource?.tokenGrantedFor).toBeUndefined();

      expect((await redeploy(bobToken, 'bobs-app')).status).toBe(200);
      expect(pulledWith()).toEqual([undefined]);
    });

    it('keepAttached must be an array of names', async () => {
      const legacy = await getGitDeployService().setToken('legacy-pat', 'ghp_legacyvalue');
      const res = await app.request(`/api/v1/git/tokens/${legacy.id}/owner`, {
        method: 'PUT',
        headers: json(adminToken),
        body: JSON.stringify({ userId: aliceId, keepAttached: 'bobs-app' }),
      });
      expect(res.status).toBe(400);
    });

    it('a webhook redeploy of an app with an attached token still uses it', async () => {
      const a = await addToken(aliceToken, 'alice-pat');
      await gitApp('hook-app', aliceId, a);

      await getGitDeployService().redeploy('hook-app', { automation: 'webhook' }, null);
      expect(pulledWith()).toEqual(['ghp_alice-pat']);
    });
  });

  describe('assigning an owner to a legacy token', () => {
    it('an admin can; the new owner then sees and can use it', async () => {
      const legacy = await getGitDeployService().setToken('legacy-pat', 'ghp_legacyvalue');
      await gitApp('alice-app', aliceId);

      const res = await app.request(`/api/v1/git/tokens/${legacy.id}/owner`, {
        method: 'PUT',
        headers: json(adminToken),
        body: JSON.stringify({ userId: aliceId }),
      });
      expect(res.status).toBe(200);
      expect(await listIds(aliceToken)).toEqual([legacy.id]);
      expect((await redeploy(aliceToken, 'alice-app', { tokenId: legacy.id })).status).toBe(200);
    });

    it('a non-admin cannot, an unknown user or token is a 404', async () => {
      const legacy = await getGitDeployService().setToken('legacy-pat', 'ghp_legacyvalue');
      const put = (token: string, id: string, userId: string) =>
        app.request(`/api/v1/git/tokens/${id}/owner`, {
          method: 'PUT',
          headers: json(token),
          body: JSON.stringify({ userId }),
        });

      expect((await put(aliceToken, legacy.id, aliceId)).status).toBe(403);
      expect((await put(adminToken, legacy.id, 'no-such-user')).status).toBe(404);
      expect((await put(adminToken, 'git_doesnotexist', aliceId)).status).toBe(404);
      expect(await listIds(aliceToken)).toEqual([]);
    });
  });

  describe('account deletion', () => {
    it("removes the tokens the account owned and leaves everyone else's", async () => {
      await addToken(aliceToken, 'alice-pat');
      const b = await addToken(bobToken, 'bob-pat');

      const res = await app.request('/api/v1/auth/account', {
        method: 'DELETE',
        headers: json(aliceToken),
        body: JSON.stringify({ password: 'password123' }),
      });
      expect(res.status).toBe(200);
      expect(await listIds(adminToken)).toEqual([b]);
    });
  });

  describe('the caller identity', () => {
    it('is admin only for an admin credential; with auth enabled, no context is refused', () => {
      expect(tokenCallerOf({ userId: 'u', role: 'admin', authMethod: 'apikey' } as any)).toEqual({ admin: true, userId: 'u', interactive: false });
      expect(tokenCallerOf({ userId: 'u', role: 'user' } as any)).toEqual({ admin: false, userId: 'u' });
      expect(tokenCallerOf(undefined)).toBeUndefined();
    });

    it('with auth disabled by configuration, no context is the operator (admin)', async () => {
      await server.stop();
      resetAuth();
      expect(tokenCallerOf(undefined)).toEqual({ admin: true, interactive: true });

      resetRateLimits();
      server = new ApiServer({ port: 3098, enableAuth: false });
      await server.initialize();
      app = server.getApp();

      const create = await app.request('/api/v1/git/tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'open', token: 'ghp_open' }),
      });
      expect(create.status).toBe(201);
      const id = ((await create.json()) as any).data.id as string;
      const list = await app.request('/api/v1/git/tokens');
      expect(((await list.json()) as any).data.map((t: any) => t.id)).toEqual([id]);
      const del = await app.request(`/api/v1/git/tokens/${id}`, { method: 'DELETE' });
      expect(del.status).toBe(200);
    });
  });
});
