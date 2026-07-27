/**
 * DELETE /api/v1/apps/:name — dump-then-drop database teardown.
 *
 * Covers the wiring added for docs/plans/2026-07-07-dump-then-drop-on-delete.md:
 * the DB step runs (and its outcome is reported) on a normal delete, is
 * skipped entirely when `?keepData=true`, and is non-fatal — the app is
 * still fully removed even if the DB teardown throws.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import * as runtimeModule from '../../managers/runtime';
import type { AppRuntime } from '../../managers/runtime';
import * as databaseModule from '../../managers/database';
import type { DatabaseProvisioner } from '../../managers/database';
import * as routerModule from '../../core/router';
import { setPlatformOps, resetPlatformOps, PlatformOps } from '../platform-ops';
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

describe('DELETE /api/v1/apps/:name — database teardown', () => {
  let tempDir: string;
  let server: ApiServer;
  let hono: ReturnType<ApiServer['getApp']>;
  let ownerToken: string;
  let ownerId: string;
  let backupAndDeleteAppDatabase: jest.Mock;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-delete-db-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetStateManager();
    resetAuth();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    jest.spyOn(runtimeModule, 'getAppRuntime').mockReturnValue(makeMockRuntime());

    backupAndDeleteAppDatabase = jest.fn().mockResolvedValue({ dropped: true });
    jest.spyOn(databaseModule, 'getDatabaseProvisioner').mockReturnValue({
      backupAndDeleteAppDatabase,
    } as unknown as DatabaseProvisioner);

    server = new ApiServer({
      port: 3098,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    hono = server.getApp();

    const owner = await createUser('db-owner', 'password123', 'user');
    ownerId = owner.id;
    ownerToken = await getTestToken('db-owner', 'password123');

    const sm = getStateManager();
    await sm.registerApp('db-app', path.join(tempDir, 'db-app'));
    await sm.updateApp('db-app', { userId: ownerId });
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('drops the database on a normal delete and reports it in the response', async () => {
    const res = await hono.request('/api/v1/apps/db-app', {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });

    expect(res.status).toBe(200);
    expect(backupAndDeleteAppDatabase).toHaveBeenCalledWith('db-app');
    const body = (await res.json()) as { data: { database: string } };
    expect(body.data.database).toBe('dropped');
    expect(getStateManager().getApp('db-app')).toBeUndefined();
  });

  it('skips the DB teardown and preserves the database with ?keepData=true', async () => {
    const res = await hono.request('/api/v1/apps/db-app?keepData=true', {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });

    expect(res.status).toBe(200);
    expect(backupAndDeleteAppDatabase).not.toHaveBeenCalled();
    const body = (await res.json()) as { data: { database: string } };
    expect(body.data.database).toBe('preserved');
    expect(getStateManager().getApp('db-app')).toBeUndefined();
  });

  it('still fully removes the app when the DB teardown throws (non-fatal)', async () => {
    backupAndDeleteAppDatabase.mockRejectedValueOnce(new Error('pg_dump: connection refused'));

    const res = await hono.request('/api/v1/apps/db-app', {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });

    expect(res.status).toBe(200);
    expect(backupAndDeleteAppDatabase).toHaveBeenCalledWith('db-app');
    const body = (await res.json()) as { data: { database: string } };
    expect(body.data.database).toBe('retained');
    expect(getStateManager().getApp('db-app')).toBeUndefined();
  });
});

describe('DELETE /api/v1/apps/:name — group-aware (M4)', () => {
  let tempDir: string;
  let server: ApiServer;
  let hono: ReturnType<ApiServer['getApp']>;
  let ownerToken: string;
  let ownerId: string;
  let removeGroup: jest.Mock;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  function makeOps(overrides?: Partial<PlatformOps>): PlatformOps {
    return {
      restartApp: jest.fn(),
      isAppInProgress: jest.fn().mockReturnValue(false), promoteApp: jest.fn(),
      removeGroup: jest.fn().mockResolvedValue({ removed: [] }),
      purgeAppArtifacts: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-delete-group-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetStateManager();
    resetAuth();
    resetPlatformOps();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    jest.spyOn(runtimeModule, 'getAppRuntime').mockReturnValue(makeMockRuntime());
    jest.spyOn(databaseModule, 'getDatabaseProvisioner').mockReturnValue({
      backupAndDeleteAppDatabase: jest.fn().mockResolvedValue({ dropped: true }),
    } as unknown as DatabaseProvisioner);

    server = new ApiServer({
      port: 3099,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
      appsDirectory: path.join(tempDir, 'webapps'),
    });
    await server.initialize();
    hono = server.getApp();

    const owner = await createUser('group-owner', 'password123', 'user');
    ownerId = owner.id;
    ownerToken = await getTestToken('group-owner', 'password123');

    removeGroup = jest.fn().mockResolvedValue({ removed: ['grp-backend', 'grp-frontend'] });

    const sm = getStateManager();
    await sm.registerApp('grp-backend', path.join(tempDir, 'webapps', 'grp-backend'));
    await sm.updateApp('grp-backend', { userId: ownerId, group: 'grp' });
    await sm.registerApp('grp-frontend', path.join(tempDir, 'webapps', 'grp-frontend'));
    await sm.updateApp('grp-frontend', { userId: ownerId, group: 'grp' });
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetPlatformOps();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('404s when neither an app nor a group with that name exists', async () => {
    setPlatformOps(makeOps({ removeGroup }));

    const res = await hono.request('/api/v1/apps/does-not-exist', {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });

    expect(res.status).toBe(404);
    expect(removeGroup).not.toHaveBeenCalled();
  });

  it('tears down the whole group via platformOps.removeGroup when :name matches no app but a group', async () => {
    setPlatformOps(makeOps({ removeGroup }));

    const res = await hono.request('/api/v1/apps/grp', {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });

    expect(res.status).toBe(200);
    expect(removeGroup).toHaveBeenCalledWith('grp');
    const body = (await res.json()) as { data: { removed: string[] } };
    expect(body.data.removed.sort()).toEqual(['grp-backend', 'grp-frontend']);
  });

  it('purges the deleted app name-keyed artifacts (logs + appdata)', async () => {
    // DELETE /apps/:name runs its own inline teardown rather than calling
    // platform.teardownApp (which only removeGroup uses), so cleaning up in
    // teardownApp alone would miss essentially every real deletion — and
    // deletion FREES THE NAME, so the residue becomes the next registrant's.
    const purgeAppArtifacts = jest.fn().mockResolvedValue(undefined);
    setPlatformOps(makeOps({ removeGroup, purgeAppArtifacts }));

    const res = await hono.request('/api/v1/apps/grp-backend', {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });

    expect(res.status).toBe(200);
    expect(purgeAppArtifacts).toHaveBeenCalledWith('grp-backend', { keepData: false });
  });

  it('honours ?keepData=true when purging artifacts', async () => {
    const purgeAppArtifacts = jest.fn().mockResolvedValue(undefined);
    setPlatformOps(makeOps({ removeGroup, purgeAppArtifacts }));

    const res = await hono.request('/api/v1/apps/grp-backend?keepData=true', {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });

    expect(res.status).toBe(200);
    expect(purgeAppArtifacts).toHaveBeenCalledWith('grp-backend', { keepData: true });
  });

  it('still succeeds when artifact purging fails', async () => {
    // Cleanup is best-effort; it must never fail a delete that already happened.
    const purgeAppArtifacts = jest.fn().mockRejectedValue(new Error('disk gone'));
    setPlatformOps(makeOps({ removeGroup, purgeAppArtifacts }));

    const res = await hono.request('/api/v1/apps/grp-backend', {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });

    expect(res.status).toBe(200);
  });

  it('503s the group branch when platform ops is unavailable', async () => {
    // Deliberately not calling setPlatformOps — mirrors a standalone ApiServer.
    const res = await hono.request('/api/v1/apps/grp', {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });

    expect(res.status).toBe(503);
  });

  it('404s the group delete when not every child is owned by the requester (IDOR guard)', async () => {
    setPlatformOps(makeOps({ removeGroup }));

    // A second child of the SAME group, owned by someone else.
    const otherOwner = await createUser('other-owner', 'password123', 'user');
    const sm = getStateManager();
    await sm.registerApp('grp-extra', path.join(tempDir, 'webapps', 'grp-extra'));
    await sm.updateApp('grp-extra', { userId: otherOwner.id, group: 'grp' });

    const res = await hono.request('/api/v1/apps/grp', {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });

    expect(res.status).toBe(404);
    expect(removeGroup).not.toHaveBeenCalled();
  });

  it('removes the group container folder when the deleted app was the LAST remaining child', async () => {
    setPlatformOps(makeOps({ removeGroup }));
    // `fs/promises` is a built-in ESM namespace here — its properties aren't
    // configurable, so `jest.spyOn(fs, 'rm')` throws. Assert the real,
    // observable effect (the container folder is actually gone) instead.
    const containerDir = path.join(tempDir, 'webapps', 'grp');
    await fs.mkdir(containerDir, { recursive: true });
    await fs.writeFile(path.join(containerDir, 'drop.yaml'), 'services:\n  backend: {}\n  frontend: {}\n');

    // Delete grp-backend first — grp-frontend is still around, so no cleanup yet.
    await hono.request('/api/v1/apps/grp-backend', {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });
    await expect(fs.access(containerDir)).resolves.toBeUndefined();

    // Now delete the LAST remaining child.
    const res = await hono.request('/api/v1/apps/grp-frontend', {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });

    expect(res.status).toBe(200);
    await expect(fs.access(containerDir)).rejects.toThrow();
  });

  it('does NOT remove the group container folder while siblings remain', async () => {
    setPlatformOps(makeOps({ removeGroup }));
    const containerDir = path.join(tempDir, 'webapps', 'grp');
    await fs.mkdir(containerDir, { recursive: true });
    await fs.writeFile(path.join(containerDir, 'drop.yaml'), 'services:\n  backend: {}\n  frontend: {}\n');

    const res = await hono.request('/api/v1/apps/grp-backend', {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });

    expect(res.status).toBe(200);
    await expect(fs.access(containerDir)).resolves.toBeUndefined();
  });

  // Regression guards for the phantom-container bug: the deploy-from-git path
  // registers the cloned repo itself as a state entry (tagged isGroupContainer
  // by expandMonorepo). Deleting it as a single app would rm the cloned repo
  // folder and orphan the children — DELETE on it must mean "delete the group".
  describe('container entries', () => {
    beforeEach(async () => {
      const sm = getStateManager();
      // Container entry named differently from the group on purpose — proves
      // the route resolves the group via the entry's tag, not its name.
      await sm.registerApp('grp-repo', path.join(tempDir, 'webapps', 'grp-repo'));
      await sm.updateApp('grp-repo', { userId: ownerId, group: 'grp', isGroupContainer: true });
    });

    it('DELETE on a container entry tears down the whole group via its group tag', async () => {
      setPlatformOps(makeOps({ removeGroup }));

      const res = await hono.request('/api/v1/apps/grp-repo', {
        method: 'DELETE',
        headers: authHeader(ownerToken),
      });

      expect(res.status).toBe(200);
      expect(removeGroup).toHaveBeenCalledWith('grp');
      const body = (await res.json()) as { data: { message: string } };
      expect(body.data.message).toContain("Group 'grp' removed");
    });

    it("404s a container DELETE when the requester can't access the container", async () => {
      setPlatformOps(makeOps({ removeGroup }));
      const stranger = await createUser('stranger', 'password123', 'user');
      void stranger;
      const strangerToken = await getTestToken('stranger', 'password123');

      const res = await hono.request('/api/v1/apps/grp-repo', {
        method: 'DELETE',
        headers: authHeader(strangerToken),
      });

      expect(res.status).toBe(404);
      expect(removeGroup).not.toHaveBeenCalled();
    });

    it('GET /apps hides container entries but lists the real children', async () => {
      setPlatformOps(makeOps({ removeGroup }));

      const res = await hono.request('/api/v1/apps', {
        headers: authHeader(ownerToken),
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ name: string }> };
      const names = body.data.map(a => a.name).sort();
      expect(names).toEqual(['grp-backend', 'grp-frontend']);
    });

    it('deleting the LAST real child also removes the container state entry', async () => {
      setPlatformOps(makeOps({ removeGroup }));

      await hono.request('/api/v1/apps/grp-backend', {
        method: 'DELETE',
        headers: authHeader(ownerToken),
      });
      // Container survives while a sibling remains.
      expect(getStateManager().getApp('grp-repo')).toBeDefined();

      const res = await hono.request('/api/v1/apps/grp-frontend', {
        method: 'DELETE',
        headers: authHeader(ownerToken),
      });

      expect(res.status).toBe(200);
      expect(getStateManager().getApp('grp-repo')).toBeUndefined();
    });

    // IDOR guards: group tags are tenant-influenced (drop.yaml group:/name:),
    // so a crafted group-name collision must never let one user's delete reach
    // another user's container entry/folder.
    it("404s a group-name DELETE when a colliding container belongs to someone else", async () => {
      setPlatformOps(makeOps({ removeGroup }));
      const victim = await createUser('victim-owner', 'password123', 'user');
      const sm = getStateManager();
      await sm.updateApp('grp-repo', { userId: victim.id });

      const res = await hono.request('/api/v1/apps/grp', {
        method: 'DELETE',
        headers: authHeader(ownerToken),
      });

      expect(res.status).toBe(404);
      expect(removeGroup).not.toHaveBeenCalled();
    });

    it("last-child delete does NOT cascade into another user's colliding container", async () => {
      setPlatformOps(makeOps({ removeGroup }));
      const victim = await createUser('victim-owner2', 'password123', 'user');
      const sm = getStateManager();
      await sm.updateApp('grp-repo', { userId: victim.id });

      await hono.request('/api/v1/apps/grp-backend', {
        method: 'DELETE',
        headers: authHeader(ownerToken),
      });
      const res = await hono.request('/api/v1/apps/grp-frontend', {
        method: 'DELETE',
        headers: authHeader(ownerToken),
      });

      // The requester's own children are gone, but the foreign container survives.
      expect(res.status).toBe(200);
      expect(getStateManager().getApp('grp-repo')).toBeDefined();
    });
  });
});

describe('DELETE /api/v1/apps/:name — in-progress guard (M4)', () => {
  // Regression coverage for docs/plan/python-docker-runtime-fixes.md §M4: a
  // DELETE issued while a build/hot-reload still holds the app in
  // appsInProgress used to wipe the app's state, so the build's later
  // setAppStatus('errored') became a no-op and the operator saw "not found"
  // instead of "errored". The route now checks PlatformOps.isAppInProgress
  // up front and 409s instead of tearing anything down.
  let tempDir: string;
  let server: ApiServer;
  let hono: ReturnType<ApiServer['getApp']>;
  let ownerToken: string;
  let ownerId: string;
  let runtime: AppRuntime;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  function makeOps(overrides?: Partial<PlatformOps>): PlatformOps {
    return {
      restartApp: jest.fn(),
      isAppInProgress: jest.fn().mockReturnValue(false), promoteApp: jest.fn(),
      removeGroup: jest.fn().mockResolvedValue({ removed: [] }),
      purgeAppArtifacts: jest.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-delete-inprogress-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetStateManager();
    resetAuth();
    resetPlatformOps();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    runtime = makeMockRuntime();
    jest.spyOn(runtimeModule, 'getAppRuntime').mockReturnValue(runtime);
    jest.spyOn(databaseModule, 'getDatabaseProvisioner').mockReturnValue({
      backupAndDeleteAppDatabase: jest.fn().mockResolvedValue({ dropped: true }),
    } as unknown as DatabaseProvisioner);

    server = new ApiServer({
      port: 3095,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    hono = server.getApp();

    const owner = await createUser('busy-owner', 'password123', 'user');
    ownerId = owner.id;
    ownerToken = await getTestToken('busy-owner', 'password123');

    const sm = getStateManager();
    await sm.registerApp('busy-app', path.join(tempDir, 'busy-app'));
    await sm.updateApp('busy-app', { userId: ownerId });
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetPlatformOps();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('409s and tears down nothing while the app is mid-build/deploy', async () => {
    setPlatformOps(makeOps({ isAppInProgress: jest.fn().mockReturnValue(true) }));

    const res = await hono.request('/api/v1/apps/busy-app', {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe(ErrorCodes.CONFLICT);

    // No teardown of any kind ran: the runtime was never stopped/deleted, and
    // the app's record is still present in state (not wiped to "not found").
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.delete).not.toHaveBeenCalled();
    expect(getStateManager().getApp('busy-app')).toBeDefined();
  });

  it('proceeds with the delete once nothing is in progress', async () => {
    setPlatformOps(makeOps({ isAppInProgress: jest.fn().mockReturnValue(false) }));

    const res = await hono.request('/api/v1/apps/busy-app', {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });

    expect(res.status).toBe(200);
    expect(runtime.stop).toHaveBeenCalledWith('busy-app');
    expect(getStateManager().getApp('busy-app')).toBeUndefined();
  });

  it('proceeds with the delete when platform ops is unwired (defense-in-depth only, matches upload-deploy route posture)', async () => {
    // Deliberately not calling setPlatformOps — mirrors a standalone
    // ApiServer. isAppInProgress is treated as "not in progress" rather than
    // blocking, same posture as platform-ops.ts documents for other callers.
    const res = await hono.request('/api/v1/apps/busy-app', {
      method: 'DELETE',
      headers: authHeader(ownerToken),
    });

    expect(res.status).toBe(200);
    expect(getStateManager().getApp('busy-app')).toBeUndefined();
  });
});

describe('POST /api/v1/apps/:name/stop — route cleanup (M4: route-leak fix)', () => {
  let tempDir: string;
  let server: ApiServer;
  let hono: ReturnType<ApiServer['getApp']>;
  let ownerToken: string;
  let ownerId: string;
  let removeRoutesForApp: jest.Mock;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-stop-route-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetStateManager();
    resetAuth();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    jest.spyOn(runtimeModule, 'getAppRuntime').mockReturnValue(makeMockRuntime());

    removeRoutesForApp = jest.fn().mockResolvedValue(undefined);
    jest.spyOn(routerModule, 'getRouterService').mockReturnValue({
      removeRoutesForApp,
    } as unknown as ReturnType<typeof routerModule.getRouterService>);

    server = new ApiServer({
      port: 3097,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    hono = server.getApp();

    const owner = await createUser('stop-owner', 'password123', 'user');
    ownerId = owner.id;
    ownerToken = await getTestToken('stop-owner', 'password123');

    const sm = getStateManager();
    await sm.registerApp('stop-app', path.join(tempDir, 'stop-app'));
    await sm.updateApp('stop-app', { userId: ownerId });
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('removes the app Caddy routes after stopping', async () => {
    const res = await hono.request('/api/v1/apps/stop-app/stop', {
      method: 'POST',
      headers: authHeader(ownerToken),
    });

    expect(res.status).toBe(200);
    expect(removeRoutesForApp).toHaveBeenCalledWith('stop-app');
  });

  it('still stops successfully (non-fatal) when route removal throws', async () => {
    removeRoutesForApp.mockRejectedValueOnce(new Error('caddy unreachable'));

    const res = await hono.request('/api/v1/apps/stop-app/stop', {
      method: 'POST',
      headers: authHeader(ownerToken),
    });

    expect(res.status).toBe(200);
    expect(removeRoutesForApp).toHaveBeenCalledWith('stop-app');
  });
});
