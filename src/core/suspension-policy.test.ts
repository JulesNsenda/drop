/**
 * The suspension resolver: one answer to "is this app refused, and why?".
 *
 * The rules are exercised against hand-built state and config views and a REAL
 * store (so the case-insensitive keys and the fail-closed states are the
 * store's own, not a double's). The pin tests at the bottom are what make
 * "one answer" true: no other source file may ask the store by name.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SuspensionStore } from '../managers/suspension';
import { AppSuspendedError } from '../api/platform-ops';
import { resetStateManager } from '../managers/app/state-manager';
import { resetAppConfigService } from '../managers/app/app-config';
import { getSuspensionStore, resetSuspensionStore } from '../managers/suspension';
import {
  childrenOf,
  suspendedOrphans,
  suspensionStoreUnavailable,
  enforcementTargets,
  isStillEnforced,
  recordedNames,
  routeWithdrawalFor,
  settleSetFor,
  claimedAgainst,
  hostClaims,
  refusalCauseOf,
  refusalEpisodeCode,
  refusalForApp,
  StartRefused,
  refusalForExpansion,
  type StartRefusalCause,
  type SuspensionPolicyDeps,
} from './suspension-policy';

interface FakeApp {
  name: string;
  group?: string;
  isGroupContainer?: boolean;
  userId?: string;
  /** The trust expandMonorepo persisted on the container's state entry. */
  groupTrusted?: boolean;
  /** Config-side fields. */
  cfgGroup?: string;
  groupContainer?: string;
  /** In config only (a deleted app's leftovers, or state not yet written). */
  configOnly?: boolean;
}

describe('suspension policy: refusalForApp', () => {
  let dir: string;
  let store: SuspensionStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-suspension-policy-'));
    store = new SuspensionStore(path.join(dir, 'suspensions.json'));
    await store.load();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function depsOf(apps: FakeApp[]): SuspensionPolicyDeps {
    const inState = apps.filter((a) => !a.configOnly);
    return {
      store,
      state: {
        getApp: (name: string) => inState.find((a) => a.name === name),
        getAllApps: () => inState,
      } as unknown as SuspensionPolicyDeps['state'],
      configs: {
        getConfig: (name: string) => {
          const a = apps.find((x) => x.name === name);
          return a ? { name: a.name, group: a.cfgGroup ?? a.group, groupContainer: a.groupContainer } : undefined;
        },
        getDomainOwners: () => new Map<string, string>(),
        getAllConfigs: () =>
          apps.map((a) => ({ name: a.name, group: a.cfgGroup ?? a.group, groupContainer: a.groupContainer })),
      } as unknown as SuspensionPolicyDeps['configs'],
    };
  }

  const container = (name: string, extra: Partial<FakeApp> = {}): FakeApp => ({
    name,
    group: name,
    isGroupContainer: true,
    ...extra,
  });

  describe("an app's own record", () => {
    it('is the answer, with no via', async () => {
      await store.suspend('site', 'admin');
      expect(refusalForApp('site', depsOf([{ name: 'site' }]))).toEqual({ reason: 'record' });
    });

    it('does not touch any other ungrouped app', async () => {
      await store.suspend('site', 'admin');
      const apps = [{ name: 'site' }, { name: 'blog' }, { name: 'shop' }];
      expect(refusalForApp('blog', depsOf(apps))).toBeNull();
      expect(refusalForApp('shop', depsOf(apps))).toBeNull();
    });

    it('matches the name ignoring case, as the store does', async () => {
      await store.suspend('Site', 'admin');
      expect(refusalForApp('site', depsOf([{ name: 'site' }]))).toEqual({ reason: 'record' });
    });
  });

  describe('a store that cannot answer', () => {
    it('refuses every app as store-unreadable, with no via', async () => {
      fs.writeFileSync(path.join(dir, 'suspensions.json'), '{ broken');
      jest.spyOn(console, 'error').mockImplementation();
      await store.load();
      expect(refusalForApp('anything', depsOf([]))).toEqual({ reason: 'store-unreadable' });
    });

    it('refuses every app as not-loaded before load()', () => {
      const unloaded = new SuspensionStore(path.join(dir, 'other.json'));
      expect(refusalForApp('anything', { ...depsOf([]), store: unloaded })).toEqual({ reason: 'not-loaded' });
    });
  });

  describe("a child of a suspended container (the container's record)", () => {
    it('is refused via the container when it carries the stamp and the container is current', async () => {
      await store.suspend('site', 'admin');
      const apps = [container('site'), { name: 'site-web', group: 'site', groupContainer: 'site' }];
      expect(refusalForApp('site-web', depsOf(apps))).toEqual({ reason: 'record', via: 'site' });
    });

    it('is refused via the container by group alone (no stamp)', async () => {
      await store.suspend('site', 'admin');
      const apps = [container('site'), { name: 'site-web', group: 'site' }];
      expect(refusalForApp('site-web', depsOf(apps))).toEqual({ reason: 'record', via: 'site' });
    });

    it('is refused when only the CONFIG carries the group', async () => {
      await store.suspend('site', 'admin');
      const apps = [container('site'), { name: 'site-web', cfgGroup: 'site' }];
      expect(refusalForApp('site-web', depsOf(apps))).toEqual({ reason: 'record', via: 'site' });
    });

    it('a stamp to a container with NO state entry (folder-dropped) stands', async () => {
      await store.suspend('site', 'admin');
      const apps = [{ name: 'site-web', group: 'site', groupContainer: 'site' }];
      expect(refusalForApp('site-web', depsOf(apps))).toEqual({ reason: 'record', via: 'site' });
    });

    it('a folder-dropped container is frozen by its stamped child\'s record, and has children', async () => {
      await store.suspend('site-api', 'admin');
      const apps = [
        { name: 'site-web', group: 'site', groupContainer: 'site' },
        { name: 'site-api', group: 'site', groupContainer: 'site' },
      ];
      const deps = depsOf(apps);
      expect(refusalForApp('site', deps)).toEqual({ reason: 'record', via: 'site-api' });
      expect(childrenOf('site', deps).sort()).toEqual(['site-api', 'site-web']);
      // The sibling is not frozen by the other child.
      expect(refusalForApp('site-web', deps)).toBeNull();
    });

    it('a bare stamp to an app that is not a container is ignored', async () => {
      await store.suspend('site', 'admin');
      const apps = [{ name: 'site' }, { name: 'site-web', group: 'site', groupContainer: 'site' }];
      expect(refusalForApp('site-web', depsOf(apps))).toBeNull();
    });

    it('a stamp to a container of a different group is ignored', async () => {
      await store.suspend('site', 'admin');
      const apps = [container('site', { group: 'elsewhere' }), { name: 'site-web', group: 'site', groupContainer: 'site' }];
      expect(refusalForApp('site-web', depsOf(apps))).toBeNull();
    });

    it('an unsuspended container refuses none of its children', async () => {
      await store.suspend('other', 'admin');
      const apps = [container('site'), { name: 'site-web', group: 'site', groupContainer: 'site' }];
      expect(refusalForApp('site-web', depsOf(apps))).toBeNull();
    });

    it('a sibling is not refused by another child record', async () => {
      await store.suspend('site-api', 'admin');
      const apps = [
        container('site'),
        { name: 'site-web', group: 'site', groupContainer: 'site' },
        { name: 'site-api', group: 'site', groupContainer: 'site' },
      ];
      expect(refusalForApp('site-web', depsOf(apps))).toBeNull();
      expect(refusalForApp('site-api', depsOf(apps))).toEqual({ reason: 'record' });
    });

    it('an undefined group never matches: ungrouped apps are not children of a group-less container', async () => {
      await store.suspend('odd', 'admin');
      const apps = [{ name: 'odd', isGroupContainer: true }, { name: 'plain' }, { name: 'plain2', groupContainer: 'odd' }];
      expect(refusalForApp('plain', depsOf(apps))).toBeNull();
      // A stamp still names a CURRENT container; with no group to compare on either side it stands.
      expect(refusalForApp('plain2', depsOf(apps))).toEqual({ reason: 'record', via: 'odd' });
    });
  });

  describe('group frozen: a container is refused for a record held by a member', () => {
    it('refuses the container via the suspended member', async () => {
      await store.suspend('site-api', 'admin');
      const apps = [container('site'), { name: 'site-web', group: 'site' }, { name: 'site-api', group: 'site' }];
      expect(refusalForApp('site', depsOf(apps))).toEqual({ reason: 'record', via: 'site-api' });
    });

    it('sees a member that exists only in config', async () => {
      await store.suspend('site-api', 'admin');
      const apps = [container('site'), { name: 'site-api', group: 'site', configOnly: true }];
      expect(refusalForApp('site', depsOf(apps))).toEqual({ reason: 'record', via: 'site-api' });
    });

    it('leaves a container with no suspended member alone', async () => {
      await store.suspend('stranger', 'admin');
      const apps = [container('site'), { name: 'site-web', group: 'site' }, { name: 'stranger', group: 'other' }];
      expect(refusalForApp('site', depsOf(apps))).toBeNull();
    });

    it('an ordinary app with a suspended group-mate by name is not a container, so is not frozen', async () => {
      await store.suspend('site-api', 'admin');
      const apps = [{ name: 'lone', group: 'site' }, { name: 'site-api', group: 'site' }];
      expect(refusalForApp('lone', depsOf(apps))).toBeNull();
    });

    it('refusalForExpansion answers for a group whose container is not in state (a folder-dropped one)', async () => {
      await store.suspend('site-api', 'admin');
      const apps = [{ name: 'site-api', group: 'site' }];
      expect(refusalForExpansion('site', 'site', true, depsOf(apps))).toEqual({
        verdict: { reason: 'record', via: 'site-api' },
        hasMembers: true,
      });
      expect(refusalForExpansion('site-api', 'site', true, depsOf(apps)).verdict).toBeNull();
    });
  });

  describe('case: the trust expandMonorepo persisted decides how groups compare', () => {
    it("an untrusted container's group matches ignoring case, when gating", async () => {
      await store.suspend('site', 'admin');
      const apps = [container('site', { groupTrusted: false }), { name: 'site-web', group: 'SITE' }];
      expect(refusalForApp('site-web', depsOf(apps))).toEqual({ reason: 'record', via: 'site' });
    });

    it('a trusted container compares exactly', async () => {
      await store.suspend('site', 'admin');
      const apps = [container('site', { groupTrusted: true }), { name: 'site-web', group: 'SITE' }];
      expect(refusalForApp('site-web', depsOf(apps))).toBeNull();
    });

    it('a legacy container (no field) gates ignoring case but is destructive only on an exact match', async () => {
      await store.suspend('site', 'admin');
      const apps = [container('site'), { name: 'site-web', group: 'SITE' }, { name: 'site-api', group: 'site' }];
      expect(refusalForApp('site-web', depsOf(apps))).toEqual({ reason: 'record', via: 'site' });
      expect(childrenOf('site', depsOf(apps))).toEqual(['site-api']);
    });

    it('a trusted ezsign group and a tenant EzSign group never cross', async () => {
      const apps = [
        container('ezsign', { groupTrusted: true }),
        container('tenant-site', { group: 'EzSign', groupTrusted: false }),
        { name: 'ezsign-web', group: 'ezsign' },
        { name: 'tenant-web', group: 'EzSign' },
      ];
      const deps = depsOf(apps);

      // Suspending the trusted container reaches only its own child.
      await store.suspend('ezsign', 'admin');
      expect(refusalForApp('ezsign-web', deps)).toEqual({ reason: 'record', via: 'ezsign' });
      expect(refusalForApp('tenant-web', deps)).toBeNull();
      expect(refusalForApp('tenant-site', deps)).toBeNull();
      expect(childrenOf('ezsign', deps)).toEqual(['ezsign-web']);
      expect(childrenOf('tenant-site', deps)).toEqual(['tenant-web']);
      await store.unsuspend('ezsign');

      // And the tenant's container reaches only its own.
      await store.suspend('tenant-site', 'admin');
      expect(refusalForApp('tenant-web', deps)).toEqual({ reason: 'record', via: 'tenant-site' });
      expect(refusalForApp('ezsign-web', deps)).toBeNull();
      expect(refusalForApp('ezsign', deps)).toBeNull();
      await store.unsuspend('tenant-site');

      // Nor does a member's record freeze the other side's container.
      await store.suspend('tenant-web', 'admin');
      expect(refusalForApp('tenant-site', deps)).toEqual({ reason: 'record', via: 'tenant-web' });
      expect(refusalForApp('ezsign', deps)).toBeNull();
      await store.unsuspend('tenant-web');
      await store.suspend('ezsign-web', 'admin');
      expect(refusalForApp('ezsign', deps)).toEqual({ reason: 'record', via: 'ezsign-web' });
      expect(refusalForApp('tenant-site', deps)).toBeNull();
    });
  });

  describe('stamps: folder-dropped containers are trusted and exact; an explicit stamp is never filtered out', () => {
    it('a stamp with no state entry keeps a case-variant untrusted container from reaching the child', async () => {
      const apps = [
        container('tenant-site', { group: 'EzSign', groupTrusted: false }),
        { name: 'ezsign-web', group: 'ezsign', groupContainer: 'ezsign' },
      ];
      const deps = depsOf(apps);
      await store.suspend('tenant-site', 'admin');
      expect(refusalForApp('ezsign-web', deps)).toBeNull();
      expect(childrenOf('tenant-site', deps)).toEqual([]);
      await store.unsuspend('tenant-site');
      await store.suspend('ezsign', 'admin');
      expect(refusalForApp('ezsign-web', deps)).toEqual({ reason: 'record', via: 'ezsign' });
    });

    it("the explicitly stamped container is kept even when a trusted container also matches by group", async () => {
      const apps = [
        container('stamped', { group: 'x', groupTrusted: false }),
        container('trusted', { group: 'x', groupTrusted: true }),
        { name: 'kid', group: 'x', groupContainer: 'stamped' },
      ];
      await store.suspend('stamped', 'admin');
      expect(refusalForApp('kid', depsOf(apps))).toEqual({ reason: 'record', via: 'stamped' });
    });
  });

  describe('refusalCauseOf', () => {
    it('reads both shapes a refusal arrives in, and nothing else', () => {
      expect(refusalCauseOf(new StartRefused('a', { kind: 'suspended', reason: 'record' }, true))).toEqual({
        cause: { kind: 'suspended', reason: 'record' },
        replaced: true,
      });
      expect(refusalCauseOf(new StartRefused('a', { kind: 'stopped' }))).toEqual({
        cause: { kind: 'stopped' },
        replaced: false,
      });
      expect(refusalCauseOf(new AppSuspendedError('a', 'store-unreadable'))).toEqual({
        cause: { kind: 'suspended', reason: 'store-unreadable', via: undefined },
        replaced: false,
      });
      expect(refusalCauseOf(new Error('x'))).toBeNull();
      expect(refusalCauseOf(undefined)).toBeNull();
    });
  });

  describe('refusalForExpansion: a group named after a record', () => {
    it('is a naming conflict when the group has no members, ignoring case', async () => {
      await store.suspend('Shared', 'admin');
      expect(refusalForExpansion('site', 'shared', true, depsOf([]))).toEqual({
        verdict: { reason: 'record', via: 'Shared' },
        hasMembers: false,
      });
    });

    it('is a plain suspension (not a conflict) once the group has members', async () => {
      await store.suspend('shared', 'admin');
      const apps = [{ name: 'kid', group: 'shared' }];
      expect(refusalForExpansion('site', 'shared', true, depsOf(apps))).toEqual({
        verdict: { reason: 'record', via: 'shared' },
        hasMembers: true,
      });
    });

    it('reports another app holding the group host, for a NEW group only', () => {
      const host = { suffix: 'dropkit.sh', owners: new Map([['foo.dropkit.sh', 'tenant-a']]) };
      expect(refusalForExpansion('site', 'foo', true, depsOf([{ name: 'tenant-a' }]), host)).toEqual({
        verdict: null,
        hasMembers: false,
        hostOwner: 'tenant-a',
      });
      const existing = depsOf([{ name: 'tenant-a' }, { name: 'kid', group: 'foo' }]);
      expect(refusalForExpansion('site', 'foo', true, existing, host)).toEqual({ verdict: null, hasMembers: true });
    });

    it("ignores the asking container's own name", async () => {
      await store.suspend('site', 'admin');
      expect(refusalForExpansion('site', 'site', true, depsOf([])).verdict).toBeNull();
    });
  });

  describe('childrenOf', () => {
    it("is a current container's group members and stamped apps, not itself", () => {
      const apps = [
        container('site'),
        { name: 'site-web', group: 'site' },
        { name: 'site-api', cfgGroup: 'site', configOnly: true },
        { name: 'stamped', groupContainer: 'site' },
        { name: 'bystander', group: 'other' },
      ];
      expect(childrenOf('site', depsOf(apps)).sort()).toEqual(['site-api', 'site-web', 'stamped']);
    });

    it('is empty for an ordinary app and for an unknown name', () => {
      const apps = [{ name: 'plain', group: 'plain' }, { name: 'kid', group: 'plain' }];
      expect(childrenOf('plain', depsOf(apps))).toEqual([]);
      expect(childrenOf('nobody', depsOf(apps))).toEqual([]);
    });

    it("agrees exactly with the gate: a stamped child that moved to another group is neither refused nor a child", async () => {
      await store.suspend('site', 'admin');
      const apps = [
        container('site'),
        { name: 'site-web', group: 'site', groupContainer: 'site' },
        { name: 'moved', group: 'elsewhere', groupContainer: 'site' },
        { name: 'site-api', cfgGroup: 'site', configOnly: true },
        { name: 'bystander', group: 'other' },
        container('site-two', { group: 'site' }),
      ];
      const deps = depsOf(apps);
      const refusedVia = apps
        .map((a) => a.name)
        .filter((name) => refusalForApp(name, deps)?.via === 'site')
        .sort();
      expect(childrenOf('site', deps).sort()).toEqual(refusedVia);
      expect(refusedVia).toEqual(['site-api', 'site-web']);
    });

    it('never includes another container of the same group', () => {
      const apps = [container('site'), container('site-two', { group: 'site' }), { name: 'site-web', group: 'site' }];
      expect(childrenOf('site', depsOf(apps))).toEqual(['site-web']);
    });
  });

  describe('childrenOf is exact for anything destructive', () => {
    it('an untrusted container still does not reach a case-variant group, and a stamped child is its stamp\'s alone', () => {
      const apps = [
        { ...container('Mono'), groupTrusted: false },
        { name: 'theirs', group: 'mono' },
        { name: 'mine', group: 'Mono' },
        container('Mono2', { group: 'Mono' }),
        { name: 'stamped', group: 'Mono', groupContainer: 'Mono2', cfgGroup: 'Mono' },
      ];
      expect(childrenOf('Mono', depsOf(apps))).toEqual(['mine']);
      expect(childrenOf('Mono2', depsOf(apps))).toContain('stamped');
    });
  });

  describe('stampOnly keeps a state container the stateless stamp would strip', () => {
    it('a folder-dropped stamp (no state entry) beside a state container with an exact group match', () => {
      const apps = [
        container('Mono'),
        { name: 'kid', group: 'Mono', groupContainer: 'dropped' },
        { name: 'dropped', configOnly: true },
      ];
      // 'dropped' has no state entry; 'Mono' is a state container and kid's group matches it exactly.
      expect(childrenOf('Mono', depsOf(apps))).toEqual(['kid']);
      expect(childrenOf('dropped', depsOf(apps))).toEqual(['kid']);
    });
  });

  describe('enforcementTargets and isStillEnforced', () => {
    it('a record names its own app only when one is known by exactly that name, plus its children', async () => {
      const apps = [container('site'), { name: 'site-web', group: 'site' }, { name: 'bystander' }];
      await store.suspend('site', 'admin');
      await store.suspend('drop-platform', 'admin');
      await store.suspend('Bystander', 'admin');

      const targets = enforcementTargets(depsOf(apps));

      expect([...targets].sort()).toEqual([
        ['site', 'site'],
        ['site-web', 'site'],
      ]);
    });

    it('is empty while the store is unreadable', async () => {
      await store.suspend('site', 'admin');
      fs.writeFileSync(path.join(dir, 'suspensions.json'), '{ broken');
      jest.spyOn(console, 'error').mockImplementation();
      await store.load();

      expect(enforcementTargets(depsOf([container('site')])).size).toBe(0);
    });

    it('isStillEnforced follows the record and the attribution', async () => {
      const apps = [container('site'), { name: 'site-web', group: 'site' }, { name: 'other' }];
      await store.suspend('site', 'admin');
      const deps = depsOf(apps);

      expect(isStillEnforced('site', deps)).toBe(true);
      expect(isStillEnforced('site-web', deps)).toBe(true);
      expect(isStillEnforced('other', deps)).toBe(false);
      // Held by a second record too: lifting one leaves it enforced.
      await store.suspend('site-web', 'admin');
      await store.unsuspend('site');
      expect(isStillEnforced('site-web', deps)).toBe(true);
      await store.unsuspend('site-web');
      expect(isStillEnforced('site-web', deps)).toBe(false);
    });

    it('settleSetFor: the app, what runs under it, and its container', () => {
      const apps = [container('site'), { name: 'site-web', group: 'site' }, { name: 'other' }];
      const deps = depsOf(apps);

      expect(settleSetFor('site', deps).sort()).toEqual(['site', 'site-web']);
      expect(settleSetFor('site-web', deps).sort()).toEqual(['site', 'site-web']);
      expect(settleSetFor('other', deps)).toEqual(['other']);
    });
  });

  describe('routeWithdrawalFor: the exact attribution, never the gate reading', () => {
    it('answers for the app itself and for what runs under a suspended container', async () => {
      const apps = [container('site'), { name: 'site-web', group: 'site' }, { name: 'other' }];
      await store.suspend('site', 'admin');
      const deps = depsOf(apps);

      expect(routeWithdrawalFor('site', deps)).toEqual({ reason: 'record' });
      expect(routeWithdrawalFor('site-web', deps)).toEqual({ reason: 'record', via: 'site' });
      expect(routeWithdrawalFor('other', deps)).toBeNull();
    });

    it('does not withdraw a route the start gate would still refuse on a case-insensitive match', async () => {
      // A legacy container (no persisted trust) and a child whose group differs only in case:
      // the gate reads it loosely and refuses the start; a route is not taken away on that doubt.
      const apps = [container('site', { group: 'Site' }), { name: 'x', group: 'SITE' }];
      await store.suspend('site', 'admin');
      const deps = depsOf(apps);

      expect(refusalForApp('x', deps)).toEqual({ reason: 'record', via: 'site' });
      expect(routeWithdrawalFor('x', deps)).toBeNull();
    });

    it('does not withdraw for a record that only matches the name ignoring case', async () => {
      await store.suspend('Site', 'admin');
      expect(refusalForApp('site', depsOf([{ name: 'site' }]))).toEqual({ reason: 'record' });
      expect(routeWithdrawalFor('site', depsOf([{ name: 'site' }]))).toBeNull();
    });

    it('never withdraws while the store is unreadable or not loaded', async () => {
      await store.suspend('site', 'admin');
      fs.writeFileSync(path.join(dir, 'suspensions.json'), '{ broken');
      jest.spyOn(console, 'error').mockImplementation();
      await store.load();
      const deps = depsOf([{ name: 'site' }]);

      expect(refusalForApp('site', deps)).toEqual({ reason: 'store-unreadable' });
      expect(routeWithdrawalFor('site', deps)).toBeNull();
      const unloaded = new SuspensionStore(path.join(dir, 'other.json'));
      expect(routeWithdrawalFor('site', { ...deps, store: unloaded })).toBeNull();
    });
  });

  describe('legacy records with no recorded app name', () => {
    /** A suspensions.json as written before records carried `app`: only the lower-cased key. */
    async function loadKeyless(...keys: string[]): Promise<void> {
      const file: Record<string, { at: string; by: string }> = {};
      for (const key of keys) file[key] = { at: '2026-01-01T00:00:00.000Z', by: 'admin' };
      fs.writeFileSync(path.join(dir, 'suspensions.json'), JSON.stringify(file));
      await store.load();
    }

    it('a key is its exact name: an app of that name is enforced, a case variant is not reached', async () => {
      await loadKeyless('myapp');

      expect([...enforcementTargets(depsOf([{ name: 'myapp' }, { name: 'other' }]))]).toEqual([['myapp', 'myapp']]);
      expect(enforcementTargets(depsOf([{ name: 'MyApp' }])).size).toBe(0);
      expect(routeWithdrawalFor('MyApp', depsOf([{ name: 'MyApp' }]))).toBeNull();
    });

    it('with no app, the key stands as a recorded name (a deleted app, its runtime orphan)', async () => {
      await loadKeyless('ghost');
      const deps = depsOf([{ name: 'other' }]);

      expect(enforcementTargets(deps).size).toBe(0);
      expect([...recordedNames(deps)]).toEqual(['ghost']);
    });
  });

  describe("DROP's own service name", () => {
    it('is never a target, a recorded name or still enforced, even when an app by that name is known', async () => {
      await store.suspend('drop-platform', 'admin');
      await store.suspend('Drop-Platform', 'admin');
      const deps = depsOf([{ name: 'drop-platform' }, { name: 'Drop-Platform' }]);

      expect(enforcementTargets(deps).size).toBe(0);
      expect(recordedNames(deps).size).toBe(0);
      expect(isStillEnforced('drop-platform', deps)).toBe(false);
      expect(routeWithdrawalFor('drop-platform', deps)).toBeNull();
    });
  });

  describe('suspendedOrphans', () => {
    it('is the runtime names a record names that nothing of ours knows, exactly', async () => {
      const apps = [container('site'), { name: 'site-web', group: 'site' }, { name: 'known' }];
      await store.suspend('site', 'admin');
      await store.suspend('ghost', 'admin');
      await store.suspend('known', 'admin');
      await store.suspend('drop-platform', 'admin');
      const deps = depsOf(apps);

      const orphans = suspendedOrphans(['site', 'site-web', 'ghost', 'Ghost', 'known', 'drop-platform', 'bystander'], deps);

      // `site` and `site-web` are known apps (the pass handles them), `known` too.
      expect([...orphans]).toEqual(['ghost']);
    });

    it('is empty while the store is unreadable', async () => {
      await store.suspend('ghost', 'admin');
      fs.writeFileSync(path.join(dir, 'suspensions.json'), '{ broken');
      jest.spyOn(console, 'error').mockImplementation();
      await store.load();

      expect(suspendedOrphans(['ghost'], depsOf([])).size).toBe(0);
    });
  });

  describe('suspensionStoreUnavailable', () => {
    it('names why the store cannot answer, and is null when it can', async () => {
      expect(suspensionStoreUnavailable(depsOf([]))).toBeNull();
      await store.suspend('site', 'admin');
      expect(suspensionStoreUnavailable(depsOf([]))).toBeNull();
      fs.writeFileSync(path.join(dir, 'suspensions.json'), '{ broken');
      jest.spyOn(console, 'error').mockImplementation();
      await store.load();
      expect(suspensionStoreUnavailable(depsOf([]))).toBe('store-unreadable');
      expect(suspensionStoreUnavailable({ ...depsOf([]), store: new SuspensionStore(path.join(dir, 'other.json')) })).toBe(
        'not-loaded'
      );
    });
  });

  describe("a record's own host", () => {
    it('is not claimed against its own app, and is against every other', async () => {
      await store.suspend('site', 'admin');
      const claims = hostClaims('dropkit.sh', depsOf([{ name: 'site' }, { name: 'other' }]));

      expect(claimedAgainst(claims, 'site.dropkit.sh', 'site')).toBe(false);
      expect(claimedAgainst(claims, 'site.dropkit.sh', 'other')).toBe(true);
    });
  });

  describe('recordedNames', () => {
    it('is each record exact name and what runs under it; empty while the store is unreadable', async () => {
      const apps = [container('site'), { name: 'site-web', group: 'site' }, { name: 'other' }];
      await store.suspend('site', 'admin');
      await store.suspend('ghost', 'admin');
      const deps = depsOf(apps);

      expect([...recordedNames(deps)].sort()).toEqual(['ghost', 'site', 'site-web']);

      fs.writeFileSync(path.join(dir, 'suspensions.json'), '{ broken');
      jest.spyOn(console, 'error').mockImplementation();
      await store.load();
      expect(recordedNames(deps).size).toBe(0);
    });
  });

  describe('hostClaims', () => {
    const holders = (claims: Map<string, Set<string>>, host: string): string[] => [...(claims.get(host) ?? [])].sort();

    it("a record's host belongs to the record alone", async () => {
      await store.suspend('gone', 'admin');
      const claims = hostClaims('dropkit.sh', depsOf([{ name: 'evil' }]));
      expect(holders(claims, 'gone.dropkit.sh')).toEqual(['gone']);
      expect(claimedAgainst(claims, 'gone.dropkit.sh', 'evil')).toBe(true);
      expect(claimedAgainst(claims, 'gone.dropkit.sh', 'gone')).toBe(false);
    });

    it('a group host ALWAYS belongs to the container and members, with nothing suspended', () => {
      const apps = [container('site'), { name: 'site-web', group: 'site' }, { name: 'evil' }];
      const claims = hostClaims('dropkit.sh', depsOf(apps));
      expect(holders(claims, 'site.dropkit.sh')).toEqual(['site', 'site-web']);
      expect(claimedAgainst(claims, 'site.dropkit.sh', 'evil')).toBe(true);
      expect(claimedAgainst(claims, 'SITE.dropkit.sh', 'site-web')).toBe(false);
    });

    it('a folder-dropped container holds its stamped children\'s group host', () => {
      const apps = [{ name: 'site-web', group: 'site', groupContainer: 'site' }];
      expect(holders(hostClaims('dropkit.sh', depsOf(apps)), 'site.dropkit.sh')).toEqual(['site', 'site-web']);
    });

    it('a stale stamp holds nothing: the named app is no longer a container', () => {
      const apps = [{ name: 'site' }, { name: 'site-web', group: 'site', groupContainer: 'site' }];
      expect(holders(hostClaims('dropkit.sh', depsOf(apps)), 'site.dropkit.sh')).toEqual(['site-web']);
    });

    it('a group stays claimed through a config alone (its state entries are gone)', () => {
      const apps = [{ name: 'kid', group: 'site', configOnly: true }];
      expect(claimedAgainst(hostClaims('dropkit.sh', depsOf(apps)), 'site.dropkit.sh', 'evil')).toBe(true);
    });

    it('folds the owner map in: an app\'s persisted domain is its own and nobody else\'s', () => {
      const owners = new Map([['shop.example.com', 'shop']]);
      const claims = hostClaims('dropkit.sh', depsOf([{ name: 'shop' }, { name: 'evil' }]), owners);
      expect(claimedAgainst(claims, 'shop.example.com', 'evil')).toBe(true);
      expect(claimedAgainst(claims, 'shop.example.com', 'shop')).toBe(false);
    });

    it('first holder wins for a group host: a non-member that already serves it keeps it, the group yields', () => {
      const owners = new Map([['foo.dropkit.sh', 'tenant-a']]);
      const apps = [container('foo'), { name: 'foo-web', group: 'foo' }, { name: 'tenant-a' }];
      const claims = hostClaims('dropkit.sh', depsOf(apps), owners);
      expect(claimedAgainst(claims, 'foo.dropkit.sh', 'tenant-a')).toBe(false);
      expect(claimedAgainst(claims, 'foo.dropkit.sh', 'foo-web')).toBe(true);
    });

    it('a group host nobody owns yet belongs to the group, and a member that owns it stays', () => {
      const apps = [container('foo'), { name: 'foo-web', group: 'foo' }, { name: 'evil' }];
      const claims = hostClaims('dropkit.sh', depsOf(apps), new Map([['foo.dropkit.sh', 'foo-web']]));
      expect(claimedAgainst(claims, 'foo.dropkit.sh', 'foo-web')).toBe(false);
      expect(claimedAgainst(claims, 'foo.dropkit.sh', 'evil')).toBe(true);
    });

    it("a record's host is the record's even when another app listed it", async () => {
      await store.suspend('gone', 'admin');
      const claims = hostClaims('dropkit.sh', depsOf([{ name: 'x' }]), new Map([['gone.dropkit.sh', 'x']]));
      expect(claimedAgainst(claims, 'gone.dropkit.sh', 'x')).toBe(true);
    });

    it("another app's persisted domain does not conflict with a covering wildcard (exact match only)", () => {
      const owners = new Map([['a.example.com', 'a']]);
      const claims = hostClaims('dropkit.sh', depsOf([{ name: 'a' }, { name: 'b' }]), owners);
      expect(claimedAgainst(claims, 'a.example.com', 'b')).toBe(true);
      expect(claimedAgainst(claims, '*.example.com', 'b')).toBe(false);
    });

    it('a wildcard that expands, by one label, to a claimed host is refused', async () => {
      await store.suspend('susp', 'admin');
      const claims = hostClaims('localhost', depsOf([{ name: 'evil' }]));
      expect(claimedAgainst(claims, '*.localhost', 'evil')).toBe(true);
      expect(claimedAgainst(claims, '*.localhost', 'susp')).toBe(false);
      expect(claimedAgainst(claims, '*.example.com', 'evil')).toBe(false);
      // Only a SINGLE label: a deeper claimed host is not a *.rest expansion.
      const deep = hostClaims('a.localhost', depsOf([{ name: 'evil' }]));
      expect(claimedAgainst(deep, '*.localhost', 'evil')).toBe(false);
    });

    it('claims no RECORD host while the store is unreadable (nothing to list)', async () => {
      await store.suspend('gone', 'admin');
      fs.writeFileSync(path.join(dir, 'suspensions.json'), '{ broken');
      jest.spyOn(console, 'error').mockImplementation();
      await store.load();
      expect(hostClaims('dropkit.sh', depsOf([{ name: 'evil' }])).size).toBe(0);
    });
  });
});

describe('refusalEpisodeCode: the one rule', () => {
  const record: StartRefusalCause = { kind: 'suspended', reason: 'record' };
  const unreadable: StartRefusalCause = { kind: 'suspended', reason: 'store-unreadable' };
  const stages = [true, false].flatMap((replaced) => [true, false, null].map((live) => ({ replaced, live })));

  it('a record or a user stop is DEPLOY_STOPPED at every stage', () => {
    for (const stage of stages) {
      expect(refusalEpisodeCode(record, stage)).toBe('DEPLOY_STOPPED');
      expect(refusalEpisodeCode({ kind: 'stopped' }, stage)).toBe('DEPLOY_STOPPED');
    }
  });

  it('a store that cannot answer is DEPLOY_STOPPED only after the old version was replaced and nothing is live', () => {
    expect(refusalEpisodeCode(unreadable, { replaced: true, live: false })).toBe('DEPLOY_STOPPED');
    expect(refusalEpisodeCode({ kind: 'suspended', reason: 'not-loaded' }, { replaced: true, live: false })).toBe(
      'DEPLOY_STOPPED'
    );
  });

  it('otherwise (before the swap, something live, or nobody looked) it is DEPLOY_REFUSED', () => {
    expect(refusalEpisodeCode(unreadable, { replaced: false, live: false })).toBe('DEPLOY_REFUSED');
    expect(refusalEpisodeCode(unreadable, { replaced: true, live: true })).toBe('DEPLOY_REFUSED');
    expect(refusalEpisodeCode(unreadable, { replaced: true, live: null })).toBe('DEPLOY_REFUSED');
    expect(refusalEpisodeCode(unreadable, { replaced: false, live: null })).toBe('DEPLOY_REFUSED');
  });
});

describe('suspension policy: default dependencies', () => {
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-suspension-policy-default-'));
    resetStateManager();
    resetAppConfigService();
    resetSuspensionStore();
    await getSuspensionStore(path.join(dir, 'suspensions.json')).load();
  });

  afterEach(() => {
    resetSuspensionStore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('with no state or config service initialised, the app own record still decides', async () => {
    await getSuspensionStore().suspend('site', 'admin');
    expect(refusalForApp('site')).toEqual({ reason: 'record' });
    expect(refusalForApp('blog')).toBeNull();
    expect(childrenOf('site')).toEqual([]);
  });
});

describe('suspension policy: pins', () => {
  const srcRoot = path.resolve(__dirname, '..');

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dashboard' || entry.name === '__testutils__') continue;
        out.push(...sourceFiles(full));
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  const rel = (file: string): string => path.relative(srcRoot, file).split(path.sep).join('/');

  // suspension-policy.ts is the resolver; app-names.ts asks a different question (is a NAME
  // free to create?), which is name-keyed by nature; the store defines the methods.
  const ALLOWED = new Set(['core/suspension-policy.ts', 'core/app-names.ts', 'managers/suspension/suspension-store.ts']);

  it('only the resolver and the name-reservation rule ask the store by name (refusalFor)', () => {
    const offenders = sourceFiles(srcRoot)
      .filter((file) => !ALLOWED.has(rel(file)))
      .filter((file) => /\.(refusalFor|isSuspended)\(/.test(fs.readFileSync(file, 'utf-8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  /** The method names called on `getSuspensionStore(...)` in a file, however its argument is laid out. */
  function storeCallsIn(file: string): string[] {
    const text = fs.readFileSync(file, 'utf-8');
    return [...text.matchAll(/getSuspensionStore\((?:[^()]|\([^()]*\))*\)\s*\.(\w+)/g)].map((m) => m[1]);
  }

  it('only the resolver, the name-reservation rule, the platform and one DTO detail import the store', () => {
    const importers = sourceFiles(srcRoot)
      .filter((file) => !/^managers\/suspension\//.test(rel(file)))
      .filter((file) => /\bgetSuspensionStore\b/.test(fs.readFileSync(file, 'utf-8')))
      .map(rel)
      .sort();
    expect(importers).toEqual(['api/routes/apps.ts', 'core/app-names.ts', 'core/platform.ts', 'core/suspension-policy.ts']);
  });

  it('the platform only writes records and loads the store; apps.ts only reads the record detail', () => {
    const platformCalls = new Set(storeCallsIn(path.join(srcRoot, 'core/platform.ts')));
    expect([...platformCalls].sort()).toEqual(['load', 'suspend', 'unsuspend']);
    expect(storeCallsIn(path.join(srcRoot, 'api/routes/apps.ts'))).toEqual(['get']);
  });

  it('nothing aliases the store or builds a second one outside its module', () => {
    const files = sourceFiles(srcRoot).filter((file) => !/^managers\/suspension\//.test(rel(file)));
    const aliased = files
      // The STORE assigned (`const s = getSuspensionStore();`), not a value read off it.
      .filter((file) =>
        /=\s*getSuspensionStore\((?:[^()]|\([^()]*\))*\)\s*[;,)]/.test(fs.readFileSync(file, 'utf-8'))
      )
      .map(rel);
    expect(aliased).toEqual([]);
    const constructed = files
      .filter((file) => rel(file) !== 'core/suspension-policy.ts')
      .filter((file) => /new SuspensionStore\(/.test(fs.readFileSync(file, 'utf-8')))
      .map(rel);
    expect(constructed).toEqual([]);
  });

  /**
   * The method (a two-space-indented class member) that holds character `index` of `text`.
   * The platform file mixes LF and CRLF line endings, so lines are split on either.
   */
  function enclosingMethod(text: string, index: number): string | undefined {
    const header = /^ {2}(?:private |protected |public |static )*(?:async )?(\w+)(?:<[^>\r\n]*>)?\(/gm;
    let found: string | undefined;
    for (const m of text.matchAll(header)) {
      if (m.index === undefined || m.index > index) break;
      found = m[1];
    }
    return found;
  }

  /** Comment lines and trailing line comments removed, so a doc that NAMES a writer is not mistaken for one. */
  function code(text: string): string {
    return text.replace(/^\s*(?:\/\*|\*|\/\/).*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  }

  /**
   * Every non-test source file outside the router module that mentions one of the route
   * writers by NAME (a call, an alias, a destructure), with the method it sits in.
   */
  function routerWriteSites(method: string): string[] {
    const mention = new RegExp(`\\b${method}\\b`, 'g');
    const sites: string[] = [];
    for (const file of sourceFiles(srcRoot)) {
      if (/^core\/router\//.test(rel(file))) continue;
      const text = code(fs.readFileSync(file, 'utf-8'));
      for (const m of text.matchAll(mention)) {
        sites.push(`${rel(file)}#${enclosingMethod(text, m.index ?? 0)}`);
      }
    }
    return sites;
  }

  it('a route is written in ONE place: router.addRoute is named only in handleConfigureRoute, straight after a synchronous record check', () => {
    expect(routerWriteSites('addRoute')).toEqual(['core/platform.ts#handleConfigureRoute']);
    const text = fs.readFileSync(path.join(srcRoot, 'core/platform.ts'), 'latin1');
    const call = text.indexOf('.addRoute(');
    const check = text.lastIndexOf("refusalForApp(appName)?.reason === 'record'", call);
    expect(check).toBeGreaterThan(-1);
    // Between the last check and the write: nothing awaited but the write itself.
    const between = text.slice(check, call).replace(/const conflict = await this\.router$/, '');
    expect(between).not.toMatch(/\bawait\b/);
  });

  it('the other route writers have no caller outside the router module', () => {
    for (const method of ['updateRoute', 'setRouteStatus', 'clearRoutes']) {
      expect(routerWriteSites(method)).toEqual([]);
    }
  });

  it('traffic is switched in ONE place: router.setUpstream is named only in cutoverTo, straight after its gate', () => {
    expect(routerWriteSites('setUpstream')).toEqual(['core/platform.ts#cutoverTo']);
    const text = fs.readFileSync(path.join(srcRoot, 'core/platform.ts'), 'latin1');
    const call = text.indexOf('.setUpstream(');
    const gate = text.lastIndexOf('this.gateBeforeSwap(appName, ctx);', call);
    expect(gate).toBeGreaterThan(-1);
    // Between the last gate and the switch: nothing awaited but the switch itself.
    const between = text.slice(gate + 'this.gateBeforeSwap(appName, ctx);'.length, call);
    expect(between.replace(/const switched = await this\.router\?/, '')).not.toMatch(/\bawait\b/);
  });

  it('the app:started handler decides nothing about suspension: the one route writer does', () => {
    const text = fs.readFileSync(path.join(srcRoot, 'core/platform.ts'), 'latin1');
    const from = text.indexOf("subscribe('app:started'");
    const handler = text.slice(from, text.indexOf('this.subscriptions.push(startedSub)', from));
    expect(handler).toContain('handleConfigureRoute');
    expect(handler).not.toMatch(/refusalForApp|routeWithdrawalFor|Suspen/);
  });

  it('the store no longer calls its own name-keyed check THE predicate', () => {
    const doc = fs.readFileSync(path.join(srcRoot, 'managers/suspension/suspension-store.ts'), 'utf-8');
    expect(doc).not.toMatch(/THE refusal predicate/);
  });
});
