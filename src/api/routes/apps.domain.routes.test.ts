/**
 * Custom-domain routes and MCP tool (#302): PUT/GET /apps/:name/domain,
 * POST /apps/:name/domain/verify, the general PUT /apps/:name, and the
 * `custom_domain` tool.
 *
 * DNS is stubbed at the module seam (platformAddresses/checkDomainDns);
 * activation is observed through AppConfig and the reconfigureRoute op, since
 * emission itself is platform.custom-domain.test.ts's.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { createTestApiServer, teardownTestApiServer, TestApiServer } from '../__testutils__/api-server';
import { makePlatformOpsStub } from '../__testutils__/platform-ops';
import { createUser, createApiKey } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager } from '../../managers/app/state-manager';
import { getAppConfigService, resetAppConfigService } from '../../managers/app/app-config';
import { setPlatformOps, AppInProgressError } from '../platform-ops';
import * as runtimeConfig from '../runtime-config';
import * as domainModule from '../../managers/domain/custom-domain';
import * as caddyApi from '../../managers/router/caddy-api';
import { handleCustomDomain } from '../mcp/tools';
import type { AuthContext } from '../middleware/auth';

describe('custom domains (#302)', () => {
  let t: TestApiServer;
  let ownerId: string;
  let ownerToken: string;
  let outsiderToken: string;
  let reconfigureRoute: jest.Mock;
  let dns: { resolves: boolean; pointsHere: boolean };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
  const put = (body: unknown, token = ownerToken, name = 'site') =>
    t.hono.request(`/api/v1/apps/${name}/domain`, { method: 'PUT', headers: auth(token), body: JSON.stringify(body) });
  const get = (token = ownerToken, name = 'site') =>
    t.hono.request(`/api/v1/apps/${name}/domain`, { headers: auth(token) });
  const verify = (token = ownerToken, name = 'site') =>
    t.hono.request(`/api/v1/apps/${name}/domain/verify`, { method: 'POST', headers: auth(token) });
  const data = async (res: Response) => ((await res.json()) as { data: Record<string, any> }).data;
  const verified = () => getAppConfigService().getConfig('site')?.customDomainVerified;

  beforeEach(async () => {
    resetAppConfigService();
    t = await createTestApiServer({ port: 3143, tempPrefix: 'drop-custom-domain-route-' });
    await fs.mkdir(path.join(t.tempDir, 'appconf'), { recursive: true });
    await fs.mkdir(path.join(t.tempDir, 'webapps', 'site'), { recursive: true });
    getAppConfigService({ configDir: path.join(t.tempDir, 'appconf'), webappsDir: path.join(t.tempDir, 'webapps') });
    await getAppConfigService().upsertConfig('site', { type: 'static', port: 4000 });
    await getAppConfigService().upsertConfig('other', { type: 'static', port: 4001 });

    ownerId = (await createUser('owner', 'password123', 'user')).id;
    ownerToken = await getTestToken('owner', 'password123');
    await createUser('outsider', 'password123', 'user');
    outsiderToken = await getTestToken('outsider', 'password123');
    const sm = getStateManager();
    await sm.registerApp('site', path.join(t.tempDir, 'webapps', 'site'), 'static');
    await sm.updateApp('site', { userId: ownerId, port: 4000 });

    jest.spyOn(runtimeConfig, 'getDomainSuffix').mockReturnValue('dropkit.sh');
    jest.spyOn(runtimeConfig, 'getPublicUrl').mockReturnValue('https://dashboard.dropkit.sh');
    jest.spyOn(domainModule, 'platformAddresses').mockResolvedValue(['203.0.113.7']);
    dns = { resolves: false, pointsHere: false };
    jest.spyOn(domainModule, 'checkDomainDns').mockImplementation(async () => dns);
    jest.spyOn(caddyApi, 'getCaddyAdminClient').mockReturnValue({
      isAvailable: jest.fn().mockResolvedValue(false),
    } as unknown as ReturnType<typeof caddyApi.getCaddyAdminClient>);

    reconfigureRoute = jest.fn().mockResolvedValue(undefined);
    setPlatformOps(makePlatformOpsStub({ reconfigureRoute }));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    resetAppConfigService();
    await teardownTestApiServer(t);
  });

  describe('PUT /apps/:name/domain', () => {
    it('records the domain without routing it, and says which DNS record to create', async () => {
      const res = await put({ domain: 'app.example.com' });

      expect(res.status).toBe(200);
      const body = await data(res);
      expect(getStateManager().getApp('site')?.customDomain).toBe('app.example.com');
      expect(body.status).toEqual(
        expect.objectContaining({
          state: 'pending',
          routed: false,
          records: expect.arrayContaining([
            expect.objectContaining({ type: 'CNAME', value: 'site.dropkit.sh' }),
            expect.objectContaining({ type: 'A', value: '203.0.113.7' }),
          ]),
        })
      );
      expect(verified()).toBeUndefined();
      expect(reconfigureRoute).not.toHaveBeenCalled();
    });

    it.each([
      ['a malformed value', 'not a domain', 'Invalid domain format'],
      ["the platform's own host", 'dashboard.dropkit.sh', 'reserved'],
      ["a name under the platform's suffix", 'victim.dropkit.sh', 'belong to the platform'],
    ])('refuses %s', async (_label, domain, why) => {
      const res = await put({ domain });

      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain(why);
      expect(getStateManager().getApp('site')?.customDomain).toBeUndefined();
    });

    it("answers someone else's app exactly like a missing one", async () => {
      expect((await put({ domain: 'app.example.com' }, outsiderToken)).status).toBe(404);
      expect((await put({ domain: 'app.example.com' }, outsiderToken, 'nope')).status).toBe(404);
    });

    it('replacing a verified domain unroutes it straight away', async () => {
      await getStateManager().updateApp('site', { customDomain: 'old.example.com' });
      await getAppConfigService().updateSystemConfig('site', {
        customDomainVerified: { domain: 'old.example.com', verifiedAt: 'x' },
      });

      await put({ domain: 'new.example.com' });

      expect(reconfigureRoute).toHaveBeenCalledWith('site');
    });
  });

  describe('the general PUT /apps/:name', () => {
    it('applies the same rules', async () => {
      const res = await t.hono.request('/api/v1/apps/site', {
        method: 'PUT',
        headers: auth(ownerToken),
        body: JSON.stringify({ customDomain: 'victim.dropkit.sh' }),
      });
      expect(res.status).toBe(400);
    });

    it('also unroutes a verified domain it replaces', async () => {
      await getStateManager().updateApp('site', { customDomain: 'old.example.com' });
      await getAppConfigService().updateSystemConfig('site', {
        customDomainVerified: { domain: 'old.example.com', verifiedAt: 'x' },
      });

      const res = await t.hono.request('/api/v1/apps/site', {
        method: 'PUT',
        headers: auth(ownerToken),
        body: JSON.stringify({ customDomain: '' }),
      });

      expect(res.status).toBe(200);
      expect(getStateManager().getApp('site')?.customDomain).toBeFalsy();
      expect(reconfigureRoute).toHaveBeenCalledWith('site');
    });
  });

  describe('GET /apps/:name/domain', () => {
    it('reports none when no domain is set', async () => {
      expect(await data(await get())).toEqual(expect.objectContaining({ domain: null, state: 'none' }));
    });

    it('reports without activating, even when DNS already points here', async () => {
      await put({ domain: 'app.example.com' });
      dns = { resolves: true, pointsHere: true };

      const body = await data(await get());

      expect(body).toEqual(expect.objectContaining({ state: 'pending', dns: { resolves: true, pointsHere: true } }));
      expect(verified()).toBeUndefined();
    });

    it('is readable by the owner only', async () => {
      expect((await get(outsiderToken)).status).toBe(404);
    });
  });

  describe('POST /apps/:name/domain/verify', () => {
    beforeEach(async () => {
      await put({ domain: 'app.example.com' });
      reconfigureRoute.mockClear();
    });

    it('stays pending while DNS does not point here, touching nothing', async () => {
      dns = { resolves: true, pointsHere: false };

      const body = await data(await verify());

      expect(body).toEqual(expect.objectContaining({ state: 'pending', routed: false }));
      expect(body.message).toMatch(/resolves, but not to this platform/);
      expect(verified()).toBeUndefined();
      expect(reconfigureRoute).not.toHaveBeenCalled();
    });

    it('verifies and routes once DNS points here; polling again is a no-op', async () => {
      dns = { resolves: true, pointsHere: true };

      const first = await data(await verify());
      const second = await data(await verify());

      expect(first).toEqual(expect.objectContaining({ state: 'verified', routed: true }));
      expect(verified()?.domain).toBe('app.example.com');
      expect(reconfigureRoute).toHaveBeenCalledTimes(1);
      expect(second.state).toBe('verified');
    });

    it('verifies even while a deploy is in flight: that deploy writes the route', async () => {
      dns = { resolves: true, pointsHere: true };
      reconfigureRoute.mockRejectedValue(new AppInProgressError('site'));

      const res = await verify();

      expect(res.status).toBe(200);
      expect((await data(res)).state).toBe('verified');
    });

    it('refuses a domain another app already serves', async () => {
      await getAppConfigService().updateSystemConfig('other', {
        customDomainVerified: { domain: 'app.example.com', verifiedAt: 'x' },
      });
      dns = { resolves: true, pointsHere: true };

      const body = await data(await verify());

      expect(body.state).toBe('blocked');
      expect(verified()).toBeUndefined();
    });

    it('reports unverifiable when the platform does not know its own address', async () => {
      (domainModule.platformAddresses as jest.Mock).mockResolvedValue([]);

      expect((await data(await verify())).state).toBe('unverifiable');
    });

    it('is refused for another tenant', async () => {
      dns = { resolves: true, pointsHere: true };
      expect((await verify(outsiderToken)).status).toBe(404);
      expect(verified()).toBeUndefined();
    });
  });

  describe('MCP custom_domain', () => {
    const owner = (): AuthContext =>
      ({ userId: ownerId, username: 'owner', role: 'user', authMethod: 'jwt', principalId: ownerId }) as AuthContext;

    it('sets the domain and lists the records to create while pending', async () => {
      const result = await handleCustomDomain(owner(), { name: 'site', domain: 'app.example.com' });

      expect(result.isError).toBeFalsy();
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain('CNAME app.example.com -> site.dropkit.sh');
      expect(result.structuredContent).toEqual(expect.objectContaining({ ok: true, state: 'pending' }));
    });

    it('verifies on a later call with the app name only', async () => {
      await handleCustomDomain(owner(), { name: 'site', domain: 'app.example.com' });
      dns = { resolves: true, pointsHere: true };

      const result = await handleCustomDomain(owner(), { name: 'site' });

      expect(result.structuredContent).toEqual(expect.objectContaining({ state: 'verified', routed: true }));
    });

    it('never echoes resolver output', async () => {
      await handleCustomDomain(owner(), { name: 'site', domain: 'app.example.com' });
      const result = await handleCustomDomain(owner(), { name: 'site' });
      expect(Object.keys(result.structuredContent!.dns as object).sort()).toEqual(['pointsHere', 'resolves']);
    });

    it('applies the shared rules', async () => {
      const result = await handleCustomDomain(owner(), { name: 'site', domain: 'x.dropkit.sh' });
      expect(result.isError).toBe(true);
    });

    it("refuses an agent scoped to read only, and another tenant's app", async () => {
      const key = await createApiKey('agent', 'user', undefined, undefined, ownerId, { kind: 'agent' });
      const readOnlyAgent = {
        userId: ownerId,
        role: 'none',
        kind: 'agent',
        scopes: ['apps:site:read'],
        authMethod: 'api-key',
        principalId: key.apiKey.id,
      } as unknown as AuthContext;
      expect((await handleCustomDomain(readOnlyAgent, { name: 'site', domain: 'app.example.com' })).isError).toBe(true);

      const stranger = { userId: 'nobody', role: 'user', authMethod: 'jwt' } as AuthContext;
      expect((await handleCustomDomain(stranger, { name: 'site' })).isError).toBe(true);
      expect(getStateManager().getApp('site')?.customDomain).toBeUndefined();
    });
  });
});
