/**
 * POST /apps/:name/redeploy (#359) - rebuild an app: a git-backed app lands its
 * newest commit first, a monorepo container is re-expanded, any other app is
 * rebuilt from the source already on disk.
 *
 * The platform's admission and start are stubbed at the PlatformOps seam (they
 * are covered against the real platform in platform.explicit-redeploy.test.ts);
 * what is under test here is the route: authorization first with 404
 * discipline, the one actor handed to admission, how each refusal reaches the
 * wire, the 202 shape, the activity entry, and the dedicated rate-limit bucket.
 */

import * as path from 'path';
import { Hono } from 'hono';
import appsRoutes from './apps';
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

    it('makes ONE call, with the one actor and the caller for the git token rules (no tokenId exists here)', async () => {
      await redeploy('site', bearer(ownerToken));
      expect(ops.redeployApp).toHaveBeenCalledTimes(1);
      const [name, actor, options, ...rest] = (ops.redeployApp as jest.Mock).mock.calls[0];
      expect(name).toBe('site');
      expect(actor).toMatchObject({ actorUserId: ownerId, agent: false });
      expect(actor.principalId).toBeDefined();
      expect(options).toEqual({ caller: { admin: false, userId: ownerId } });
      expect(rest).toEqual([]);
    });

    it('a git-backed app: 202 like any other, logged as git', async () => {
      await getStateManager().updateApp('site', {
        gitSource: { repoUrl: 'https://github.com/user/site', branch: 'main' },
      } as Record<string, unknown>);
      const res = await redeploy('site', bearer(ownerToken));
      expect(res.status).toBe(202);
      expect((await body(res)).data.deployId).toBe('11111111-2222-4333-8444-555555555555');
      expect(logSpy).toHaveBeenCalledWith(expect.anything(), { action: 'redeploy', appName: 'site', detail: 'git' });
    });

    it('a monorepo container: 202 group with the container, the follow, and no deploy id', async () => {
      (ops.redeployApp as jest.Mock).mockResolvedValue({ group: { container: 'site' } });
      const res = await redeploy('site', bearer(ownerToken));
      expect(res.status).toBe(202);
      const json = await body(res);
      expect(json.data.group).toBe(true);
      expect(json.data.container).toBe('site');
      expect(json.data.deployId).toBeUndefined();
      expect(json.data.follow).toBe(
        `/api/v1/deploys/stream?app=site&since=${encodeURIComponent(json.data.acceptedAt)}`
      );
      expect(logSpy).toHaveBeenCalledWith(expect.anything(), { action: 'redeploy', appName: 'site', detail: 'group' });
    });

    describe('a service of a git-deployed group', () => {
      const registerGroup = async (containerOwner: string) => {
        const sm = getStateManager();
        await sm.registerApp('svc', path.join(t.tempDir, 'svc'));
        await sm.updateApp('svc', { userId: ownerId, group: 'g' } as Record<string, unknown>);
        await sm.registerApp('box', path.join(t.tempDir, 'box'));
        await sm.updateApp('box', {
          userId: containerOwner,
          group: 'g',
          isGroupContainer: true,
          gitSource: { repoUrl: 'https://github.com/user/box', branch: 'main' },
        } as Record<string, unknown>);
      };

      it('is redeployed through its container: the container is what the platform is asked for, and what is answered', async () => {
        await registerGroup(ownerId);
        (ops.redeployApp as jest.Mock).mockResolvedValue({ group: { container: 'box' } });
        const res = await redeploy('svc', bearer(ownerToken));
        expect(res.status).toBe(202);
        const json = await body(res);
        expect((ops.redeployApp as jest.Mock).mock.calls[0][0]).toBe('box');
        expect(json.data).toMatchObject({ group: true, container: 'box' });
        expect(json.data.follow).toContain('app=box');
        expect(logSpy).toHaveBeenCalledWith(expect.anything(), { action: 'redeploy', appName: 'box', detail: 'git' });
      });

      it("404s, naming only the requested app, when the caller has no access to the container", async () => {
        const other = await createUser({ username: 'other', role: 'user', credential: { password: 'password123' } });
        await registerGroup(other.id);
        const res = await redeploy('svc', bearer(ownerToken));
        expect(res.status).toBe(404);
        expect((await body(res)).error.message).toBe("Application 'svc' not found");
        expect(ops.redeployApp).not.toHaveBeenCalled();
      });
    });

    it('maps a refused recorded repository URL to a 400 and a stale group child to a 409', async () => {
      refuse({ code: 'INVALID_GIT_SOURCE', message: 'Invalid recorded repository URL for site' });
      expect((await redeploy('site', bearer(ownerToken))).status).toBe(400);
      refuse({ code: 'REDEPLOY_VIA_CONTAINER', message: 'redeploy the group container' });
      expect((await redeploy('site', bearer(ownerToken))).status).toBe(409);
    });

    it('a container answered to a role-none caller carries no follow link', async () => {
      (ops.redeployApp as jest.Mock).mockResolvedValue({ group: { container: 'site' } });
      const bare = new Hono();
      bare.use('*', async (c, next) => {
        (c.set as Function)('auth', {
          userId: ownerId,
          username: 'agent',
          role: 'none',
          kind: 'agent',
          scopes: ['app:site:deploy'],
          authMethod: 'apikey',
          principalId: 'p-1',
        });
        await next();
      });
      bare.route('/apps', appsRoutes);
      const res = await bare.request('/apps/site/redeploy', { method: 'POST' });
      expect(res.status).toBe(202);
      const json = await body(res);
      expect(json.data).toMatchObject({ group: true, container: 'site' });
      expect(json.data.follow).toBeUndefined();
    });

    it('gives a scope-only caller (role none) the facts and no follow link: it cannot read /deploys', async () => {
      // Never reaches the handler through the real role floor, so the route is
      // mounted bare under an injected auth context.
      const bare = new Hono();
      bare.use('*', async (c, next) => {
        (c.set as Function)('auth', {
          userId: ownerId,
          username: 'agent',
          role: 'none',
          kind: 'agent',
          scopes: ['app:site:deploy'],
          authMethod: 'apikey',
          principalId: 'p-1',
        });
        await next();
      });
      bare.route('/apps', appsRoutes);

      const res = await bare.request('/apps/site/redeploy', { method: 'POST' });
      expect(res.status).toBe(202);
      const json = await body(res);
      expect(json.data.deployId).toBe('11111111-2222-4333-8444-555555555555');
      expect(json.data.acceptedAt).toBeDefined();
      expect(json.data.follow).toBeUndefined();
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
      ['APP_SOURCE_MISSING', 409, 'APP_SOURCE_MISSING'],
      ['APP_BUSY', 409, 'APP_BUSY'],
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
