/**
 * What a NEW app may be called, beyond syntax (callers keep their own
 * `isValidAppName`: it differs by path in what it answers).
 *
 * `isNewNameRefused` is the single entry point for the non-monorepo create
 * paths (it adds the folder check and the admin exemption); the monorepo
 * expansion, whose new children follow the same rule under its own trust
 * decision, uses `isNameTaken` underneath. So the rule cannot drift between
 * them.
 */

import * as path from 'path';
import { pathTaken } from '../utils/paths';
import type { AppStateManager } from '../managers/app/state-manager';
import type { AppConfigService } from '../managers/app/app-config';
import { getSuspensionStore } from '../managers/suspension';

/**
 * Every name `isNameTaken` reads from state and configs (app, group, recorded
 * container), for the callers that need the names and not just the verdict.
 */
function recordedNames(
  deps: { stateManager: AppStateManager; appConfigService?: AppConfigService },
  scope: 'apps' | 'all'
): string[] {
  const names: string[] = [];
  for (const app of deps.stateManager.getAllApps()) {
    names.push(app.name);
    if (scope === 'all' && app.group) names.push(app.group);
  }
  for (const config of deps.appConfigService?.getAllConfigs() ?? []) {
    names.push(config.name);
    if (scope === 'all' && config.group) names.push(config.group);
    if (scope === 'all' && config.groupContainer) names.push(config.groupContainer);
  }
  return names;
}

/**
 * Existing names that equal `name` ignoring case but are not spelled exactly
 * like it. The suspension store matches ignoring case, so suspending or lifting
 * `name` would act on these too. `scope` 'apps' is the names the store's refusal
 * acts on (state and config app names); 'all' adds the group and container names
 * `isNameTaken` also guards. A tenant-authored group name must never block a
 * suspension, so suspend and unsuspend ask for 'apps'.
 */
export function caseVariantsOf(
  name: string,
  deps: { stateManager: AppStateManager; appConfigService?: AppConfigService },
  scope: 'apps' | 'all'
): string[] {
  const wanted = name.toLowerCase();
  return [...new Set(recordedNames(deps, scope))].filter((n) => n !== name && n.toLowerCase() === wanted);
}

/**
 * Whether `name` is already spoken for: equal, ignoring case, to an existing
 * app, a group (state or config), or a recorded `groupContainer`. Case-
 * insensitive because hostnames are; groups and containers because a group
 * name is an identity (it decides teardown and which OAuth resource an app
 * resolves to), and a deleted container's name lives on in its surviving
 * children's stamps.
 *
 * A name with a suspension record (matched ignoring case) is taken too, even
 * when no app holds it any more: the record outlives the app, and a variant
 * created later would strand the record, since suspend and unsuspend refuse a
 * name that collides in case with another app. With the suspension store
 * unreadable, every name is taken (fail closed).
 *
 * Fails CLOSED: with no config service the recorded names cannot be read, and
 * "nothing recorded" must not read as "free".
 *
 * `ownGroup` is for a monorepo container asking about one of ITS children: an
 * app of EXACTLY that name that is already in that group is the child itself,
 * not a rival. A case-variant, even of its own group, still counts (it is the
 * same hostname), as do groups and recorded containers.
 */
export function isNameTaken(
  name: string,
  deps: { stateManager: AppStateManager; appConfigService?: AppConfigService; ownGroup?: string }
): boolean {
  if (!deps.appConfigService) return true;
  // An unreadable suspension store cannot say which names it holds. (An UNLOADED one is not
  // treated the same: it is an early-boot state, and every test that never loads it would refuse.)
  if (getSuspensionStore().refusalFor(name) === 'store-unreadable') return true;
  const wanted = name.toLowerCase();
  const same = (other: string | undefined): boolean => other?.toLowerCase() === wanted;
  const own = deps.ownGroup?.toLowerCase();
  const isOwnChild = (entryName: string, group: string | undefined): boolean =>
    own !== undefined && entryName === name && group?.toLowerCase() === own;
  let ownChildExists = false;
  for (const app of deps.stateManager.getAllApps()) {
    if ((same(app.name) && !isOwnChild(app.name, app.group)) || same(app.group)) return true;
    if (same(app.name)) ownChildExists = true;
  }
  for (const config of deps.appConfigService.getAllConfigs()) {
    if (
      (same(config.name) && !isOwnChild(config.name, config.group)) ||
      same(config.group) ||
      same(config.groupContainer)
    ) {
      return true;
    }
    if (same(config.name)) ownChildExists = true;
  }
  // The container's own existing child keeps its (possibly suspended) name.
  return !ownChildExists && getSuspensionStore().list().some((record) => same(record.name));
}

/**
 * The one answer to "may this caller create an app called `name`?", for every
 * create path that is not a monorepo expansion (upload preflight, the upload
 * service's two backstops, git deploy). True means refuse.
 *
 * A folder already holding the name counts (`pathTaken`: a dangling link or a
 * plain file too), because "not in state" is not "free": a folder-dropped app
 * is never in state. Admins, and callers with no account at all (auth off),
 * are trusted to adopt a folder they dropped and to name things as they like,
 * so they are never refused here; pass `callerIsAdmin: true` for either.
 *
 * The monorepo expansion asks `isNameTaken` directly, with its own trust
 * decision (see `containerTrusted` in platform.ts).
 */
export async function isNewNameRefused(
  name: string,
  deps: {
    callerIsAdmin: boolean;
    appsDirectory: string;
    stateManager: AppStateManager;
    appConfigService?: AppConfigService;
  }
): Promise<boolean> {
  if (deps.callerIsAdmin) return false;
  if (await pathTaken(path.join(deps.appsDirectory, name))) return true;
  return isNameTaken(name, { stateManager: deps.stateManager, appConfigService: deps.appConfigService });
}
