/**
 * THE answer to "is this app refused, and why?".
 *
 * A suspension is a record keyed by one app NAME (`SuspensionStore`), but what
 * it must stop is wider than that name: a monorepo container's children serve
 * on the container's hostname, and a renamed service must not be a way out of
 * a child's suspension. So every reader (the start choke point, the update and
 * redeploy gates, the upload and git paths, the DTO, the MCP status tools, the
 * prober) asks THIS module and never the store's name-keyed `refusalFor`; a
 * test pins that, and pins who may import the store at all.
 *
 * Rules, in order (the first that applies answers):
 *  1. the app's OWN record, or the store's own state (`store-unreadable` and
 *     `not-loaded` refuse every app);
 *  2. its CONTAINER's record: the container is the app named by the config
 *     `groupContainer` stamp, or any state app marked `isGroupContainer` whose
 *     group equals the app's group. A stamp counts while its container is
 *     CURRENT: in state with `isGroupContainer` for that group, or absent from
 *     state altogether (a folder-dropped container never has an entry). A state
 *     entry that is NOT a container makes the stamp stale, and it is ignored;
 *  3. if the app IS a container (current, or folder-dropped with stamped
 *     children), a record held by ANY member of its group ("group frozen").
 *
 * A group that is undefined never matches anything. Group names are compared
 * the way `expandMonorepo` decided for that container: it persists the trust
 * it computed as `groupTrusted` on the container's state entry, and a trusted
 * container compares exactly, an untrusted one ignoring case. A container with
 * no such field (legacy, or folder-dropped) compares ignoring case when GATING
 * (refuse more) and exactly when something DESTRUCTIVE asks (`childrenOf`), so
 * a doubt never widens a take-down. A child that matches a trusted container
 * exactly belongs to it alone: an untrusted container's case-insensitive reading
 * cannot reach it, so `ezsign` and `EzSign` never cross.
 *
 * `via` names the other app whose record is the cause. Only a `record` reason
 * ever has one.
 *
 * The state and config services default to the platform singletons (a missing
 * one answers from the app's own record alone) and are overridden only in tests.
 */

import { getSuspensionStore } from '../managers/suspension';
import type { SuspensionStore, SuspensionRefusal } from '../managers/suspension';
import { getStateManager } from '../managers/app/state-manager';
import type { AppStateManager } from '../managers/app/state-manager';
import { getAppConfigServiceOrNull } from '../managers/app/app-config';
import type { AppConfigService } from '../managers/app/app-config';

/** Why an app is refused: the reason, and the OTHER app whose record it is, if any. */
export interface SuspensionVerdict {
  reason: SuspensionRefusal;
  via?: string;
}

/**
 * Why a start was cut short, which decides the status text and what to do with
 * an instance that is still live (see the platform's settleRefusedStart).
 * `stopped` is the user-stop cause the closer is shaped for.
 */
export type StartRefusalCause =
  | { kind: 'suspended'; reason: SuspensionRefusal; via?: string }
  | { kind: 'stopped'; error?: string };

/** Thrown by a gate that refuses a start, carrying the cause the closer settles by. */
export class StartRefused extends Error {
  constructor(
    readonly appName: string,
    readonly cause: StartRefusalCause
  ) {
    super(
      cause.kind === 'stopped'
        ? `Application '${appName}' was stopped`
        : `Starting '${appName}' is refused (${cause.reason}${cause.via ? `, via '${cause.via}'` : ''})`
    );
    this.name = 'StartRefused';
  }
}

/**
 * The deploy-episode code for a refused start. ONE rule for every surface that
 * closes an episode on a refusal. `replaced` says whether the old version was
 * already taken away; `live` what the closer saw of the runtime (`null`: nobody
 * looked, or it could not be read). Both are required so no caller can forget:
 *  - an administrator's record, or a user stop, is DEPLOY_STOPPED;
 *  - otherwise (the store merely cannot answer) it is DEPLOY_STOPPED only when
 *    the old version was replaced AND nothing is live now;
 *  - otherwise nobody stopped anything and the old instance may still be
 *    serving, so it is a refusal: DEPLOY_REFUSED.
 */
export function refusalEpisodeCode(
  cause: StartRefusalCause,
  stage: { replaced: boolean; live: boolean | null }
): 'DEPLOY_STOPPED' | 'DEPLOY_REFUSED' {
  if (cause.kind === 'stopped' || cause.reason === 'record') return 'DEPLOY_STOPPED';
  return stage.replaced && stage.live === false ? 'DEPLOY_STOPPED' : 'DEPLOY_REFUSED';
}

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
type Use = 'gate' | 'destructive';

const exact: NameMatch = (x, y) => x !== undefined && x === y;
const ignoringCase: NameMatch = (x, y) => x !== undefined && y !== undefined && x.toLowerCase() === y.toLowerCase();

/** How `container` compares group names for this use (see the module doc). */
function sameNameFor(container: string, use: Use, deps: SuspensionPolicyDeps): NameMatch {
  const trusted = deps.state?.getApp(container)?.groupTrusted;
  if (trusted === true) return exact;
  if (trusted === false) return ignoringCase;
  return use === 'destructive' ? exact : ignoringCase;
}

function isStateContainer(name: string, deps: SuspensionPolicyDeps): boolean {
  return deps.state?.getApp(name)?.isGroupContainer === true;
}

/** Whether `name` has children stamped with it but no state entry of its own: a folder-dropped container. */
function isFolderDroppedContainer(name: string, deps: SuspensionPolicyDeps): boolean {
  if (!deps.state || deps.state.getApp(name)) return false;
  return (deps.configs?.getAllConfigs() ?? []).some((config) => config.groupContainer === name);
}

function isContainer(name: string, deps: SuspensionPolicyDeps): boolean {
  return isStateContainer(name, deps) || isFolderDroppedContainer(name, deps);
}

/** An app's groups: the config's and the state's, whichever are defined. */
function groupsOf(name: string, deps: SuspensionPolicyDeps): string[] {
  const groups = [deps.configs?.getConfig(name)?.group, deps.state?.getApp(name)?.group];
  return [...new Set(groups.filter((g): g is string => typeof g === 'string' && g !== ''))];
}

function groupOfContainer(container: string, deps: SuspensionPolicyDeps): string | undefined {
  return deps.state?.getApp(container)?.group || deps.configs?.getConfig(container)?.group || undefined;
}

function allNames(deps: SuspensionPolicyDeps): string[] {
  const names = new Set<string>();
  for (const app of deps.state?.getAllApps() ?? []) names.add(app.name);
  for (const config of deps.configs?.getAllConfigs() ?? []) names.add(config.name);
  return [...names];
}

/** The CONTAINERS `name` is a member of (never `name` itself, never when `name` is one). */
function containersOf(name: string, use: Use, deps: SuspensionPolicyDeps): string[] {
  if (!deps.state || isStateContainer(name, deps)) return [];
  const groups = groupsOf(name, deps);
  const found = new Map<string, { exactly: boolean; trusted: boolean }>();
  const add = (container: string, exactly: boolean): void => {
    found.set(container, { exactly, trusted: deps.state?.getApp(container)?.groupTrusted === true });
  };
  const stamp = deps.configs?.getConfig(name)?.groupContainer;
  if (stamp && stamp !== name) {
    const entry = deps.state.getApp(stamp);
    if (!entry) {
      // No state entry at all: a folder-dropped (or unregistered) container. Nothing to compare.
      add(stamp, false);
    } else if (entry.isGroupContainer) {
      // For THAT group: with no group to compare (a child mid-materialisation) the
      // stamp stands, because "cannot tell" must not read as "not a member".
      const group = groupOfContainer(stamp, deps);
      const same = sameNameFor(stamp, use, deps);
      if (groups.length === 0 || groups.some((g) => same(group, g))) add(stamp, groups.some((g) => exact(group, g)));
    }
    // A state entry that is not a container: the stamp is stale and names nothing.
  }
  for (const app of deps.state.getAllApps()) {
    if (!app.isGroupContainer || app.name === name || app.group === undefined) continue;
    const same = sameNameFor(app.name, use, deps);
    if (groups.some((g) => same(app.group, g))) add(app.name, groups.some((g) => exact(app.group, g)));
  }
  // A child that matches a TRUSTED container exactly is that container's alone.
  const exactlyTrusted = [...found].filter(([, v]) => v.trusted && v.exactly);
  return (exactlyTrusted.length > 0 ? exactlyTrusted : [...found]).map(([container]) => container);
}

/** Whether `group`'s exact spelling belongs to a trusted container other than `except`. */
function exactlyHeldByOtherTrusted(group: string | undefined, except: string, deps: SuspensionPolicyDeps): boolean {
  if (group === undefined) return false;
  return (deps.state?.getAllApps() ?? []).some(
    (app) => app.isGroupContainer && app.groupTrusted === true && app.name !== except && app.group === group
  );
}

/** The members of container `container`, by the same attribution `refusalForApp`'s rule 2 uses. */
function membersOf(container: string, use: Use, deps: SuspensionPolicyDeps): string[] {
  if (!isContainer(container, deps)) return [];
  return allNames(deps).filter((name) => name !== container && containersOf(name, use, deps).includes(container));
}

/**
 * Why a start or build of the app must be refused, or null. Synchronous (the
 * store, state and config services all answer from memory), so it can sit
 * directly in front of an irreversible step with nothing awaited between.
 */
export function refusalForApp(name: string, deps: SuspensionPolicyDeps = defaultDeps()): SuspensionVerdict | null {
  const own = deps.store.refusalFor(name);
  if (own) return { reason: own };
  for (const container of containersOf(name, 'gate', deps)) {
    if (deps.store.refusalFor(container) === 'record') return { reason: 'record', via: container };
  }
  for (const member of membersOf(name, 'gate', deps)) {
    if (deps.store.refusalFor(member) === 'record') return { reason: 'record', via: member };
  }
  return null;
}

/**
 * The apps that run under `container`: exactly those `refusalForApp` would
 * refuse on its record (rule 2), read the cautious way for something that
 * DESTROYS (see the module doc). Empty unless `container` is a container, so an
 * ordinary app, or a stale name, has none.
 */
export function childrenOf(container: string, deps: SuspensionPolicyDeps = defaultDeps()): string[] {
  return membersOf(container, 'destructive', deps);
}

/**
 * What a container's expansion asks before it creates or overwrites anything:
 * `repoName` is about to expand `group`, with the `trusted` decision it just
 * made. Asked by GROUP because a folder-dropped container is not in state, so
 * the container-keyed rules cannot see it.
 *  - `verdict`: a record held by a member of the group (a renamed service must
 *    not escape it), or a record that IS the group's name (the children would
 *    be served on that app's host);
 *  - `newGroupConflict`: the latter with no members yet, i.e. a naming conflict
 *    for a group that does not exist, not a suspension of the owner's own group.
 */
export function refusalForExpansion(
  repoName: string,
  group: string,
  trusted: boolean,
  deps: SuspensionPolicyDeps = defaultDeps()
): { verdict: SuspensionVerdict | null; newGroupConflict: boolean } {
  const same = trusted ? exact : ignoringCase;
  const members = new Set<string>();
  for (const app of deps.state?.getAllApps() ?? []) {
    if (!app.isGroupContainer && same(app.group, group)) members.add(app.name);
  }
  for (const config of deps.configs?.getAllConfigs() ?? []) {
    if (!deps.state?.getApp(config.name)?.isGroupContainer && same(config.group, group)) members.add(config.name);
  }
  members.delete(repoName);
  const mine = [...members].filter((m) => !groupsOf(m, deps).every((g) => exactlyHeldByOtherTrusted(g, repoName, deps)));
  for (const member of mine) {
    if (deps.store.refusalFor(member) === 'record') return { verdict: { reason: 'record', via: member }, newGroupConflict: false };
  }
  const named = deps.store.list().find((r) => ignoringCase(r.name, group) && !ignoringCase(r.name, repoName));
  if (named) return { verdict: { reason: 'record', via: named.name }, newGroupConflict: mine.length === 0 };
  return { verdict: null, newGroupConflict: false };
}

/**
 * Who may route each hostname under `domainSuffix` through a drop.yaml
 * `domains:` entry, for the hosts someone already holds that the per-app owner
 * map does not list. Host (lower-cased) to the app names allowed to use it:
 *  - `<group>.<suffix>` ALWAYS belongs to its group's container and members,
 *    suspended or not (a group's host is nobody's config entry, so any other
 *    tenant's `domains:` could otherwise take it). Each config's group counts,
 *    so it stays claimed after the members' state entries are gone;
 *  - `<recordName>.<suffix>` belongs to the record: it outlives the app, and a
 *    deleted app's name reads as free.
 * Record claims come from `store.list()`, which is empty while the store is
 * unreadable: a corrupt store claims nothing and so withdraws no route.
 */
export function hostClaims(domainSuffix: string, deps: SuspensionPolicyDeps = defaultDeps()): Map<string, Set<string>> {
  const claims = new Map<string, Set<string>>();
  const add = (label: string, holder: string): void => {
    const host = `${label}.${domainSuffix}`.toLowerCase();
    if (!claims.has(host)) claims.set(host, new Set());
    claims.get(host)!.add(holder);
  };
  for (const name of allNames(deps)) {
    for (const group of groupsOf(name, deps)) add(group, name);
    const stamp = deps.configs?.getConfig(name)?.groupContainer;
    if (stamp) for (const group of groupsOf(name, deps)) add(group, stamp);
  }
  for (const record of deps.store.list()) add(record.name, record.name);
  return claims;
}

/**
 * Whether `appName` may route `entry` (a `domains:` entry) given `claims`:
 * refused when the host is claimed by others, or when it is a wildcard
 * (`*.rest`) that expands, by one label, to a host claimed by others.
 */
export function claimedAgainst(claims: Map<string, Set<string>>, entry: string, appName: string): boolean {
  const host = entry.toLowerCase();
  const held = (h: string): boolean => {
    const holders = claims.get(h);
    return !!holders && !holders.has(appName);
  };
  if (!host.startsWith('*.')) return held(host);
  const rest = host.slice(1); // ".rest"
  for (const claimed of claims.keys()) {
    const label = claimed.endsWith(rest) ? claimed.slice(0, claimed.length - rest.length) : '';
    if (label !== '' && !label.includes('.') && held(claimed)) {
      return true;
    }
  }
  return false;
}
