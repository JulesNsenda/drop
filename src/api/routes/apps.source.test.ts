/**
 * POST /apps/:name/source — upload-deploy route (PRD-039).
 *
 * Mirrors the mocking style of git-deploy.authz.test.ts / apps.restart.test.ts:
 * getUploadDeployService and platform-ops are mocked so these tests exercise
 * the route's own guards (ownership/no-existence-oracle, stopped-app 409,
 * per-user app limit, in-progress 409, per-user upload concurrency 429,
 * missing-body 400, the streamed byte cap 413, and service-error mapping)
 * without touching real tar extraction or the filesystem landing logic
 * (covered by upload-deploy.test.ts / tar-extract.test.ts).
 */

import { getAppConfigService, resetAppConfigService } from '../../managers/app/app-config';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { setPlatformOps, resetPlatformOps, PlatformOps } from '../platform-ops';
import { AppSuspendedError } from '../platform-ops';
import { getSuspensionStore } from '../../managers/suspension';
import { makePlatformOpsStub } from '../__testutils__/platform-ops';
import * as diskUtils from '../../utils/disk';
import * as runtimeConfigModule from '../runtime-config';
import * as uploadDeployModule from '../../core/upload-deploy';
import { ArchiveRejectedError } from '../../core/upload-deploy';
import * as activity from '../../managers/activity';
import { resetRateLimits } from '../middleware/rate-limit';

type DeployMock = jest.Mock;

function makeOps(overrides?: Partial<PlatformOps>): PlatformOps {
  return makePlatformOpsStub(overrides);
}

import { loadEmptySuspensionStore } from '../../core/__testutils__/suspension';

// An unloaded suspension store fails closed; these tests never start the platform that loads it.
beforeEach(loadEmptySuspensionStore);

describe('POST /apps/:name/source (upload deploy)', () => {
  let tempDir: string;
  let uploadTempDir: string;
  let server: ApiServer;
  let hono: ReturnType<ApiServer['getApp']>;
  let aliceToken: string;
  let bobToken: string;
  let adminToken: string;
  let aliceId: string;
  let deployMock: DeployMock;
  let activitySpy: jest.SpyInstance;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-upload-route-test-'));
    uploadTempDir = path.join(tempDir, 'temp');
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();

    resetRateLimits();
    resetStateManager();
    resetAuth();
    resetPlatformOps();

    jest.spyOn(diskUtils, 'hasEnoughDisk').mockResolvedValue({ ok: true, freeMb: 10000 });
    jest.spyOn(runtimeConfigModule, 'getTempDirectory').mockReturnValue(uploadTempDir);
    jest.spyOn(runtimeConfigModule, 'getUploadMaxBytes').mockReturnValue(10 * 1024 * 1024);

    deployMock = jest.fn().mockResolvedValue({
      app: 'placeholder',
      acceptedAt: '2026-07-09T00:00:00.000Z',
      isNew: false,
    });
    jest.spyOn(uploadDeployModule, 'getUploadDeployService').mockReturnValue({
      deploy: deployMock,
      isUploading: jest.fn().mockReturnValue(false),
    } as unknown as ReturnType<typeof uploadDeployModule.getUploadDeployService>);

    setPlatformOps(makeOps());
    activitySpy = jest.spyOn(activity, 'logActivityFor').mockResolvedValue();

    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    // The new-app name rules fail closed without a config service.
    resetAppConfigService();
    await getAppConfigService({ configDir: path.join(tempDir, 'appconf'), webappsDir: tempDir }).initialize();

    server = new ApiServer({
      port: 3098,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    hono = server.getApp();

    const alice = await createUser({ username: 'alice', role: 'user', credential: { password: 'password123' } });
    aliceId = alice.id;
    await createUser({ username: 'bob', role: 'user', credential: { password: 'password123' } });
    await createUser({ username: 'sysadmin', role: 'admin', credential: { password: 'password123' } });
    aliceToken = await getTestToken('alice', 'password123');
    bobToken = await getTestToken('bob', 'password123');
    adminToken = await getTestToken('sysadmin', 'password123');

    const sm = getStateManager();
    await sm.registerApp('alice-app', path.join(tempDir, 'alice-app'));
    await sm.updateApp('alice-app', { userId: aliceId });
  });

  afterEach(async () => {
    resetPlatformOps();
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetAuth();
    resetAppConfigService();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("404s a non-owner upload and never calls the deploy service (no existence oracle)", async () => {
    const res = await hono.request('/api/v1/apps/alice-app/source', {
      method: 'POST',
      headers: authHeader(bobToken),
      body: Buffer.from('fake-archive-bytes'),
    });
    expect(res.status).toBe(404);
    expect(deployMock).not.toHaveBeenCalled();
  });

  it('answers a suspended (and therefore stopped) app 409 APP_SUSPENDED, not "start or remove it"; a non-owner still gets 404', async () => {
    await getStateManager().setAppStatus('alice-app', 'stopped');
    await getSuspensionStore().suspend('alice-app', 'admin-1');
    const upload = (token: string) =>
      hono.request('/api/v1/apps/alice-app/source', {
        method: 'POST',
        headers: authHeader(token),
        body: Buffer.from('fake-archive-bytes'),
      });

    const owner = await upload(aliceToken);
    expect(owner.status).toBe(409);
    const json = (await owner.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe('APP_SUSPENDED');
    expect(json.error.message).not.toContain('start or remove');

    // The ownership answer comes first: never an oracle for someone else's app.
    expect((await upload(bobToken)).status).toBe(404);
    expect(deployMock).not.toHaveBeenCalled();
  });

  it('lets the owner redeploy — 202, acceptedAt passthrough, service called with userId', async () => {
    deployMock.mockResolvedValueOnce({
      app: 'alice-app',
      acceptedAt: '2026-07-09T01:02:03.000Z',
      isNew: false,
    });

    const res = await hono.request('/api/v1/apps/alice-app/source', {
      method: 'POST',
      headers: authHeader(aliceToken),
      body: Buffer.from('fake-archive-bytes'),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: { app: string; acceptedAt: string; isNew: boolean } };
    expect(body.data).toEqual({ app: 'alice-app', acceptedAt: '2026-07-09T01:02:03.000Z', isNew: false });
    expect(deployMock).toHaveBeenCalledWith({
      appName: 'alice-app',
      archivePath: expect.any(String),
      userId: aliceId,
      callerIsAdmin: false,
      // Threaded for the deploy guardrail, so a looping agent is keyed on its
      // own credential rather than on the human it acts for.
      principalId: `jwt:${aliceId}`,
      // Derived from the credential kind, never from request input — it is what
      // exposes an app to automatic reaping.
      agentCaller: false,
    });

    const call = activitySpy.mock.calls.find((call) => call[1].action === 'upload-deploy');
    expect(call?.[1]).toMatchObject({ action: 'upload-deploy', appName: 'alice-app' });
    expect(call?.[0]).toMatchObject({ userId: aliceId });
  });

  it("lets an admin upload to another user's app — 202", async () => {
    const res = await hono.request('/api/v1/apps/alice-app/source', {
      method: 'POST',
      headers: authHeader(adminToken),
      body: Buffer.from('fake-archive-bytes'),
    });
    expect(res.status).toBe(202);
    expect(deployMock).toHaveBeenCalledWith(expect.objectContaining({ appName: 'alice-app' }));
  });

  describe('a new name whose folder already exists on disk (folder-dropped app)', () => {
    let webapps: string;

    beforeEach(async () => {
      webapps = path.join(tempDir, 'webapps');
      await fs.mkdir(path.join(webapps, 'dropped'), { recursive: true });
      await fs.writeFile(path.join(webapps, 'dropped', 'index.js'), 'operator');
      jest.spyOn(runtimeConfigModule, 'getAppsDirectory').mockReturnValue(webapps);
    });

    it('404s a non-admin upload to it, never calls the deploy service, and leaves the folder alone', async () => {
      const res = await hono.request('/api/v1/apps/dropped/source', {
        method: 'POST',
        headers: authHeader(aliceToken),
        body: Buffer.from('fake-archive-bytes'),
      });
      // Same answer as a foreign-owned or unknown app: no oracle for the folder.
      expect(res.status).toBe(404);
      expect(deployMock).not.toHaveBeenCalled();
      expect(getStateManager().hasApp('dropped')).toBe(false);
      expect(await fs.readFile(path.join(webapps, 'dropped', 'index.js'), 'utf8')).toBe('operator');
    });

    it('404s when the name is a plain file rather than a directory', async () => {
      await fs.writeFile(path.join(webapps, 'a-file'), 'x');
      const res = await hono.request('/api/v1/apps/a-file/source', {
        method: 'POST',
        headers: authHeader(aliceToken),
        body: Buffer.from('fake-archive-bytes'),
      });
      expect(res.status).toBe(404);
      expect(deployMock).not.toHaveBeenCalled();
    });

    it('lets an admin create over it — 202', async () => {
      const res = await hono.request('/api/v1/apps/dropped/source', {
        method: 'POST',
        headers: authHeader(adminToken),
        body: Buffer.from('fake-archive-bytes'),
      });
      expect(res.status).toBe(202);
      expect(deployMock).toHaveBeenCalledWith(expect.objectContaining({ appName: 'dropped' }));
    });

    it('404s a non-admin upload to a name that is a group, or an existing app in another case', async () => {
      await getStateManager().registerApp('Existing', path.join(webapps, 'Existing'));
      await getStateManager().registerApp('grp-web', path.join(webapps, 'grp-web'));
      await getStateManager().updateApp('grp-web', { group: 'grp' });

      for (const name of ['grp', 'GRP', 'existing']) {
        const res = await hono.request(`/api/v1/apps/${name}/source`, {
          method: 'POST',
          headers: authHeader(aliceToken),
          body: Buffer.from('fake-archive-bytes'),
        });
        expect(res.status).toBe(404);
      }
      expect(deployMock).not.toHaveBeenCalled();
    });

    it('still lets a non-admin create a genuinely new name — 202', async () => {
      const res = await hono.request('/api/v1/apps/fresh-app/source', {
        method: 'POST',
        headers: authHeader(aliceToken),
        body: Buffer.from('fake-archive-bytes'),
      });
      expect(res.status).toBe(202);
      expect(deployMock).toHaveBeenCalledWith(expect.objectContaining({ appName: 'fresh-app' }));
    });
  });

  it('rejects a new app upload at the per-user app limit — same shape as POST /apps', async () => {
    const original = process.env.DROP_MAX_APPS_PER_USER;
    process.env.DROP_MAX_APPS_PER_USER = '1'; // alice already owns alice-app
    try {
      const res = await hono.request('/api/v1/apps/brand-new-app/source', {
        method: 'POST',
        headers: authHeader(aliceToken),
        body: Buffer.from('fake-archive-bytes'),
      });
      expect(res.status).toBe(429);
      expect(deployMock).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.DROP_MAX_APPS_PER_USER;
      else process.env.DROP_MAX_APPS_PER_USER = original;
    }
  });

  it('409s when the app already has an operation in progress', async () => {
    setPlatformOps(makeOps({ isAppInProgress: jest.fn().mockReturnValue(true) }));

    const res = await hono.request('/api/v1/apps/alice-app/source', {
      method: 'POST',
      headers: authHeader(aliceToken),
      body: Buffer.from('fake-archive-bytes'),
    });
    expect(res.status).toBe(409);
    expect(deployMock).not.toHaveBeenCalled();
  });

  it('409s uploading to a stopped app (deterministic instead of polling forever)', async () => {
    await getStateManager().setAppStatus('alice-app', 'stopped');

    const res = await hono.request('/api/v1/apps/alice-app/source', {
      method: 'POST',
      headers: authHeader(aliceToken),
      body: Buffer.from('fake-archive-bytes'),
    });
    expect(res.status).toBe(409);
    expect(deployMock).not.toHaveBeenCalled();
  });

  it('409s uploading onto a git-deployed app instead of severing its git link', async () => {
    // syncTree's prune would delete the app's real .git (DEFAULT_PRESERVE is
    // node_modules only) while gitSource survives in apps.json, so the app
    // would still look git-backed and every later redeploy would fail in
    // `git remote get-url origin`.
    await getStateManager().updateApp('alice-app', {
      gitSource: {
        repoUrl: 'https://github.com/alice/app',
        branch: 'main',
        autoRedeploy: true,
      },
    } as Record<string, unknown>);

    const res = await hono.request('/api/v1/apps/alice-app/source', {
      method: 'POST',
      headers: authHeader(aliceToken),
      body: Buffer.from('fake-archive-bytes'),
    });

    expect(res.status).toBe(409);
    expect(deployMock).not.toHaveBeenCalled();
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain('git/redeploy');
  });

  it('409s uploading onto a monorepo child whose group container is git-deployed', async () => {
    // The child carries no gitSource of its own — expandMonorepo never sets
    // one — so a check on gitSource alone would leave the whole group
    // clobberable by targeting any single child.
    const sm = getStateManager();
    await sm.registerApp('alice-group', path.join(tempDir, 'alice-group'));
    await sm.updateApp('alice-group', {
      userId: aliceId,
      isGroupContainer: true,
      group: 'alice-group',
      gitSource: {
        repoUrl: 'https://github.com/alice/mono',
        branch: 'main',
        autoRedeploy: true,
      },
    } as Record<string, unknown>);
    await sm.updateApp('alice-app', { group: 'alice-group' } as Record<string, unknown>);

    const res = await hono.request('/api/v1/apps/alice-app/source', {
      method: 'POST',
      headers: authHeader(aliceToken),
      body: Buffer.from('fake-archive-bytes'),
    });

    expect(res.status).toBe(409);
    expect(deployMock).not.toHaveBeenCalled();
  });

  it('429s a concurrent upload from the same account while the first is still in flight', async () => {
    let resolveDeploy: (value: { app: string; acceptedAt: string; isNew: boolean }) => void;
    let resolveEntered: () => void;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    const deployResult = new Promise<{ app: string; acceptedAt: string; isNew: boolean }>((resolve) => {
      resolveDeploy = resolve;
    });
    deployMock.mockImplementationOnce(async () => {
      resolveEntered();
      return deployResult;
    });

    const firstRequest = hono.request('/api/v1/apps/alice-app/source', {
      method: 'POST',
      headers: authHeader(aliceToken),
      body: Buffer.from('fake-archive-bytes'),
    });

    // Wait until the first request's handler has actually called deploy() —
    // guarantees uploadsInFlight.add() already ran (it happens synchronously
    // before any await in the handler, well before deploy() is reached).
    await entered;

    const secondRes = await hono.request('/api/v1/apps/alice-app/source', {
      method: 'POST',
      headers: authHeader(aliceToken),
      body: Buffer.from('fake-archive-bytes'),
    });
    expect(secondRes.status).toBe(429);

    resolveDeploy!({ app: 'alice-app', acceptedAt: '2026-07-09T00:00:00.000Z', isNew: false });
    const firstRes = await firstRequest;
    expect(firstRes.status).toBe(202);
  });

  it('400s when no request body is sent', async () => {
    const res = await hono.request('/api/v1/apps/alice-app/source', {
      method: 'POST',
      headers: authHeader(aliceToken),
    });
    expect(res.status).toBe(400);
    expect(deployMock).not.toHaveBeenCalled();
  });

  it('413s an oversize body stream (never trusts Content-Length) and cleans up the staged file', async () => {
    jest.spyOn(runtimeConfigModule, 'getUploadMaxBytes').mockReturnValue(10); // 10 bytes

    const res = await hono.request('/api/v1/apps/alice-app/source', {
      method: 'POST',
      headers: authHeader(aliceToken),
      body: Buffer.alloc(1000, 'x'),
    });
    expect(res.status).toBe(413);
    expect(deployMock).not.toHaveBeenCalled();

    const stagedDir = path.join(uploadTempDir, 'upload-archives');
    const remaining = await fs.readdir(stagedDir).catch(() => []);
    expect(remaining.filter((f) => f.startsWith('alice-app-'))).toHaveLength(0);
  });

  it('maps ArchiveRejectedError from the service to 400 with the reason in the message', async () => {
    deployMock.mockRejectedValueOnce(
      new ArchiveRejectedError('path_escape', 'Entry path escapes destination directory: ../evil')
    );

    const res = await hono.request('/api/v1/apps/alice-app/source', {
      method: 'POST',
      headers: authHeader(aliceToken),
      body: Buffer.from('fake-archive-bytes'),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('path_escape');
  });

  it('maps a suspended app to 409 APP_SUSPENDED, naming the administrator only for a real suspension', async () => {
    deployMock.mockRejectedValueOnce(new AppSuspendedError('alice-app'));
    const upload = () =>
      hono.request('/api/v1/apps/alice-app/source', {
        method: 'POST',
        headers: authHeader(aliceToken),
        body: Buffer.from('fake-archive-bytes'),
      });

    const res = await upload();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string; message: string } }).error).toMatchObject({
      code: 'APP_SUSPENDED',
      message: "Application 'alice-app' is suspended by an administrator",
    });

    // The store's own state is not a tenant's to read.
    deployMock.mockRejectedValueOnce(new AppSuspendedError('alice-app', 'store-unreadable'));
    const generic = await upload();
    expect(generic.status).toBe(409);
    expect(((await generic.json()) as { error: { message: string } }).error.message).toBe(
      "Starting 'alice-app' is refused right now; contact your administrator"
    );
  });

  describe('auth disabled (single-user box)', () => {
    let noAuthServer: ApiServer;

    afterEach(async () => {
      if (noAuthServer) await noAuthServer.stop();
    });

    it('still works with no auth context', async () => {
      noAuthServer = new ApiServer({ port: 3099, enableAuth: false });
      await noAuthServer.initialize();
      const app = noAuthServer.getApp();

      const res = await app.request('/api/v1/apps/alice-app/source', {
        method: 'POST',
        body: Buffer.from('fake-archive-bytes'),
      });
      expect(res.status).toBe(202);
      expect(deployMock).toHaveBeenCalledWith({
        appName: 'alice-app',
        archivePath: expect.any(String),
        userId: undefined,
        callerIsAdmin: false,
        principalId: undefined,
        // With auth disabled there is no credential at all, so nothing can be
        // an agent — and an app created here is never auto-reapable.
        agentCaller: false,
      });
    });
  });
});
