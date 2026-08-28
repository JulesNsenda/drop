/**
 * `AppConfig.access` containment (DROP-152).
 *
 * The field is an AUTHORIZATION decision persisted in a per-app config file,
 * so the only interesting question is which writers can reach it. The tier
 * that protects it (RESTRICTED_CONFIG_FIELDS) is strictly stronger than
 * SYSTEM_CONFIG_FIELDS on purpose: `upsertSystemConfig`/`updateSystemConfig`
 * are UNSTRIPPED and are already called from `upload-deploy.ts` and
 * `git-deploy.ts` on the agent/upload deploy path, so "system-owned" alone
 * would leave `access` reachable from request-derived data.
 *
 * These assert the RUNTIME strip, not the parameter types: an excess-property
 * check fires on a fresh object literal but not on a cast or a spread, which
 * is exactly how the previous boundary incidents in this repo got through.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'yaml';
import * as atomicWrite from '../../utils/atomic-write';
import {
  AppConfigService,
  configTierOverlap,
  NO_CHANGE,
  type AppConfig,
  type AppAccessPolicy,
} from './app-config';

const POLICY: AppAccessPolicy = { mode: 'drop-users', allow: ['user-1'] };

/**
 * Arrange helper: `setAccessPolicy` takes only an updater — a whole
 * `AppAccessPolicy` literal (or a bare `undefined`) can no longer be written
 * directly, precisely because that path bypassed provenance merging by
 * construction. Every test below that just wants to SEED a policy (rather
 * than exercise an updater) goes through this instead.
 */
const setPolicy = (
  svc: AppConfigService,
  name: string,
  access: AppAccessPolicy
): Promise<AppConfig | null> => svc.setAccessPolicy(name, () => access);

/**
 * The invariant `guests`/`guestGrantedBy` carry-forward exists to protect:
 * every `guestGrantedBy` key must name a guest actually present in `guests`
 * — a provenance entry for a guest no longer on the list is exactly the
 * stranding shape DROP-153 Gate 2 closed for `grantedBy`/`allow`, now
 * checked on the guest pair after every write this file exercises.
 */
const expectGuestGrantedByIsSubsetOfGuests = (access: AppAccessPolicy | undefined): void => {
  const guests = new Set(access?.guests ?? []);
  for (const guestId of Object.keys(access?.guestGrantedBy ?? {})) {
    expect(guests.has(guestId)).toBe(true);
  }
};

describe('config field tiers', () => {
  it('SYSTEM and RESTRICTED stay disjoint', () => {
    // A field in both is stripped twice and warns twice for one write. The
    // doc says they must not overlap; without this nothing checks it, and the
    // obvious "make access extra safe" edit is to add it to both lists.
    expect(configTierOverlap()).toEqual([]);
  });
});

describe('AppConfig.access containment', () => {
  let tempDir: string;
  let service: AppConfigService;

  const readFromDisk = async (name: string): Promise<AppConfig> =>
    yaml.parse(await fs.readFile(path.join(tempDir, 'appconf', `${name}.yaml`), 'utf-8'));

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-appconfig-access-'));
    jest.spyOn(console, 'warn').mockImplementation();
    await fs.mkdir(path.join(tempDir, 'appconf'), { recursive: true });
    // The app folder must exist: initialize() prunes configs whose app
    // directory is gone, which would otherwise delete the fixture mid-test.
    await fs.mkdir(path.join(tempDir, 'webapps', 'myapp'), { recursive: true });
    service = new AppConfigService({
      configDir: path.join(tempDir, 'appconf'),
      webappsDir: path.join(tempDir, 'webapps'),
    });
    await service.upsertConfig('myapp', { type: 'nodejs', port: 4000 });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('setAccessPolicy is the writer that actually persists it', async () => {
    const updated = await setPolicy(service, 'myapp', POLICY);
    expect(updated?.access).toEqual(POLICY);
    expect((await readFromDisk('myapp')).access).toEqual(POLICY);
  });

  it('setAccessPolicy REFUSES rather than minting a config for an unknown app', async () => {
    // upsertSystemConfig would create a skeleton config here, and boot
    // reconciliation treats configs as authoritative — an access write against
    // a typo would fabricate an app.
    expect(await setPolicy(service, 'no-such-app', POLICY)).toBeNull();
    await expect(
      fs.access(path.join(tempDir, 'appconf', 'no-such-app.yaml'))
    ).rejects.toBeDefined();
  });

  it('clears the field entirely (not to null) when set to undefined', async () => {
    await setPolicy(service, 'myapp', POLICY);
    await service.setAccessPolicy('myapp', () => undefined);
    const onDisk = await readFromDisk('myapp');
    expect('access' in onDisk).toBe(false);
    expect(service.getConfig('myapp')?.access).toBeUndefined();
  });

  it.each([
    ['upsertConfig', (s: AppConfigService, u: Partial<AppConfig>) => s.upsertConfig('myapp', u)],
    ['updateConfig', (s: AppConfigService, u: Partial<AppConfig>) => s.updateConfig('myapp', u)],
    // The two that matter most: unstripped for SYSTEM fields, already called
    // from the upload/git deploy paths with request-derived data.
    [
      'upsertSystemConfig',
      (s: AppConfigService, u: Partial<AppConfig>) => s.upsertSystemConfig('myapp', u),
    ],
    [
      'updateSystemConfig',
      (s: AppConfigService, u: Partial<AppConfig>) => s.updateSystemConfig('myapp', u),
    ],
  ])('%s cannot write access, however the caller got there', async (_label, write) => {
    // A CAST, not a fresh literal — the parameter type would catch a literal
    // and catches nothing here, which is the point.
    await write(service, { access: POLICY } as Partial<AppConfig>);

    expect(service.getConfig('myapp')?.access).toBeUndefined();
    expect('access' in (await readFromDisk('myapp'))).toBe(false);
  });

  it('preserves an existing policy through an ordinary redeploy-shaped write', async () => {
    // `access` must not share `mcp`'s lifecycle, where the field is recomputed
    // from tenant source and overwritten via updateConfig on EVERY build.
    await setPolicy(service, 'myapp', POLICY);

    await service.updateConfig('myapp', {
      port: 4001,
      lastDeployedAt: new Date(0).toISOString(),
      sourceHash: 'abc123',
    });
    await service.upsertSystemConfig('myapp', { agentCreated: true });

    expect(service.getConfig('myapp')?.access).toEqual(POLICY);
    expect((await readFromDisk('myapp')).access).toEqual(POLICY);
  });

  it('warns when a write is stripped, so a bypass attempt is not silent', async () => {
    const warn = jest.spyOn(console, 'warn');
    await service.upsertSystemConfig('myapp', { access: POLICY } as Partial<AppConfig>);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('access'));
  });

  describe('pruneAllowListEntries', () => {
    it('removes one user from every list they are on, and leaves the rest', async () => {
      await fs.mkdir(path.join(tempDir, 'webapps', 'other'), { recursive: true });
      await service.upsertConfig('other', { type: 'nodejs' });
      await setPolicy(service, 'myapp', { mode: 'drop-users', allow: ['u1', 'u2'] });
      await setPolicy(service, 'other', { mode: 'drop-users', allow: ['u2'] });

      const touched = await service.pruneAllowListEntries('u2');

      expect(touched.sort()).toEqual(['myapp', 'other']);
      expect(service.getConfig('myapp')?.access?.allow).toEqual(['u1']);
      expect(service.getConfig('other')?.access?.allow).toEqual([]);
    });

    it('leaves apps the user was never on untouched', async () => {
      await setPolicy(service, 'myapp', { mode: 'drop-users', allow: ['u1'] });
      expect(await service.pruneAllowListEntries('nobody')).toEqual([]);
      expect(service.getConfig('myapp')?.access?.allow).toEqual(['u1']);
    });

    it('is a no-op on an ungated app', async () => {
      expect(await service.pruneAllowListEntries('u1')).toEqual([]);
      expect(service.getConfig('myapp')?.access).toBeUndefined();
    });

    it('does NOT remove the policy itself — an empty list still gates', async () => {
      // Emptying an allow-list and REMOVING a gate mean different things: the
      // owner and admins can still open a gated app with an empty list.
      await setPolicy(service, 'myapp', { mode: 'drop-users', allow: ['u1'] });
      await service.pruneAllowListEntries('u1');
      expect(service.getConfig('myapp')?.access).toEqual({ mode: 'drop-users', allow: [] });
    });

    it('persists through the RESTRICTED writer, not around it', async () => {
      await setPolicy(service, 'myapp', { mode: 'drop-users', allow: ['u1'] });
      await service.pruneAllowListEntries('u1');
      expect((await readFromDisk('myapp')).access).toEqual({ mode: 'drop-users', allow: [] });
    });

    it('drops the pruned id from grantedBy too (DROP-153)', async () => {
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: ['u1', 'u2'],
        grantedBy: { u1: 'owner-a', u2: 'owner-b' },
      });
      await service.pruneAllowListEntries('u1');
      expect(service.getConfig('myapp')?.access).toEqual({
        mode: 'drop-users',
        allow: ['u2'],
        grantedBy: { u2: 'owner-b' },
      });
    });

    it('strips grantedBy entries the deleted user GRANTED, even on an app they cannot open (DROP-153 Gate 2)', async () => {
      // u-grantor shared 'myapp' with u1 but was never given access to
      // 'myapp' itself — the pre-fix candidate filter (`allow?.includes`)
      // would never even look at this app, stranding u1's entry: unrevokable
      // through DELETE /share/:userId (no live requester's id ever matches a
      // deleted grantor again), yet still counted as owner-authored by any
      // allOwnerAuthored-style check.
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: ['u1'],
        grantedBy: { u1: 'u-grantor' },
      });

      const touched = await service.pruneAllowListEntries('u-grantor');

      expect(touched).toEqual(['myapp']);
      // u1 keeps their access — only the stale provenance is dropped, which
      // makes the entry read as admin-authored (absent from grantedBy).
      expect(service.getConfig('myapp')?.access).toEqual({
        mode: 'drop-users',
        allow: ['u1'],
      });
    });

    it('strips guestGrantedBy entries the deleted user GRANTED, even though they hold no allow entry themselves (DROP-155)', async () => {
      // u-inviter invited a guest into 'myapp' but was never given `allow`
      // access to it themselves — the same stranding shape DROP-153 Gate 2
      // closed for grantedBy, now on the guest provenance map: without this,
      // the pre-filter never looks at this app and the entry survives
      // attributed to a deleted account forever.
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: [],
        guests: ['guest:g1'],
        guestGrantedBy: { 'guest:g1': 'u-inviter' },
      });

      const touched = await service.pruneAllowListEntries('u-inviter');

      expect(touched).toEqual(['myapp']);
      // The guest keeps their access — only the stale provenance is dropped,
      // which makes the entry read as admin-authored (absent from
      // guestGrantedBy).
      const access = service.getConfig('myapp')?.access;
      expect(access).toEqual({
        mode: 'drop-users',
        allow: [],
        guests: ['guest:g1'],
      });
      expectGuestGrantedByIsSubsetOfGuests(access);
    });

    it('handles a user who is both grantee and grantor on the same app', async () => {
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: ['both', 'u2'],
        grantedBy: { both: 'owner-a', u2: 'both' },
      });

      await service.pruneAllowListEntries('both');

      expect(service.getConfig('myapp')?.access).toEqual({
        mode: 'drop-users',
        allow: ['u2'],
      });
    });

    it('returns NO_CHANGE when the whole policy is cleared between the pre-filter snapshot and the updater running', async () => {
      // The pre-filter in pruneAllowListEntries is a cheap snapshot, not the
      // correctness check (its own doc). Simulate an admin's whole-policy
      // clear (DELETE /access) landing after that snapshot already matched
      // 'myapp' but before the updater actually runs — the updater must see
      // NO policy at all and take the `!access` branch, not resurrect one.
      await setPolicy(service, 'myapp', { mode: 'drop-users', allow: ['u1'] });
      const writeSpy = jest.spyOn(atomicWrite, 'writeFileAtomic');
      writeSpy.mockClear();

      const real = service.setAccessPolicy.bind(service);
      const spy = jest
        .spyOn(service, 'setAccessPolicy')
        .mockImplementation(async (name: unknown, arg: unknown) => {
          await real('myapp', () => undefined); // the racing whole-policy clear
          return real(name as string, arg as never); // the prune's own real write
        });

      const touched = await service.pruneAllowListEntries('u1');

      expect(touched).toEqual([]); // NO_CHANGE — nothing left for the prune to touch
      expect(service.getConfig('myapp')?.access).toBeUndefined(); // stays cleared, not resurrected
      // Exactly one write happened (the racing clear) — the prune's own
      // updater found nothing to do and skipped saveConfig entirely.
      expect(writeSpy).toHaveBeenCalledTimes(1);

      spy.mockRestore();
      writeSpy.mockRestore();
    });

    it('a prune that races an identical prune returns NO_CHANGE the second time and skips its write', async () => {
      await setPolicy(service, 'myapp', { mode: 'drop-users', allow: ['u1'] });
      const writeSpy = jest.spyOn(atomicWrite, 'writeFileAtomic');
      writeSpy.mockClear();

      // Both pass the cheap pre-filter (both snapshots see 'u1' present).
      // `enqueueWrite` serializes them: the first updater does the real
      // removal and saves; the second's updater then re-reads the ALREADY
      // pruned policy inside the write chain, finds nothing left to do, and
      // must return NO_CHANGE rather than rewrite the identical result.
      const [a, b] = await Promise.all([
        service.pruneAllowListEntries('u1'),
        service.pruneAllowListEntries('u1'),
      ]);

      expect([...a, ...b]).toEqual(['myapp']);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(service.getConfig('myapp')?.access).toEqual({ mode: 'drop-users', allow: [] });
      writeSpy.mockRestore();
    });
  });

  describe('pruneGuestEntries (DROP-155 §2)', () => {
    it('removes one guest from every list they are on, and leaves the rest', async () => {
      await fs.mkdir(path.join(tempDir, 'webapps', 'other'), { recursive: true });
      await service.upsertConfig('other', { type: 'nodejs' });
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: [],
        guests: ['guest:g1', 'guest:g2'],
      });
      await setPolicy(service, 'other', { mode: 'drop-users', allow: [], guests: ['guest:g2'] });

      const touched = await service.pruneGuestEntries('guest:g2');

      expect(touched.sort()).toEqual(['myapp', 'other']);
      expect(service.getConfig('myapp')?.access?.guests).toEqual(['guest:g1']);
      expect(service.getConfig('other')?.access?.guests).toEqual([]);
    });

    it('leaves apps the guest was never on untouched', async () => {
      await setPolicy(service, 'myapp', { mode: 'drop-users', allow: [], guests: ['guest:g1'] });
      expect(await service.pruneGuestEntries('guest:nobody')).toEqual([]);
      expect(service.getConfig('myapp')?.access?.guests).toEqual(['guest:g1']);
    });

    it('is a no-op on an ungated app', async () => {
      expect(await service.pruneGuestEntries('guest:g1')).toEqual([]);
      expect(service.getConfig('myapp')?.access).toBeUndefined();
    });

    it('does NOT remove the policy itself — an empty guest list still gates', async () => {
      await setPolicy(service, 'myapp', { mode: 'drop-users', allow: [], guests: ['guest:g1'] });
      await service.pruneGuestEntries('guest:g1');
      expect(service.getConfig('myapp')?.access).toEqual({
        mode: 'drop-users',
        allow: [],
        guests: [],
      });
    });

    it('persists through the RESTRICTED writer, not around it', async () => {
      await setPolicy(service, 'myapp', { mode: 'drop-users', allow: [], guests: ['guest:g1'] });
      await service.pruneGuestEntries('guest:g1');
      expect((await readFromDisk('myapp')).access).toEqual({
        mode: 'drop-users',
        allow: [],
        guests: [],
      });
    });

    it('drops the pruned guest id from guestGrantedBy too', async () => {
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: [],
        guests: ['guest:g1', 'guest:g2'],
        guestGrantedBy: { 'guest:g1': 'owner-a', 'guest:g2': 'owner-b' },
      });
      await service.pruneGuestEntries('guest:g1');
      expect(service.getConfig('myapp')?.access).toEqual({
        mode: 'drop-users',
        allow: [],
        guests: ['guest:g2'],
        guestGrantedBy: { 'guest:g2': 'owner-b' },
      });
    });

    it('does not touch allow/grantedBy — a guest id never appears there', async () => {
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: ['u1'],
        grantedBy: { u1: 'owner-a' },
        guests: ['guest:g1'],
      });
      await service.pruneGuestEntries('guest:g1');
      expect(service.getConfig('myapp')?.access).toEqual({
        mode: 'drop-users',
        allow: ['u1'],
        grantedBy: { u1: 'owner-a' },
        guests: [],
      });
    });

    it('a grant racing a prune under the write chain settles deterministically, never both applied and reverted', async () => {
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: [],
        guests: ['guest:g1'],
      });

      const grantGuest = (guestId: string): Promise<AppConfig | null> =>
        service.setAccessPolicy('myapp', existing => {
          const current = existing.access ?? { mode: 'drop-users' as const, allow: [] };
          const guests = current.guests ?? [];
          if (guests.includes(guestId)) return current; // idempotent re-grant
          return { ...current, guests: [...guests, guestId] };
        });

      await Promise.all([grantGuest('guest:g2'), service.pruneGuestEntries('guest:g1')]);

      // `enqueueWrite` serializes both onto the same per-app chain
      // (`setAccessPolicy` is called synchronously by each before either op
      // actually runs), so the grant's write always lands first and the
      // prune's updater re-reads THAT result rather than a stale snapshot
      // taken before it: g1 is gone (the prune removed it) and g2 survives
      // (the grant added it and the prune never touches an unrelated id) —
      // neither op silently reverts the other's write.
      expect(service.getConfig('myapp')?.access?.guests?.sort()).toEqual(['guest:g2']);
    });
  });

  /**
   * DROP-153 Gate 2: `carryForwardGrantedBy` is no longer exported, and
   * `setAccessPolicy` no longer accepts a whole `AppAccessPolicy` literal —
   * only the updater form can write a real policy, and provenance now merges
   * INSIDE that path, structurally, rather than being an opt-in call a route
   * remembers (or forgets) to make. These exercise that merge through the
   * only surface left: `setAccessPolicy` itself.
   */
  describe('setAccessPolicy: automatic provenance carry-forward (DROP-153 Gate 2)', () => {
    it('a whole-policy updater that omits grantedBy cannot erase provenance', async () => {
      // This is the invariant the fix makes structural: a caller that has
      // never heard of carryForwardGrantedBy — a group route, a migration,
      // the CLI — returns a fresh `{ mode, allow }` with no grantedBy at
      // all, exactly like the admin PUT /access route used to build before
      // this fix (it was one explicit helper call away from doing this by
      // accident).
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: ['u1', 'u2'],
        grantedBy: { u1: 'owner-a' }, // u1 owner-authored, u2 admin-authored
      });

      await service.setAccessPolicy('myapp', (): AppAccessPolicy => ({
        mode: 'drop-users',
        allow: ['u1', 'u2', 'u3'],
      }));

      expect(service.getConfig('myapp')?.access).toEqual({
        mode: 'drop-users',
        allow: ['u1', 'u2', 'u3'],
        grantedBy: { u1: 'owner-a' }, // survived without the caller doing anything
      });
    });

    it('drops provenance for ids the write removes from allow', async () => {
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: ['u1', 'u2'],
        grantedBy: { u1: 'owner-a', u2: 'owner-b' },
      });

      await service.setAccessPolicy('myapp', (): AppAccessPolicy => ({
        mode: 'drop-users',
        allow: ['u2'],
      }));

      expect(service.getConfig('myapp')?.access).toEqual({
        mode: 'drop-users',
        allow: ['u2'],
        grantedBy: { u2: 'owner-b' },
      });
    });

    it('an updater that explicitly manages grantedBy (even to nothing) is never overridden', async () => {
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: ['u1'],
        grantedBy: { u1: 'owner-a' },
      });

      // Explicit `grantedBy: undefined` — "this write means no provenance",
      // not "I forgot to set it". Auto carry-forward must not resurrect it.
      await service.setAccessPolicy('myapp', (): AppAccessPolicy => ({
        mode: 'drop-users',
        allow: ['u1'],
        grantedBy: undefined,
      }));

      expect(service.getConfig('myapp')?.access).toEqual({ mode: 'drop-users', allow: ['u1'] });
    });

    it('has nothing to carry forward when there was no existing policy', async () => {
      const updated = await service.setAccessPolicy('myapp', (): AppAccessPolicy => ({
        mode: 'drop-users',
        allow: ['u1'],
      }));
      expect(updated?.access).toEqual({ mode: 'drop-users', allow: ['u1'] });
    });

    it('carries forward to ABSENT (not an empty object) when the write drops every owner-authored id', async () => {
      // u1 owner-authored, u2 admin-authored (absent from grantedBy). The
      // write's new `allow` drops u1 entirely, leaving only the
      // already-admin-authored u2 — so there is nothing left to carry
      // forward. `carryForwardGrantedBy`'s own doc requires this to come out
      // as `undefined`, not `{}`, matching the "field absent, not empty"
      // shape `grantedBy` has everywhere else.
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: ['u1', 'u2'],
        grantedBy: { u1: 'owner-a' },
      });

      await service.setAccessPolicy('myapp', (): AppAccessPolicy => ({
        mode: 'drop-users',
        allow: ['u2'],
      }));

      const access = service.getConfig('myapp')?.access;
      expect(access).toEqual({ mode: 'drop-users', allow: ['u2'] });
      expect(access && 'grantedBy' in access).toBe(false);
    });
  });

  /**
   * DROP-155 plan §A (critical): `guests` and `guestGrantedBy` must be
   * STRUCTURAL in `mergeAccessProvenance` exactly as `allow`/`grantedBy`
   * are — a whole-policy literal that has never heard of guests must not
   * delete them. `PUT /apps/:name/access` and `POST /apps/:name/share` both
   * return whole-policy literals of this exact shape; these simulate each
   * writer's own return shape rather than exercising the routes (which live
   * outside this file).
   */
  describe('setAccessPolicy: guest carry-forward (DROP-155 §A)', () => {
    it('an admin PUT /access-shaped literal that omits guests does not lose them', async () => {
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: ['u1'],
        guests: ['guest:g1', 'guest:g2'],
        guestGrantedBy: { 'guest:g1': 'owner-a' },
      });

      // The admin PUT /access route's own return shape: { mode, allow,
      // grantedBy } — no `guests` key at all.
      await service.setAccessPolicy('myapp', (): AppAccessPolicy => ({
        mode: 'drop-users',
        allow: ['u1', 'u2'],
        grantedBy: { u2: 'admin-a' },
      }));

      const access = service.getConfig('myapp')?.access;
      expect(access).toEqual({
        mode: 'drop-users',
        allow: ['u1', 'u2'],
        grantedBy: { u2: 'admin-a' },
        guests: ['guest:g1', 'guest:g2'],
        guestGrantedBy: { 'guest:g1': 'owner-a' },
      });
      expectGuestGrantedByIsSubsetOfGuests(access);
    });

    it('an owner POST /share-shaped literal that omits guests does not lose them', async () => {
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: ['u1'],
        guests: ['guest:g1'],
        guestGrantedBy: { 'guest:g1': 'admin-a' },
      });

      // The owner share route's own return shape: another whole-policy
      // literal that has never heard of guests either.
      await service.setAccessPolicy('myapp', (): AppAccessPolicy => ({
        mode: 'drop-users',
        allow: ['u1', 'u3'],
        grantedBy: { u3: 'u1' },
      }));

      expect(service.getConfig('myapp')?.access?.guests).toEqual(['guest:g1']);
      expect(service.getConfig('myapp')?.access?.guestGrantedBy).toEqual({
        'guest:g1': 'admin-a',
      });
    });

    it('drops guest provenance for guest ids the write removes from guests', async () => {
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: [],
        guests: ['guest:g1', 'guest:g2'],
        guestGrantedBy: { 'guest:g1': 'owner-a', 'guest:g2': 'owner-b' },
      });

      await service.setAccessPolicy('myapp', (): AppAccessPolicy => ({
        mode: 'drop-users',
        allow: [],
        guests: ['guest:g2'],
      }));

      expect(service.getConfig('myapp')?.access).toEqual({
        mode: 'drop-users',
        allow: [],
        guests: ['guest:g2'],
        guestGrantedBy: { 'guest:g2': 'owner-b' },
      });
    });

    it('an updater that explicitly manages guests/guestGrantedBy (even to nothing) is never overridden', async () => {
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: [],
        guests: ['guest:g1'],
        guestGrantedBy: { 'guest:g1': 'owner-a' },
      });

      // Explicit `guests: undefined` — "this write clears guests", not "I
      // forgot to mention them". Auto carry-forward must not resurrect it.
      await service.setAccessPolicy('myapp', (): AppAccessPolicy => ({
        mode: 'drop-users',
        allow: [],
        guests: undefined,
        guestGrantedBy: undefined,
      }));

      expect(service.getConfig('myapp')?.access).toEqual({ mode: 'drop-users', allow: [] });
      // `yaml.stringify` omits undefined values, so on disk (unlike the
      // in-memory object, which legitimately carries the key with an
      // `undefined` value) the fields are truly absent, not resurrected.
      const onDisk = await readFromDisk('myapp');
      expect('guests' in onDisk.access!).toBe(false);
      expect('guestGrantedBy' in onDisk.access!).toBe(false);
    });

    it('has nothing to carry forward when there was no existing policy', async () => {
      const updated = await service.setAccessPolicy('myapp', (): AppAccessPolicy => ({
        mode: 'drop-users',
        allow: [],
        guests: ['guest:g1'],
      }));
      expect(updated?.access).toEqual({ mode: 'drop-users', allow: [], guests: ['guest:g1'] });
    });

    it('carries guestGrantedBy forward to ABSENT (not an empty object) when the write drops every owner-authored guest id', async () => {
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: [],
        guests: ['guest:g1', 'guest:g2'],
        guestGrantedBy: { 'guest:g1': 'owner-a' }, // g1 owner-authored, g2 admin-authored
      });

      await service.setAccessPolicy('myapp', (): AppAccessPolicy => ({
        mode: 'drop-users',
        allow: [],
        guests: ['guest:g2'],
      }));

      const access = service.getConfig('myapp')?.access;
      expect(access).toEqual({ mode: 'drop-users', allow: [], guests: ['guest:g2'] });
      expect(access && 'guestGrantedBy' in access).toBe(false);
    });

    it('survives an ordinary redeploy-shaped write untouched, same as allow/grantedBy', async () => {
      // `access` (guests included) must not share `mcp`'s lifecycle, where
      // the field is recomputed from tenant source on every build.
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: [],
        guests: ['guest:g1'],
        guestGrantedBy: { 'guest:g1': 'owner-a' },
      });

      await service.updateConfig('myapp', {
        port: 4001,
        lastDeployedAt: new Date(0).toISOString(),
        sourceHash: 'abc123',
      });
      await service.upsertSystemConfig('myapp', { agentCreated: true });

      expect(service.getConfig('myapp')?.access?.guests).toEqual(['guest:g1']);
      expect(service.getConfig('myapp')?.access?.guestGrantedBy).toEqual({
        'guest:g1': 'owner-a',
      });
    });
  });

  describe('setAccessPolicy: NO_CHANGE sentinel (DROP-153 Gate 2)', () => {
    it('skips saveConfig entirely and resolves with the untouched config', async () => {
      await setPolicy(service, 'myapp', { mode: 'drop-users', allow: ['u1'] });
      const writeSpy = jest.spyOn(atomicWrite, 'writeFileAtomic');
      writeSpy.mockClear();

      const result = await service.setAccessPolicy('myapp', (): typeof NO_CHANGE => NO_CHANGE);

      expect(writeSpy).not.toHaveBeenCalled();
      expect(result?.access).toEqual({ mode: 'drop-users', allow: ['u1'] });
      // The in-memory entry is the SAME snapshot, not a freshly saved one —
      // a refused write must not even bump the map entry.
      expect(service.getConfig('myapp')).toBe(result);
      writeSpy.mockRestore();
    });

    it('is distinct from returning undefined, which is a real, saved clear', async () => {
      await setPolicy(service, 'myapp', { mode: 'drop-users', allow: ['u1'] });
      const writeSpy = jest.spyOn(atomicWrite, 'writeFileAtomic');
      writeSpy.mockClear();

      await service.setAccessPolicy('myapp', () => undefined);

      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(service.getConfig('myapp')?.access).toBeUndefined();
      writeSpy.mockRestore();
    });
  });

  /**
   * The updater overload's whole reason to exist (DROP-153, plan §4): a
   * per-entry mutation must read the CURRENT policy INSIDE the write chain,
   * not a snapshot taken outside it. `grant` below is a stand-in for what the
   * real share route does — it is deliberately written against the public
   * `setAccessPolicy` updater form only, with its own LOCAL cap constant
   * (never imported from `src/api/routes/apps.ts`, which would create the
   * apps.ts <-> app-config.ts cycle the plan calls out) — so these tests
   * exercise exactly the primitive a caller gets, not a helper this file
   * doesn't actually ship.
   */
  describe('setAccessPolicy updater form: concurrency (DROP-153)', () => {
    const CAP_FOR_TEST = 3;

    async function grant(
      svc: AppConfigService,
      appName: string,
      userId: string,
      grantedByUserId: string,
      cap: number
    ): Promise<{ ok: boolean }> {
      let ok = true;
      await svc.setAccessPolicy(appName, existing => {
        const current = existing.access ?? { mode: 'drop-users' as const, allow: [] };
        if (current.allow.includes(userId)) return current; // idempotent re-grant
        if (current.allow.length >= cap) {
          ok = false;
          return current;
        }
        return {
          ...current,
          allow: [...current.allow, userId],
          grantedBy: { ...(current.grantedBy ?? {}), [userId]: grantedByUserId },
        };
      });
      return { ok };
    }

    it('two concurrent grants through the updater form both survive', async () => {
      await Promise.all([
        grant(service, 'myapp', 'u1', 'owner-1', 200),
        grant(service, 'myapp', 'u2', 'owner-1', 200),
      ]);
      expect(service.getConfig('myapp')?.access?.allow.slice().sort()).toEqual(['u1', 'u2']);
      expect(service.getConfig('myapp')?.access?.grantedBy).toEqual({
        u1: 'owner-1',
        u2: 'owner-1',
      });
    });

    it('a grant interleaved with pruneAllowListEntries for a different user: the grant survives', async () => {
      await setPolicy(service, 'myapp', { mode: 'drop-users', allow: ['u3'] });
      await Promise.all([
        grant(service, 'myapp', 'u1', 'owner-1', 200),
        service.pruneAllowListEntries('u3'),
      ]);
      expect(service.getConfig('myapp')?.access?.allow).toEqual(['u1']);
    });

    it('a grant racing a whole-policy clear is deterministic and never resurrects stale entries', async () => {
      await setPolicy(service, 'myapp', { mode: 'drop-users', allow: ['u1'] });
      await Promise.all([
        grant(service, 'myapp', 'u2', 'owner-1', 200),
        service.setAccessPolicy('myapp', () => undefined),
      ]);
      const finalAccess = service.getConfig('myapp')?.access;
      // Whichever write settles last wins outright — the result is always ONE
      // of the two well-formed outcomes below, never a merge of both (e.g.
      // u1 resurrected alongside u2, which is exactly the bug this closes).
      if (finalAccess === undefined) {
        expect(finalAccess).toBeUndefined();
      } else {
        expect(finalAccess.allow).toEqual(['u2']);
      }
    });

    it('bounds entries inside the updater under concurrency — a route-level check alone is advisory', async () => {
      await setPolicy(service, 'myapp', {
        mode: 'drop-users',
        allow: Array.from({ length: CAP_FOR_TEST - 1 }, (_, i) => `existing-${i}`),
      });

      const results = await Promise.all([
        grant(service, 'myapp', 'u-over-1', 'owner-1', CAP_FOR_TEST),
        grant(service, 'myapp', 'u-over-2', 'owner-1', CAP_FOR_TEST),
      ]);

      // Exactly one of the two racing grants fits under the cap; the other
      // must see the FULL list (including its rival's just-written entry)
      // and refuse, not a stale snapshot that would let both through.
      expect(service.getConfig('myapp')?.access?.allow.length).toBe(CAP_FOR_TEST);
      expect(results.filter(r => r.ok).length).toBe(1);
    });
  });

  it('survives a reload from disk', async () => {
    await setPolicy(service, 'myapp', POLICY);
    const reloaded = new AppConfigService({
      configDir: path.join(tempDir, 'appconf'),
      webappsDir: path.join(tempDir, 'webapps'),
    });
    await reloaded.initialize();
    expect(reloaded.getConfig('myapp')?.access).toEqual(POLICY);
  });
});
