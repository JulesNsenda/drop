/**
 * Builder Module
 *
 * Exports the BuilderService and related types.
 */

export {
  BuilderService,
  createBuilderService,
  getBuilder,
  resetBuilder,
} from './builder';

// Re-export strategies for customization
export { BaseBuildStrategy, executeCommand } from './strategies/base';
export { nodejsBuildStrategy, NodejsBuildStrategy } from './strategies/nodejs';
export { pythonBuildStrategy, PythonBuildStrategy } from './strategies/python';
export { staticBuildStrategy, StaticBuildStrategy } from './strategies/static';
export { dockerBuildStrategy, DockerBuildStrategy } from './strategies/docker';

export type {
  BuildContext,
  BuildResult,
  BuildConfig,
  BuildStrategy,
  BuilderConfig,
  BuildStatus,
  BuildStage,
  BuildStageResult,
  BuildError,
  ActiveBuild,
  BuildProgressEvent,
  BuildLogEvent,
  CommandResult,
} from './builder.types';
