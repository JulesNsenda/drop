/**
 * The one decision path behind an explicit redeploy (#359), shared by
 * POST /apps/:name/redeploy and the MCP `redeploy_app` tool so the two cannot
 * drift on authorization, git-group resolution or the actor.
 *
 * Callers own only how the answer is rendered: the route turns it into a 202 or
 * an error body, the tool waits for the deploy outcome.
 */

import type { AuthContext } from './middleware/auth';
import { canAccessScoped, tokenCallerOf } from './access';
import { deployActorOf } from './deploy-actor';
import { getStateManager } from '../managers/app/state-manager';
import { resolveGitBackedName } from '../core/git-backed';
import type { PlatformOps, RedeployStart } from './platform-ops';

export type RedeployForResult =
  /** Unknown, foreign or out-of-scope: one answer for all three, naming only the app asked for. */
  | { kind: 'not-found' }
  | { kind: 'unavailable' }
  | {
      kind: 'done';
      /** The app actually redeployed: the git-deployed container when the request named one of its services. */
      target: string;
      /** Taken before the start, so a since-stream or outcome poll cannot miss an episode opened meanwhile. */
      acceptedAt: string;
      result: RedeployStart;
      /** What the activity entry records as the source of the rebuild. */
      detail: 'git' | 'group' | 'files';
    };

export async function redeployFor(
  auth: AuthContext | undefined,
  ops: PlatformOps | null | undefined,
  name: string
): Promise<RedeployForResult> {
  // Authorization first, and a 404 that names only the app the caller asked
  // for. Scoped: an agent token needs app:<name>:deploy for THIS app.
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);
  if (!app || !canAccessScoped(auth, app, name, 'deploy')) return { kind: 'not-found' };

  // A service of a git-deployed group holds no repository: its container does,
  // and a rebuild of the child would only redo a copy the container's next
  // expansion overwrites. The group tag is tenant-influenced, so access is
  // re-checked on the RESOLVED container, and a refusal names only the app asked for.
  let target = name;
  const owner = resolveGitBackedName(app, stateManager);
  if (owner && owner !== name) {
    const container = stateManager.getApp(owner);
    if (!container || !canAccessScoped(auth, container, owner, 'deploy')) return { kind: 'not-found' };
    target = owner;
  }

  if (!ops) return { kind: 'unavailable' };

  // Taken BEFORE the start, so the since-stream cannot miss an episode that
  // opens while the platform is still deciding.
  const acceptedAt = new Date().toISOString();

  // One operation: the platform reserves, admits (with the one actor, for the
  // guardrail keys and the stopped rule alike) and starts.
  const result = await ops.redeployApp(target, deployActorOf(auth), { caller: tokenCallerOf(auth) ?? null });
  const detail = target !== name || app.gitSource ? 'git' : 'group' in result ? 'group' : 'files';
  return { kind: 'done', target, acceptedAt, result, detail };
}
