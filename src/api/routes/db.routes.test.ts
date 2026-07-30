/**
 * Database panel routes (M1 — DROP-120).
 *
 * Follows the standalone-ApiServer harness in certs.authz.test.ts. The
 * inspector module is mocked (no real PostgreSQL on this box); `DbUnavailableError`
 * is the REAL class (via jest.requireActual) so the route's `instanceof` checks
 * behave exactly as they do in production.
 *
 * Proves: no existence oracle (foreign/missing app both 404), the read paths
 * are session-only (an API key is refused even with admin role), the 'user'
 * role floor is actually bound (a readonly JWT is refused), `provisioned:false`
 * is a normal 200, every `DbUnavailableError` reason survives the onError
 * 500-collapse with its intended message, and reads never touch the activity
 * log.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, createApiKey, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { resetRateLimits } from '../middleware/rate-limit';
import { getActivityLog, resetActivityLog } from '../../managers/activity';
import type { DbOverview, DbTable } from '../../managers/database/app-db-inspector';

jest.mock('../../managers/database/app-db-inspector', () => {
  const actual = jest.requireActual('../../managers/database/app-db-inspector');
  return {
    ...actual,
    getOverview: jest.fn(),
    listTables: jest.fn(),
  };
});

import {
  getOverview,
  listTables,
  DbUnavailableError,
} from '../../managers/database/app-db-inspector';

const mockGetOverview = getOverview as jest.MockedFunction<typeof getOverview>;
const mockListTables = listTables as jest.MockedFunction<typeof listTables>;

describe('database panel routes (DROP-120)', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let aliceToken: string;
  let readonlyToken: string;
  let adminApiKey: string;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-db-panel-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    mockGetOverview.mockReset();
    mockListTables.mockReset();

    resetStateManager();
    resetAuth();
    resetRateLimits();
    resetActivityLog();
    getActivityLog(path.join(tempDir, 'activity-log.json'));
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    server = new ApiServer({
      port: 3097,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    const alice = await createUser('alice', 'password123', 'user');
    const bob = await createUser('bob', 'password123', 'user');
    const admin = await createUser('root', 'password123', 'admin');
    await createUser('ro', 'password123', 'readonly');

    aliceToken = await getTestToken('alice', 'password123');
    readonlyToken = await getTestToken('ro', 'password123');
    adminApiKey = (await createApiKey('root-key', 'admin', undefined, undefined, admin.id)).key;

    const sm = getStateManager();
    await sm.registerApp('alice-app', path.join(tempDir, 'alice-app'));
    await sm.updateApp('alice-app', { userId: alice.id });
    await sm.registerApp('bob-app', path.join(tempDir, 'bob-app'));
    await sm.updateApp('bob-app', { userId: bob.id });
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetAuth();
    resetRateLimits();
    resetActivityLog();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('no existence oracle', () => {
    it('404s a foreign app on GET /db/:name (not 403)', async () => {
      const res = await app.request('/api/v1/db/bob-app', { headers: authHeader(aliceToken) });
      expect(res.status).toBe(404);
    });

    it('404s a foreign app on GET /db/:name/tables (not 403)', async () => {
      const res = await app.request('/api/v1/db/bob-app/tables', {
        headers: authHeader(aliceToken),
      });
      expect(res.status).toBe(404);
    });

    it('404s an app that does not exist', async () => {
      const res = await app.request('/api/v1/db/no-such-app', { headers: authHeader(aliceToken) });
      expect(res.status).toBe(404);
    });
  });

  describe('session-only (API keys refused, even admin-role)', () => {
    it('refuses an admin API key on GET /db/:name', async () => {
      const res = await app.request('/api/v1/db/alice-app', {
        headers: { 'X-API-Key': adminApiKey },
      });
      expect(res.status).toBe(403);
    });

    it('refuses an admin API key on GET /db/:name/tables', async () => {
      const res = await app.request('/api/v1/db/alice-app/tables', {
        headers: { 'X-API-Key': adminApiKey },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("'user' role floor is bound", () => {
    it('refuses a readonly JWT on GET /db/:name', async () => {
      const res = await app.request('/api/v1/db/alice-app', {
        headers: authHeader(readonlyToken),
      });
      expect(res.status).toBe(403);
    });

    it('refuses a readonly JWT on GET /db/:name/tables', async () => {
      const res = await app.request('/api/v1/db/alice-app/tables', {
        headers: authHeader(readonlyToken),
      });
      expect(res.status).toBe(403);
    });
  });

  describe('normal responses', () => {
    it('returns 200 with provisioned:false for an app with no database', async () => {
      mockGetOverview.mockResolvedValue({ provisioned: false });

      const res = await app.request('/api/v1/db/alice-app', { headers: authHeader(aliceToken) });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: DbOverview };
      expect(json.data.provisioned).toBe(false);
    });

    it('returns the overview for a provisioned app', async () => {
      mockGetOverview.mockResolvedValue({
        provisioned: true,
        database: 'alice_app',
        sizeBytes: 1234,
        tableCount: 3,
      });

      const res = await app.request('/api/v1/db/alice-app', { headers: authHeader(aliceToken) });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: DbOverview };
      expect(json.data).toEqual({
        provisioned: true,
        database: 'alice_app',
        sizeBytes: 1234,
        tableCount: 3,
      });
    });

    it('returns the table list for a provisioned app (single call, no overview pre-check)', async () => {
      mockListTables.mockResolvedValue([
        { name: 'users', rowEstimate: 10, analysed: true, sizeBytes: 8192 },
      ]);

      const res = await app.request('/api/v1/db/alice-app/tables', {
        headers: authHeader(aliceToken),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: { tables: DbTable[] } };
      expect(json.data.tables).toEqual([
        { name: 'users', rowEstimate: 10, analysed: true, sizeBytes: 8192 },
      ]);
      // Only one connection per tables page load — see the comment in db.ts.
      expect(mockGetOverview).not.toHaveBeenCalled();
    });
  });

  describe('DbUnavailableError -> 404 for not-provisioned (a permanent state, not a "try again" one)', () => {
    it('maps not-provisioned to 404 on GET /db/:name', async () => {
      mockGetOverview.mockRejectedValue(new DbUnavailableError('not-provisioned', 'raw driver detail'));

      const res = await app.request('/api/v1/db/alice-app', { headers: authHeader(aliceToken) });
      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: { message: string } };
      expect(json.error.message).toBe('This app has no provisioned database');
    });

    it('maps not-provisioned to 404 on GET /db/:name/tables', async () => {
      mockListTables.mockRejectedValue(new DbUnavailableError('not-provisioned', 'raw driver detail'));

      const res = await app.request('/api/v1/db/alice-app/tables', {
        headers: authHeader(aliceToken),
      });
      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: { message: string } };
      expect(json.error.message).toBe('This app has no provisioned database');
    });
  });

  describe('DbUnavailableError -> 503 (survives the onError 500-collapse)', () => {
    const cases: Array<[Exclude<DbUnavailableError['reason'], 'not-provisioned'>, string]> = [
      ['no-service', 'Database service is not available on this instance'],
      ['busy', 'Database panel is busy, retry shortly'],
      ['unreachable', 'PostgreSQL is not reachable'],
      ['conn-limit', 'Database connection limit reached'],
      ['auth-failed', 'Stored database credentials were rejected'],
      [
        'database-missing',
        "The database named in this app's stored credentials no longer exists — it may need reprovisioning",
      ],
      [
        'credentials-missing',
        'No database credentials are stored for this app; if a database exists for it anyway, ' +
          'its credentials file may have been quarantined after failing to parse',
      ],
    ];

    it.each(cases)('maps %s to 503 with its operator-readable message', async (reason, expectedMessage) => {
      mockGetOverview.mockRejectedValue(new DbUnavailableError(reason, 'raw driver detail'));

      const res = await app.request('/api/v1/db/alice-app', { headers: authHeader(aliceToken) });
      expect(res.status).toBe(503);
      const json = (await res.json()) as { error: { message: string } };
      expect(json.error.message).toBe(expectedMessage);
    });

    it('sets Retry-After: 2 for the busy reason', async () => {
      mockGetOverview.mockRejectedValue(new DbUnavailableError('busy', 'raw driver detail'));

      const res = await app.request('/api/v1/db/alice-app', { headers: authHeader(aliceToken) });
      expect(res.status).toBe(503);
      expect(res.headers.get('Retry-After')).toBe('2');
    });

    it('maps a genuine failure reason to 503 on GET /db/:name/tables too', async () => {
      mockListTables.mockRejectedValue(new DbUnavailableError('unreachable', 'raw driver detail'));

      const res = await app.request('/api/v1/db/alice-app/tables', {
        headers: authHeader(aliceToken),
      });
      expect(res.status).toBe(503);
      const json = (await res.json()) as { error: { message: string } };
      expect(json.error.message).toBe('PostgreSQL is not reachable');
    });

    it('maps credentials-missing to 503 (not a normal 200) on GET /db/:name/tables', async () => {
      // Previously translated back into a normal `{tables:[]}` 200 — now a
      // real, distinct state (it also covers a quarantined-credentials
      // orphan with a still-live database), so it must reach the client as a
      // 503 like every other reason.
      mockListTables.mockRejectedValue(
        new DbUnavailableError('credentials-missing', 'raw driver detail')
      );

      const res = await app.request('/api/v1/db/alice-app/tables', {
        headers: authHeader(aliceToken),
      });
      expect(res.status).toBe(503);
      const json = (await res.json()) as { error: { message: string } };
      expect(json.error.message).toBe(
        'No database credentials are stored for this app; if a database exists for it anyway, ' +
          'its credentials file may have been quarantined after failing to parse'
      );
    });
  });

  describe('no activity-log entry for reads', () => {
    it('writes nothing to the activity log across success, empty, and error responses', async () => {
      mockGetOverview.mockResolvedValueOnce({ provisioned: false });
      await app.request('/api/v1/db/alice-app', { headers: authHeader(aliceToken) });

      mockListTables.mockResolvedValueOnce([]);
      await app.request('/api/v1/db/alice-app/tables', { headers: authHeader(aliceToken) });

      mockGetOverview.mockRejectedValueOnce(new DbUnavailableError('unreachable', 'x'));
      await app.request('/api/v1/db/alice-app', { headers: authHeader(aliceToken) });

      expect(getActivityLog().getEntries().total).toBe(0);
    });
  });
});

describe('database panel routes — auth disabled (DROP-120)', () => {
  // Separate server/suite: on an auth-disabled box the
  // `if (enableAuth && isAuthEnabled())` block in server.ts never runs, so
  // `authMiddleware('user')` is never mounted on `/db/*` at all — the route's
  // own `interactiveSessionOnly` gate is the ONLY thing standing between an
  // anonymous caller and every app's schema. This is the exact scenario the
  // plan cites as the guard's reason to exist; it must be proven directly,
  // not inferred from the enabled-auth suite above.
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-db-panel-noauth-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    mockGetOverview.mockReset();
    mockListTables.mockReset();

    resetStateManager();
    resetAuth();
    resetRateLimits();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    server = new ApiServer({ port: 3098, enableAuth: false });
    await server.initialize();
    app = server.getApp();

    const sm = getStateManager();
    await sm.registerApp('open-app', path.join(tempDir, 'open-app'));
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetAuth();
    resetRateLimits();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('refuses an anonymous GET /db/:name with no principal at all', async () => {
    const res = await app.request('/api/v1/db/open-app');
    expect(res.status).toBe(403);
    expect(mockGetOverview).not.toHaveBeenCalled();
  });

  it('refuses an anonymous GET /db/:name/tables with no principal at all', async () => {
    const res = await app.request('/api/v1/db/open-app/tables');
    expect(res.status).toBe(403);
    expect(mockListTables).not.toHaveBeenCalled();
  });
});
