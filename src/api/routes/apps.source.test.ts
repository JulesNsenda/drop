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

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { setPlatformOps, resetPlatformOps, PlatformOps } from '../platform-ops';
import * as diskUtils from '../../utils/disk';
import * as runtimeConfigModule from '../runtime-config';
import * as uploadDeployModule from '../../core/upload-deploy';
import { ArchiveRejectedError } from '../../core/upload-deploy';
import * as activity from '../../managers/activity';
import { resetRateLimits } from '../middleware/rate-limit';

type DeployMock = jest.Mock;

function makeOps(overrides?: Partial<PlatformOps>): PlatformOps {
  return {
    restartApp: jest.fn(),
    isAppInProgress: jest.fn().mockReturnValue(false), promoteApp: jest.fn(),
    removeGroup: jest.fn().mockResolvedValue({ removed: [] }),
    purgeAppArtifacts: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

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
    activitySpy = jest.spyOn(activity, 'tryLogActivity').mockResolvedValue();

    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    server = new ApiServer({
      port: 3098,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    hono = server.getApp();

    const alice = await createUser('alice', 'password123', 'user');
    aliceId = alice.id;
    await createUser('bob', 'password123', 'user');
    await createUser('sysadmin', 'password123', 'admin');
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
      // Threaded for the deploy guardrail, so a looping agent is keyed on its
      // own credential rather than on the human it acts for.
      principalId: `jwt:${aliceId}`,
    });

    const entry = activitySpy.mock.calls.find((call) => call[0].action === 'upload-deploy')?.[0];
    expect(entry).toMatchObject({ action: 'upload-deploy', appName: 'alice-app', userId: aliceId });
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
      });
    });
  });
});
