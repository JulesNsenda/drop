/**
 * Object storage is the one backing service whose teardown destroys data with
 * no backup, so detaching it — and deleting an app that holds a bucket —
 * demands an interactive session and an explicit `?confirm=<name>`, enforced
 * on the SERVER (#301). The dashboard's dialog is a courtesy, not the control.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, createApiKey, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { resetAppConfigService } from '../../managers/app/app-config';
import * as runtimeModule from '../../managers/runtime';
import type { AppRuntime } from '../../managers/runtime';
import * as databaseModule from '../../managers/database';
import type { DatabaseProvisioner } from '../../managers/database';
import { setPlatformOps, resetPlatformOps, PlatformOps } from '../platform-ops';
import { makePlatformOpsStub } from '../__testutils__/platform-ops';
import { ErrorCodes } from '../types';

function makeMockRuntime(): AppRuntime {
  return {
    type: 'pm2',
    start: jest.fn(),
    stop: jest.fn().mockResolvedValue(undefined),
    restart: jest.fn(),
    delete: jest.fn().mockResolvedValue(undefined),
    getStatus: jest.fn().mockResolvedValue(null),
    getAllStatus: jest.fn().mockResolvedValue([]),
    getLogs: jest.fn().mockResolvedValue(''),
    streamLogs: jest.fn().mockResolvedValue(() => undefined),
    getLogPaths: jest.fn().mockResolvedValue({}),
    disconnect: jest.fn(),
  } as unknown as AppRuntime;
}

describe('destroying a bucket needs an interactive session and a confirmation (#301)', () => {
  let tempDir: string;
  let server: ApiServer;
  let hono: ReturnType<ApiServer['getApp']>;
  let ownerToken: string;
  let ownerApiKey: string;
  let runtime: AppRuntime;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const ops = (overrides?: Partial<PlatformOps>) => setPlatformOps(makePlatformOpsStub(overrides));
  const del = (url: string, headers: Record<string, string> = bearer(ownerToken), env?: unknown) =>
    hono.request(url, { method: 'DELETE', headers }, env as never);
  /** The CLI's own key, exactly as the platform mints it at boot. */
  const mintLocalCliKey = async () => ({ 'X-API-Key': (await createApiKey('cli-local', 'admin')).key });
  /** What @hono/node-server hands the app for a request that arrived on this socket. */
  const fromLoopback = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-bucket-destruction-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetStateManager();
    resetAuth();
    resetAppConfigService();
    resetPlatformOps();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    runtime = makeMockRuntime();
    jest.spyOn(runtimeModule, 'getAppRuntime').mockReturnValue(runtime);
    jest.spyOn(databaseModule, 'getDatabaseProvisioner').mockReturnValue({
      backupAndDeleteAppDatabase: jest.fn().mockResolvedValue({ dropped: true }),
    } as unknown as DatabaseProvisioner);

    server = new ApiServer({
      port: 3094,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    hono = server.getApp();

    const owner = await createUser({ username: 'bucket-owner', role: 'user', credential: { password: 'password123' } });
    ownerToken = await getTestToken('bucket-owner', 'password123');
    ownerApiKey = (await createApiKey('owner-key', 'user', undefined, undefined, owner.id)).key;

    const sm = getStateManager();
    await sm.registerApp('site', path.join(tempDir, 'site'));
    await sm.updateApp('site', { userId: owner.id });
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetPlatformOps();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('DELETE /apps/:name/services/object-storage', () => {
    const detachResult = { detached: true, deprovisioned: true, drainPending: true, restart: 'restarted' } as const;

    it('refuses without ?confirm=<app>, touching nothing', async () => {
      const detachService = jest.fn().mockResolvedValue(detachResult);
      ops({ detachService });

      for (const url of [
        '/api/v1/apps/site/services/object-storage',
        '/api/v1/apps/site/services/object-storage?confirm=other',
        '/api/v1/apps/site/services/object-storage?confirm=',
      ]) {
        const res = await del(url);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string; details?: { reason: string } } };
        expect(body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
        expect(body.error.details?.reason).toBe('confirmation-required');
      }
      expect(detachService).not.toHaveBeenCalled();
    });

    it('refuses an API key even with the right confirmation', async () => {
      const detachService = jest.fn().mockResolvedValue(detachResult);
      ops({ detachService });

      const res = await del('/api/v1/apps/site/services/object-storage?confirm=site', { 'X-API-Key': ownerApiKey });

      expect(res.status).toBe(403);
      expect(detachService).not.toHaveBeenCalled();
    });

    it('refuses the CLI\'s own key for a detach: dashboard-only', async () => {
      const detachService = jest.fn().mockResolvedValue(detachResult);
      ops({ detachService });
      const cli = await mintLocalCliKey();

      const res = await del('/api/v1/apps/site/services/object-storage?confirm=site', cli, fromLoopback);

      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: { details?: { reason: string } } }).error.details?.reason).toBe('dashboard-only');
      expect(detachService).not.toHaveBeenCalled();
    });

    it('proceeds for an interactive session with the confirmation', async () => {
      const detachService = jest.fn().mockResolvedValue(detachResult);
      ops({ detachService });

      const res = await del('/api/v1/apps/site/services/object-storage?confirm=site');

      expect(res.status).toBe(200);
      expect(detachService).toHaveBeenCalledWith('site', 'object-storage');
    });

    it('does not ask for it on the services that do not destroy a bucket', async () => {
      const detachService = jest.fn().mockResolvedValue({ detached: true, deprovisioned: false, restart: 'not-needed' });
      ops({ detachService });

      expect((await del('/api/v1/apps/site/services/redis')).status).toBe(200);
      expect(detachService).toHaveBeenCalledWith('site', 'redis');
    });
  });

  describe('DELETE /apps/:name for an app that holds a bucket', () => {
    const withRisk = (risk: 'none' | 'bucket' | 'unknown') =>
      ops({ objectStorageDeleteRisk: jest.fn().mockResolvedValue(risk) });

    it('refuses without ?confirm=<app> when the app holds a bucket, stopping nothing', async () => {
      withRisk('bucket');

      const res = await del('/api/v1/apps/site');

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { details?: { reason: string } } }).error.details?.reason).toBe(
        'confirmation-required'
      );
      expect(runtime.stop).not.toHaveBeenCalled();
      expect(getStateManager().getApp('site')).toBeDefined();
    });

    it('answers 503, saying why, when the allocation store is unreadable — not a confirmation prompt', async () => {
      withRisk('unknown');

      for (const url of ['/api/v1/apps/site', '/api/v1/apps/site?confirm=site']) {
        const res = await del(url);
        expect(res.status).toBe(503);
        const body = (await res.json()) as { error: { code: string; message: string; details?: { reason: string } } };
        expect(body.error.code).toBe(ErrorCodes.SERVICE_UNAVAILABLE);
        expect(body.error.details?.reason).toBe('object-storage-unreadable');
        expect(body.error.message).toMatch(/unreadable/);
      }
      expect(runtime.stop).not.toHaveBeenCalled();
      expect(getStateManager().getApp('site')).toBeDefined();

      // keepData keeps any bucket, so it is the way out.
      expect((await del('/api/v1/apps/site?keepData=true')).status).toBe(200);
    });

    it('refuses the CLI\'s own key for a bucket-destroying delete: destroying a bucket is dashboard-only', async () => {
      withRisk('bucket');
      const cli = await mintLocalCliKey();

      // With and without the confirmation, from a direct loopback connection.
      for (const url of ['/api/v1/apps/site', '/api/v1/apps/site?confirm=site']) {
        const res = await del(url, cli, fromLoopback);
        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { message: string; details?: { reason: string } } };
        expect(body.error.details?.reason).toBe('dashboard-only');
        expect(body.error.message).toMatch(/dashboard/);
        expect(body.error.message).toMatch(/keepData=true/);
      }
      expect(runtime.stop).not.toHaveBeenCalled();
      expect(getStateManager().getApp('site')).toBeDefined();
    });

    it('lets the CLI delete the app and KEEP the bucket (keepData), which destroys nothing', async () => {
      withRisk('bucket');
      const cli = await mintLocalCliKey();

      expect((await del('/api/v1/apps/site?keepData=true', cli, fromLoopback)).status).toBe(200);
      expect(getStateManager().getApp('site')).toBeUndefined();
    });

    it('refuses every other credential with the confirmation too: other admin keys, owned admin keys, agent tokens', async () => {
      withRisk('bucket');
      const admin = await createUser({ username: 'boss', role: 'admin', credential: { password: 'password123' } });
      const keys: Record<string, string> = {
        'ownerless admin key under another name': (await createApiKey('deploy-bot', 'admin')).key,
        'owned admin key even if named cli-local': (await createApiKey('cli-local', 'admin', undefined, undefined, admin.id)).key,
        'agent token': (
          await createApiKey('agent', 'admin', undefined, undefined, admin.id, { expiresInMinutes: 30, kind: 'agent' })
        ).key,
      };

      for (const [label, key] of Object.entries(keys)) {
        const res = await del('/api/v1/apps/site?confirm=site', { 'X-API-Key': key });
        expect({ label, status: res.status }).toEqual({ label, status: 403 });
      }
      expect(getStateManager().getApp('site')).toBeDefined();
    });

    it('refuses an API key even with the right confirmation', async () => {
      withRisk('bucket');

      const res = await del('/api/v1/apps/site?confirm=site', { 'X-API-Key': ownerApiKey });

      expect(res.status).toBe(403);
      expect(runtime.stop).not.toHaveBeenCalled();
      expect(getStateManager().getApp('site')).toBeDefined();
    });

    it('deletes for an interactive session with the confirmation', async () => {
      withRisk('bucket');

      const res = await del('/api/v1/apps/site?confirm=site');

      expect(res.status).toBe(200);
      expect(getStateManager().getApp('site')).toBeUndefined();
    });

    it('needs nothing extra with keepData, which keeps the bucket', async () => {
      withRisk('bucket');

      const res = await del('/api/v1/apps/site?keepData=true', { 'X-API-Key': ownerApiKey });

      expect(res.status).toBe(200);
      expect(getStateManager().getApp('site')).toBeUndefined();
    });

    it('applies the same gate to a group delete, which destroys every child bucket', async () => {
      const sm = getStateManager();
      const owner = (await sm.getApp('site'))!.userId;
      await sm.registerApp('mono-web', path.join(tempDir, 'mono-web'));
      await sm.updateApp('mono-web', { userId: owner, group: 'mono' });
      const removeGroup = jest.fn().mockResolvedValue({ removed: ['mono-web'] });
      ops({
        removeGroup,
        objectStorageDeleteRisk: jest.fn(async (n: string) => (n === 'mono-web' ? 'bucket' : 'none')),
      });

      expect((await del('/api/v1/apps/mono')).status).toBe(400);
      expect((await del('/api/v1/apps/mono?confirm=mono', { 'X-API-Key': ownerApiKey })).status).toBe(403);
      expect(removeGroup).not.toHaveBeenCalled();

      expect((await del('/api/v1/apps/mono?confirm=mono')).status).toBe(200);
      expect(removeGroup).toHaveBeenCalledWith('mono');
    });

    it('refuses the CLI\'s own key for a bucket-destroying group delete too', async () => {
      const sm = getStateManager();
      const owner = (await sm.getApp('site'))!.userId;
      await sm.registerApp('mono-web', path.join(tempDir, 'mono-web'));
      await sm.updateApp('mono-web', { userId: owner, group: 'mono' });
      const removeGroup = jest.fn().mockResolvedValue({ removed: ['mono-web'] });
      ops({
        removeGroup,
        objectStorageDeleteRisk: jest.fn(async (n: string) => (n === 'mono-web' ? 'bucket' : 'none')),
      });
      const cli = await mintLocalCliKey();

      expect((await del('/api/v1/apps/mono?confirm=mono', cli, fromLoopback)).status).toBe(403);
      expect(removeGroup).not.toHaveBeenCalled();
    });

    it('answers 503 for a group delete when a child allocation store is unreadable', async () => {
      const sm = getStateManager();
      const owner = (await sm.getApp('site'))!.userId;
      await sm.registerApp('mono-web', path.join(tempDir, 'mono-web'));
      await sm.updateApp('mono-web', { userId: owner, group: 'mono' });
      const removeGroup = jest.fn().mockResolvedValue({ removed: ['mono-web'] });
      ops({ removeGroup, objectStorageDeleteRisk: jest.fn().mockResolvedValue('unknown') });

      expect((await del('/api/v1/apps/mono?confirm=mono')).status).toBe(503);
      expect(removeGroup).not.toHaveBeenCalled();
    });

    it('needs nothing extra for an app without a bucket (an API key still deletes)', async () => {
      withRisk('none');

      const res = await del('/api/v1/apps/site', { 'X-API-Key': ownerApiKey });

      expect(res.status).toBe(200);
    });
  });
});
