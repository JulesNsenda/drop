/**
 * Git Deploy Module
 *
 * Public exports for git-based deployment functionality.
 */

export {
  GitDeployService,
  getGitDeployService,
  getGitDeployServiceOrNull,
  resetGitDeployService,
  gitCheckoutCaps,
  PlatformNotReadyError,
  deployActorOfInfo,
  publishRedeployUpdate,
} from './git-deploy';
export {
  gitClone,
  configureCloneBase,
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
  TokenCaller,
  GitCloneOptions,
} from './git-deploy.types';
