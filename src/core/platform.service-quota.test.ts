/**
 * checkDbQuota / checkRedisQuota — the two per-user backing-service quota
 * checks, extracted from what used to be inline branches in handleStartApp
 * and provisionRedisEnvVars (DROP-151) so a future attach route can refuse
 * explicitly instead of the deploy path's own silent warn-and-skip.
 *
 * The two guards are DELIBERATELY not unified — Postgres bypasses the count
 * on a truthy test of `ownerUserId`, Redis bypasses it on `ownerUserId !==
 * undefined`. For the realistic ownerless case (`userId === undefined`,
 * e.g. a DROP_API_KEY/cli-local deploy) BOTH tests are false — `undefined`
 * is neither truthy nor `!== undefined` — so BOTH currently skip the count
 * identically and are unlimited for genuinely ownerless apps. That is
 * "each service's current semantics" and is pinned below as-is; it is not
 * this file's job to relitigate whether that shared behaviour is desirable
 * (extension-catalog plan, open question 1).
 *
 * The two tests do diverge, but only for a value that is falsy WITHOUT being
 * `undefined` — the one other value `userId`'s type (`string | undefined`)
 * admits is the empty string. `!''` is true (Postgres skips); `'' !==
 * undefined` is true (Redis does NOT skip and enforces the count). That
 * divergence is what "truthy vs `!== undefined`, preserved exactly" actually
 * describes at the boolean-logic level, and is pinned explicitly below so an
 * accidental normalisation of the two conditions is caught even though the
 * empty-string case is not known to be reachable through any real deploy
 * path today.
 */

import * as path from 'path';
import * as os from 'os';
import { DropPlatform, createPlatform } from './platform';
import type { AppState } from '../managers/app/state-manager';

describe('checkDbQuota / checkRedisQuota', () => {
  let platform: DropPlatform;
  let tempDir: string;

  const fakeApp = (name: string, userId: string | undefined): AppState => ({
    name,
    type: 'nodejs',
    status: 'running',
    path: `/apps/${name}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    userId,
  });

  /**
   * Stub stateManager.getAllApps() plus a provisioner whose isProvisioned()
   * reports true for the given app names — the shape both checkDbQuota and
   * checkRedisQuota read.
   */
  const withApps = (apps: AppState[], provisionedNames: string[]) => {
    (platform as any).stateManager = {
      getAllApps: jest.fn().mockReturnValue(apps),
    };
    const isProvisioned = jest.fn((name: string) => provisionedNames.includes(name));
    (platform as any).dbProvisioner = { isProvisioned };
    (platform as any).redisProvisioner = { isProvisioned };
  };

  beforeEach(() => {
    tempDir = path.join(os.tmpdir(), `drop-quota-${Date.now()}-${Math.random()}`);
    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'apps'),
      logLevel: 'error',
      maxDbsPerUser: 2,
      maxRedisPerUser: 2,
    });
  });

  describe('checkDbQuota — TRUTHY test on ownerUserId (deliberately not !== undefined)', () => {
    it('allows an ownerless app (userId undefined) regardless of how many ownerless DBs already exist', () => {
      withApps(
        [fakeApp('a', undefined), fakeApp('b', undefined), fakeApp('c', undefined)],
        ['a', 'b', 'c']
      );
      expect((platform as any).checkDbQuota(undefined)).toEqual({ allowed: true });
    });

    it("allows an app under its owner's limit", () => {
      withApps([fakeApp('a', 'user-1')], ['a']);
      expect((platform as any).checkDbQuota('user-1')).toEqual({ allowed: true });
    });

    it('refuses, with used/limit, once the owner is at the configured limit', () => {
      withApps([fakeApp('a', 'user-1'), fakeApp('b', 'user-1')], ['a', 'b']);
      expect((platform as any).checkDbQuota('user-1')).toEqual({
        allowed: false,
        used: 2,
        limit: 2,
      });
    });

    it("counts only the owner's own provisioned databases, not other users'", () => {
      withApps(
        [fakeApp('a', 'user-1'), fakeApp('b', 'user-2'), fakeApp('c', 'user-2')],
        ['a', 'b', 'c']
      );
      expect((platform as any).checkDbQuota('user-1')).toEqual({ allowed: true });
    });

    it('allows unconditionally when maxDbsPerUser is 0 (disabled)', () => {
      (platform as any).config.maxDbsPerUser = 0;
      withApps([fakeApp('a', 'user-1'), fakeApp('b', 'user-1')], ['a', 'b']);
      expect((platform as any).checkDbQuota('user-1')).toEqual({ allowed: true });
    });

    // The empty string is the one falsy, non-undefined value userId's type
    // admits — see the file header. Truthy(''): false, so this bypasses the
    // count exactly like undefined does.
    it("also bypasses the count for a falsy-but-defined userId ('')", () => {
      withApps([fakeApp('a', ''), fakeApp('b', '')], ['a', 'b']);
      expect((platform as any).checkDbQuota('')).toEqual({ allowed: true });
    });
  });

  describe('checkRedisQuota — !== undefined test on ownerUserId (deliberately not truthy)', () => {
    it('allows an ownerless app (userId undefined) regardless of how many ownerless allocations already exist — same as Postgres for this value', () => {
      withApps(
        [fakeApp('a', undefined), fakeApp('b', undefined), fakeApp('c', undefined)],
        ['a', 'b', 'c']
      );
      expect((platform as any).checkRedisQuota(undefined)).toEqual({ allowed: true });
    });

    it("allows an owned app under its owner's limit", () => {
      withApps([fakeApp('a', 'user-1')], ['a']);
      expect((platform as any).checkRedisQuota('user-1')).toEqual({ allowed: true });
    });

    it('refuses, with used/limit, once the owner is at the configured limit', () => {
      withApps([fakeApp('a', 'user-1'), fakeApp('b', 'user-1')], ['a', 'b']);
      expect((platform as any).checkRedisQuota('user-1')).toEqual({
        allowed: false,
        used: 2,
        limit: 2,
      });
    });

    it('allows unconditionally when maxRedisPerUser is 0 (disabled)', () => {
      (platform as any).config.maxRedisPerUser = 0;
      withApps([fakeApp('a', 'user-1'), fakeApp('b', 'user-1')], ['a', 'b']);
      expect((platform as any).checkRedisQuota('user-1')).toEqual({ allowed: true });
    });

    // Unlike Postgres: `'' !== undefined` is true, so Redis does NOT bypass
    // here — it enforces the count for a falsy-but-defined userId. This is
    // the one value where the two guards actually disagree; see the file
    // header for why undefined itself is not that value.
    it("DOES enforce the count for a falsy-but-defined userId ('') — the actual divergence from Postgres", () => {
      withApps([fakeApp('a', ''), fakeApp('b', '')], ['a', 'b']);
      expect((platform as any).checkRedisQuota('')).toEqual({
        allowed: false,
        used: 2,
        limit: 2,
      });
    });
  });

  it("the two checks agree for the realistic ownerless case (userId undefined) but disagree for '' — pinning exactly where the divergence is and is not", () => {
    withApps([fakeApp('a', undefined), fakeApp('b', undefined)], ['a', 'b']);
    expect((platform as any).checkDbQuota(undefined)).toEqual({ allowed: true });
    expect((platform as any).checkRedisQuota(undefined)).toEqual({ allowed: true });

    withApps([fakeApp('a', ''), fakeApp('b', '')], ['a', 'b']);
    expect((platform as any).checkDbQuota('')).toEqual({ allowed: true });
    expect((platform as any).checkRedisQuota('')).toEqual({
      allowed: false,
      used: 2,
      limit: 2,
    });
  });
});
