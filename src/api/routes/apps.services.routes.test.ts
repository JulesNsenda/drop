/**
 * POST /apps/:name/services/:id — attach a backing service (DROP-151 Phase 2).
 *
 * Follows the `setPlatformOps`/`PlatformOps` stubbing pattern in
 * apps.restart.test.ts / apps.capabilities.test.ts and the standalone-ApiServer
 * harness in db.routes.test.ts (no real platform is booted).
 *
 * Covers: the success path FIRST as the guard everything else depends on
 * (attachService actually invoked with (name, serviceId), response carries
 * envVarNames), that no DSN/secret value ever reaches the serialized response
 * even if the ops layer misbehaves, that an unknown :id is rejected before
 * ever calling attachService, that every AttachServiceResult refusal reason
 * maps to 409 with its reason (and quota, where applicable) preserved, that a
 * busy app (thrown AppInProgressError) maps to 409, that unwired platform ops
 * 503s, the method-scoped role guard (POST needs >= 'user') and the
 * no-existence-oracle (non-owner 404s, not 403) IDOR posture, and that only a
 * successful attach writes an attach-service activity-log entry.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { getActivityLog, resetActivityLog } from '../../managers/activity';
import { resetRateLimits } from '../middleware/rate-limit';
import {
  setPlatformOps,
  resetPlatformOps,
  AppInProgressError,
  PlatformOps,
  AttachServiceResult,
} from '../platform-ops';
import { ErrorCodes } from '../types';

function makeOps(overrides?: Partial<PlatformOps>): PlatformOps {
  return {
    restartApp: jest.fn(),
    isAppInProgress: jest.fn().mockReturnValue(false),
    promoteApp: jest.fn(),
    removeGroup: jest.fn().mockResolvedValue({ removed: [] }),
    purgeAppArtifacts: jest.fn().mockResolvedValue(undefined),
    attachService: jest.fn().mockResolvedValue({
      attached: true,
      envVarNames: ['DATABASE_URL'],
    } satisfies AttachServiceResult),
    ...overrides,
  };
}

describe('POST /apps/:name/services/:id (DROP-151 Phase 2 attach)', () => {
  let tempDir: string;
  let server: ApiServer;
  let hono: ReturnType<ApiServer['getApp']>;
  let ownerToken: string;
  let ownerId: string;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });
  const attach = (name: string, serviceId: string, token: string) =>
    hono.request(`/api/v1/apps/${name}/services/${serviceId}`, {
      method: 'POST',
      headers: authHeader(token),
    });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-attach-service-route-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetStateManager();
    resetAuth();
    resetPlatformOps();
    resetRateLimits();
    resetActivityLog();
    getActivityLog(path.join(tempDir, 'activity-log.json'));
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    server = new ApiServer({
      port: 3100,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    hono = server.getApp();

    const owner = await createUser('owner', 'password123', 'user');
    ownerId = owner.id;
    ownerToken = await getTestToken('owner', 'password123');

    const sm = getStateManager();
    await sm.registerApp('test-app', path.join(tempDir, 'test-app'));
    await sm.updateApp('test-app', { userId: ownerId });
  });

  afterEach(async () => {
    resetPlatformOps();
    resetActivityLog();
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetRateLimits();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  afterAll(() => {
    resetPlatformOps();
  });

  // --- 1. Success path -- the guard every refusal test below depends on ----
  describe('success (the guard for everything below)', () => {
    it('attaches postgres, returns 200 with envVarNames, and calls attachService(name, id)', async () => {
      const ops = makeOps();
      setPlatformOps(ops);

      const res = await attach('test-app', 'postgres', ownerToken);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { message: string; envVarNames: string[] } };
      expect(body.data.envVarNames).toEqual(['DATABASE_URL']);
      expect(body.data.message).toContain('postgres');
      expect(ops.attachService).toHaveBeenCalledTimes(1);
      expect(ops.attachService).toHaveBeenCalledWith('test-app', 'postgres');
    });

    it('attaches redis, returns 200 with its envVarNames, and calls attachService(name, id)', async () => {
      const ops = makeOps({
        attachService: jest.fn().mockResolvedValue({
          attached: true,
          envVarNames: ['REDIS_URL'],
        } satisfies AttachServiceResult),
      });
      setPlatformOps(ops);

      const res = await attach('test-app', 'redis', ownerToken);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: { envVarNames: string[] } };
      expect(body.data.envVarNames).toEqual(['REDIS_URL']);
      expect(ops.attachService).toHaveBeenCalledWith('test-app', 'redis');
    });
  });

  // --- 2. No DSN or secret value ever leaves the route ----------------------
  describe('no secret material leaves the route', () => {
    it('never echoes a DSN or secret value, even if the ops layer accidentally attached one', async () => {
      // Simulates a hypothetical future regression where the platform op
      // spread raw provisioned env VALUES into the result instead of just
      // their names -- the route must pick only envVarNames off the result,
      // never forward the object wholesale.
      const leaky = {
        attached: true,
        envVarNames: ['DATABASE_URL'],
        databaseUrl: 'postgres://app_test_app:s3cr3t-pw@127.0.0.1:5432/test_app',
        secretValue: 'do-not-leak-me-s3cr3t',
      };
      const ops = makeOps({ attachService: jest.fn().mockResolvedValue(leaky) });
      setPlatformOps(ops);

      const res = await attach('test-app', 'postgres', ownerToken);
      expect(res.status).toBe(200);
      const rawText = await res.text();
      expect(rawText).not.toContain('postgres://');
      expect(rawText).not.toContain('s3cr3t');
      expect(rawText).not.toContain('@127.0.0.1');

      const body = JSON.parse(rawText) as { data: Record<string, unknown> };
      expect(Object.keys(body.data).sort()).toEqual(['envVarNames', 'message']);
    });

    it('never echoes DSN-shaped userinfo in a refusal body either', async () => {
      const ops = makeOps({
        attachService: jest.fn().mockResolvedValue({
          attached: false,
          reason: 'has-own-database-url',
          detail: 'This app already supplies its own DATABASE_URL (via secret DATABASE_URL).',
        } satisfies AttachServiceResult),
      });
      setPlatformOps(ops);

      const res = await attach('test-app', 'postgres', ownerToken);
      expect(res.status).toBe(409);
      const rawText = await res.text();
      expect(rawText).not.toContain('postgres://');
      expect(rawText).not.toMatch(/:\/\/[^/]+:[^/]+@/); // no userinfo-bearing URL of any scheme
    });
  });

  // --- 3. Unknown service id is rejected before ops is ever called ---------
  describe('unknown service id', () => {
    it.each(['mysql', 'not-a-service', 'Postgres'])(
      "rejects unknown id '%s' with 400 and never calls attachService",
      async (badId) => {
        const ops = makeOps();
        setPlatformOps(ops);

        const res = await attach('test-app', badId, ownerToken);
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
        expect(ops.attachService).not.toHaveBeenCalled();
      }
    );

    it('rejects a path-traversal-shaped id and never calls attachService', async () => {
      const ops = makeOps();
      setPlatformOps(ops);

      // %2e%2e%2fetc -- URL-encoded so the segment reaches Hono as one :id
      // param rather than being collapsed by URL normalization before routing.
      const res = await hono.request('/api/v1/apps/test-app/services/%2e%2e%2fetc', {
        method: 'POST',
        headers: authHeader(ownerToken),
      });
      // The route's own ATTACHABLE_SERVICE_IDS allowlist check catches this —
      // the decoded id ('../etc') is just another unrecognized string to it.
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(ErrorCodes.VALIDATION_ERROR);
      expect(ops.attachService).not.toHaveBeenCalled();
    });

    it('never routes to the handler for an empty id segment (no route match, not the validation 400)', async () => {
      const ops = makeOps();
      setPlatformOps(ops);

      const res = await hono.request('/api/v1/apps/test-app/services/', {
        method: 'POST',
        headers: authHeader(ownerToken),
      });
      // No :id segment at all -- Hono's router doesn't match
      // '/:name/services/:id' and falls through to its default 404, distinct
      // from the route's own 400 validation response above.
      expect(res.status).toBe(404);
      expect(ops.attachService).not.toHaveBeenCalled();
    });
  });

  // --- 4. Each refusal reason -> 409 with its reason (and quota) preserved -
  describe('refusal reasons map to 409 with the reason preserved', () => {
    it('maps "ephemeral" to 409 with reason preserved', async () => {
      const ops = makeOps({
        attachService: jest.fn().mockResolvedValue({
          attached: false,
          reason: 'ephemeral',
          detail: 'This app is ephemeral and will be torn down on its TTL without a database backup.',
        } satisfies AttachServiceResult),
      });
      setPlatformOps(ops);

      const res = await attach('test-app', 'postgres', ownerToken);
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: { code: string; message: string; details: { reason: string; quota?: unknown } };
      };
      expect(body.error.code).toBe(ErrorCodes.CONFLICT);
      expect(body.error.details.reason).toBe('ephemeral');
      expect(body.error.details.quota).toBeUndefined();
      expect(body.error.message).toContain('ephemeral');
    });

    it('maps "has-own-database-url" to 409 with reason preserved', async () => {
      const ops = makeOps({
        attachService: jest.fn().mockResolvedValue({
          attached: false,
          reason: 'has-own-database-url',
          detail: 'This app already supplies its own DATABASE_URL (via secret DATABASE_URL).',
        } satisfies AttachServiceResult),
      });
      setPlatformOps(ops);

      const res = await attach('test-app', 'postgres', ownerToken);
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: { code: string; message: string; details: { reason: string; quota?: unknown } };
      };
      expect(body.error.code).toBe(ErrorCodes.CONFLICT);
      expect(body.error.details.reason).toBe('has-own-database-url');
      expect(body.error.details.quota).toBeUndefined();
      expect(body.error.message).toContain('DATABASE_URL');
    });

    it('maps "quota-exceeded" to 409 with reason AND quota {used,limit} preserved', async () => {
      const ops = makeOps({
        attachService: jest.fn().mockResolvedValue({
          attached: false,
          reason: 'quota-exceeded',
          detail: 'Database quota reached (3/3).',
          quota: { used: 3, limit: 3 },
        } satisfies AttachServiceResult),
      });
      setPlatformOps(ops);

      const res = await attach('test-app', 'postgres', ownerToken);
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        error: {
          code: string;
          message: string;
          details: { reason: string; quota: { used: number; limit: number } };
        };
      };
      expect(body.error.code).toBe(ErrorCodes.CONFLICT);
      expect(body.error.details.reason).toBe('quota-exceeded');
      expect(body.error.details.quota).toEqual({ used: 3, limit: 3 });
      expect(body.error.message).toContain('3/3');
    });
  });

  // --- 5. Busy app (thrown AppInProgressError) -> 409 -----------------------
  describe('busy app (AppInProgressError)', () => {
    it('409s when attachService throws AppInProgressError', async () => {
      const ops = makeOps({
        attachService: jest.fn().mockRejectedValue(new AppInProgressError('test-app')),
      });
      setPlatformOps(ops);

      const res = await attach('test-app', 'postgres', ownerToken);
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(ErrorCodes.CONFLICT);
    });
  });

  // --- 6. Unwired platform ops -> 503 ----------------------------------------
  describe('unwired platform ops', () => {
    it('503s when no PlatformOps has been registered', async () => {
      // resetPlatformOps() already ran in beforeEach -- nothing to set.
      const res = await attach('test-app', 'postgres', ownerToken);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe(ErrorCodes.SERVICE_UNAVAILABLE);
    });
  });

  // --- 7. Authorization -------------------------------------------------------
  describe('authorization', () => {
    it('blocks a readonly-role token with 403 (POST is gated at >= user)', async () => {
      await createUser('viewer', 'password123', 'readonly');
      const viewerToken = await getTestToken('viewer', 'password123');
      const ops = makeOps();
      setPlatformOps(ops);

      const res = await attach('test-app', 'postgres', viewerToken);
      expect(res.status).toBe(403);
      expect(ops.attachService).not.toHaveBeenCalled();
    });

    it('lets a user-role owner through the guard (200)', async () => {
      setPlatformOps(makeOps());

      const res = await attach('test-app', 'postgres', ownerToken);
      expect(res.status).toBe(200);
    });

    it("404s (not 403) when a non-owning user-role caller attaches to another user's app -- no existence oracle", async () => {
      await createUser('intruder', 'password123', 'user');
      const intruderToken = await getTestToken('intruder', 'password123');
      const ops = makeOps();
      setPlatformOps(ops);

      const res = await attach('test-app', 'postgres', intruderToken);
      expect(res.status).toBe(404);
      expect(ops.attachService).not.toHaveBeenCalled();
    });

    it('404s (not 403) for an app that does not exist at all -- matches the foreign-app 404 (no existence oracle)', async () => {
      const ops = makeOps();
      setPlatformOps(ops);

      const res = await attach('no-such-app', 'postgres', ownerToken);
      expect(res.status).toBe(404);
      expect(ops.attachService).not.toHaveBeenCalled();
    });

    it("lets an admin attach to another user's app", async () => {
      await createUser('root', 'password123', 'admin');
      const adminToken = await getTestToken('root', 'password123');
      const ops = makeOps();
      setPlatformOps(ops);

      const res = await attach('test-app', 'postgres', adminToken);
      expect(res.status).toBe(200);
      expect(ops.attachService).toHaveBeenCalledWith('test-app', 'postgres');
    });
  });

  // --- 8. ActivityLog ----------------------------------------------------------
  describe('activity log', () => {
    it('records an attach-service entry on success, with the serviceId as detail', async () => {
      setPlatformOps(makeOps());

      const res = await attach('test-app', 'postgres', ownerToken);
      expect(res.status).toBe(200);

      const { entries } = getActivityLog().getEntries();
      const entry = entries.find(e => e.action === 'attach-service');
      expect(entry).toBeDefined();
      expect(entry).toMatchObject({
        action: 'attach-service',
        appName: 'test-app',
        detail: 'postgres',
        userId: ownerId,
      });
    });

    it('does NOT record an activity-log entry on a refusal (attached: false)', async () => {
      setPlatformOps(
        makeOps({
          attachService: jest.fn().mockResolvedValue({
            attached: false,
            reason: 'ephemeral',
            detail: 'nope',
          } satisfies AttachServiceResult),
        })
      );

      const res = await attach('test-app', 'postgres', ownerToken);
      expect(res.status).toBe(409);

      const { entries } = getActivityLog().getEntries();
      expect(entries.find(e => e.action === 'attach-service')).toBeUndefined();
    });

    it('does NOT record an activity-log entry when the app is busy (AppInProgressError)', async () => {
      setPlatformOps(
        makeOps({ attachService: jest.fn().mockRejectedValue(new AppInProgressError('test-app')) })
      );

      const res = await attach('test-app', 'postgres', ownerToken);
      expect(res.status).toBe(409);

      const { entries } = getActivityLog().getEntries();
      expect(entries.find(e => e.action === 'attach-service')).toBeUndefined();
    });
  });
});
