/**
 * The name of the git-deployed app an upload to `app` would damage, or
 * `undefined` if it is not git-backed.
 *
 * Returns the app's own name when it carries a `gitSource` directly. For a
 * monorepo child it returns the CONTAINER's name: `expandMonorepo` gives
 * children no `gitSource` of their own — the hidden container holds it — so a
 * check on `gitSource` alone would leave the whole group clobberable by
 * targeting any one child, whose materialized copy the next expansion would
 * overwrite anyway. Mirrors the container resolution in `routes/git-deploy.ts`,
 * which is what "redeploy this child" already means.
 *
 * Shared by the upload route's preflight and the upload service's backstop, so
 * a caller that bypasses or races the route is refused the same way.
 */

import type { AppState, AppStateManager } from '../managers/app/state-manager';

export function resolveGitBackedName(app: AppState, stateManager: AppStateManager): string | undefined {
  if (app.gitSource) return app.name;
  if (!app.group) return undefined;
  return stateManager
    .getAllApps()
    .find((a) => a.isGroupContainer && a.group === app.group && a.gitSource)?.name;
}
