/**
 * Git Deploy Type Definitions
 *
 * Types for deploying applications from GitHub repositories.
 */

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
