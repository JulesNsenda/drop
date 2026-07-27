/**
 * DeployTracker Module
 *
 * Exports the DeployTracker class, singleton accessors, and all related types.
 */

export { DeployTracker, getDeployTracker, resetDeployTracker } from './deploy-tracker';

export {
  DeployDetailStore,
  getDeployDetailStore,
  resetDeployDetailStore,
} from './deploy-detail';

export type {
  DeployStageName,
  DeployRow,
  DeployStatus,
  DeployStage,
  DeployEpisode,
  DeployFailureCategory,
} from './deploy-tracker.types';

export type {
  DeployDetail,
  DeployFailurePhase,
  DeployFailureReason,
} from './deploy-detail.types';
