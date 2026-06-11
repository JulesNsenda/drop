/**
 * Builder Service Type Definitions
 *
 * Types for the build pipeline and build strategies.
 */

import { AppType } from '../detector/detector.types';

/**
 * Build stage names
 */
export type BuildStage =
  | 'pre-build'
  | 'environment'
  | 'install'
  | 'build'
  | 'optimize'
  | 'post-build'
  | 'validate';

/**
 * Build status
 */
export type BuildStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

/**
 * Signature for a command executor injected into BuildContext.
 * Matches the signature of executeCommand in base.ts so callers can
 * swap between the host runner and the container runner transparently.
 */
export type ExecCommandFn = (
  command: string,
  cwd: string,
  env: Record<string, string>,
  signal?: AbortSignal,
  onOutput?: (data: string, type: 'stdout' | 'stderr') => void,
  timeoutMs?: number
) => Promise<CommandResult>;

/**
 * Context provided to the builder
 */
export interface BuildContext {
  appName: string;
  appPath: string;
  appType: AppType;
  framework: string | null;
  config: BuildConfig;
  env: Record<string, string>;
  previousBuild?: BuildResult;
  /**
   * Scratch directory for ephemeral build artifacts (tarballs, generated
   * Dockerfiles, layer caches, …).  Lives outside the watched app dir so the
   * watcher never sees these files and cannot trigger a spurious rebuild.
   * Set by the platform to data/temp/{appName}/ before each build.
   * Strategies that write temp files MUST use this path, not appPath.
   */
  workDir?: string;
  /**
   * Command executor for this build.  When isolation === 'docker', the
   * platform injects a container-based executor; otherwise the builder
   * falls back to executeCommand (the host shell runner).
   *
   * The BuilderService uses `context.execCommand ?? executeCommand`
   * everywhere, so callers that don't care about the distinction get the
   * right behaviour for free.
   */
  execCommand?: ExecCommandFn;
}

/**
 * Build configuration
 */
export interface BuildConfig {
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
  nodeVersion?: string;
  pythonVersion?: string;
  env?: Record<string, string>;
  preBuild?: string[];
  postBuild?: string[];
  timeout?: number;
}

/**
 * Result of a single build stage
 */
export interface BuildStageResult {
  stage: BuildStage;
  status: 'success' | 'failed' | 'skipped';
  duration: number;
  output?: string;
  error?: string;
}

/**
 * Error during build
 */
export interface BuildError {
  stage: BuildStage;
  message: string;
  code?: string;
  details?: string;
}

/**
 * Result of a complete build
 */
export interface BuildResult {
  success: boolean;
  status: BuildStatus;
  duration: number;
  stages: BuildStageResult[];
  artifacts: string[];
  outputPath: string | null;
  errors: BuildError[];
  warnings: string[];
  startedAt: Date;
  completedAt: Date;
}

/**
 * Build progress event payload
 */
export interface BuildProgressEvent {
  appName: string;
  stage: BuildStage;
  progress: number; // 0-100
  message: string;
}

/**
 * Build log event payload
 */
export interface BuildLogEvent {
  appName: string;
  stage: BuildStage;
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: Date;
}

/**
 * Build strategy interface
 */
export interface BuildStrategy {
  name: string;
  supportedTypes: AppType[];

  /**
   * Check if this strategy can build the given context
   */
  canBuild(context: BuildContext): boolean;

  /**
   * Get the install command for this build
   */
  getInstallCommand(context: BuildContext): string | null;

  /**
   * Get the build command for this build
   */
  getBuildCommand(context: BuildContext): string | null;

  /**
   * Get the output directory for build artifacts
   */
  getOutputDirectory(context: BuildContext): string | null;

  /**
   * Execute pre-build setup (e.g., environment setup)
   */
  preBuild?(context: BuildContext): Promise<void>;

  /**
   * Execute post-build tasks (e.g., optimization)
   */
  postBuild?(context: BuildContext, outputPath: string): Promise<void>;

  /**
   * Validate the build output
   */
  validate?(context: BuildContext, outputPath: string): Promise<boolean>;
}

/**
 * Builder service configuration
 */
export interface BuilderConfig {
  /** Default timeout for builds in milliseconds (default: 10 minutes) */
  defaultTimeout: number;
  /** Maximum concurrent builds (default: 3) */
  maxConcurrentBuilds: number;
  /** Whether to clean up on failed builds (default: true) */
  cleanupOnFailure: boolean;
  /** Custom build strategies */
  customStrategies: BuildStrategy[];
}

/**
 * Active build tracking
 */
export interface ActiveBuild {
  context: BuildContext;
  status: BuildStatus;
  currentStage: BuildStage | null;
  progress: number;
  startedAt: Date;
  abortController: AbortController;
}

/**
 * Command execution result
 */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
}
