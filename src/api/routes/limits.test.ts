/**
 * GET /api/v1/limits (#293) — the caller's own headroom against every deploy
 * guardrail, read before it is spent.
 *
 * The properties that matter are the two the route's module doc names: every
 * figure is the CALLER's (never another tenant's, never the fleet's, not even
 * for an admin), and reading a limit never changes it.
 */

import * as path from 'path';
import { createUser } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import {
  createTestApiServer,
  teardownTestApiServer,
  type TestApiServer,
} from '../__testutils__/api-server';
import { getStateManager } from '../../managers/app/state-manager';
import {
  getDeployBreaker,
  resetDeployBreaker,
  breakerKey,
} from '../../managers/guardrail/deploy-breaker';
import { getPrincipalQuota, resetPrincipalQuota } from '../../managers/guardrail/principal-quota';

interface LimitsBody {
  deploys: {
    used: number;
    limit: number;
    windowResetsAt: string | null;
    ownerUsed: number | null;
    ownerLimit: number | null;
  } | null;
  breaker: {
    open: boolean;
    retryAfterSeconds: number | null;
    newApps: { open: boolean; failures: number };
    owner: { open: boolean; failures: number } | null;
    apps: Array<{ app: string; open: boolean; failures: number }>;
  } | null;
  ephemeral: { live: number; max: number; defaultTtlMinutes: number; maxTtlMinutes: number };
  apps: { used: number; limit: number };
  disk: { perAppMaxMb: number | null };
}

describe('GET /api/v1/limits', () => {
  let t: TestApiServer;
  let aliceId: string;
  let bobId: string;
  let aliceToken: string;
  let bobToken: string;

  const get = async (token?: string) =>
    t.hono.request('/api/v1/limits', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  const body = async (token: string): Promise<LimitsBody> => {
    const res = await get(token);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: LimitsBody }).data;
  };

  beforeEach(async () => {
    t = await createTestApiServer({ port: 3193, tempPrefix: 'drop-limits-' });
    resetDeployBreaker();
    resetPrincipalQuota();
    // Initialised up front, as the platform does at boot: a first initialize()
    // inside the route would reload from disk over records made in the test.
    await getPrincipalQuota(path.join(t.tempDir, 'principal-quotas.json')).initialize();

    aliceId = (await createUser('alice', 'password123', 'user')).id;
    bobId = (await createUser('bob', 'password123', 'user')).id;
    aliceToken = await getTestToken('alice', 'password123');
    bobToken = await getTestToken('bob', 'password123');

    await getStateManager().registerApp('alice-app', path.join(t.tempDir, 'alice-app'));
    await getStateManager().updateApp('alice-app', { userId: aliceId });
  });

  afterEach(async () => {
    resetDeployBreaker();
    resetPrincipalQuota();
    await teardownTestApiServer(t);
  });

  it('requires authentication', async () => {
    expect((await get()).status).toBe(401);
  });

  it('reports every limit that can refuse the next deploy, at zero usage', async () => {
    const data = await body(aliceToken);

    expect(data.deploys).toEqual(
      expect.objectContaining({ used: 0, limit: 20, ownerUsed: 0, ownerLimit: 60, windowResetsAt: null })
    );
    expect(data.breaker).toEqual(
      expect.objectContaining({ open: false, retryAfterSeconds: null, apps: [] })
    );
    expect(data.ephemeral).toEqual({ live: 0, max: 3, defaultTtlMinutes: 60, maxTtlMinutes: 1440 });
    expect(data.apps).toEqual({ used: 1, limit: 5 });
    expect(data.disk).toEqual({ perAppMaxMb: 2048 });
  });

  it("counts the caller's own deploys and never another tenant's", async () => {
    const quota = getPrincipalQuota();
    const keysFor = (userId: string) => {
      const k = quota.keysFor({ principalId: `jwt:${userId}`, actorUserId: userId });
      if (!k.metered) throw new Error('expected metered keys');
      return k.keys;
    };
    quota.record(keysFor(aliceId));
    quota.record(keysFor(aliceId));
    quota.record(keysFor(bobId));

    const alice = await body(aliceToken);
    const bob = await body(bobToken);

    expect(alice.deploys?.used).toBe(2);
    expect(alice.deploys?.ownerUsed).toBe(2);
    expect(alice.deploys?.windowResetsAt).toEqual(expect.any(String));
    expect(bob.deploys?.used).toBe(1);
  });

  it("reports an open breaker on the caller's own app, and only to the caller", async () => {
    const breaker = getDeployBreaker();
    const key = breakerKey(`jwt:${aliceId}`, 'alice-app');
    for (let i = 0; i < breaker.threshold; i++) breaker.recordFailure(key);

    const alice = await body(aliceToken);
    const bob = await body(bobToken);

    expect(alice.breaker?.open).toBe(true);
    expect(alice.breaker?.retryAfterSeconds).toBeGreaterThan(0);
    expect(alice.breaker?.apps).toEqual([
      expect.objectContaining({ app: 'alice-app', open: true, failures: breaker.threshold }),
    ]);
    expect(bob.breaker?.open).toBe(false);
    expect(JSON.stringify(bob)).not.toContain('alice-app');
  });

  it('never changes what it reports: a lapsed cooldown is not expired by reading it', async () => {
    const breaker = getDeployBreaker();
    const key = breakerKey(`jwt:${aliceId}`);
    const peek = jest.spyOn(breaker, 'peek');
    const check = jest.spyOn(breaker, 'check');
    breaker.recordFailure(key);
    check.mockClear();

    const data = await body(aliceToken);

    expect(data.breaker?.newApps.failures).toBe(1);
    expect(peek).toHaveBeenCalled();
    // check() prunes and deletes; the route must not reach for it.
    expect(check).not.toHaveBeenCalled();
  });

  it("gives an admin their OWN figures, not the fleet's", async () => {
    await createUser('root', 'password123', 'admin');
    const adminToken = await getTestToken('root', 'password123');

    const data = await body(adminToken);

    // alice's app exists, but it is not the admin's.
    expect(data.apps).toEqual({ used: 0, limit: 0 });
    expect(data.breaker?.apps).toEqual([]);
  });
});
