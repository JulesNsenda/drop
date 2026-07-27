/**
 * The DROP-075 × DROP-076 intersection.
 *
 * DROP-076 (#108) made DELETE /apps/:name destroy name-keyed artifacts on
 * disk — the app's log directories and its DROP_DATA_DIR. DROP-075 changes
 * who may reach that verb (destructive methods gated at `user`). Each branch
 * covers its own half; neither pins the intersection, which is where the
 * damage would be.
 *
 * The invariant: the role gate must run BEFORE the purge, not merely return
 * 403 alongside it. Asserting only the status code would still pass if the
 * purge were hoisted into a pre-handler or the middleware order flipped — and
 * a readonly caller would then wipe the artifacts of an app it is forbidden
 * to delete, leaving a 403 in the response and no trace in app state.
 *
 * Lives in its own file deliberately: two route-test describe blocks in one
 * file hang the Jest worker (each passes alone, no handle reported by
 * --detectOpenHandles). One concern per file.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, createApiKey, resetAuth } from '../middleware/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import * as runtimeModule from '../../managers/runtime';
import type { AppRuntime } from '../../managers/runtime';
import * as databaseModule from '../../managers/database';
import type { DatabaseProvisioner } from '../../managers/database';
import { setPlatformOps, resetPlatformOps, PlatformOps } from '../platform-ops';

function makeOps(overrides?: Partial<PlatformOps>): PlatformOps {
  return {
    restartApp: jest.fn(),
    isAppInProgress: jest.fn().mockReturnValue(false),
    removeGroup: jest.fn().mockResolvedValue({ removed: [] }),
    purgeAppArtifacts: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

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

describe('a role-gated DELETE does not reach the artifact purge', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let bobId: string;
  let purgeAppArtifacts: jest.Mock;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-gate-purge-'));
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

    purgeAppArtifacts = jest.fn().mockResolvedValue(undefined);
    setPlatformOps(makeOps({ purgeAppArtifacts }));

    server = new ApiServer({
      port: 3096,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    const bob = await createUser('bob-purge', 'password123', 'user');
    bobId = bob.id;

    await getStateManager().registerApp('bobapp', path.join(tempDir, 'bobapp'), 'nodejs');
    await getStateManager().updateApp('bobapp', { userId: bobId });
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetAuth();
    resetPlatformOps();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('does not purge artifacts when a readonly key is refused', async () => {
    const { key } = await createApiKey('bob-ro-purge', 'readonly', undefined, undefined, bobId);

    const res = await app.request('/api/v1/apps/bobapp', {
      method: 'DELETE',
      headers: { 'X-API-Key': key },
    });

    // Asserted FIRST, deliberately. This is the invariant the file exists for,
    // and the status check would otherwise fail ahead of it on every
    // regression — leaving the purge assertion permanently unexercised. The
    // app surviving in state is not sufficient either: the purge targets the
    // filesystem and leaves no trace in state.
    expect(purgeAppArtifacts).not.toHaveBeenCalled();
    expect(res.status).toBe(403);
    expect(getStateManager().getApp('bobapp')).toBeDefined();
  });

  it('still purges artifacts for a key that passes the gate', async () => {
    // The other half — the gate must not have broken the legitimate delete.
    // Without this, removing the purge call entirely would satisfy the test
    // above and look like a pass.
    const { key } = await createApiKey('bob-rw-purge', 'user', undefined, undefined, bobId);

    const res = await app.request('/api/v1/apps/bobapp', {
      method: 'DELETE',
      headers: { 'X-API-Key': key },
    });

    expect(res.status).toBe(200);
    expect(purgeAppArtifacts).toHaveBeenCalledWith('bobapp', { keepData: false });
    expect(getStateManager().getApp('bobapp')).toBeUndefined();
  });
});
