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
import { suspensionEpisodeCode, type StartRefusalCause } from '../api/platform-ops';
import { resetStateManager } from '../managers/app/state-manager';
import { resetAppConfigService } from '../managers/app/app-config';
import { getSuspensionStore, resetSuspensionStore } from '../managers/suspension';
import {
  childrenOf,
  claimedHostsAgainst,
  refusalForApp,
  refusalForGroup,
  refusalForGroupName,
  type SuspensionPolicyDeps,
} from './suspension-policy';

interface FakeApp {
  name: string;
  group?: string;
  isGroupContainer?: boolean;
  userId?: string;
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

    it('a stale stamp to a container that is gone names nothing', async () => {
      await store.suspend('site', 'admin');
      const apps = [{ name: 'site-web', group: 'site', groupContainer: 'site' }];
      expect(refusalForApp('site-web', depsOf(apps))).toBeNull();
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

    it('refusalForGroup answers for a container that is not in state (a folder-dropped one)', async () => {
      await store.suspend('site-api', 'admin');
      const apps = [{ name: 'site-api', group: 'site' }];
      expect(refusalForGroup('site', { except: 'site', trusted: true }, depsOf(apps))).toEqual({
        reason: 'record',
        via: 'site-api',
      });
      expect(refusalForGroup('site', { except: 'site-api', trusted: true }, depsOf(apps))).toBeNull();
    });
  });

  describe('case: trust decides how groups compare, as in expandMonorepo', () => {
    it("an owned container's group matches ignoring case", async () => {
      await store.suspend('site', 'admin');
      const apps = [container('site', { userId: 'u1' }), { name: 'site-web', group: 'SITE' }];
      expect(refusalForApp('site-web', depsOf(apps))).toEqual({ reason: 'record', via: 'site' });
    });

    it("the operator's own (ownerless) container compares exactly", async () => {
      await store.suspend('site', 'admin');
      const apps = [container('site'), { name: 'site-web', group: 'SITE' }];
      expect(refusalForApp('site-web', depsOf(apps))).toBeNull();
    });
  });

  describe('refusalForGroupName', () => {
    it('finds a record that is the group name, ignoring case', async () => {
      await store.suspend('Shared', 'admin');
      expect(refusalForGroupName('shared', 'site', depsOf([]))).toEqual({ reason: 'record', via: 'Shared' });
    });

    it("ignores the asking container's own name", async () => {
      await store.suspend('site', 'admin');
      expect(refusalForGroupName('site', 'site', depsOf([]))).toBeNull();
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

  describe('claimedHostsAgainst', () => {
    it("claims every record's host against everyone else", async () => {
      await store.suspend('gone', 'admin');
      const deps = depsOf([{ name: 'evil' }]);
      expect(claimedHostsAgainst('evil', 'dropkit.sh', deps)).toEqual(new Set(['gone.dropkit.sh']));
    });

    it("does not claim an app's own host against itself", async () => {
      await store.suspend('site', 'admin');
      expect(claimedHostsAgainst('site', 'dropkit.sh', depsOf([{ name: 'site' }])).size).toBe(0);
    });

    it('claims the group host of a group with a record-refused member, except for the group itself', async () => {
      await store.suspend('site-api', 'admin');
      const apps = [container('site'), { name: 'site-web', group: 'site' }, { name: 'site-api', group: 'site' }, { name: 'evil' }];
      expect(claimedHostsAgainst('evil', 'dropkit.sh', depsOf(apps))).toEqual(
        new Set(['site-api.dropkit.sh', 'site.dropkit.sh'])
      );
      const forMember = claimedHostsAgainst('site-web', 'dropkit.sh', depsOf(apps));
      expect(forMember.has('site.dropkit.sh')).toBe(false);
      expect(forMember.has('site-api.dropkit.sh')).toBe(true);
    });

    it('claims nothing while the store is unreadable (no records to list)', async () => {
      await store.suspend('gone', 'admin');
      fs.writeFileSync(path.join(dir, 'suspensions.json'), '{ broken');
      jest.spyOn(console, 'error').mockImplementation();
      await store.load();
      expect(claimedHostsAgainst('evil', 'dropkit.sh', depsOf([{ name: 'evil' }])).size).toBe(0);
    });
  });
});

describe('suspensionEpisodeCode: the one rule', () => {
  const record: StartRefusalCause = { kind: 'suspended', reason: 'record' };
  const unreadable: StartRefusalCause = { kind: 'suspended', reason: 'store-unreadable' };

  it('a record or a user stop is DEPLOY_STOPPED whatever the runtime shows', () => {
    for (const live of [true, false, null, undefined]) {
      expect(suspensionEpisodeCode(record, live)).toBe('DEPLOY_STOPPED');
      expect(suspensionEpisodeCode({ kind: 'stopped' }, live)).toBe('DEPLOY_STOPPED');
    }
  });

  it('a store that cannot answer is DEPLOY_STOPPED only when nothing is live', () => {
    expect(suspensionEpisodeCode(unreadable, false)).toBe('DEPLOY_STOPPED');
    expect(suspensionEpisodeCode({ kind: 'suspended', reason: 'not-loaded' }, false)).toBe('DEPLOY_STOPPED');
  });

  it('otherwise (something live, or nobody looked) it is DEPLOY_REFUSED', () => {
    expect(suspensionEpisodeCode(unreadable, true)).toBe('DEPLOY_REFUSED');
    expect(suspensionEpisodeCode(unreadable, null)).toBe('DEPLOY_REFUSED');
    expect(suspensionEpisodeCode(unreadable)).toBe('DEPLOY_REFUSED');
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

  it('only the resolver and the name-reservation rule ask the store by name (refusalFor / isSuspended)', () => {
    const offenders = sourceFiles(srcRoot)
      .filter((file) => !ALLOWED.has(rel(file)))
      .filter((file) => /\.(refusalFor|isSuspended)\(/.test(fs.readFileSync(file, 'utf-8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('the store no longer calls its own name-keyed check THE predicate', () => {
    const doc = fs.readFileSync(path.join(srcRoot, 'managers/suspension/suspension-store.ts'), 'utf-8');
    expect(doc).not.toMatch(/THE refusal predicate/);
  });
});
