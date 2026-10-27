/**
 * Who is deploying, as the deploy guardrails and the admission rules read it.
 *
 * `agent` is an agent token OR an OAuth session: both are autonomous callers,
 * and an autonomous caller never rebuilds an app a human stopped.
 *
 * Used by `redeployFor` only, so POST /apps/:name/redeploy and the MCP
 * `redeploy_app` tool agree. It is NOT used for `agentCaller` in the upload,
 * git and MCP `deploy_files` / `deploy_from_git` paths: there the flag decides
 * `agentCreated` on first creation (idle reaper, ephemeral rules), and those
 * paths read `kind === 'agent'` alone, so an OAuth session counts as an agent
 * for a redeploy but not for the ownership flag of an app it creates.
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
