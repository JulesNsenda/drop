/**
 * DropPlatform.detachService (DROP-151 Phase 3 — detach), the mirror of
 * attachService (see platform.attach-service.test.ts). Same harness shape and
 * same reason it's the right one here: `createPlatform()` + per-test field
 * stubs, NOT the heavy real-orchestration harness platform.restart.test.ts
 * uses. This suite's assertions are almost entirely "X was/wasn't called, in
 * this order" — mixing in the module-level jest.mock('../managers/database')
 * harness would reintroduce exactly the vacuous-pass mode
 * platform.restart.test.ts's own header warns about (a mock whose call
 * history survives jest.restoreAllMocks() across tests). The isolation-parity
 * assertion (detach's restart spec carries no DATABASE_URL/REDIS_URL under
 * both runtimes) therefore lives in platform.restart.test.ts's own
 * "DROP-151: AppConfig.services attach/detach intent" block instead, where
 * the real buildFreshStartSpec/doRestart machinery already runs.
 *
 * Guard order per platform.ts's own detachService doc comment:
 *   1. busy (AppInProgressError, spans the WHOLE operation)
 *   2. not-found (both config and state absent)
 *   3. group-app (container OR child)
 *   4. service-unavailable (per-service provisioner null)
 *   5. not provisioned -> credentials-missing (postgres orphan) OR a
 *      non-refusal early return (persist + {deprovisioned:false, restart:
 *      'not-needed'})
 *   6. detach-limit -> cooldown (per-SERVICE — keyed on
 *      `lastDetachAt[serviceId]`, not one shared per-app value), then
 *      (postgres only, skipped entirely for an ephemeral app) the per-owner
 *      byte budget, attributed via the SAME `ownerUserId` the deprovision
 *      call below is given; the retry exemption skips only the cooldown
 *   7. manifest conflict (never a refusal)
 *   8. setServiceIntent -> null is 'no-app-config', enforced at the write
 *      site rather than as an up-front guard
 *   9-10. stop (liveness from the RUNTIME, not state) then deprovision, in
 *      ONE try/catch (a throwing runtime.stop no longer escapes
 *      detachService). backup-failed / deprovision-failed on a genuine
 *      failure or a thrown error (restarts exactly once either way); a
 *      REPORTED redis flush failure is now a SUCCESS with `flushed: false`
 *      — 'flush-failed' no longer exists.
 *  11. restart iff `wasLive || wasRunning`
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DropPlatform, createPlatform } from './platform';
import { AppInProgressError } from '../api/platform-ops';
import type { AppState } from '../managers/app/state-manager';
import type { AppConfig } from '../managers/app/app-config';
import {
  baseConfig as baseConfigFixture,
  baseState as baseStateFixture,
  stubAppConfigService as stubAppConfigServiceFixture,
} from './__testutils__/service-fixtures';
// Dump attribution is keyed on a per-owner DIRECTORY (detach-limits.ts) —
// tests that exercise the byte budget must write into
// `ownerDumpDirName(userId)`, not the pre-delete root.
import { ownerDumpDirName } from '../managers/database/database-provisioner';

describe('DropPlatform.detachService', () => {
  let platform: DropPlatform;
  let dropRoot: string;
  const appName = 'myapp';
  const prevCooldownEnv = process.env.DROP_DETACH_COOLDOWN_MINUTES;
  const prevBudgetEnv = process.env.DROP_PREDELETE_MAX_MB;

  // Thin closures over `appName`/`platform` so every call site below stays
  // `baseConfig(...)`/`stubAppConfigService(...)` — see
  // __testutils__/service-fixtures.ts for the shared bodies (also used by
  // platform.attach-service.test.ts).
  const baseConfig = (overrides?: Partial<AppConfig>): AppConfig => baseConfigFixture(appName, overrides);
  const baseState = (overrides?: Partial<AppState>): AppState => baseStateFixture(appName, overrides);
  const stubAppConfigService = (config: AppConfig | undefined): jest.Mock =>
    stubAppConfigServiceFixture(platform, config);

  const stubStateManager = (state: AppState | undefined, allApps: AppState[] = []): {
    setAppStatus: jest.Mock;
  } => {
    const setAppStatus = jest.fn().mockResolvedValue(undefined);
    (platform as any).stateManager = {
      getApp: jest.fn().mockReturnValue(state),
      getAllApps: jest.fn().mockReturnValue(allApps),
      setAppStatus,
    };
    return { setAppStatus };
  };

  /** Runtime stub: getStatus (liveness), stop, and a settable `type`. Default: a live pm2 process. */
  const stubRuntime = (opts?: { live?: boolean; type?: 'pm2' | 'docker' }): {
    getStatus: jest.Mock;
    stop: jest.Mock;
  } => {
    const getStatus = jest
      .fn()
      .mockResolvedValue(opts?.live === false ? { status: 'stopped' } : { status: 'running' });
    const stop = jest.fn().mockResolvedValue(undefined);
    (platform as any).runtime = { getStatus, stop, type: opts?.type ?? 'pm2' };
    return { getStatus, stop };
  };

  type DbProvisionerStub = {
    isProvisioned: jest.Mock;
    orphanDatabaseExists: jest.Mock;
    backupAndDeleteAppDatabase: jest.Mock;
    dbNameForApp: jest.Mock;
    ownerDumpDir: jest.Mock;
  };

  const stubDbProvisioner = (opts?: {
    present?: boolean;
    provisionedNames?: string[];
    orphanExists?: boolean;
    backupResult?: Partial<{
      dropped: boolean;
      databaseDropped: boolean;
      roleDropped: boolean;
      reason: string;
      dumpPath: string;
    }>;
  }): DbProvisionerStub | null => {
    if (opts?.present === false) {
      (platform as any).dbProvisioner = null;
      return null;
    }
    const stub: DbProvisionerStub = {
      isProvisioned: jest.fn((name: string) => (opts?.provisionedNames ?? []).includes(name)),
      orphanDatabaseExists: jest.fn().mockResolvedValue(opts?.orphanExists ?? false),
      backupAndDeleteAppDatabase: jest.fn().mockResolvedValue({
        dropped: true,
        databaseDropped: true,
        roleDropped: true,
        dumpPath: path.join(dropRoot, 'data', 'backup', 'pre-delete', `drop_${appName}-stamp.dump`),
        ...opts?.backupResult,
      }),
      dbNameForApp: jest.fn((name: string) => `drop_${name}`),
      // Mirrors the real DatabaseProvisioner.ownerDumpDir (preDeleteRootDir()
      // + ownerDumpDirName(userId)) — detachService's byte-budget gate calls
      // this directly rather than rebuilding the path itself.
      ownerDumpDir: jest.fn((userId?: string | null) =>
        path.join(dropRoot, 'data', 'backup', 'pre-delete', ownerDumpDirName(userId))
      ),
    };
    (platform as any).dbProvisioner = stub;
    return stub;
  };

  type RedisProvisionerStub = {
    isProvisioned: jest.Mock;
    deprovisionAppRedis: jest.Mock;
  };

  const stubRedisProvisioner = (opts?: {
    present?: boolean;
    provisionedNames?: string[];
    deprovisionResult?: Partial<{ removed: boolean; flushed: boolean; hadAllocation: boolean }>;
  }): RedisProvisionerStub | null => {
    if (opts?.present === false) {
      (platform as any).redisProvisioner = null;
      return null;
    }
    const stub: RedisProvisionerStub = {
      isProvisioned: jest.fn((name: string) => (opts?.provisionedNames ?? []).includes(name)),
      deprovisionAppRedis: jest
        .fn()
        .mockResolvedValue({ removed: true, flushed: true, hadAllocation: true, ...opts?.deprovisionResult }),
    };
    (platform as any).redisProvisioner = stub;
    return stub;
  };

  beforeEach(async () => {
    dropRoot = await fs.mkdtemp(path.join(os.tmpdir(), `drop-detach-${Date.now()}-`));
    platform = createPlatform({
      dropRoot,
      appsDirectory: path.join(dropRoot, 'apps'),
      logLevel: 'error',
    });
    // detachService's init guard requires `this.runtime` (step 9 reads
    // liveness from it) — a default live pm2 stub so tests that don't care
    // about the stop recipe don't each have to wire one up; tests that DO
    // care call stubRuntime() again to override.
    stubRuntime();
    delete process.env.DROP_DETACH_COOLDOWN_MINUTES;
    delete process.env.DROP_PREDELETE_MAX_MB;
  });

  afterEach(async () => {
    if (prevCooldownEnv === undefined) delete process.env.DROP_DETACH_COOLDOWN_MINUTES;
    else process.env.DROP_DETACH_COOLDOWN_MINUTES = prevCooldownEnv;
    if (prevBudgetEnv === undefined) delete process.env.DROP_PREDELETE_MAX_MB;
    else process.env.DROP_PREDELETE_MAX_MB = prevBudgetEnv;
    await fs.rm(dropRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // ── busy ─────────────────────────────────────────────────────────────────

  it('throws AppInProgressError when the app is already in appsInProgress', async () => {
    (platform as any).appsInProgress.add(appName);
    await expect(platform.detachService(appName, 'postgres')).rejects.toThrow(AppInProgressError);
  });

  // ── not-found ────────────────────────────────────────────────────────────

  it('refuses not-found when neither config nor state exists — RETURNED, not thrown (unlike attach)', async () => {
    stubAppConfigService(undefined);
    stubStateManager(undefined);
    const dbProvisioner = stubDbProvisioner();
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart');

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toEqual({ detached: false, reason: 'not-found', detail: expect.any(String) });
    expect(dbProvisioner!.backupAndDeleteAppDatabase).not.toHaveBeenCalled();
    expect(doRestartSpy).not.toHaveBeenCalled();
    expect((platform as any).appsInProgress.has(appName)).toBe(false);
  });

  // ── group-app ────────────────────────────────────────────────────────────

  it('refuses group-app for a monorepo group CONTAINER, even though the service is otherwise attached and provisioned', async () => {
    stubAppConfigService(baseConfig({ services: { postgres: 'attached' } }));
    stubStateManager(baseState({ isGroupContainer: true, group: 'g1' }));
    const dbProvisioner = stubDbProvisioner({ provisionedNames: [appName] });

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toEqual({ detached: false, reason: 'group-app', detail: expect.any(String) });
    expect(dbProvisioner!.backupAndDeleteAppDatabase).not.toHaveBeenCalled();
  });

  it('refuses group-app for a group CHILD (carries only `group`, not isGroupContainer)', async () => {
    stubAppConfigService(baseConfig({ services: { postgres: 'attached' } }));
    stubStateManager(baseState({ group: 'g1' }));
    stubDbProvisioner({ provisionedNames: [appName] });

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toMatchObject({ detached: false, reason: 'group-app' });
  });

  // ── service-unavailable ──────────────────────────────────────────────────

  it('refuses service-unavailable for postgres when no database provisioner exists — wins over group-app being false but provisioned-true being unreachable', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState());
    stubDbProvisioner({ present: false });
    const redisProvisioner = stubRedisProvisioner();

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toEqual({ detached: false, reason: 'service-unavailable', detail: expect.any(String) });
    expect(redisProvisioner!.deprovisionAppRedis).not.toHaveBeenCalled();
  });

  it('refuses service-unavailable for redis when managed Redis is unavailable', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState());
    stubDbProvisioner();
    stubRedisProvisioner({ present: false });

    const result = await platform.detachService(appName, 'redis');

    expect(result).toEqual({ detached: false, reason: 'service-unavailable', detail: expect.any(String) });
  });

  // ── not provisioned: credentials-missing (postgres orphan) ─────────────────

  it('refuses credentials-missing when postgres reports not-provisioned but an orphaned database still exists on the server', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig());
    stubStateManager(baseState());
    const dbProvisioner = stubDbProvisioner({ provisionedNames: [], orphanExists: true });

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toEqual({ detached: false, reason: 'credentials-missing', detail: expect.any(String) });
    expect(setServiceIntent).not.toHaveBeenCalled();
    expect(dbProvisioner!.backupAndDeleteAppDatabase).not.toHaveBeenCalled();
  });

  // ── not provisioned: non-refusal early return ───────────────────────────

  it('not-provisioned + no orphan is NOT a refusal — persists "detached" intent and returns deprovisioned:false, restart:not-needed', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig());
    stubStateManager(baseState());
    const dbProvisioner = stubDbProvisioner({ provisionedNames: [], orphanExists: false });
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart');

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toEqual({
      detached: true,
      deprovisioned: false,
      manifestConflict: false,
      // Distinct from 'not-restarted' — nothing was ever stopped on this
      // branch, so liveness is beside the point.
      restart: 'not-needed',
    });
    // No lastDetachAt here — nothing was actually deprovisioned, so no
    // cooldown window needs to open.
    expect(setServiceIntent).toHaveBeenCalledWith(appName, 'postgres', 'detached');
    expect(dbProvisioner!.backupAndDeleteAppDatabase).not.toHaveBeenCalled();
    expect(doRestartSpy).not.toHaveBeenCalled();
  });

  it('the not-provisioned early return refuses no-app-config when setServiceIntent finds no config to write into', async () => {
    const setServiceIntent = stubAppConfigService(undefined);
    stubStateManager(baseState());
    setServiceIntent.mockResolvedValue(null);
    stubDbProvisioner({ provisionedNames: [], orphanExists: false });

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toEqual({ detached: false, reason: 'no-app-config', detail: expect.any(String) });
  });

  it('not-provisioned skips the cooldown/byte-budget guards entirely, even with a very recent lastDetachAt', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig({ lastDetachAt: { postgres: Date.now() } }));
    stubStateManager(baseState());
    stubDbProvisioner({ provisionedNames: [], orphanExists: false });

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toMatchObject({ detached: true, deprovisioned: false });
    expect(setServiceIntent).toHaveBeenCalled();
  });

  // ── detach-limit: cooldown ──────────────────────────────────────────────

  it('refuses detach-limit (cooldown) when the app was detached too recently, before persisting or deprovisioning', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig({ lastDetachAt: { postgres: Date.now() - 1000 } }));
    stubStateManager(baseState());
    const dbProvisioner = stubDbProvisioner({ provisionedNames: [appName] });
    process.env.DROP_DETACH_COOLDOWN_MINUTES = '10';

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toMatchObject({
      detached: false,
      reason: 'detach-limit',
      limit: 'cooldown',
      retryAfterSeconds: expect.any(Number),
    });
    expect(setServiceIntent).not.toHaveBeenCalled();
    expect(dbProvisioner!.backupAndDeleteAppDatabase).not.toHaveBeenCalled();
  });

  it('retry exemption: intent already "detached" while still provisioned skips ONLY the cooldown, not the byte budget', async () => {
    stubAppConfigService(baseConfig({ services: { postgres: 'detached' }, lastDetachAt: { postgres: Date.now() - 1000 } }));
    stubStateManager(baseState());
    stubDbProvisioner({ provisionedNames: [appName] });
    process.env.DROP_DETACH_COOLDOWN_MINUTES = '10';

    const result = await platform.detachService(appName, 'postgres');

    // Cooldown alone (a fresh lastDetachAt) would have refused this — the
    // exemption is what lets it proceed to a real deprovision attempt.
    expect(result).toMatchObject({ detached: true, deprovisioned: true });
  });

  // ── detach-limit: per-owner byte budget (postgres only) ─────────────────

  it('cooldown is checked BEFORE the byte budget — a fresh cooldown refusal wins even when the budget is also exhausted', async () => {
    stubAppConfigService(baseConfig({ lastDetachAt: { postgres: Date.now() - 1000 } }));
    stubStateManager(baseState({ userId: 'user-1' }), [baseState({ userId: 'user-1' })]);
    stubDbProvisioner({ provisionedNames: [appName] });
    process.env.DROP_DETACH_COOLDOWN_MINUTES = '10';
    process.env.DROP_PREDELETE_MAX_MB = '1';
    const ownerDir = path.join(dropRoot, 'data', 'backup', 'pre-delete', ownerDumpDirName('user-1'));
    await fs.mkdir(ownerDir, { recursive: true });
    await fs.writeFile(path.join(ownerDir, `drop_${appName}-stamp.dump`), Buffer.alloc(2 * 1024 * 1024));

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toMatchObject({ detached: false, reason: 'detach-limit', limit: 'cooldown' });
  });

  it('the cooldown is keyed PER SERVICE — a fresh postgres lastDetachAt does not 429 a redis detach for the same app', async () => {
    stubAppConfigService(baseConfig({ lastDetachAt: { postgres: Date.now() - 1000 } }));
    stubStateManager(baseState());
    stubRedisProvisioner({ provisionedNames: [appName] });
    process.env.DROP_DETACH_COOLDOWN_MINUTES = '10';

    const result = await platform.detachService(appName, 'redis');

    // A postgres cooldown alone would refuse a POSTGRES detach — this is a
    // REDIS detach, and redis has no recorded lastDetachAt of its own, so it
    // proceeds.
    expect(result).toMatchObject({ detached: true, deprovisioned: true });
  });

  it('refuses detach-limit (dump-budget) for postgres when the owner\'s pre-delete dumps exceed the ceiling — no retryAfterSeconds (pruning, not waiting, unblocks it)', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig());
    stubStateManager(baseState({ userId: 'user-1' }), [baseState({ userId: 'user-1' })]);
    const dbProvisioner = stubDbProvisioner({ provisionedNames: [appName] });
    process.env.DROP_PREDELETE_MAX_MB = '1';
    const ownerDir = path.join(dropRoot, 'data', 'backup', 'pre-delete', ownerDumpDirName('user-1'));
    await fs.mkdir(ownerDir, { recursive: true });
    await fs.writeFile(path.join(ownerDir, `drop_${appName}-stamp.dump`), Buffer.alloc(2 * 1024 * 1024));

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toEqual({
      detached: false,
      reason: 'detach-limit',
      limit: 'dump-budget',
      detail: expect.any(String),
    });
    expect((result as any).retryAfterSeconds).toBeUndefined();
    expect(setServiceIntent).not.toHaveBeenCalled();
    expect(dbProvisioner!.backupAndDeleteAppDatabase).not.toHaveBeenCalled();
  });

  it('the byte budget is per-OWNER: a same-sized dump belonging to a DIFFERENT owner does not count against this one', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ userId: 'user-1' }), [baseState({ userId: 'user-1' })]);
    stubDbProvisioner({ provisionedNames: [appName] });
    process.env.DROP_PREDELETE_MAX_MB = '1';
    const preDeleteDir = path.join(dropRoot, 'data', 'backup', 'pre-delete');
    // Belongs to a DIFFERENT owner's directory — must not be charged to
    // user-1's budget.
    const otherOwnerDir = path.join(preDeleteDir, ownerDumpDirName('user-2'));
    await fs.mkdir(otherOwnerDir, { recursive: true });
    await fs.writeFile(path.join(otherOwnerDir, 'drop_otherapp-stamp.dump'), Buffer.alloc(2 * 1024 * 1024));

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toMatchObject({ detached: true, deprovisioned: true });
  });

  it('the byte budget is measured against the SAME owner directory backupAndDeleteAppDatabase is told to write into (end-to-end, not two isolated assertions)', async () => {
    // A budget that reads one directory while the dump lands in another
    // bounds nothing. Two isolated assertions (a call-arg check here, a
    // separate write-then-refuse check elsewhere) can each pass while that
    // seam is broken — this test instead makes the stub WRITE to wherever
    // it's TOLD to via `ownerUserId`, exactly like the real
    // DatabaseProvisioner does (`ownerDumpDirName(opts.ownerUserId)`). If
    // the call site ever regresses to omitting `ownerUserId` (or passing
    // the wrong one), the dump lands in `_ownerless` instead, the budget
    // gate — which reads `ownerDumpDirName(state?.userId)` = user-1's own
    // directory — stays empty forever, and the SECOND call below wrongly
    // succeeds instead of being refused.
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ userId: 'user-1' }), [baseState({ userId: 'user-1' })]);
    const dbProvisioner = stubDbProvisioner({ provisionedNames: [appName] });
    process.env.DROP_PREDELETE_MAX_MB = '1';
    const preDeleteDir = path.join(dropRoot, 'data', 'backup', 'pre-delete');
    dbProvisioner!.backupAndDeleteAppDatabase.mockImplementation(
      async (name: string, opts: { ownerUserId?: string | null }) => {
        const ownerDir = path.join(preDeleteDir, ownerDumpDirName(opts.ownerUserId));
        const dumpPath = path.join(ownerDir, `drop_${name}-stamp.dump`);
        await fs.mkdir(ownerDir, { recursive: true });
        await fs.writeFile(dumpPath, Buffer.alloc(2 * 1024 * 1024));
        return { dropped: true, databaseDropped: true, roleDropped: true, dumpPath };
      }
    );

    const first = await platform.detachService(appName, 'postgres');
    expect(first).toMatchObject({ detached: true, deprovisioned: true });

    // The stubbed AppConfigService's `getConfig` returns a fixed snapshot
    // (never updated by the first call's `setServiceIntent`), so the
    // cooldown reads no `lastDetachAt` and stays open — the byte budget,
    // now exceeded by the dump the first call just wrote, is the only gate
    // left standing for this second call.
    const second = await platform.detachService(appName, 'postgres');

    expect(second).toMatchObject({ detached: false, reason: 'detach-limit', limit: 'dump-budget' });
  });

  it('the byte budget does not apply to redis (postgres-only limiter)', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ userId: 'user-1' }), [baseState({ userId: 'user-1' })]);
    stubDbProvisioner();
    stubRedisProvisioner({ provisionedNames: [appName] });
    process.env.DROP_PREDELETE_MAX_MB = '1';
    // Even a huge postgres dump pile must not block a REDIS detach.
    const ownerDir = path.join(dropRoot, 'data', 'backup', 'pre-delete', ownerDumpDirName('user-1'));
    await fs.mkdir(ownerDir, { recursive: true });
    await fs.writeFile(path.join(ownerDir, `drop_${appName}-stamp.dump`), Buffer.alloc(2 * 1024 * 1024));

    const result = await platform.detachService(appName, 'redis');

    expect(result).toMatchObject({ detached: true, deprovisioned: true });
  });

  it('the byte budget is skipped entirely for an ephemeral app — its dump is about to be skipped too', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig({ ephemeral: true }));
    stubStateManager(baseState({ userId: 'user-1', status: 'stopped' }), [baseState({ userId: 'user-1' })]);
    stubRuntime({ live: false });
    const dbProvisioner = stubDbProvisioner({ provisionedNames: [appName] });
    process.env.DROP_PREDELETE_MAX_MB = '1';
    // A pile of dumps that would exhaust the budget for a NON-ephemeral app.
    const ownerDir = path.join(dropRoot, 'data', 'backup', 'pre-delete', ownerDumpDirName('user-1'));
    await fs.mkdir(ownerDir, { recursive: true });
    await fs.writeFile(path.join(ownerDir, `drop_${appName}-stamp.dump`), Buffer.alloc(2 * 1024 * 1024));

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toMatchObject({ detached: true, deprovisioned: true });
    expect(setServiceIntent).toHaveBeenCalled();
    // Attributed to the owner whose (perpetually-empty, since this app is
    // ephemeral) directory the byte-budget gate would have measured.
    expect(dbProvisioner!.backupAndDeleteAppDatabase).toHaveBeenCalledWith(appName, {
      skipBackup: true,
      ownerUserId: 'user-1',
    });
  });

  // ── persist-first: the plan's core invariant ────────────────────────────

  it('persists "detached" + lastDetachAt BEFORE any destruction — even when the dump then fails', async () => {
    const callOrder: string[] = [];
    const setServiceIntent = stubAppConfigService(baseConfig());
    setServiceIntent.mockImplementation(async () => {
      callOrder.push('persist');
      return baseConfig({ services: { postgres: 'detached' } });
    });
    stubStateManager(baseState());
    stubRuntime();
    const dbProvisioner = stubDbProvisioner({
      provisionedNames: [appName],
      backupResult: { dropped: false, databaseDropped: false, roleDropped: false, reason: 'dump failed: boom', dumpPath: undefined },
    });
    dbProvisioner!.backupAndDeleteAppDatabase.mockImplementation(async () => {
      callOrder.push('deprovision');
      return { dropped: false, databaseDropped: false, roleDropped: false, reason: 'dump failed: boom' };
    });
    jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const result = await platform.detachService(appName, 'postgres');

    expect(callOrder).toEqual(['persist', 'deprovision']);
    expect(setServiceIntent).toHaveBeenCalledWith(appName, 'postgres', 'detached', {
      lastDetachAt: expect.any(Number),
    });
    expect(result).toMatchObject({ detached: false, reason: 'backup-failed' });
  });

  it('refuses no-app-config (at persist time) when setServiceIntent finds no config, even though the app IS provisioned', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig());
    setServiceIntent.mockResolvedValue(null);
    stubStateManager(baseState());
    stubDbProvisioner({ provisionedNames: [appName] });

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toEqual({ detached: false, reason: 'no-app-config', detail: expect.any(String) });
  });

  // ── stop recipe ──────────────────────────────────────────────────────────

  it('stops a live process even when state says "errored" — liveness comes from the RUNTIME, not state status — AND still restarts it', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ status: 'errored' }));
    const runtime = stubRuntime({ live: true });
    stubDbProvisioner({ provisionedNames: [appName] });
    const stopHealthProberSpy = jest.spyOn(platform as any, 'stopHealthProber');
    const stopCrashLoopWatchSpy = jest.spyOn(platform as any, 'stopCrashLoopWatch');
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const result = await platform.detachService(appName, 'postgres');

    expect(stopHealthProberSpy).toHaveBeenCalledWith(appName);
    expect(stopCrashLoopWatchSpy).toHaveBeenCalledWith(appName);
    expect(runtime.stop).toHaveBeenCalledWith(appName);
    // setAppStatus('stopped') must land BEFORE runtime.stop.
    const setAppStatusCall = ((platform as any).stateManager.setAppStatus as jest.Mock).mock
      .invocationCallOrder[0];
    const runtimeStopCall = (runtime.stop as jest.Mock).mock.invocationCallOrder[0];
    expect(setAppStatusCall).toBeLessThan(runtimeStopCall);
    // The app was LIVE (even though state said 'errored', not 'running') —
    // restart is decided by `wasLive || wasRunning`, so it must not be
    // left dead with a dishonest "was not running" result.
    expect(doRestartSpy).toHaveBeenCalledWith(appName);
    expect(result).toMatchObject({ restart: 'restarted' });
  });

  it('does not stop anything when the runtime reports no live process, even though state says "running"', async () => {
    stubAppConfigService(baseConfig());
    const { setAppStatus } = stubStateManager(baseState({ status: 'running' }));
    const runtime = stubRuntime({ live: false });
    stubDbProvisioner({ provisionedNames: [appName] });
    jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    await platform.detachService(appName, 'postgres');

    expect(runtime.stop).not.toHaveBeenCalled();
    expect(setAppStatus).not.toHaveBeenCalledWith(appName, 'stopped');
  });

  it('restart is `wasLive || wasRunning` — a "stopped"-in-state app with a live process still gets restarted, not left dead', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ status: 'stopped' }));
    stubRuntime({ live: true });
    stubDbProvisioner({ provisionedNames: [appName] });
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const result = await platform.detachService(appName, 'postgres');

    // wasRunning (state) is false, but wasLive (runtime) is true — the OR
    // decides restart, so the process this call just stopped must come back.
    expect(doRestartSpy).toHaveBeenCalledWith(appName);
    expect(result).toMatchObject({ restart: 'restarted' });
  });

  it('a genuinely stopped app (state stopped, runtime not live) gets no restart and is not started', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ status: 'stopped' }));
    const runtime = stubRuntime({ live: false });
    stubDbProvisioner({ provisionedNames: [appName] });
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart');

    const result = await platform.detachService(appName, 'postgres');

    expect(runtime.stop).not.toHaveBeenCalled();
    expect(doRestartSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ restart: 'not-restarted' });
  });

  // ── a THROWING runtime.stop must not escape detachService ──────────────

  it('a throwing runtime.stop (postgres) is caught, refuses deprovision-failed, never reaches the provisioner, and still attempts a restart', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig());
    stubStateManager(baseState({ status: 'running' }));
    const runtime = stubRuntime({ live: true });
    runtime.stop.mockRejectedValue(new Error('docker daemon hiccup'));
    const dbProvisioner = stubDbProvisioner({ provisionedNames: [appName] });
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const result = await platform.detachService(appName, 'postgres');

    // 'detached' intent was already persisted in step 8, BEFORE step 9 —
    // that does not change just because the stop itself then failed.
    expect(setServiceIntent).toHaveBeenCalled();
    expect(result).toMatchObject({ detached: false, reason: 'deprovision-failed', restart: 'restarted' });
    // The database must be left ALONE — deprovisioning never got a chance
    // to run once the stop itself failed.
    expect(dbProvisioner!.backupAndDeleteAppDatabase).not.toHaveBeenCalled();
    // A previously-live app must still get its restart attempt — the whole
    // point of widening the try/catch to cover the stop step too.
    expect(doRestartSpy).toHaveBeenCalledWith(appName);
    expect((platform as any).appsInProgress.has(appName)).toBe(false);
  });

  it('a throwing runtime.stop (redis) is caught, refuses deprovision-failed, and never reaches deprovisionAppRedis', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ status: 'running' }));
    const runtime = stubRuntime({ live: true });
    runtime.stop.mockRejectedValue(new Error('docker daemon hiccup'));
    stubDbProvisioner();
    const redisProvisioner = stubRedisProvisioner({ provisionedNames: [appName] });
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const result = await platform.detachService(appName, 'redis');

    expect(result).toMatchObject({ detached: false, reason: 'deprovision-failed', restart: 'restarted' });
    expect(redisProvisioner!.deprovisionAppRedis).not.toHaveBeenCalled();
    expect(doRestartSpy).toHaveBeenCalledWith(appName);
  });

  // ── deprovision + restart: postgres ─────────────────────────────────────

  it('postgres success: reports databaseDropped/roleDropped, a basename-only backup.file, and restarts a previously-running app', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ status: 'running' }));
    stubRuntime();
    // Build the fixture with path.join, never a hardcoded separator: a literal
    // Windows path passes on Windows and fails on Linux CI, because
    // path.basename only treats '\' as a separator on win32.
    const dumpFile = `drop_${appName}-stamp.dump`;
    const dumpPath = path.join(dropRoot, 'data', 'backup', 'pre-delete', dumpFile);
    stubDbProvisioner({
      provisionedNames: [appName],
      backupResult: { dropped: true, databaseDropped: true, roleDropped: true, dumpPath },
    });
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toEqual({
      detached: true,
      deprovisioned: true,
      databaseDropped: true,
      roleDropped: true,
      backup: { written: true, file: dumpFile },
      manifestConflict: false,
      restart: 'restarted',
    });
    expect(doRestartSpy).toHaveBeenCalledWith(appName);
  });

  it('postgres cleanup arm (databaseDropped:true, no dumpPath — nothing to dump) reports backup.written:false honestly', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ status: 'stopped' }));
    stubRuntime({ live: false });
    stubDbProvisioner({
      provisionedNames: [appName],
      backupResult: { dropped: true, databaseDropped: true, roleDropped: true, dumpPath: undefined },
    });

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toMatchObject({
      detached: true,
      deprovisioned: true,
      databaseDropped: true,
      backup: { written: false, file: undefined },
    });
  });

  it('postgres backup-failed restarts a previously-running app, and the failure detail never leaks the raw provider reason', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ status: 'running' }));
    stubRuntime();
    stubDbProvisioner({
      provisionedNames: [appName],
      backupResult: {
        dropped: false,
        databaseDropped: false,
        roleDropped: false,
        reason: 'dump failed: /secret/host/path leaked',
        dumpPath: undefined,
      },
    });
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toMatchObject({ detached: false, reason: 'backup-failed', restart: 'restarted' });
    expect((result as any).detail).not.toMatch(/secret\/host\/path/);
    expect(doRestartSpy).toHaveBeenCalledWith(appName);
  });

  it('skips the pg_dump backup for an ephemeral app (skipBackup: true)', async () => {
    stubAppConfigService(baseConfig({ ephemeral: true }));
    stubStateManager(baseState({ status: 'stopped' }));
    stubRuntime({ live: false });
    const dbProvisioner = stubDbProvisioner({ provisionedNames: [appName] });

    await platform.detachService(appName, 'postgres');

    // ownerUserId is required at the call site — see the byte-budget-gate/
    // dump-directory seam test below.
    expect(dbProvisioner!.backupAndDeleteAppDatabase).toHaveBeenCalledWith(appName, {
      skipBackup: true,
      ownerUserId: 'user-1',
    });
  });

  // ── a THROWN deprovision error must still restart ───────────────────────

  it('dbProvisioner.backupAndDeleteAppDatabase THROWING still restarts a previously-live app, returns the backup-failed shape, and never leaks the raw error', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ status: 'running' }));
    stubRuntime();
    const dbProvisioner = stubDbProvisioner({ provisionedNames: [appName] });
    dbProvisioner!.backupAndDeleteAppDatabase.mockRejectedValue(
      new Error('connect ECONNREFUSED /secret/host/path/pg.sock')
    );
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toMatchObject({ detached: false, reason: 'backup-failed', restart: 'restarted' });
    expect((result as any).detail).not.toMatch(/secret\/host\/path/);
    expect(doRestartSpy).toHaveBeenCalledWith(appName);
  });

  it('redisProvisioner.deprovisionAppRedis THROWING still restarts a previously-live app and returns the deprovision-failed shape', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ status: 'running' }));
    stubRuntime();
    stubDbProvisioner();
    const redisProvisioner = stubRedisProvisioner({ provisionedNames: [appName] });
    redisProvisioner!.deprovisionAppRedis.mockRejectedValue(new Error('redis unreachable'));
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const result = await platform.detachService(appName, 'redis');

    // 'flush-failed' is gone — a THROWN redis error (as opposed to a
    // REPORTED flush failure, which is now a success) is what
    // 'deprovision-failed' covers.
    expect(result).toMatchObject({ detached: false, reason: 'deprovision-failed', restart: 'restarted' });
    expect(doRestartSpy).toHaveBeenCalledWith(appName);
  });

  it('a thrown deprovision error never escapes detachService and always releases the busy guard', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ status: 'stopped' }));
    stubRuntime({ live: false });
    const dbProvisioner = stubDbProvisioner({ provisionedNames: [appName] });
    dbProvisioner!.backupAndDeleteAppDatabase.mockRejectedValue(new Error('disk full'));

    await expect(platform.detachService(appName, 'postgres')).resolves.toMatchObject({
      detached: false,
      reason: 'backup-failed',
    });
    expect((platform as any).appsInProgress.has(appName)).toBe(false);
  });

  // ── deprovision + restart: redis ────────────────────────────────────────

  it('redis success: reports flushed:true, no postgres-only fields, and restarts a previously-running app', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ status: 'running' }));
    stubRuntime();
    stubDbProvisioner();
    const redisProvisioner = stubRedisProvisioner({ provisionedNames: [appName] });
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const result = await platform.detachService(appName, 'redis');

    expect(result).toEqual({
      detached: true,
      deprovisioned: true,
      flushed: true,
      manifestConflict: false,
      restart: 'restarted',
    });
    expect(redisProvisioner!.deprovisionAppRedis).toHaveBeenCalledWith(appName);
    expect(doRestartSpy).toHaveBeenCalledWith(appName);
  });

  it('a REPORTED redis flush failure (hadAllocation:true) is a SUCCESS — the allocation was still freed and tombstoned, not a flush-failed refusal', async () => {
    const setServiceIntent = stubAppConfigService(baseConfig());
    stubStateManager(baseState({ status: 'running' }));
    stubRuntime();
    stubDbProvisioner();
    stubRedisProvisioner({
      provisionedNames: [appName],
      deprovisionResult: { removed: false, flushed: false, hadAllocation: true },
    });
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const result = await platform.detachService(appName, 'redis');

    // See RedisProvisioner.deprovisionAppRedis's own doc for why this is a
    // success (allocation freed, number tombstoned pending reflush) rather
    // than the old 'flush-failed' refusal, which contradicted itself: a
    // retry would hit guard 5 and say "nothing was provisioned to remove"
    // about a detach that had already completed. `flushed: false` is the
    // honest signal the result already carries.
    expect(result).toEqual({
      detached: true,
      deprovisioned: true,
      flushed: false,
      manifestConflict: false,
      restart: 'restarted',
    });
    expect(setServiceIntent).toHaveBeenCalledWith(appName, 'redis', 'detached', { lastDetachAt: expect.any(Number) });
    expect(doRestartSpy).toHaveBeenCalledWith(appName);
  });

  // ── "no allocation" vs "flush failed" ───────────────────────────────────

  it('redis "no allocation" (hadAllocation:false — a race, not a failure) is a SUCCESSFUL no-op detach, not a flush-failed refusal', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ status: 'running' }));
    stubRuntime();
    stubDbProvisioner();
    stubRedisProvisioner({
      provisionedNames: [appName],
      deprovisionResult: { removed: false, flushed: false, hadAllocation: false },
    });
    const doRestartSpy = jest.spyOn(platform as any, 'doRestart').mockResolvedValue(undefined);

    const result = await platform.detachService(appName, 'redis');

    expect(result).toMatchObject({ detached: true, deprovisioned: false });
    expect((result as any).reason).toBeUndefined();
    expect(doRestartSpy).toHaveBeenCalledWith(appName);
  });

  // ── restart outcome: needs-config / failed ──────────────────────────────

  it('maps a doRestart AppNeedsConfigError to restart:"needs-config" with missingSecrets, without throwing', async () => {
    const { AppNeedsConfigError } = require('../api/platform-ops');
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ status: 'running' }));
    stubRuntime();
    stubDbProvisioner({ provisionedNames: [appName] });
    jest
      .spyOn(platform as any, 'doRestart')
      .mockRejectedValue(new AppNeedsConfigError(appName, ['JWT_SECRET']));

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toMatchObject({
      detached: true,
      deprovisioned: true,
      restart: 'needs-config',
      missingSecrets: ['JWT_SECRET'],
    });
  });

  it('maps any other doRestart failure to restart:"failed" — the detach itself still succeeded and is not undone', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ status: 'running' }));
    stubRuntime();
    stubDbProvisioner({ provisionedNames: [appName] });
    jest.spyOn(platform as any, 'doRestart').mockRejectedValue(new Error('port allocation failed'));

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toMatchObject({ detached: true, deprovisioned: true, restart: 'failed' });
  });

  // ── manifest conflict: never a refusal ──────────────────────────────────

  it('manifestConflict is informational only — a drop.yaml `database:` declaration does not block detach', async () => {
    const appPath = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-detach-manifest-'));
    await fs.writeFile(path.join(appPath, 'drop.yaml'), 'database: true\n');
    stubAppConfigService(baseConfig({ path: appPath }));
    stubStateManager(baseState({ path: appPath, status: 'stopped' }));
    stubRuntime({ live: false });
    stubDbProvisioner({ provisionedNames: [appName] });

    const result = await platform.detachService(appName, 'postgres');

    expect(result).toMatchObject({ detached: true, deprovisioned: true, manifestConflict: true });
    await fs.rm(appPath, { recursive: true, force: true });
  });

  // ── busy guard: released after any outcome ──────────────────────────────

  it('releases the busy guard after a refusal — a second detach for the same app is not blocked', async () => {
    stubAppConfigService(undefined);
    stubStateManager(undefined);
    stubDbProvisioner();

    await platform.detachService(appName, 'postgres');
    expect((platform as any).appsInProgress.has(appName)).toBe(false);
  });

  it('releases the busy guard after a successful detach', async () => {
    stubAppConfigService(baseConfig());
    stubStateManager(baseState({ status: 'stopped' }));
    stubRuntime({ live: false });
    stubDbProvisioner({ provisionedNames: [appName] });

    await platform.detachService(appName, 'postgres');
    expect((platform as any).appsInProgress.has(appName)).toBe(false);
  });
});
