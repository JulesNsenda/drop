/**
 * DropPlatform.attachService (DROP-151 Phase 2) — the headline operation of
 * this phase, previously untested at any level. The 26 route tests in
 * src/api/routes/apps.services.routes.test.ts all mock
 * PlatformOps.attachService, so none of them execute this method.
 *
 * Shape: `createPlatform()` + field stubs (the platform.service-quota.test.ts
 * harness) plus a `jest.spyOn(platform as any, 'doRestart')` — NOT the heavy
 * real-orchestration harness platform.restart.test.ts uses. attachService's
 * own contract (guard ordering, no-side-effects-before-persistence, the busy
 * guard spanning provisioning) is a property of attachService's body, not of
 * doRestart's internals — doRestart already has its own dedicated suite, and
 * platform.restart.test.ts's own "DROP-151: AppConfig.services attach/detach
 * intent" block already proves the persisted config round-trips through a
 * real redeploy/restart. Stubbing doRestart here keeps every test fast and
 * keeps the "nothing happens before X" assertions honest against a
 * per-test-fresh mock, rather than the module-level dbProvisioner mock
 * platform.restart.test.ts warns (at its own lines ~740-746) survives
 * jest.restoreAllMocks() and can make a "not called" assertion pass for the
 * wrong reason.
 *
 * Ordering per platform.ts's own attachService doc comment:
 *   1. busy (AppInProgressError, spans the WHOLE operation)
 *   2. Application not found (both config and state absent)
 *   3. no-app-config (state but no AppConfig)
 *   4. ephemeral
 *   5. has-own-database-url (postgres only)
 *   6. quota-exceeded
 *   7. service-unavailable (checked INSIDE the provisioning branch, i.e.
 *      textually after quota — see the dedicated describe block below for why
 *      that is not a defect)
 *   8. provision -> persist (setServiceIntent) -> restart (doRestart)
 */

import * as path from 'path';
import * as os from 'os';
import { DropPlatform, createPlatform } from './platform';
import { AppInProgressError } from '../api/platform-ops';
import { HOST_ALIAS } from '../managers/runtime/container-config';
import type { AppState } from '../managers/app/state-manager';
import type { AppConfig } from '../managers/app/app-config';
import {
  baseConfig as baseConfigFixture,
  baseState as baseStateFixture,
  stubAppConfigService as stubAppConfigServiceFixture,
} from './__testutils__/service-fixtures';

describe('DropPlatform.attachService', () => {
  let platform: DropPlatform;
  const appName = 'myapp';

  // Thin closures over `appName`/`platform` so every call site below stays
  // `baseConfig(...)`/`stubAppConfigService(...)` — see
  // __testutils__/service-fixtures.ts for the shared bodies (also used by
  // platform.detach-service.test.ts).
  const baseConfig = (overrides?: Partial<AppConfig>): AppConfig => baseConfigFixture(appName, overrides);
  const baseState = (overrides?: Partial<AppState>): AppState => baseStateFixture(appName, overrides);
  const stubAppConfigService = (config: AppConfig | undefined): jest.Mock =>
    stubAppConfigServiceFixture(platform, config);

  /** Stub AppStateManager: getApp resolves the app, getAllApps backs the quota count. */
  const stubStateManager = (state: AppState | undefined, allApps: AppState[] = []): void => {
    (platform as any).stateManager = {
      getApp: jest.fn().mockReturnValue(state),
      getAllApps: jest.fn().mockReturnValue(allApps),
    };
  };

  /** No secretManager.get call ever returns a DATABASE_URL unless told to. */
  const stubSecrets = (databaseUrl: string | null = null, redisUrl: string | null = null): void => {
    (platform as any).secretManager = {
      get: jest.fn((_app: string, key: string) => {
        if (key === 'DATABASE_URL') return databaseUrl;
        if (key === 'REDIS_URL') return redisUrl;
        return null;
      }),
    };
  };

  type DbProvisionerStub = {
    isProvisioned: jest.Mock;
    provisionAppDatabase: jest.Mock;
    getEnvVars: jest.Mock;
  };

  /** Stub (or null out) dbProvisioner. Realistic-looking credentials by default, per the brief. */
  const stubDbProvisioner = (opts?: {
    present?: boolean;
    provisionedNames?: string[];
    envVars?: Record<string, string>;
  }): DbProvisionerStub | null => {
    if (opts?.present === false) {
      (platform as any).dbProvisioner = null;
      return null;
    }
    const stub: DbProvisionerStub = {
      isProvisioned: jest.fn((name: string) => (opts?.provisionedNames ?? []).includes(name)),
      provisionAppDatabase: jest.fn().mockResolvedValue(undefined),
      getEnvVars: jest.fn().mockReturnValue(
        opts?.envVars ?? { DATABASE_URL: 'postgresql://app_u:s3cr3tpassw0rd@127.0.0.1:5433/app_db' }
      ),
    };
    (platform as any).dbProvisioner = stub;
    return stub;
  };

  type RedisProvisionerStub = {
    isProvisioned: jest.Mock;
    provisionAppRedis: jest.Mock;
    getEnvVars: jest.Mock;
  };

  /** Stub (or null out) redisProvisioner. Realistic-looking credentials by default, per the brief. */
  const stubRedisProvisioner = (opts?: {
    present?: boolean;
    provisionedNames?: string[];
    envVars?: Record<string, string>;
  }): RedisProvisionerStub | null => {
    if (opts?.present === false) {
      (platform as any).redisProvisioner = null;
      return null;
    }
    const stub: RedisProvisionerStub = {
      isProvisioned: jest.fn((name: string) => (opts?.provisionedNames ?? []).includes(name)),
      provisionAppRedis: jest.fn().mockResolvedValue({ db: 3 }),
      getEnvVars: jest.fn().mockReturnValue(
        opts?.envVars ?? { REDIS_URL: 'redis://:r3d1sp4ss@127.0.0.1:6380/3', REDIS_DB: '3' }
      ),
    };
    (platform as any).redisProvisioner = stub;
    return stub;
  };

  /**
   * Shared "nothing irreversible happened" assertion for a refusal. Provided
   * provisioners are asserted un-touched; setServiceIntent and doRestart are
   * always asserted not-called (the load-bearing pair when a provisioner
   * argument is null, since "not called" on a null object is vacuous).
   */
  const expectNoSideEffects = (
    dbProvisioner: DbProvisionerStub | null,
    redisProvisioner: RedisProvisionerStub | null,
    setServiceIntent: jest.Mock,
    doRestartSpy: jest.SpyInstance
  ): void => {
    if (dbProvisioner) expect(dbProvisioner.provisionAppDatabase).not.toHaveBeenCalled();
    if (redisProvisioner) expect(redisProvisioner.provisionAppRedis).not.toHaveBeenCalled();
    expect(setServiceIntent).not.toHaveBeenCalled();
    expect(doRestartSpy).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    const tempDir = path.join(os.tmpdir(), `drop-attach-${Date.now()}-${Math.random()}`);
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      maxDbsPerUser: 2,
      maxRedisPerUser: 2,
    });
  });

  // ── Not-found / no-app-config ───────────────────────────────────────────

  it('throws "Application not found" when neither config nor state exists, before any refusal logic', async () => {
    stubAppConfigService(undefined);
    stubStateManager(undefined);
    stubSecrets(null);
    const dbProvisioner = stubDbProvisioner();
    const redisProvisioner = stubRedisProvisioner();
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart');

    await expect(platform.attachService(appName, 'postgres')).rejects.toThrow(
      `Application not found: ${appName}`
    );
    expectNoSideEffects(
      dbProvisioner,
      redisProvisioner,
      (platform as any).appConfigService.setServiceIntent,
      doRestartSpy
    );
  });

  it('refuses no-app-config when the app has runtime state but no AppConfig, before provisioning', async () => {
    const setServiceIntent = stubAppConfigService(undefined);
    stubStateManager(baseState());
    stubSecrets(null);
    const dbProvisioner = stubDbProvisioner();
    const redisProvisioner = stubRedisProvisioner();
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart');

    const result = await platform.attachService(appName, 'postgres');

    expect(result).toEqual({
      attached: false,
      reason: 'no-app-config',
      detail: expect.any(String),
    });
    expectNoSideEffects(dbProvisioner, redisProvisioner, setServiceIntent, doRestartSpy);
  });

  // ── ephemeral ────────────────────────────────────────────────────────────

  it('refuses ephemeral apps, before provisioning', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig({ ephemeral: true }));
    stubStateManager(baseState());
    stubSecrets(null);
    const dbProvisioner = stubDbProvisioner();
    const redisProvisioner = stubRedisProvisioner();
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart');

    const result = await platform.attachService(appName, 'postgres');

    expect(result).toEqual({
      attached: false,
      reason: 'ephemeral',
      detail: expect.any(String),
    });
    expectNoSideEffects(dbProvisioner, redisProvisioner, setServiceIntent, doRestartSpy);
  });

  // ── has-own-database-url (postgres only) ────────────────────────────────

  it('refuses has-own-database-url for postgres when the app already has its own DATABASE_URL secret, before provisioning', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig());
    stubStateManager(baseState());
    stubSecrets('postgresql://elsewhere/prod');
    const dbProvisioner = stubDbProvisioner();
    const redisProvisioner = stubRedisProvisioner();
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart');

    const result = await platform.attachService(appName, 'postgres');

    expect(result).toEqual({
      attached: false,
      reason: 'has-own-database-url',
      detail: expect.any(String),
    });
    expectNoSideEffects(dbProvisioner, redisProvisioner, setServiceIntent, doRestartSpy);
  });

  it('does NOT check has-own-database-url for redis (an own DATABASE_URL secret does not block attaching Redis)', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ userId: undefined }));
    stubSecrets('postgresql://elsewhere/prod');
    stubDbProvisioner();
    const redisProvisioner = stubRedisProvisioner();
    jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const result = await platform.attachService(appName, 'redis');

    expect(result).toEqual({ attached: true, envVarNames: ['REDIS_URL', 'REDIS_DB'] });
    expect(redisProvisioner!.provisionAppRedis).toHaveBeenCalledWith(appName);
  });

  // ── has-own-redis-url (redis only) ───────────────────────────────────────
  //
  // The Redis half of the same guard. It was originally built for Postgres
  // only, which left the identical hazard open here: redisEnvVars is spread
  // after secretEnvVars, so attaching over an owner's own REDIS_URL repoints
  // the app at an empty instance — for a session store, that destroys live
  // auth state rather than merely losing a cached value.

  it('refuses has-own-redis-url for redis when the app already has its own REDIS_URL secret, before provisioning', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig());
    stubStateManager(baseState());
    stubSecrets(null, 'redis://elsewhere:6379/0');
    const dbProvisioner = stubDbProvisioner();
    const redisProvisioner = stubRedisProvisioner();
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart');

    const result = await platform.attachService(appName, 'redis');

    expect(result).toEqual({
      attached: false,
      reason: 'has-own-redis-url',
      detail: expect.any(String),
    });
    expectNoSideEffects(dbProvisioner, redisProvisioner, setServiceIntent, doRestartSpy);
  });

  it('does NOT check has-own-redis-url for postgres (an own REDIS_URL secret does not block attaching Postgres)', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ userId: undefined }));
    stubSecrets(null, 'redis://elsewhere:6379/0');
    const dbProvisioner = stubDbProvisioner();
    stubRedisProvisioner();
    jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const result = await platform.attachService(appName, 'postgres');

    expect(result).toEqual({ attached: true, envVarNames: expect.any(Array) });
    expect(dbProvisioner!.provisionAppDatabase).toHaveBeenCalledWith(appName);
  });

  // ── quota-exceeded ───────────────────────────────────────────────────────

  it('refuses quota-exceeded for postgres once the owner is at the configured limit, before provisioning', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig());
    stubStateManager(baseState({ userId: 'user-1' }), [
      baseState({ name: 'other1', userId: 'user-1' }),
      baseState({ name: 'other2', userId: 'user-1' }),
    ]);
    stubSecrets(null);
    const dbProvisioner = stubDbProvisioner({ provisionedNames: ['other1', 'other2'] });
    const redisProvisioner = stubRedisProvisioner();
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart');

    const result = await platform.attachService(appName, 'postgres');

    expect(result).toEqual({
      attached: false,
      reason: 'quota-exceeded',
      detail: expect.any(String),
      quota: { used: 2, limit: 2 },
    });
    expectNoSideEffects(dbProvisioner, redisProvisioner, setServiceIntent, doRestartSpy);
  });

  it('refuses quota-exceeded for redis once the owner is at the configured limit, before provisioning', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig());
    stubStateManager(baseState({ userId: 'user-1' }), [
      baseState({ name: 'other1', userId: 'user-1' }),
      baseState({ name: 'other2', userId: 'user-1' }),
    ]);
    stubSecrets(null);
    const dbProvisioner = stubDbProvisioner();
    const redisProvisioner = stubRedisProvisioner({ provisionedNames: ['other1', 'other2'] });
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart');

    const result = await platform.attachService(appName, 'redis');

    expect(result).toEqual({
      attached: false,
      reason: 'quota-exceeded',
      detail: expect.any(String),
      quota: { used: 2, limit: 2 },
    });
    expectNoSideEffects(dbProvisioner, redisProvisioner, setServiceIntent, doRestartSpy);
  });

  // ── service-unavailable ──────────────────────────────────────────────────

  it('refuses service-unavailable for postgres when no database provisioner exists, before persisting or restarting', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig());
    stubStateManager(baseState());
    stubSecrets(null);
    stubDbProvisioner({ present: false });
    const redisProvisioner = stubRedisProvisioner();
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart');

    const result = await platform.attachService(appName, 'postgres');

    expect(result).toEqual({
      attached: false,
      reason: 'service-unavailable',
      detail: expect.any(String),
    });
    // "provisionAppDatabase not called" would be vacuous (the provisioner is
    // null) — the load-bearing assertions here are the other provisioner
    // untouched, plus persist/restart untouched.
    expectNoSideEffects(null, redisProvisioner, setServiceIntent, doRestartSpy);
  });

  it('refuses service-unavailable for redis when managed Redis is unavailable, before persisting or restarting', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig());
    stubStateManager(baseState());
    stubSecrets(null);
    const dbProvisioner = stubDbProvisioner();
    stubRedisProvisioner({ present: false });
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart');

    const result = await platform.attachService(appName, 'redis');

    expect(result).toEqual({
      attached: false,
      reason: 'service-unavailable',
      detail: expect.any(String),
    });
    expectNoSideEffects(dbProvisioner, null, setServiceIntent, doRestartSpy);
  });

  // The brief lists service-unavailable (5) before quota-exceeded (6); the
  // code checks quota BEFORE the (postgres|redis)-specific provisioner-null
  // branch. Verified NOT a defect: checkDbQuota/checkRedisQuota both
  // short-circuit to {allowed:true} when their own provisioner is null
  // (platform.ts:2860 / :2883), so a null provisioner can never be reported
  // as "over quota" regardless of how many apps stateManager reports for the
  // owner — the two orderings are observationally equivalent. Pinned here so
  // a future removal of that short-circuit (which WOULD make the ordering
  // observable, and wrong per the brief) is caught.
  it('when the provisioner is entirely absent, an "over quota"-shaped owner still gets service-unavailable, not quota-exceeded', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ userId: 'user-1' }), [
      baseState({ name: 'other1', userId: 'user-1' }),
      baseState({ name: 'other2', userId: 'user-1' }),
    ]);
    stubSecrets(null);
    stubDbProvisioner({ present: false });

    const result = await platform.attachService(appName, 'postgres');

    expect(result).toMatchObject({ attached: false, reason: 'service-unavailable' });
  });

  // ── Ordering between refusals ────────────────────────────────────────────

  it('has-own-database-url is checked before quota-exceeded — a user who cannot attach at all is not told they are over quota', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ userId: 'user-1' }), [
      baseState({ name: 'other1', userId: 'user-1' }),
      baseState({ name: 'other2', userId: 'user-1' }),
    ]);
    stubSecrets('postgresql://elsewhere/prod');
    stubDbProvisioner({ provisionedNames: ['other1', 'other2'] });

    const result = await platform.attachService(appName, 'postgres');

    expect(result).toMatchObject({ attached: false, reason: 'has-own-database-url' });
  });

  it('ephemeral is checked before has-own-database-url', async () => {
    stubAppConfigService(baseConfig({ ephemeral: true }));
    stubStateManager(baseState());
    stubSecrets('postgresql://elsewhere/prod');
    stubDbProvisioner();

    const result = await platform.attachService(appName, 'postgres');

    expect(result).toMatchObject({ attached: false, reason: 'ephemeral' });
  });

  it('ephemeral is checked before quota-exceeded', async () => {
    stubAppConfigService(baseConfig({ ephemeral: true }));
    stubStateManager(baseState({ userId: 'user-1' }), [
      baseState({ name: 'other1', userId: 'user-1' }),
      baseState({ name: 'other2', userId: 'user-1' }),
    ]);
    stubSecrets(null);
    stubDbProvisioner({ provisionedNames: ['other1', 'other2'] });

    const result = await platform.attachService(appName, 'postgres');

    expect(result).toMatchObject({ attached: false, reason: 'ephemeral' });
  });

  // ── Success path: provision -> persist -> restart, in that order ───────────

  it('provisions, then persists intent, then restarts — in that order (postgres)', async () => {
    const callOrder: string[] = [];
    const setServiceIntent = stubAppConfigService(baseConfig());
    stubStateManager(baseState());
    stubSecrets(null);
    const dbProvisioner = stubDbProvisioner();
    dbProvisioner!.provisionAppDatabase.mockImplementation(async () => {
      callOrder.push('provision');
    });
    setServiceIntent.mockImplementation(async () => {
      callOrder.push('upsert');
      return baseConfig();
    });
    const doRestartSpy = jest
      .spyOn(platform as any, 'doRestart')
      .mockImplementation(async () => {
        callOrder.push('restart');
      });

    const result = await platform.attachService(appName, 'postgres');

    expect(callOrder).toEqual(['provision', 'upsert', 'restart']);
    expect(result).toEqual({ attached: true, envVarNames: ['DATABASE_URL'] });
    expect(doRestartSpy).toHaveBeenCalledWith(appName);
  });

  it('provisions, then persists intent, then restarts — in that order (redis)', async () => {
    const callOrder: string[] = [];
    const setServiceIntent = stubAppConfigService(baseConfig());
    stubStateManager(baseState());
    stubSecrets(null);
    const redisProvisioner = stubRedisProvisioner();
    redisProvisioner!.provisionAppRedis.mockImplementation(async () => {
      callOrder.push('provision');
      return { db: 3 };
    });
    setServiceIntent.mockImplementation(async () => {
      callOrder.push('upsert');
      return baseConfig();
    });
    const doRestartSpy = jest
      .spyOn(platform as any, 'doRestart')
      .mockImplementation(async () => {
        callOrder.push('restart');
      });

    const result = await platform.attachService(appName, 'redis');

    expect(callOrder).toEqual(['provision', 'upsert', 'restart']);
    expect(result).toEqual({ attached: true, envVarNames: ['REDIS_URL', 'REDIS_DB'] });
    expect(doRestartSpy).toHaveBeenCalledWith(appName);
  });

  it('persists intent via setServiceIntent(appName, serviceId, "attached") — merging siblings is setServiceIntent\'s own job now (#11), not platform.ts\'s', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig({ services: { redis: 'detached' } }));
    stubStateManager(baseState());
    stubSecrets(null);
    stubDbProvisioner();
    jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    await platform.attachService(appName, 'postgres');

    expect(setServiceIntent).toHaveBeenCalledWith(appName, 'postgres', 'attached');
  });

  it('refuses no-app-config when setServiceIntent resolves null AFTER provisioning succeeded (a deleteConfig landed in the gap) — never silently drops the intent, never restarts', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig());
    setServiceIntent.mockResolvedValue(null);
    stubStateManager(baseState());
    stubSecrets(null);
    const dbProvisioner = stubDbProvisioner();
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const result = await platform.attachService(appName, 'postgres');

    expect(result).toEqual({
      attached: false,
      reason: 'no-app-config',
      detail: expect.any(String),
    });
    // Provisioning already ran (setServiceIntent's own read happens INSIDE
    // its write chain, at execution time — after the provisioning awaits
    // above it in the method body) — this is the "provisioned but
    // unlabeled" gap the ordering-note comment already flags, not a new
    // one. The point of the fix is that the refusal is now RETURNED rather
    // than silently ignored, and the restart never fires for it.
    expect(dbProvisioner!.provisionAppDatabase).toHaveBeenCalledWith(appName);
    expect(doRestartSpy).not.toHaveBeenCalled();
    expect((platform as any).appsInProgress.has(appName)).toBe(false);
  });

  it('when provisioning rejects, nothing is persisted or restarted, and the busy guard is released', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig());
    stubStateManager(baseState());
    stubSecrets(null);
    const dbProvisioner = stubDbProvisioner();
    dbProvisioner!.provisionAppDatabase.mockRejectedValue(new Error('provision failed'));
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart');

    await expect(platform.attachService(appName, 'postgres')).rejects.toThrow('provision failed');

    expect(setServiceIntent).not.toHaveBeenCalled();
    expect(doRestartSpy).not.toHaveBeenCalled();
    expect((platform as any).appsInProgress.has(appName)).toBe(false);
  });

  // ── envVarNames: names only, never values ───────────────────────────────

  it('envVarNames carries names only — no DSN or password leaks into the result, even from a realistic-looking credential (postgres)', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState());
    stubSecrets(null);
    stubDbProvisioner({
      envVars: { DATABASE_URL: 'postgresql://app_u:s3cr3tpassw0rd@127.0.0.1:5433/app_db' },
    });
    jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const result = await platform.attachService(appName, 'postgres');

    expect(result).toEqual({ attached: true, envVarNames: ['DATABASE_URL'] });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/s3cr3tpassw0rd/);
    expect(serialized).not.toMatch(/postgresql:\/\//);
  });

  it('envVarNames carries names only — no connection string or password leaks into the result (redis)', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState());
    stubSecrets(null);
    stubRedisProvisioner({
      envVars: { REDIS_URL: 'redis://:r3d1sp4ss@127.0.0.1:6380/3', REDIS_DB: '3' },
    });
    jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const result = await platform.attachService(appName, 'redis');

    expect(result).toEqual({ attached: true, envVarNames: ['REDIS_URL', 'REDIS_DB'] });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/r3d1sp4ss/);
    expect(serialized).not.toMatch(/redis:\/\//);
  });

  // ── The busy guard: released on refusal, held across provisioning ──────────

  it('a refusal releases the busy guard — a second attach for the same app is not blocked', async () => {
    stubAppConfigService(baseConfig({ ephemeral: true }));
    stubStateManager(baseState());
    stubSecrets(null);
    stubDbProvisioner();

    await platform.attachService(appName, 'postgres');
    expect((platform as any).appsInProgress.has(appName)).toBe(false);

    await expect(platform.attachService(appName, 'postgres')).resolves.toMatchObject({
      attached: false,
      reason: 'ephemeral',
    });
  });

  // The per-app busy guard does NOT cover this: two DIFFERENT apps with the
  // same owner sail past it, both read the same `used` count before either
  // provisioner call registers, and both provision — so an owner at the limit
  // can exceed it in one burst. The owner lock is what closes that, and an
  // untested lock is exactly the kind that silently stops locking.
  it('serialises attaches by OWNER — a second attach for a different app of the same owner waits for the first to finish provisioning', async () => {
    const appA = 'app-a';
    const appB = 'app-b';
    // Both apps share baseState()'s userId ('user-1') — that shared owner is
    // the whole point: the per-app guard cannot see it, the quota does.
    const stateFor = (name: string): AppState => baseState({ name, path: `/apps/${name}` });
    (platform as any).stateManager = {
      getApp: jest.fn((name: string) => stateFor(name)),
      getAllApps: jest.fn().mockReturnValue([stateFor(appA), stateFor(appB)]),
    };
    (platform as any).appConfigService = {
      getConfig: jest.fn((name: string) => baseConfig({ name, path: `/apps/${name}` })),
      // Truthy (attach checks this return value) — the specific shape isn't
      // asserted by this test, only that attach isn't refused over it.
      setServiceIntent: jest.fn().mockResolvedValue(baseConfig()),
    };
    stubSecrets(null);
    const dbProvisioner = stubDbProvisioner();
    jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStartedResolve: () => void = () => {};
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedResolve = resolve;
    });
    let calls = 0;
    dbProvisioner!.provisionAppDatabase.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        firstStartedResolve();
        await firstGate;
      }
    });

    const first = platform.attachService(appA, 'postgres');
    await firstStarted;

    const second = platform.attachService(appB, 'postgres');
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });

    // Counting microtask ticks is NOT enough and produced a vacuous test on
    // the first attempt: appB's own guards (`appDatabaseUrlSource` →
    // `parseDropYaml`) await before ever reaching the provisioner, so
    // "provision not yet called" is briefly true with or without the lock.
    // What the lock actually guarantees is stronger and time-independent in
    // direction: appB cannot COMPLETE while appA holds. Its provisioner mock
    // returns immediately (only the first call blocks), so without the lock
    // `second` settles here; with it, it cannot.
    await new Promise((r) => setTimeout(r, 25));

    expect(secondSettled).toBe(false);
    expect(dbProvisioner!.provisionAppDatabase).toHaveBeenCalledTimes(1);
    expect(dbProvisioner!.provisionAppDatabase).toHaveBeenCalledWith(appA);

    releaseFirst();
    await expect(first).resolves.toEqual({ attached: true, envVarNames: expect.any(Array) });
    await expect(second).resolves.toEqual({ attached: true, envVarNames: expect.any(Array) });
    expect(dbProvisioner!.provisionAppDatabase).toHaveBeenCalledTimes(2);
  });

  it('the busy guard spans provisioning — a second attach for the same app while one is in flight throws AppInProgressError', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState());
    stubSecrets(null);
    const dbProvisioner = stubDbProvisioner();

    let releaseProvision: () => void = () => {};
    const provisionGate = new Promise<void>((resolve) => {
      releaseProvision = resolve;
    });
    let provisionStartedResolve: () => void = () => {};
    const provisionStarted = new Promise<void>((resolve) => {
      provisionStartedResolve = resolve;
    });
    dbProvisioner!.provisionAppDatabase.mockImplementation(async () => {
      provisionStartedResolve();
      await provisionGate;
    });
    jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const firstCall = platform.attachService(appName, 'postgres');
    // Deterministically inside provisioning: appDatabaseUrlSource (a real fs
    // read) and the quota check have both already resolved by the time
    // provisionAppDatabase itself starts running.
    await provisionStarted;

    await expect(platform.attachService(appName, 'postgres')).rejects.toThrow(AppInProgressError);
    expect(dbProvisioner!.provisionAppDatabase).toHaveBeenCalledTimes(1);

    releaseProvision();
    const result = await firstCall;

    expect(result).toEqual({ attached: true, envVarNames: ['DATABASE_URL'] });
    expect((platform as any).appsInProgress.has(appName)).toBe(false);
  });

  // ── Isolation parity (CLAUDE.md: single-mode-only behaviour is a bug class) ─

  describe('isolation parity', () => {
    it('postgres: getEnvVars is called with pgSocketDir under docker isolation', async () => {
      stubAppConfigService(baseConfig());
      stubStateManager(baseState());
      stubSecrets(null);
      const dbProvisioner = stubDbProvisioner();
      (platform as any).postgresServer = { getSocketDir: jest.fn().mockReturnValue('/tmp/pgsocket') };
      (platform as any).config.isolation = 'docker';
      jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

      await platform.attachService(appName, 'postgres');

      expect(dbProvisioner!.getEnvVars).toHaveBeenCalledWith(appName, { pgSocketDir: '/tmp/pgsocket' });
    });

    it('postgres: getEnvVars is called with undefined options under none isolation', async () => {
      stubAppConfigService(baseConfig());
      stubStateManager(baseState());
      stubSecrets(null);
      const dbProvisioner = stubDbProvisioner();
      (platform as any).config.isolation = 'none';
      jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

      await platform.attachService(appName, 'postgres');

      expect(dbProvisioner!.getEnvVars).toHaveBeenCalledWith(appName, undefined);
    });

    it('redis: getEnvVars is called with the drop-host alias under docker isolation', async () => {
      stubAppConfigService(baseConfig());
      stubStateManager(baseState());
      stubSecrets(null);
      const redisProvisioner = stubRedisProvisioner();
      (platform as any).config.isolation = 'docker';
      jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

      await platform.attachService(appName, 'redis');

      expect(redisProvisioner!.getEnvVars).toHaveBeenCalledWith(appName, { host: HOST_ALIAS });
    });

    it('redis: getEnvVars is called with loopback under none isolation', async () => {
      stubAppConfigService(baseConfig());
      stubStateManager(baseState());
      stubSecrets(null);
      const redisProvisioner = stubRedisProvisioner();
      (platform as any).config.isolation = 'none';
      jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

      await platform.attachService(appName, 'redis');

      expect(redisProvisioner!.getEnvVars).toHaveBeenCalledWith(appName, { host: '127.0.0.1' });
    });
  });
});

