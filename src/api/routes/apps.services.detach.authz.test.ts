/**
 * Authorization regression pin for DELETE /apps/:name/services/:id
 * (DROP-151 Phase 3 detach). Modelled on `secrets.authz.test.ts`.
 *
 * This repo's convention is a dedicated `*.authz.test.ts` per protected
 * surface, and this route had none — the `readonly` rejection lives only in
 * server.ts's hand-rolled method-scoped `use()` block (`v1.use('/apps/*',
 * ...)`, gating DELETE/PUT/PATCH/POST at >= 'user'), not in the route
 * itself, so a future edit to that block could silently expose data
 * destruction to readonly tokens with an otherwise-green suite.
 * `apps.services.routes.test.ts` already covers the same posture for the
 * POST (attach) route; this file is its DELETE (detach) counterpart.
 *
 * Follows the standalone-ApiServer + `setPlatformOps` stubbing pattern in
 * `apps.services.routes.test.ts` (no real platform is booted).
 */

import * as path from 'path';
import { createUser } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { createTestApiServer, teardownTestApiServer, type TestApiServer } from '../__testutils__/api-server';
import { makePlatformOpsStub } from '../__testutils__/platform-ops';
import { getStateManager } from '../../managers/app/state-manager';
import { getActivityLog } from '../../managers/activity';
import { setPlatformOps, resetPlatformOps, DetachServiceResult } from '../platform-ops';

describe('DELETE /apps/:name/services/:id authorization (DROP-151 Phase 3 detach)', () => {
  let t: TestApiServer;
  let ownerToken: string;
  let ownerId: string;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
  const detach = (name: string, serviceId: string, token: string) =>
    t.hono.request(`/api/v1/apps/${name}/services/${serviceId}`, {
      method: 'DELETE',
      headers: authHeader(token),
    });

  beforeEach(async () => {
    t = await createTestApiServer({ port: 3102, tempPrefix: 'drop-detach-service-authz-', activityLog: true });

    const owner = await createUser('owner', 'password123', 'user');
    ownerId = owner.id;
    ownerToken = await getTestToken('owner', 'password123');

    const sm = getStateManager();
    await sm.registerApp('test-app', path.join(t.tempDir, 'test-app'));
    await sm.updateApp('test-app', { userId: ownerId });
  });

  afterEach(async () => {
    await teardownTestApiServer(t, { activityLog: true });
  });

  afterAll(() => {
    resetPlatformOps();
  });

  // --- Positive control first: a typo'd URL prefix would make every
  // negative assertion below pass while pinning nothing. -----------------
  it('lets a user-role owner through the guard (200)', async () => {
    const ops = makePlatformOpsStub();
    setPlatformOps(ops);

    const res = await detach('test-app', 'postgres', ownerToken);
    expect(res.status).toBe(200);
    expect(ops.detachService).toHaveBeenCalledWith('test-app', 'postgres');
  });

  it('blocks a readonly-role token with 403 (DELETE is gated at >= user) and never calls detachService', async () => {
    await createUser('viewer', 'password123', 'readonly');
    const viewerToken = await getTestToken('viewer', 'password123');
    const ops = makePlatformOpsStub();
    setPlatformOps(ops);

    const res = await detach('test-app', 'postgres', viewerToken);
    expect(res.status).toBe(403);
    expect(ops.detachService).not.toHaveBeenCalled();
  });

  it("404s (not 403) when a non-owning user-role caller detaches another user's app -- no existence oracle", async () => {
    await createUser('intruder', 'password123', 'user');
    const intruderToken = await getTestToken('intruder', 'password123');
    const ops = makePlatformOpsStub();
    setPlatformOps(ops);

    const res = await detach('test-app', 'postgres', intruderToken);
    expect(res.status).toBe(404);
    expect(ops.detachService).not.toHaveBeenCalled();
  });

  it('404s (not 403) for an app that does not exist at all -- matches the foreign-app 404 (no existence oracle)', async () => {
    const ops = makePlatformOpsStub();
    setPlatformOps(ops);

    const res = await detach('no-such-app', 'postgres', ownerToken);
    expect(res.status).toBe(404);
    expect(ops.detachService).not.toHaveBeenCalled();
  });

  it("lets an admin detach another user's app", async () => {
    await createUser('root', 'password123', 'admin');
    const adminToken = await getTestToken('root', 'password123');
    const ops = makePlatformOpsStub();
    setPlatformOps(ops);

    const res = await detach('test-app', 'postgres', adminToken);
    expect(res.status).toBe(200);
    expect(ops.detachService).toHaveBeenCalledWith('test-app', 'postgres');
  });
});

describe('DELETE /apps/:name/services/:id — refusal detail and audit-log shape (DROP-151 Phase 3)', () => {
  let t: TestApiServer;
  let ownerToken: string;
  let ownerId: string;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
  const detach = (name: string, serviceId: string, token: string) =>
    t.hono.request(`/api/v1/apps/${name}/services/${serviceId}`, {
      method: 'DELETE',
      headers: authHeader(token),
    });

  beforeEach(async () => {
    t = await createTestApiServer({ port: 3103, tempPrefix: 'drop-detach-service-fixes-', activityLog: true });

    const owner = await createUser('owner2', 'password123', 'user');
    ownerId = owner.id;
    ownerToken = await getTestToken('owner2', 'password123');

    const sm = getStateManager();
    await sm.registerApp('test-app', path.join(t.tempDir, 'test-app'));
    await sm.updateApp('test-app', { userId: ownerId });
  });

  afterEach(async () => {
    await teardownTestApiServer(t, { activityLog: true });
  });

  afterAll(() => {
    resetPlatformOps();
  });

  it('a backup-failed refusal carries the restart outcome so the client can tell the app is still down', async () => {
    const ops = makePlatformOpsStub({
      detachService: jest.fn().mockResolvedValue({
        detached: false,
        reason: 'backup-failed',
        detail: 'The database backup could not be completed.',
        restart: 'failed',
      } satisfies DetachServiceResult),
    });
    setPlatformOps(ops);

    const res = await detach('test-app', 'postgres', ownerToken);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { details: { reason: string; restart: string } } };
    expect(body.error.details.reason).toBe('backup-failed');
    expect(body.error.details.restart).toBe('failed');
  });

  it('a backup-failed refusal with restart:needs-config also carries missingSecrets', async () => {
    const ops = makePlatformOpsStub({
      detachService: jest.fn().mockResolvedValue({
        detached: false,
        reason: 'backup-failed',
        detail: 'The database backup could not be completed.',
        restart: 'needs-config',
        missingSecrets: ['API_KEY'],
      } satisfies DetachServiceResult),
    });
    setPlatformOps(ops);

    const res = await detach('test-app', 'postgres', ownerToken);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { details: { reason: string; restart: string; missingSecrets: string[] } };
    };
    expect(body.error.details.restart).toBe('needs-config');
    expect(body.error.details.missingSecrets).toEqual(['API_KEY']);
  });

  // 'deprovision-failed' is the reported-Redis-flush refusal's replacement —
  // it gets the exact same audited, restart-outcome-carrying treatment as
  // backup-failed, since both are the arm where the persisted 'detached'
  // intent already changed durable state before the refusal happened.
  it('a deprovision-failed refusal carries the restart outcome exactly like backup-failed', async () => {
    const ops = makePlatformOpsStub({
      detachService: jest.fn().mockResolvedValue({
        detached: false,
        reason: 'deprovision-failed',
        detail: 'Redis could not be reached to deprovision this app.',
        restart: 'failed',
      } satisfies DetachServiceResult),
    });
    setPlatformOps(ops);

    const res = await detach('test-app', 'redis', ownerToken);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { details: { reason: string; restart: string } } };
    expect(body.error.details.reason).toBe('deprovision-failed');
    expect(body.error.details.restart).toBe('failed');

    const { entries } = getActivityLog().getEntries();
    expect(entries.find(e => e.action === 'detach-service')).toBeDefined();
  });

  it('a refusal reason that carries no restart outcome (e.g. group-app) never fabricates one', async () => {
    const ops = makePlatformOpsStub({
      detachService: jest.fn().mockResolvedValue({
        detached: false,
        reason: 'group-app',
        detail: "'test-app' is part of a monorepo group.",
      } satisfies DetachServiceResult),
    });
    setPlatformOps(ops);

    const res = await detach('test-app', 'postgres', ownerToken);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { details: { reason: string; restart?: string } } };
    expect(body.error.details.reason).toBe('group-app');
    expect(body.error.details.restart).toBeUndefined();
  });

  it('an unexpected throw never leaks raw error text (which can embed the pg socket / pre-delete dump path)', async () => {
    const sensitive = `pg_dump: error: connection failed: could not connect to server: No such file or directory\n\tIs the server running locally and accepting connections on Unix domain socket "${t.tempDir}\\data\\db\\.s.PGSQL.5433"?`;
    const ops = makePlatformOpsStub({
      detachService: jest.fn().mockRejectedValue(new Error(sensitive)),
    });
    setPlatformOps(ops);

    const res = await detach('test-app', 'postgres', ownerToken);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Failed to detach service');
    expect(body.error.message).not.toContain(t.tempDir);
    expect(JSON.stringify(body)).not.toContain('PGSQL');
  });
});
