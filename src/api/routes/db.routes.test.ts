/**
 * Database panel routes (M1 — DROP-120).
 *
 * Follows the standalone-ApiServer harness in certs.authz.test.ts. The
 * inspector module is mocked (no real PostgreSQL on this box); `DbUnavailableError`
 * is the REAL class (via jest.requireActual) so the route's `instanceof` checks
 * behave exactly as they do in production. The database/redis provisioner
 * singletons are mocked the same way (requireActual passthrough, only the
 * getters stubbed) so the DROP-151 Phase 2 extended-payload fields (redis
 * flag, quota) can be driven without a real PostgreSQL/Redis on this box.
 *
 * Proves: no existence oracle (foreign/missing app both 404), the read paths
 * are session-only (an API key is refused even with admin role), the 'user'
 * role floor is actually bound (a readonly JWT is refused), `provisioned:false`
 * is a normal 200, every `DbUnavailableError` reason survives the onError
 * 500-collapse with its intended message, reads never touch the activity
 * log, and the extended GET /db/:name payload (redis flag, persisted services
 * intent, per-service quota state) is correct — including the deliberately
 * divergent ownerless `constrained` rule between postgres and redis that
 * `serviceQuotaState`'s own header comment calls out as not-to-be-normalised.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, createApiKey, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { getAppConfigService, resetAppConfigService } from '../../managers/app/app-config';
import { resetRateLimits } from '../middleware/rate-limit';
import { getActivityLog, resetActivityLog } from '../../managers/activity';
import { getMaxDbsPerUser, getMaxRedisPerUser } from '../runtime-config';
import type { DbOverview, DbTable } from '../../managers/database/app-db-inspector';
import { serviceQuotaState } from './db';

jest.mock('../../managers/database/app-db-inspector', () => {
  const actual = jest.requireActual('../../managers/database/app-db-inspector');
  return {
    ...actual,
    getOverview: jest.fn(),
    listTables: jest.fn(),
    runQuery: jest.fn(),
  };
});

jest.mock('../../managers/database', () => {
  const actual = jest.requireActual('../../managers/database');
  return { ...actual, getDatabaseProvisioner: jest.fn() };
});

jest.mock('../../managers/redis', () => {
  const actual = jest.requireActual('../../managers/redis');
  return { ...actual, getRedisProvisioner: jest.fn() };
});

import {
  getOverview,
  listTables,
  runQuery,
  DbUnavailableError,
  DbQueryError,
} from '../../managers/database/app-db-inspector';
import { getSettingsManager, resetSettingsManager } from '../../managers/settings/settings-manager';
import { getDatabaseProvisioner } from '../../managers/database';
import { getRedisProvisioner } from '../../managers/redis';

const mockGetOverview = getOverview as jest.MockedFunction<typeof getOverview>;
const mockListTables = listTables as jest.MockedFunction<typeof listTables>;
const mockRunQuery = runQuery as jest.MockedFunction<typeof runQuery>;
const mockGetDatabaseProvisioner = getDatabaseProvisioner as jest.MockedFunction<
  typeof getDatabaseProvisioner
>;
const mockGetRedisProvisioner = getRedisProvisioner as jest.MockedFunction<typeof getRedisProvisioner>;

describe('database panel routes (DROP-120)', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let aliceToken: string;
  let aliceId: string;
  let readonlyToken: string;
  let adminApiKey: string;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-db-panel-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    mockGetOverview.mockReset();
    mockListTables.mockReset();
    // Default to "no provisioner wired" (matches production on a box where
    // the DB/Redis layer never booted) — the same shape GET /db/:name already
    // has to tolerate. Individual tests override this to exercise the
    // redis-flag / quota fields.
    mockGetDatabaseProvisioner.mockReset();
    mockGetDatabaseProvisioner.mockReturnValue(null);
    mockGetRedisProvisioner.mockReset();
    mockGetRedisProvisioner.mockReturnValue(null);

    resetStateManager();
    resetAuth();
    resetRateLimits();
    resetActivityLog();
    resetAppConfigService();
    getActivityLog(path.join(tempDir, 'activity-log.json'));
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    // GET /db/:name now reads the persisted services intent (DROP-151 Phase
    // 2) — getAppConfigService() throws on first use if never initialized
    // with options, so every test in this file needs it seeded, not just the
    // ones that assert on `services`.
    getAppConfigService({
      configDir: path.join(tempDir, 'appconf', 'webapps'),
      webappsDir: path.join(tempDir, 'webapps'),
    });
    await getAppConfigService().initialize();

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
    aliceId = alice.id;

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
    resetAppConfigService();
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
      // The overview fields are spread alongside the DROP-151 Phase 2
      // additions (redis flag, services intent, quota) — see the "extended
      // payload" describe block below for dedicated coverage of those three;
      // this asserts they don't corrupt or drop the base overview fields.
      expect(json.data).toMatchObject({
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
    // 'database-missing' is deliberately EXCLUDED here — it now maps to a
    // renderable 200, not a 503; see its own describe block below.
    const cases: Array<[Exclude<DbUnavailableError['reason'], 'not-provisioned' | 'database-missing'>, string]> = [
      ['no-service', 'Database service is not available on this instance'],
      ['busy', 'Database panel is busy, retry shortly'],
      ['unreachable', 'PostgreSQL is not reachable'],
      ['conn-limit', 'Database connection limit reached'],
      ['auth-failed', 'Stored database credentials were rejected'],
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

  // A dropped-out-from-under-its-credentials database (SQLSTATE 3D000 ->
  // 'database-missing') is exactly the state a partial Postgres detach
  // leaves behind before its retry converges — the dashboard needs a
  // renderable 200 with a repair marker, not a dead 503 error card that
  // hides redis/services/quota (and with them, the Detach/retry button).
  describe("DbUnavailableError('database-missing') -> renderable 200, not 503", () => {
    it('returns 200 with provisioned:false and a broken:"database-missing" marker', async () => {
      mockGetOverview.mockRejectedValue(new DbUnavailableError('database-missing', 'raw driver detail'));

      const res = await app.request('/api/v1/db/alice-app', { headers: authHeader(aliceToken) });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: { provisioned: boolean; broken?: string } };
      expect(json.data.provisioned).toBe(false);
      expect(json.data.broken).toBe('database-missing');
    });

    it('still carries the Phase-2 fields (redis, services, quota) instead of hiding them behind the failed overview', async () => {
      mockGetOverview.mockRejectedValue(new DbUnavailableError('database-missing', 'raw driver detail'));
      mockGetRedisProvisioner.mockReturnValue({
        isProvisioned: jest.fn().mockReturnValue(true),
      } as unknown as ReturnType<typeof getRedisProvisioner>);
      await getAppConfigService().upsertSystemConfig('alice-app', {
        services: { postgres: 'detached' },
      });

      const res = await app.request('/api/v1/db/alice-app', { headers: authHeader(aliceToken) });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: {
          redis: { provisioned: boolean };
          services: Record<string, string>;
          quota: { postgres: unknown; redis: unknown };
        };
      };
      expect(json.data.redis).toEqual({ provisioned: true });
      expect(json.data.services).toEqual({ postgres: 'detached' });
      expect(json.data.quota.postgres).toBeDefined();
      expect(json.data.quota.redis).toBeDefined();
    });

    it('maps database-missing on GET /db/:name/tables unchanged (still 503) — the renderable-200 fix is GET /:name only', async () => {
      // listTables has no {provisioned:false}-shaped success answer to fall
      // back to (see DbUnavailableError's own doc), so the 200 remap is
      // deliberately scoped to the overview route only.
      mockListTables.mockRejectedValue(new DbUnavailableError('database-missing', 'raw driver detail'));

      const res = await app.request('/api/v1/db/alice-app/tables', {
        headers: authHeader(aliceToken),
      });
      expect(res.status).toBe(503);
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

  // DROP-151 Phase 2: the additions GET /db/:name carries alongside the base
  // overview — redis provisioned flag, the persisted attach/detach services
  // intent, and per-service quota state (see db.ts's own comment on why the
  // two quotas' `constrained` rule deliberately diverges for an ownerless
  // app; serviceQuotaState's own unit tests below lock in that divergence
  // directly).
  describe('extended payload (DROP-151 Phase 2): redis flag, services intent, quota state', () => {
    it('defaults redis.provisioned=false, services={}, and both quotas unconstrained when neither provisioner is wired', async () => {
      mockGetOverview.mockResolvedValue({ provisioned: false });

      const res = await app.request('/api/v1/db/alice-app', { headers: authHeader(aliceToken) });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: {
          redis: { provisioned: boolean };
          services: Record<string, string>;
          quota: {
            postgres: { used: number; limit: number; constrained: boolean };
            redis: { used: number; limit: number; constrained: boolean };
          };
        };
      };
      expect(json.data.redis).toEqual({ provisioned: false });
      expect(json.data.services).toEqual({});
      expect(json.data.quota).toEqual({
        postgres: { used: 0, limit: getMaxDbsPerUser(), constrained: false },
        redis: { used: 0, limit: getMaxRedisPerUser(), constrained: false },
      });
    });

    it('reports redis.provisioned=true from the redis provisioner independently of the postgres overview', async () => {
      mockGetOverview.mockResolvedValue({ provisioned: false });
      mockGetRedisProvisioner.mockReturnValue({
        isProvisioned: jest.fn().mockReturnValue(true),
      } as unknown as ReturnType<typeof getRedisProvisioner>);

      const res = await app.request('/api/v1/db/alice-app', { headers: authHeader(aliceToken) });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: { redis: { provisioned: boolean } } };
      expect(json.data.redis).toEqual({ provisioned: true });
    });

    it('surfaces the persisted services attach/detach intent from AppConfigService', async () => {
      mockGetOverview.mockResolvedValue({ provisioned: false });
      await getAppConfigService().upsertSystemConfig('alice-app', {
        services: { postgres: 'attached' },
      });

      const res = await app.request('/api/v1/db/alice-app', { headers: authHeader(aliceToken) });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: { services: Record<string, string> } };
      expect(json.data.services).toEqual({ postgres: 'attached' });
    });

    it('reports constrained quota usage counted against the owner once a provisioner is wired', async () => {
      mockGetOverview.mockResolvedValue({ provisioned: false });
      mockGetDatabaseProvisioner.mockReturnValue({
        isProvisioned: jest.fn((name: string) => name === 'alice-app'),
      } as unknown as ReturnType<typeof getDatabaseProvisioner>);

      const res = await app.request('/api/v1/db/alice-app', { headers: authHeader(aliceToken) });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: { quota: { postgres: { used: number; limit: number; constrained: boolean } } };
      };
      expect(json.data.quota.postgres).toEqual({
        used: 1,
        limit: getMaxDbsPerUser(),
        constrained: true,
      });
    });

    // The Detach confirm dialog needs to know an app is
    // ephemeral BEFORE it promises a Postgres backup `detachService` never
    // actually writes for one (`skipBackup: config?.ephemeral === true` in
    // platform.ts). GET /db/:name is the only place that can tell it.
    it('defaults ephemeral=false when the app has no config', async () => {
      mockGetOverview.mockResolvedValue({ provisioned: false });

      const res = await app.request('/api/v1/db/alice-app', { headers: authHeader(aliceToken) });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: { ephemeral: boolean } };
      expect(json.data.ephemeral).toBe(false);
    });

    it('reports ephemeral=true for an app whose AppConfig says so', async () => {
      mockGetOverview.mockResolvedValue({ provisioned: false });
      await getAppConfigService().upsertSystemConfig('alice-app', { ephemeral: true });

      const res = await app.request('/api/v1/db/alice-app', { headers: authHeader(aliceToken) });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: { ephemeral: boolean } };
      expect(json.data.ephemeral).toBe(true);
    });

    // An uninitialised AppConfigService must degrade to
    // the safe defaults (services: {}, ephemeral: false), not a 500 — the
    // same defensive posture apps.ts's own ephemeral read already takes.
    it('degrades to services={} and ephemeral=false instead of 500ing when AppConfigService is not initialised', async () => {
      mockGetOverview.mockResolvedValue({ provisioned: false });
      resetAppConfigService();

      const res = await app.request('/api/v1/db/alice-app', { headers: authHeader(aliceToken) });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: { services: Record<string, string>; ephemeral: boolean };
      };
      expect(json.data.services).toEqual({});
      expect(json.data.ephemeral).toBe(false);
    });
  });

  // Pure unit coverage of serviceQuotaState itself — exercised through the
  // route above for the common case, but the ownerless divergence between
  // postgres (truthy-gated `applicable`) and redis (`!== undefined`-gated) is
  // easiest to pin precisely at the function boundary, matching how the
  // route computes each `applicable` argument (see db.ts's GET /:name).
  describe('serviceQuotaState — the deliberately divergent ownerless "constrained" rule', () => {
    it('is unconstrained for postgres but constrained for redis when ownerUserId is an empty string (the divergent case)', () => {
      const isProvisioned = () => false;
      const postgres = serviceQuotaState('', 3, Boolean(''), isProvisioned);
      const redis = serviceQuotaState('', 3, ('' as string | undefined) !== undefined, isProvisioned);
      expect(postgres).toEqual({ used: 0, limit: 3, constrained: false });
      expect(redis).toEqual({ used: 0, limit: 3, constrained: true });
    });

    it('is unconstrained for BOTH when the app is fully ownerless (userId undefined)', () => {
      const isProvisioned = () => false;
      const ownerUserId: string | undefined = undefined;
      const postgres = serviceQuotaState(ownerUserId, 3, Boolean(ownerUserId), isProvisioned);
      const redis = serviceQuotaState(ownerUserId, 3, ownerUserId !== undefined, isProvisioned);
      expect(postgres).toEqual({ used: 0, limit: 3, constrained: false });
      expect(redis).toEqual({ used: 0, limit: 3, constrained: false });
    });

    it('is unconstrained when the limit is zero or negative, even with an owner and applicable=true', () => {
      const result = serviceQuotaState('alice-id', 0, true, () => true);
      expect(result).toEqual({ used: 0, limit: 0, constrained: false });
    });

    it('is unconstrained when no isProvisioned function is supplied (provisioner unwired)', () => {
      const result = serviceQuotaState('alice-id', 3, true, undefined);
      expect(result).toEqual({ used: 0, limit: 3, constrained: false });
    });

    it('counts zero used for an owner who owns no provisioned app under this service', () => {
      // Exercised against the REAL state manager seeded in the outer
      // beforeEach (alice-app/bob-app), so this also proves the counting
      // filters by owner correctly rather than counting every provisioned app.
      const result = serviceQuotaState('nobody-owns-this-app', 5, true, () => true);
      expect(result).toEqual({ used: 0, limit: 5, constrained: true });
    });

    it("counts only the owner's own provisioned apps against the limit", () => {
      const result = serviceQuotaState(aliceId, 5, true, (name) => name === 'alice-app');
      expect(result).toEqual({ used: 1, limit: 5, constrained: true });
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

/**
 * POST /db/:name/query — the SQL console's gate (DROP-163, M2).
 *
 * The query MECHANISM is covered in app-db-inspector.query.test.ts and was
 * verified against a real PostgreSQL 16. What is covered here is who is allowed
 * to reach it, which is where this feature's actual risk lives: `pg_catalog` is
 * world-readable and no privilege setting closes it, so anyone who can run
 * arbitrary SQL can enumerate every database and role on the server. Three
 * independent gates keep that admin-only and opt-in, and each is tested alone
 * so that removing any one of them fails here rather than in production.
 */
describe('POST /db/:name/query — the SQL console gate', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let adminToken: string;
  let aliceToken: string;
  let adminApiKey: string;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  const post = (token: string, name = 'alice-app', body: unknown = { sql: 'SELECT 1' }) =>
    app.request(`/api/v1/db/${name}/query`, {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-db-query-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    mockRunQuery.mockReset();
    mockRunQuery.mockResolvedValue({
      columns: ['id'],
      rows: [['1']],
      rowCount: 1,
      truncated: false,
      durationMs: 3,
    });
    mockGetDatabaseProvisioner.mockReset();
    mockGetDatabaseProvisioner.mockReturnValue(null);
    mockGetRedisProvisioner.mockReset();
    mockGetRedisProvisioner.mockReturnValue(null);

    resetStateManager();
    resetAuth();
    resetRateLimits();
    resetActivityLog();
    resetAppConfigService();
    resetSettingsManager();
    getSettingsManager({ settingsFilePath: path.join(tempDir, 'settings.json') });
    getActivityLog(path.join(tempDir, 'activity-log.json'));
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    getAppConfigService({
      configDir: path.join(tempDir, 'appconf', 'webapps'),
      webappsDir: path.join(tempDir, 'webapps'),
    });
    await getAppConfigService().initialize();

    server = new ApiServer({
      port: 3099,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    const alice = await createUser('alice', 'password123', 'user');
    const admin = await createUser('root', 'password123', 'admin');
    aliceToken = await getTestToken('alice', 'password123');
    adminToken = await getTestToken('root', 'password123');
    adminApiKey = (await createApiKey('root-key', 'admin', undefined, undefined, admin.id)).key;

    const sm = getStateManager();
    await sm.registerApp('alice-app', path.join(tempDir, 'alice-app'));
    await sm.updateApp('alice-app', { userId: alice.id });

    // On by default in this block; the "off" case has its own test.
    await getSettingsManager().setSqlConsoleEnabled(true);
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetAuth();
    resetRateLimits();
    resetActivityLog();
    resetAppConfigService();
    resetSettingsManager();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('runs a query for an admin on an interactive session', async () => {
    const res = await post(adminToken);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { rows: string[][]; columns: string[] } };
    expect(body.data.columns).toEqual(['id']);
    expect(body.data.rows).toEqual([['1']]);
  });

  it('refuses a non-admin, even the app OWNER', async () => {
    // The asymmetry that decides this feature's shape: for an admin the
    // catalogs disclose nothing they cannot already list, but for an app owner
    // they are a cross-tenant inventory of every database and role on the box.
    const res = await post(aliceToken);

    expect(res.status).toBe(403);
    expect(mockRunQuery).not.toHaveBeenCalled();
  });

  it('refuses an API key, even an admin one', async () => {
    // An agent token must never reach arbitrary SQL. Same rule the rest of the
    // panel applies, and the reason it exists is stronger here.
    const res = await app.request('/api/v1/db/alice-app/query', {
      method: 'POST',
      headers: { 'X-API-Key': adminApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT 1' }),
    });

    expect(res.status).toBe(403);
    expect(mockRunQuery).not.toHaveBeenCalled();
  });

  it('refuses when the console setting is off', async () => {
    // The operator's conscious acceptance of the catalog exposure. Off is the
    // default; this proves the flag is actually consulted rather than being
    // decoration on the settings page.
    await getSettingsManager().setSqlConsoleEnabled(false);

    const res = await post(adminToken);

    expect(res.status).toBe(403);
    expect(mockRunQuery).not.toHaveBeenCalled();
  });

  it('is off by default, with no setting written at all', async () => {
    await getSettingsManager().setSqlConsoleEnabled(undefined);

    const res = await post(adminToken);

    expect(res.status).toBe(403);
  });

  it('404s for an app that does not exist, with no existence oracle', async () => {
    const res = await post(adminToken, 'no-such-app');

    expect(res.status).toBe(404);
  });

  it('rejects a non-string sql field', async () => {
    const res = await post(adminToken, 'alice-app', { sql: { evil: true } });

    expect(res.status).toBe(400);
    expect(mockRunQuery).not.toHaveBeenCalled();
  });

  it('reports a refused query as 400, not as a platform failure', async () => {
    // PostgreSQL understood the statement and refused it. A 500 would tell the
    // operator the platform is broken when their SQL is.
    mockRunQuery.mockRejectedValue(
      new DbQueryError('rejected', 'cannot execute INSERT in a read-only transaction (SQLSTATE 25006)')
    );

    const res = await post(adminToken);

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/25006/);
  });

  it('still reports an unreachable database as 503', async () => {
    mockRunQuery.mockRejectedValue(new DbUnavailableError('unreachable', 'PostgreSQL is not reachable.'));

    const res = await post(adminToken);

    expect(res.status).toBe(503);
  });

  it('writes an activity entry, but never the SQL itself', async () => {
    // Unlike the panel's reads, this is audited: arbitrary SQL against tenant
    // data makes "who ran this" the first question after a leak. The statement
    // text is deliberately absent — a query can carry the very token or address
    // whose exposure is being investigated, and the activity log is plaintext.
    await post(adminToken, 'alice-app', { sql: "SELECT * FROM users WHERE token = 'super-secret'" });

    const { entries } = getActivityLog().getEntries(50, 0);
    const entry = entries.find(e => e.action === 'db-query');
    expect(entry).toBeDefined();
    expect(entry?.appName).toBe('alice-app');
    expect(JSON.stringify(entries)).not.toContain('super-secret');
  });
});
