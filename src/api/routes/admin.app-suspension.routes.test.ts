/**
 * POST /admin/apps/:name/suspend, POST /admin/apps/:name/unsuspend, the
 * `suspended` field on the app DTO, and the 409 APP_SUSPENDED a refused start
 * maps to (follow-up F2, Item 1).
 *
 * The routes delegate to PlatformOps (the platform's own behaviour is covered in
 * core/platform.suspension.test.ts); what is pinned here is the wire contract:
 * the admin floor, the human-only unsuspend, stopErrors on a partial stop, the
 * container refusal, and who may see by/reason.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { createUser, createApiKey, listApiKeys, appProvisionKeyName } from '../middleware/auth';
import * as appConfigModule from '../../managers/app/app-config';
import { getTestToken } from '../__testutils__/auth';
import { createTestApiServer, teardownTestApiServer, type TestApiServer } from '../__testutils__/api-server';
import { makePlatformOpsStub } from '../__testutils__/platform-ops';
import { getStateManager } from '../../managers/app/state-manager';
import { getSuspensionStore, resetSuspensionStore } from '../../managers/suspension';
import { AppSuspendedError, resetPlatformOps, setPlatformOps, type PlatformOps } from '../platform-ops';
import * as activity from '../../managers/activity';

describe('app suspension routes', () => {
  let t: TestApiServer;
  let adminToken: string;
  let adminId: string;
  let adminApiKey: string;
  let ownerToken: string;
  let ownerId: string;
  let logSpy: jest.SpyInstance;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const post = (url: string, token: string, body?: unknown) =>
    t.hono.request(url, {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  function ops(overrides?: Partial<PlatformOps>): PlatformOps {
    const stub = makePlatformOpsStub(overrides);
    setPlatformOps(stub);
    return stub;
  }

  beforeEach(async () => {
    t = await createTestApiServer({ port: 3197, tempPrefix: 'drop-suspend-route-' });
    logSpy = jest.spyOn(activity, 'logActivityFor').mockResolvedValue();
    resetSuspensionStore();
    await getSuspensionStore(path.join(t.tempDir, 'suspensions.json')).load();

    const admin = await createUser({ username: 'boss', role: 'admin', credential: { password: 'password123' } });
    adminId = admin.id;
    adminToken = await getTestToken('boss', 'password123');
    adminApiKey = (await createApiKey('ci-key', 'admin', undefined, undefined, admin.id)).key;
    const owner = await createUser({ username: 'owner', role: 'user', credential: { password: 'password123' } });
    ownerId = owner.id;
    ownerToken = await getTestToken('owner', 'password123');

    const sm = getStateManager();
    await sm.registerApp('shop', path.join(t.tempDir, 'shop'));
    await sm.updateApp('shop', { userId: ownerId });
  });

  afterEach(async () => {
    resetSuspensionStore();
    await teardownTestApiServer(t);
  });

  describe('POST /admin/apps/:name/suspend', () => {
    it('suspends through the platform, attributing the admin and the reason, and logs it', async () => {
      const stub = ops();

      const res = await post('/api/v1/admin/apps/shop/suspend', adminToken, { reason: ' abuse report ' });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { appName: string; suspended: boolean; stopErrors?: string[] } };
      expect(body.data).toMatchObject({ appName: 'shop', suspended: true });
      expect(body.data.stopErrors).toBeUndefined();
      expect(stub.suspendApp).toHaveBeenCalledWith('shop', adminId, 'abuse report');
      expect(logSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'suspend', appName: 'shop' })
      );
    });

    it('works without a body', async () => {
      const stub = ops();
      const res = await post('/api/v1/admin/apps/shop/suspend', adminToken);
      expect(res.status).toBe(200);
      expect(stub.suspendApp).toHaveBeenCalledWith('shop', adminId, undefined);
    });

    it('reports what is still live as stopErrors, not a bare success', async () => {
      ops({
        suspendApp: jest
          .fn()
          .mockResolvedValue({ suspended: true, at: 'now', stopErrors: ['shop.b: still present after delete'] }),
      });

      const res = await post('/api/v1/admin/apps/shop/suspend', adminToken);

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { stopErrors?: string[] } };
      expect(body.data.stopErrors).toEqual(['shop.b: still present after delete']);
      // The audit trail says the stop was incomplete, not just that a suspension happened.
      expect(logSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ detail: expect.stringContaining('shop.b: still present after delete') })
      );
    });

    it('409s on a monorepo container, naming its services', async () => {
      ops({
        suspendApp: jest.fn().mockResolvedValue({ refused: 'group-container', services: ['mono-api', 'mono-web'] }),
      });

      const res = await post('/api/v1/admin/apps/shop/suspend', adminToken);

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string; details: { services: string[] } } };
      expect(body.error.message).toContain('mono-api, mono-web');
      expect(body.error.details.services).toEqual(['mono-api', 'mono-web']);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('answers 500, not success, when the record cannot be written', async () => {
      ops({ suspendApp: jest.fn().mockRejectedValue(new Error('disk full')) });

      const res = await post('/api/v1/admin/apps/shop/suspend', adminToken);

      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: { message: string } }).error.message).toContain('disk full');
    });

    it('404s for an unknown app and 503s without platform ops', async () => {
      ops();
      expect((await post('/api/v1/admin/apps/nope/suspend', adminToken)).status).toBe(404);
      resetPlatformOps();
      expect((await post('/api/v1/admin/apps/shop/suspend', adminToken)).status).toBe(503);
    });

    it('is admin-only', async () => {
      const stub = ops();
      expect((await post('/api/v1/admin/apps/shop/suspend', ownerToken)).status).toBe(403);
      expect(stub.suspendApp).not.toHaveBeenCalled();
    });
  });

  describe('POST /admin/apps/:name/unsuspend', () => {
    it('lifts the suspension for an interactive admin session and logs it', async () => {
      const stub = ops();

      const res = await post('/api/v1/admin/apps/shop/unsuspend', adminToken);

      expect(res.status).toBe(200);
      expect(((await res.json()) as { data: { suspended: boolean } }).data.suspended).toBe(false);
      expect(stub.unsuspendApp).toHaveBeenCalledWith('shop');
      expect(logSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'unsuspend', appName: 'shop' })
      );
    });

    it('refuses an API key, even an admin one (humanOnly)', async () => {
      const stub = ops();

      const res = await post('/api/v1/admin/apps/shop/unsuspend', adminApiKey);

      expect(res.status).toBe(403);
      expect(stub.unsuspendApp).not.toHaveBeenCalled();
    });

    it('is admin-only', async () => {
      const stub = ops();
      expect((await post('/api/v1/admin/apps/shop/unsuspend', ownerToken)).status).toBe(403);
      expect(stub.unsuspendApp).not.toHaveBeenCalled();
    });

    it('404s when the app is not suspended', async () => {
      ops({ unsuspendApp: jest.fn().mockResolvedValue({ unsuspended: false }) });
      const res = await post('/api/v1/admin/apps/shop/unsuspend', adminToken);
      expect(res.status).toBe(404);
    });

    it('answers 500 when the record cannot be removed', async () => {
      ops({ unsuspendApp: jest.fn().mockRejectedValue(new Error('read-only')) });
      const res = await post('/api/v1/admin/apps/shop/unsuspend', adminToken);
      expect(res.status).toBe(500);
    });
  });

  describe('a refused start', () => {
    it.each(['start', 'restart'])('POST /apps/:name/%s maps AppSuspendedError to 409 APP_SUSPENDED', async (verb) => {
      ops({ restartApp: jest.fn().mockRejectedValue(new AppSuspendedError('shop')) });

      const res = await post(`/api/v1/apps/shop/${verb}`, ownerToken);

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('APP_SUSPENDED');
    });

    it.each([
      ['promote', '/api/v1/apps/shop/promote', 'promoteApp'],
      ['rollback', '/api/v1/apps/shop/rollback', 'rollbackApp'],
      ['attach', '/api/v1/apps/shop/services/postgres', 'attachService'],
    ] as const)('POST %s maps AppSuspendedError to 409 APP_SUSPENDED', async (_name, url, op) => {
      ops({ [op]: jest.fn().mockRejectedValue(new AppSuspendedError('shop')) } as Partial<PlatformOps>);

      const res = await post(url, ownerToken);

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('APP_SUSPENDED');
    });

    it('an unreadable store is reported as the store, not as an administrator', async () => {
      ops({ restartApp: jest.fn().mockRejectedValue(new AppSuspendedError('shop', 'store-unreadable')) });

      const res = await post('/api/v1/apps/shop/restart', ownerToken);

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toContain('suspension store is unreadable');
      expect(body.error.message).not.toContain('administrator');
    });
  });

  describe('PUT /apps/:name/capabilities on a suspended app', () => {
    function putScopes(scopes: string[]) {
      return t.hono.request('/api/v1/apps/shop/capabilities', {
        method: 'PUT',
        headers: { ...bearer(adminToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ scopes }),
      });
    }

    function storedGrant(scopes: string[]) {
      const updateSystemConfig = jest.fn().mockResolvedValue({});
      jest.spyOn(appConfigModule, 'getAppConfigService').mockReturnValue({
        updateSystemConfig,
        getConfig: jest.fn().mockReturnValue({ grantedApiScopes: scopes }),
      } as never);
      return updateSystemConfig;
    }

    it('refuses a WIDENING grant BEFORE it is written', async () => {
      const ops_ = ops();
      await getSuspensionStore().suspend('shop', adminId);
      const updateSystemConfig = storedGrant([]);

      const res = await putScopes(['users:create']);

      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('APP_SUSPENDED');
      expect(updateSystemConfig).not.toHaveBeenCalled();
      expect(ops_.restartApp).not.toHaveBeenCalled();
    });

    it('lets an admin CLEAR a grant (a subset of the stored one) without restarting the app', async () => {
      const ops_ = ops();
      await getSuspensionStore().suspend('shop', adminId);
      const updateSystemConfig = storedGrant(['users:create']);

      const res = await putScopes([]);

      expect(res.status).toBe(200);
      expect(updateSystemConfig).toHaveBeenCalledWith('shop', { grantedApiScopes: [] });
      expect(ops_.restartApp).not.toHaveBeenCalled();
    });

    it('revokes the app\'s minted DROP_API_KEY when it narrows the grant, since no restart will re-mint it', async () => {
      ops();
      await getSuspensionStore().suspend('shop', adminId);
      storedGrant(['users:create']);
      await createApiKey(appProvisionKeyName('shop'), 'none', undefined, ['users:create']);
      expect(listApiKeys().some((k) => k.name === appProvisionKeyName('shop'))).toBe(true);

      const res = await putScopes([]);

      expect(res.status).toBe(200);
      expect(listApiKeys().some((k) => k.name === appProvisionKeyName('shop'))).toBe(false);
    });

    it('lets an unchanged grant through too (nothing widens), still without a restart', async () => {
      const ops_ = ops();
      await getSuspensionStore().suspend('shop', adminId);
      const updateSystemConfig = storedGrant(['users:create']);

      const res = await putScopes(['users:create']);

      expect(res.status).toBe(200);
      expect(updateSystemConfig).toHaveBeenCalled();
      expect(ops_.restartApp).not.toHaveBeenCalled();
    });
  });

  describe('case collisions', () => {
    it.each([
      ['suspend', 'suspendApp'],
      ['unsuspend', 'unsuspendApp'],
    ] as const)('%s answers 409 naming the colliding apps', async (verb, op) => {
      ops({ [op]: jest.fn().mockResolvedValue({ refused: 'case-collision', names: ['Shop'] }) } as Partial<PlatformOps>);

      const res = await post(`/api/v1/admin/apps/shop/${verb}`, adminToken);

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string; details: { names: string[] } } };
      expect(body.error.details.names).toEqual(['Shop']);
      expect(body.error.message).toContain("'Shop'");
    });
  });

  describe('the DTO', () => {
    interface AppBody {
      data: { suspended?: { kind: string; at?: string; by?: string; reason?: string } };
    }

    it('shows everyone THAT the app is suspended and since when, but only admins by whom and why', async () => {
      const record = await getSuspensionStore().suspend('shop', adminId, 'abuse report');

      const asOwner = (await (await t.hono.request('/api/v1/apps/shop', { headers: bearer(ownerToken) })).json()) as AppBody;
      expect(asOwner.data.suspended).toEqual({ kind: 'record', at: record.at });

      const asAdmin = (await (await t.hono.request('/api/v1/apps/shop', { headers: bearer(adminToken) })).json()) as AppBody;
      expect(asAdmin.data.suspended).toEqual({ kind: 'record', at: record.at, by: adminId, reason: 'abuse report' });
    });

    it('tells an admin the store is unreadable, but anyone else only that the app is suspended (no detail of the platform)', async () => {
      await fs.writeFile(path.join(t.tempDir, 'suspensions.json'), '{ broken');
      jest.spyOn(console, 'error').mockImplementation();
      await getSuspensionStore().load();

      const asAdmin = await t.hono.request('/api/v1/apps/shop', { headers: bearer(adminToken) });
      expect(((await asAdmin.json()) as AppBody).data.suspended).toEqual({ kind: 'store-unreadable' });

      const asOwner = await t.hono.request('/api/v1/apps/shop', { headers: bearer(ownerToken) });
      expect(((await asOwner.json()) as AppBody).data.suspended).toEqual({ kind: 'record' });
    });

    it('tells an admin the store is not loaded yet, and an owner only that the app is suspended', async () => {
      resetSuspensionStore();
      getSuspensionStore(path.join(t.tempDir, 'never-loaded.json'));

      const asAdmin = await t.hono.request('/api/v1/apps/shop', { headers: bearer(adminToken) });
      expect(((await asAdmin.json()) as AppBody).data.suspended).toEqual({ kind: 'not-loaded' });

      const asOwner = await t.hono.request('/api/v1/apps/shop', { headers: bearer(ownerToken) });
      expect(((await asOwner.json()) as AppBody).data.suspended).toEqual({ kind: 'record' });
    });

    it('carries the same field on the list, and nothing for an app that is not suspended', async () => {
      await getStateManager().registerApp('other', path.join(t.tempDir, 'other'));
      await getStateManager().updateApp('other', { userId: ownerId });
      const record = await getSuspensionStore().suspend('shop', adminId, 'abuse report');

      const res = await t.hono.request('/api/v1/apps', { headers: bearer(ownerToken) });
      const apps = ((await res.json()) as { data: Array<{ name: string; suspended?: unknown }> }).data;

      expect(apps.find((a) => a.name === 'shop')?.suspended).toEqual({ kind: 'record', at: record.at });
      expect(apps.find((a) => a.name === 'other')?.suspended).toBeUndefined();
    });
  });
});
