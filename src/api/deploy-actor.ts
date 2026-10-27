/**
 * Who is deploying, as the deploy guardrails and the admission rules read it.
 *
 * One helper for the REST routes, the MCP tools and the git route, so the
 * three cannot drift on what an agent is. `agent` is an agent token OR an
 * OAuth session: both are autonomous callers, and an autonomous caller never
 * rebuilds an app a human stopped.
 */

import type { AuthContext } from './middleware/auth';
import type { DeployActorInfo } from '../managers/guardrail/deploy-breaker';

export function deployActorOf(auth: AuthContext | undefined): DeployActorInfo {
  return {
    principalId: auth?.principalId,
    actorUserId: auth?.userId,
    agent: auth?.kind === 'agent' || auth?.authMethod === 'oauth',
  };
}
