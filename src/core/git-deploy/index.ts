/**
 * Git Deploy Module
 *
 * Public exports for git-based deployment functionality.
 */

export { GitDeployService, getGitDeployService, resetGitDeployService } from './git-deploy';
export {
  gitClone,
  gitPull,
  getCommitSha,
  getCurrentBranch,
  normalizeRepoUrl,
  extractRepoName,
  isValidGitHubUrl,
  isGitAvailable,
} from './git-client';
export type {
  GitSource,
  GitDeployRequest,
  GitDeployResult,
  GitTokenInfo,
  GitTokenCreateRequest,
  GitCloneOptions,
} from './git-deploy.types';
