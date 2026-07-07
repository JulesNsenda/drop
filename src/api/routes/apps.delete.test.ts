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
