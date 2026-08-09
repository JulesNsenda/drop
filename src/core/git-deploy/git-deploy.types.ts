/**
 * Git Deploy Type Definitions
 *
 * Types for deploying applications from GitHub repositories.
 */

/**
 * The shape of a stored git token's id, as minted by `GitDeployService.setToken`.
 *
 * Defined once because three layers depend on it agreeing: the REST route
 * validates an incoming `tokenId` against it, the store resolves an id by
 * prefix match, and the dashboard's unit test asserts its sentinels cannot
 * collide with it. A copy in any of those catches a widening only by accident
 * and a narrowing not at all.
 */
export const GIT_TOKEN_ID_RE = /^git_[A-Za-z0-9]+$/;

/** Git source metadata stored per-app */
export interface GitSource {
  repoUrl: string;
  branch: string;
  lastCommitSha?: string;
  lastClonedAt?: string;
  autoRedeploy: boolean;
  tokenId?: string;
}

/** API request to deploy from git */
/**
 * Who asked for a deploy, for guardrail keying only.
 *
 * `automation` is set when DROP triggered the deploy itself and there is no
 * caller at all. It is a separate field rather than "principalId is undefined"
 * because the two must NOT share a bucket: a webhook firing in a loop would
 * otherwise consume the quota of whichever human happens to own the app.
 */
export interface DeployActor {
  principalId?: string;
  userId?: string;
  automation?: 'webhook';
  /**
   * Attach/clear a stored token at redeploy time (DROP-142 — lets an operator
   * recover an app whose repo went public → private). `undefined` (the
   * default, via omission) leaves the stored token unchanged; `null` clears
   * it; a string replaces it. Rides this existing actor rather than a third
   * `redeploy()` parameter — see the arity note on `GitDeployService.redeploy`.
   */
  tokenId?: string | null;
}

export interface GitDeployRequest {
  repoUrl: string;
  branch?: string;
  name?: string;
  autoRedeploy?: boolean;
  tokenId?: string;
  userId?: string;
  /** See UploadDeployRequest.principalId — guardrail keying, not authorization. */
  principalId?: string;
  /** See UploadDeployRequest.agentCaller — server-derived, first creation only. */
  agentCaller?: boolean;
  /** See UploadDeployRequest.ephemeral. */
  ephemeral?: boolean;
  ttlMinutes?: number;
}

/** API request to store a GitHub token */
export interface GitTokenCreateRequest {
  name: string;
  token: string;
}

/** GitHub token metadata (never includes the actual token value) */
export interface GitTokenInfo {
  id: string;
  name: string;
  createdAt: string;
}

/** Git clone options */
export interface GitCloneOptions {
  url: string;
  dest: string;
  branch: string;
  token?: string;
  shallow?: boolean;
}

/** Git deploy result */
export interface GitDeployResult {
  appName: string;
  repoUrl: string;
  branch: string;
  commitSha?: string;
  clonedAt: string;
}
