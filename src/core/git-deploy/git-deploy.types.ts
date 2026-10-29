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
  /**
   * Set by the SERVER (never read from a request) when an admin attached a
   * token owned by someone other than the app's owner: the admin's user id.
   * It is what lets that deliberate grant survive the token's owner differing
   * from the app's. Cleared when the token is cleared or replaced.
   */
  tokenGrantedBy?: string;
  /**
   * The app owner the grant was made FOR. The grant is honoured only while the
   * app still has that owner, so a later transfer does not carry it along.
   */
  tokenGrantedFor?: string;
}

/**
 * Who is asking to use or manage a stored git token. Built server-side from
 * the auth context by `tokenCallerOf` (src/api/access.ts), never from a
 * request body, and passed to the service as its own argument rather than
 * riding on a request type a client can fill in. An admin is also the caller
 * when auth is disabled by configuration; `userId` is then absent.
 *
 * `interactive` is true for a signed-in browser session. Choosing a token that
 * someone else owns takes an admin AND an interactive session: an admin API
 * key or agent token may use only its own tokens.
 */
export type TokenCaller =
  | { admin: true; userId?: string; interactive: boolean }
  | { admin: false; userId: string };

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
   * it; a string replaces it. WHO may choose a token is decided from the
   * `TokenCaller` passed to `redeploy()`, not from anything on this object.
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
  /** See UploadDeployRequest.callerIsAdmin — server-derived from the credential, never the body. */
  callerIsAdmin?: boolean;
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
  /**
   * Owning user id. Reported only in an admin's view of the list; absent for a
   * legacy token that predates ownership (admin-only until an owner is assigned).
   */
  ownerUserId?: string;
  /** The owner's username, admin view only; absent when the account no longer resolves. */
  ownerName?: string;
}

/** Git clone options */
export interface GitCloneOptions {
  url: string;
  dest: string;
  branch: string;
  token?: string;
  /**
   * TEST ONLY: also allow the `file` transport. Production is https-only; the
   * suite has no network and clones from a `file://` remote.
   */
  allowFileProtocol?: boolean;
  /**
   * Refuse, BEFORE any file is written, a repository whose tree is larger than
   * this many bytes or has more than `maxEntries` files. The clone is made
   * without a checkout and sized from the tree object (`ls-tree -r -l`), so a
   * huge repository costs a download, not the disk.
   */
  maxBytes?: number;
  maxEntries?: number;
}

/** Git deploy result */
export interface GitDeployResult {
  appName: string;
  repoUrl: string;
  branch: string;
  commitSha?: string;
  clonedAt: string;
}
