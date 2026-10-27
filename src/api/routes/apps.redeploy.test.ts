/**
 * POST /apps/:name/redeploy (#359 Item 2) - rebuild a FILES app from the source
 * already on disk.
 *
 * The platform's admission and start are stubbed at the PlatformOps seam (they
 * are covered against the real platform in platform.explicit-redeploy.test.ts);
 * what is under test here is the route: authorization first with 404
 * discipline, the one actor handed to admission, how each refusal reaches the
 * wire, the 202 shape, the activity entry, and the dedicated rate-limit bucket.
 */

import * as path from 'path';
import { createUser, createApiKey } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { createTestApiServer, teardownTestApiServer, type TestApiServer } from '../__testutils__/api-server';
import { makePlatformOpsStub } from '../__testutils__/platform-ops';
import { getStateManager } from '../../managers/app/state-manager';
import { setPlatformOps, resetPlatformOps, type PlatformOps, type RedeployRefusal } from '../platform-ops';
import * as activity from '../../managers/activity';

describe('POST /apps/:name/redeploy', () => {
  let t: TestApiServer;
  let ownerId: string;
  let ownerToken: string;
  let strangerToken: string;
  let readonlyToken: string;
  let logSpy: jest.SpyInstance;
  let ops: PlatformOps;

  const body = async (res: Response): Promise<any> => res.json();
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const redeploy = (name: string, headers: Record<string, string>) =>
    t.hono.request(`/api/v1/apps/${name}/redeploy`, { method: 'POST', headers });
  const refuse = (refused: RedeployRefusal) => (ops.redeployApp as jest.Mock).mockResolvedValue({ refused });

  beforeEach(async () => {
    t = await createTestApiServer({ port: 3112, tempPrefix: 'drop-redeploy-route-', activityLog: true });
    logSpy = jest.spyOn(activity, 'logActivityFor').mockResolvedValue();

    const owner = await createUser({ username: 'owner', role: 'user', credential: { password: 'password123' } });
    ownerId = owner.id;
    await createUser({ username: 'stranger', role: 'user', credential: { password: 'password123' } });
    await createUser({ username: 'viewer', role: 'readonly', credential: { password: 'password123' } });
    ownerToken = await getTestToken('owner', 'password123');
    strangerToken = await getTestToken('stranger', 'password123');
    readonlyToken = await getTestToken('viewer', 'password123');

    const sm = getStateManager();
    await sm.registerApp('site', path.join(t.tempDir, 'site'));
    await sm.updateApp('site', { userId: ownerId });

    ops = makePlatformOpsStub({
      redeployApp: jest.fn().mockResolvedValue({ started: '11111111-2222-4333-8444-555555555555' }),
    });
    setPlatformOps(ops);
  });

  afterEach(async () => {
    resetPlatformOps();
    await teardownTestApiServer(t);
  });

  describe('authorization comes first', () => {
    it("404s another user's app, and never reaches admission", async () => {
      const res = await redeploy('site', bearer(strangerToken));
      expect(res.status).toBe(404);
      expect(ops.redeployApp).not.toHaveBeenCalled();
    });

    it('answers a stranger exactly as it answers an app that does not exist, naming only the requested app', async () => {
      const foreign = await body(await redeploy('site', bearer(strangerToken)));
      const unknown = await body(await redeploy('no-such-app', bearer(strangerToken)));
      expect(foreign.error.code).toBe('NOT_FOUND');
      expect(foreign.error.message).toBe("Application 'site' not found");
      expect(unknown.error.message).toBe("Application 'no-such-app' not found");
      expect(foreign.error.code).toBe(unknown.error.code);
    });

    it('refuses an anonymous caller (401) and a read-only token (403)', async () => {
      expect((await redeploy('site', {})).status).toBe(401);
      expect((await redeploy('site', bearer(readonlyToken))).status).toBe(403);
      expect(ops.redeployApp).not.toHaveBeenCalled();
    });

    it('503s when the platform operations are not wired', async () => {
      resetPlatformOps();
      const res = await redeploy('site', bearer(ownerToken));
      expect(res.status).toBe(503);
    });
  });

  describe('accepted', () => {
    it('with a slot in time: 202 with the deploy id, and the app + since stream to follow it', async () => {
      const before = Date.now();
      const res = await redeploy('site', bearer(ownerToken));
      expect(res.status).toBe(202);
      const json = await body(res);
      expect(json.success).toBe(true);
      expect(json.data.deployId).toBe('11111111-2222-4333-8444-555555555555');
      // The by-id stream 404s between the mint and the build's first event, so
      // both answers follow by app + since, with since taken BEFORE the start.
      expect(json.data.follow).toBe(
        `/api/v1/deploys/stream?app=site&since=${encodeURIComponent(json.data.acceptedAt)}`
      );
      expect(new Date(json.data.acceptedAt).getTime()).toBeGreaterThanOrEqual(before - 1);
      expect(new Date(json.data.acceptedAt).getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('with no slot in time: 202 accepted, with no id yet and the same follow', async () => {
      (ops.redeployApp as jest.Mock).mockResolvedValue({ accepted: true });
      const res = await redeploy('site', bearer(ownerToken));
      expect(res.status).toBe(202);
      const json = await body(res);
      expect(json.data.accepted).toBe(true);
      expect(json.data.deployId).toBeUndefined();
      expect(json.data.follow).toBe(
        `/api/v1/deploys/stream?app=site&since=${encodeURIComponent(json.data.acceptedAt)}`
      );
      expect(logSpy).toHaveBeenCalledWith(expect.anything(), { action: 'redeploy', appName: 'site', detail: 'files' });
    });

    it('takes acceptedAt before it starts the redeploy', async () => {
      let atStart = 0;
      (ops.redeployApp as jest.Mock).mockImplementation(async () => {
        atStart = Date.now();
        return { started: '11111111-2222-4333-8444-555555555555' };
      });
      const json = await body(await redeploy('site', bearer(ownerToken)));
      expect(new Date(json.data.acceptedAt).getTime()).toBeLessThanOrEqual(atStart);
    });

    it("makes ONE call, with the one actor and the caller's token standing as options", async () => {
      await redeploy('site', bearer(ownerToken));
      expect(ops.redeployApp).toHaveBeenCalledTimes(1);
      const [name, actor, options] = (ops.redeployApp as jest.Mock).mock.calls[0];
      expect(name).toBe('site');
      expect(actor).toMatchObject({ actorUserId: ownerId, agent: false });
      expect(actor.principalId).toBeDefined();
      expect(options).toEqual({ caller: { admin: false, userId: ownerId } });
    });

    it('marks an agent token as an agent', async () => {
      const key = await createApiKey('agent-key', 'user', undefined, undefined, ownerId, { kind: 'agent' });
      const res = await redeploy('site', { 'X-API-Key': key.key });
      expect(res.status).toBe(202);
      expect((ops.redeployApp as jest.Mock).mock.calls[0][1]).toMatchObject({ agent: true });
    });

    it('records the acceptance in the activity log', async () => {
      await redeploy('site', bearer(ownerToken));
      expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ userId: ownerId }), {
        action: 'redeploy',
        appName: 'site',
        detail: 'files',
      });
    });

    it('records nothing when it is refused', async () => {
      refuse({ code: 'APP_BUSY', message: 'busy' });
      await redeploy('site', bearer(ownerToken));
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  describe('refusals', () => {
    const cases: Array<[RedeployRefusal['code'], number, string]> = [
      ['NOT_FOUND', 404, 'NOT_FOUND'],
      ['APP_BUSY', 409, 'APP_BUSY'],
      ['REDEPLOY_NOT_SUPPORTED_YET', 409, 'REDEPLOY_NOT_SUPPORTED_YET'],
      ['APP_STOPPED', 409, 'APP_STOPPED'],
      ['SERVICE_UNAVAILABLE', 503, 'SERVICE_UNAVAILABLE'],
      ['RATE_LIMITED', 429, 'RATE_LIMITED'],
      ['INSUFFICIENT_DISK', 507, 'INSUFFICIENT_DISK'],
    ];

    it.each(cases)('maps a refusal %s to %i / %s', async (code, status, apiCode) => {
      refuse({ code, message: `refused: ${code}` });
      const res = await redeploy('site', bearer(ownerToken));
      expect(res.status).toBe(status);
      const json = await body(res);
      expect(json.error).toMatchObject({ code: apiCode, message: `refused: ${code}` });
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('carries the retry hint as Retry-After and in the body', async () => {
      refuse({ code: 'RATE_LIMITED', message: 'Too many failed deploys.', retryAfterSeconds: 37 });
      const res = await redeploy('site', bearer(ownerToken));
      expect(res.status).toBe(429);
      expect(res.headers.get('Retry-After')).toBe('37');
      expect((await body(res)).error.details).toEqual({ retryAfterSeconds: 37 });
    });

    it('tells a git-backed app where to go', async () => {
      refuse({
        code: 'REDEPLOY_NOT_SUPPORTED_YET',
        message: "Application 'site' is deployed from git; use POST /api/v1/git/redeploy/site",
      });
      const res = await redeploy('site', bearer(ownerToken));
      expect((await body(res)).error.message).toContain('/git/redeploy/site');
    });

    it('500s when the platform operation itself throws', async () => {
      jest.spyOn(console, 'error').mockImplementation();
      (ops.redeployApp as jest.Mock).mockRejectedValue(new Error('quota store down'));
      const res = await redeploy('site', bearer(ownerToken));
      expect(res.status).toBe(500);
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  describe('rate limit', () => {
    const fromLoopback = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
    const headers = () => ({ ...bearer(ownerToken), 'x-forwarded-for': '10.20.30.40' });
    const post = (p: string) => t.hono.request(p, { method: 'POST', headers: headers() }, fromLoopback);

    it('has its own bucket: 429s after 10 a minute, and leaves the other buckets alone', async () => {
      for (let i = 0; i < 10; i++) {
        expect((await post('/api/v1/apps/site/redeploy')).status).not.toBe(429);
      }
      const blocked = await post('/api/v1/apps/site/redeploy');
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers.get('Retry-After'))).toBeGreaterThan(0);

      // The upload bucket is a different counter, and so is restart's general one.
      const upload = await post('/api/v1/apps/site/source');
      expect(upload.status).not.toBe(429);
    });
  });
});
