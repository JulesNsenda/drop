/**
 * THE answer to "is this app refused, and why?".
 *
 * A suspension is a record keyed by one app NAME (`SuspensionStore`), but what
 * it must stop is wider than that name: a monorepo container's children serve
 * on the container's hostname, and a renamed service must not be a way out of
 * a child's suspension. So every reader (the start choke point, the update and
 * redeploy gates, the upload and git paths, the DTO, the MCP status tools, the
 * prober) asks THIS module and never the store's name-keyed `refusalFor`; a
 * test pins that.
 *
 * Rules, in order (the first that applies answers):
 *  1. the app's OWN record, or the store's own state (`store-unreadable` and
 *     `not-loaded` refuse every app);
 *  2. its CONTAINER's record: the container is the app named by the config
 *     `groupContainer` stamp, or any state app marked `isGroupContainer` whose
 *     group equals the app's group. A stamp counts only while that container is
 *     CURRENT (in state, `isGroupContainer`, for that group): a stale stamp on a
 *     child whose container was deleted or replaced names nothing;
 *  3. if the app IS a container, a record held by ANY member of its group
 *     ("group frozen"): a container's expansion would otherwise re-create,
 *     rename around or overwrite the suspended member.
 *
 * A group that is undefined never matches anything. Group names are compared
 * the way `expandMonorepo` compares them: exactly for a TRUSTED container (the
 * operator's, which has no owner), ignoring case otherwise. Whether an owned
 * container is an enabled admin's needs an async credentials read, which a
 * synchronous resolver cannot make, so an owned container is always compared
 * ignoring case: that can only refuse MORE, never less.
 *
 * `via` names the other app whose record is the cause. Only a `record` reason
 * ever has one.
 *
 * The state and config services default to the platform singletons (a missing
 * one answers from the app's own record alone) and are overridden only in tests.
 */

import { getSuspensionStore } from '../managers/suspension';
import type { SuspensionStore, SuspensionVerdict } from '../managers/suspension';
import { getStateManager } from '../managers/app/state-manager';
import type { AppStateManager } from '../managers/app/state-manager';
import { getAppConfigServiceOrNull } from '../managers/app/app-config';
import type { AppConfigService } from '../managers/app/app-config';

export interface SuspensionPolicyDeps {
  store: Pick<SuspensionStore, 'refusalFor' | 'list'>;
  state: Pick<AppStateManager, 'getApp' | 'getAllApps'> | null;
  configs: Pick<AppConfigService, 'getConfig' | 'getAllConfigs'> | null;
}

function defaultDeps(): SuspensionPolicyDeps {
  let state: SuspensionPolicyDeps['state'] = null;
  try {
    state = getStateManager();
  } catch {
    // Not initialised (a context that never built a platform): the app's own record decides.
  }
  return { store: getSuspensionStore(), state, configs: getAppConfigServiceOrNull() };
}

type NameMatch = (x: string | undefined, y: string | undefined) => boolean;

const exact: NameMatch = (x, y) => x !== undefined && x === y;
const ignoringCase: NameMatch = (x, y) => x !== undefined && y !== undefined && x.toLowerCase() === y.toLowerCase();

/** Exact for the operator's own (ownerless) container, ignoring case for anything owned. */
function sameNameFor(container: string, deps: SuspensionPolicyDeps): NameMatch {
  return deps.state?.getApp(container)?.userId ? ignoringCase : exact;
}

function isCurrentContainer(name: string, deps: SuspensionPolicyDeps): boolean {
  return deps.state?.getApp(name)?.isGroupContainer === true;
}

/** An app's groups: the config's and the state's, whichever are defined. */
function groupsOf(name: string, deps: SuspensionPolicyDeps): string[] {
  const groups = [deps.configs?.getConfig(name)?.group, deps.state?.getApp(name)?.group];
  return [...new Set(groups.filter((g): g is string => typeof g === 'string' && g !== ''))];
}

function groupOfContainer(container: string, deps: SuspensionPolicyDeps): string | undefined {
  return deps.state?.getApp(container)?.group || deps.configs?.getConfig(container)?.group || undefined;
}

/** The CURRENT containers `name` is a member of (never `name` itself). */
function containersOf(name: string, deps: SuspensionPolicyDeps): string[] {
  if (!deps.state || isCurrentContainer(name, deps)) return [];
  const groups = groupsOf(name, deps);
  const found = new Set<string>();
  const stamp = deps.configs?.getConfig(name)?.groupContainer;
  if (stamp && stamp !== name && isCurrentContainer(stamp, deps)) {
    // For THAT group: with no group to compare (a child mid-materialisation) the
    // stamp stands, because "cannot tell" must not read as "not a member".
    const group = groupOfContainer(stamp, deps);
    const same = sameNameFor(stamp, deps);
    if (groups.length === 0 || groups.some((g) => same(group, g))) found.add(stamp);
  }
  for (const app of deps.state.getAllApps()) {
    if (!app.isGroupContainer || app.name === name || app.group === undefined) continue;
    const same = sameNameFor(app.name, deps);
    if (groups.some((g) => same(app.group, g))) found.add(app.name);
  }
  return [...found];
}

/**
 * The members of `group` (state and config, never a container, never `except`),
 * plus any app stamped with `container`. Used for "group frozen" and fan-out.
 */
function membersOfGroup(
  group: string,
  same: NameMatch,
  deps: SuspensionPolicyDeps,
  opts: { except?: string; container?: string } = {}
): string[] {
  const found = new Set<string>();
  for (const app of deps.state?.getAllApps() ?? []) {
    if (!app.isGroupContainer && same(app.group, group)) found.add(app.name);
  }
  for (const config of deps.configs?.getAllConfigs() ?? []) {
    if (deps.state?.getApp(config.name)?.isGroupContainer) continue;
    if (same(config.group, group) || (opts.container !== undefined && config.groupContainer === opts.container)) {
      found.add(config.name);
    }
  }
  found.delete(opts.except ?? '');
  return [...found];
}

/**
 * A record held by a member of `group`, as the verdict on whoever would expand
 * it (`except` is the container itself). For `expandMonorepo`, which asks it
 * about a group BEFORE the container is in state (a folder-dropped one never
 * is), so it cannot go through `refusalForApp`. `trusted` is that container's
 * trust, decided by the caller.
 */
export function refusalForGroup(
  group: string,
  opts: { except?: string; trusted?: boolean } = {},
  deps: SuspensionPolicyDeps = defaultDeps()
): SuspensionVerdict | null {
  const same = opts.trusted ? exact : ignoringCase;
  for (const member of membersOfGroup(group, same, deps, { except: opts.except })) {
    if (deps.store.refusalFor(member) === 'record') return { reason: 'record', via: member };
  }
  return null;
}

/**
 * A group whose NAME is a suspension record's: its children would be served on
 * `<group>.<suffix>`, the very host a suspended app (or a deleted one, whose
 * record outlives it) is not allowed to have served. Matched ignoring case,
 * as the store keys are. `except` is the container asking (its own record is
 * `refusalForApp`'s question).
 */
export function refusalForGroupName(
  group: string,
  except?: string,
  deps: SuspensionPolicyDeps = defaultDeps()
): SuspensionVerdict | null {
  const held = deps.store.list().find((record) => ignoringCase(record.name, group) && !ignoringCase(record.name, except));
  return held ? { reason: 'record', via: held.name } : null;
}

/**
 * Why a start or build of the app must be refused, or null. Synchronous (the
 * store, state and config services all answer from memory), so it can sit
 * directly in front of an irreversible step with nothing awaited between.
 */
export function refusalForApp(name: string, deps: SuspensionPolicyDeps = defaultDeps()): SuspensionVerdict | null {
  const own = deps.store.refusalFor(name);
  if (own) return { reason: own };
  for (const container of containersOf(name, deps)) {
    if (deps.store.refusalFor(container) === 'record') return { reason: 'record', via: container };
  }
  if (isCurrentContainer(name, deps)) {
    const group = groupOfContainer(name, deps);
    if (group !== undefined) return refusalForGroup(group, { except: name, trusted: sameNameFor(name, deps) === exact }, deps);
  }
  return null;
}

/**
 * The apps that run under `container`: its group's members and any app stamped
 * with its name. Empty unless `container` is a CURRENT container, so an ordinary
 * app, or a stale name, has none.
 */
export function childrenOf(container: string, deps: SuspensionPolicyDeps = defaultDeps()): string[] {
  if (!isCurrentContainer(container, deps)) return [];
  const group = groupOfContainer(container, deps);
  if (group === undefined) return [];
  return membersOfGroup(group, sameNameFor(container, deps), deps, { except: container, container });
}

/**
 * Hostnames under `domainSuffix` that no app but their holder may claim through
 * a drop.yaml `domains:` entry, lower-cased:
 *  - `<recordName>.<suffix>` for every suspension record (the record outlives
 *    the app, so `getDomainOwners` no longer lists the name);
 *  - `<group>.<suffix>` for every group with a member refused by a RECORD, for
 *    every app that is not itself in that group.
 * Acts only on `record`: an unreadable store has no records to list, so it can
 * never withdraw a route that exists.
 */
export function claimedHostsAgainst(
  appName: string,
  domainSuffix: string,
  deps: SuspensionPolicyDeps = defaultDeps()
): Set<string> {
  const claimed = new Set<string>();
  const records = deps.store.list();
  if (records.length === 0) return claimed;
  const add = (label: string): void => {
    claimed.add(`${label}.${domainSuffix}`.toLowerCase());
  };
  for (const record of records) {
    if (!ignoringCase(record.name, appName)) add(record.name);
  }
  const names = new Set<string>();
  for (const app of deps.state?.getAllApps() ?? []) names.add(app.name);
  for (const config of deps.configs?.getAllConfigs() ?? []) names.add(config.name);
  const mine = groupsOf(appName, deps);
  for (const name of names) {
    if (refusalForApp(name, deps)?.reason !== 'record') continue;
    for (const group of groupsOf(name, deps)) {
      const inGroup = ignoringCase(group, appName) || mine.some((g) => ignoringCase(g, group));
      if (!inGroup) add(group);
    }
  }
  return claimed;
}
