/**
 * GET / POST /api/v1/apps/:name/rollback (#296).
 *
 * The platform op is stubbed — its behaviour is platform.rollback.test.ts's
 * job. What is pinned here: ownership (a foreign app is a plain 404), the role
 * floor (a readonly token may ask, not act), a missing snapshot is a clear 409
 * rather than a 500, and every answer says what a rollback does NOT restore.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createUser } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import {
  createTestApiServer,
  teardownTestApiServer,
  type TestApiServer,
} from '../__testutils__/api-server';
import { makePlatformOpsStub } from '../__testutils__/platform-ops';
import { setPlatformOps } from '../platform-ops';
import { getStateManager } from '../../managers/app/state-manager';
import {
  initRollbackStore,
  resetRollbackStore,
  getRollbackStore,
  NoRollbackSnapshotError,
  NOT_RESTORED,
  captureBeforeRedeploy,
} from '../../managers/rollback';
import * as diskUtils from '../../utils/disk';

describe('/api/v1/apps/:name/rollback (#296)', () => {
  let t: TestApiServer;
  let aliceId: string;
  let alice: string;
  let bob: string;
  let reader: string;
  let rollbackApp: jest.Mock;
  let describeRollback: jest.Mock;

  const call = (method: 'GET' | 'POST', token: string, name = 'web') =>
    t.hono.request(`/api/v1/apps/${name}/rollback`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    });

  beforeEach(async () => {
    t = await createTestApiServer({ port: 3198, tempPrefix: 'drop-rollback-routes-' });
    jest.spyOn(diskUtils, 'hasEnoughDisk').mockResolvedValue({ ok: true, freeMb: 999999 });
    initRollbackStore(t.tempDir);

    aliceId = (await createUser('alice', 'password123', 'user')).id;
    await createUser('bob', 'password123', 'user');
    await createUser('reader', 'password123', 'readonly');
    alice = await getTestToken('alice', 'password123');
    bob = await getTestToken('bob', 'password123');
    reader = await getTestToken('reader', 'password123');

    const appPath = path.join(t.tempDir, 'webapps', 'web');
    await fs.mkdir(appPath, { recursive: true });
    await fs.writeFile(path.join(appPath, 'index.html'), 'v1');
    await getStateManager().registerApp('web', appPath);
    await getStateManager().updateApp('web', { userId: aliceId, status: 'running' });

    rollbackApp = jest.fn().mockResolvedValue({
      meta: { appName: 'web', takenAt: '2026-09-01T00:00:00.000Z', bytes: 2, outputDirectory: 'dist' },
      info: { name: 'web', status: 'running' },
    });
    // What the platform reports for an app without a previous release: the
    // snapshot store's answer.
    describeRollback = jest.fn(async (name: string) => {
      const meta = await getRollbackStore()?.get(name);
      return meta ? { ...meta, kind: 'snapshot' } : null;
    });
    setPlatformOps(makePlatformOpsStub({ rollbackApp, describeRollback }));
  });

  afterEach(async () => {
    resetRollbackStore();
    await teardownTestApiServer(t);
  });

  it("answers someone else's app exactly like a missing one", async () => {
    const foreign = await call('POST', bob);
    const missing = await call('POST', bob, 'nothing');

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(rollbackApp).not.toHaveBeenCalled();
    expect((await call('GET', bob)).status).toBe(404);
  });

  it('reports availability, and what a rollback would not restore', async () => {
    const before = (await (await call('GET', alice)).json()) as { data: Record<string, unknown> };
    expect(before.data).toEqual({ app: 'web', available: false });

    expect((await captureBeforeRedeploy('web')).captured).toBe(true);

    const after = (await (await call('GET', alice)).json()) as { data: Record<string, unknown> };
    expect(after.data).toEqual(
      expect.objectContaining({ available: true, source: 'snapshot', doesNotRestore: [...NOT_RESTORED] })
    );
  });

  it('reports a previous release as the rollback source (#298 step 6)', async () => {
    describeRollback.mockResolvedValue({
      appName: 'web',
      takenAt: '2026-09-02T00:00:00.000Z',
      bytes: 10,
      kind: 'release',
    });

    const res = (await (await call('GET', alice)).json()) as { data: Record<string, unknown> };

    expect(res.data).toEqual(
      expect.objectContaining({
        available: true,
        source: 'release',
        snapshotTakenAt: '2026-09-02T00:00:00.000Z',
        doesNotRestore: [...NOT_RESTORED],
      })
    );
  });

  it('rolls back and says exactly what it did and did not restore', async () => {
    const res = await call('POST', alice);

    expect(res.status).toBe(200);
    expect(rollbackApp).toHaveBeenCalledWith('web');
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(body.data).toEqual(
      expect.objectContaining({
        snapshotTakenAt: '2026-09-01T00:00:00.000Z',
        restores: ['code', 'build output', 'dependencies', 'output directory'],
        doesNotRestore: ['database', 'redis', 'appdata', 'secrets', 'environment'],
      })
    );
  });

  it('is a clear 409, not a 500, when there is nothing to roll back to', async () => {
    rollbackApp.mockRejectedValue(new NoRollbackSnapshotError('web'));

    const res = await call('POST', alice);

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('No rollback snapshot');
    expect(body.error.message).toContain('redeploy replaces a running app');
  });

  it('lets a readonly token ask, but not act', async () => {
    // Readonly can see the app only if it owns it; the floor must refuse the
    // POST before ownership is even considered.
    expect((await call('POST', reader)).status).toBe(403);
    expect(rollbackApp).not.toHaveBeenCalled();
  });
});
