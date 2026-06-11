/**
 * Builder Service Implementation
 *
 * Orchestrates the build pipeline for applications,
 * managing dependencies, compilation, and artifact generation.
 */

import { eventBus } from '../event-bus';
import {
  BuildContext,
  BuildResult,
  BuildStrategy,
  BuilderConfig,
  BuildStatus,
  BuildStage,
  BuildStageResult,
  BuildError,
  ActiveBuild,
} from './builder.types';
import { executeCommand } from './strategies/base';
import { nodejsBuildStrategy } from './strategies/nodejs';
import { pythonBuildStrategy } from './strategies/python';
import { goBuildStrategy } from './strategies/go';
import { staticBuildStrategy } from './strategies/static';
import { dockerBuildStrategy } from './strategies/docker';

const DEFAULT_CONFIG: BuilderConfig = {
  defaultTimeout: 10 * 60 * 1000, // 10 minutes
  maxConcurrentBuilds: 3,
  cleanupOnFailure: true,
  customStrategies: [],
};

const BUILD_STAGES: BuildStage[] = [
  'pre-build',
  'environment',
  'install',
  'build',
  'optimize',
  'post-build',
  'validate',
];

export class BuilderService {
  private readonly config: BuilderConfig;
  private readonly strategies: BuildStrategy[] = [];
  private readonly activeBuilds: Map<string, ActiveBuild> = new Map();

  constructor(config: Partial<BuilderConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Register built-in strategies
    this.registerBuiltinStrategies();

    // Register custom strategies
    for (const strategy of this.config.customStrategies) {
      this.registerStrategy(strategy);
    }
  }

  /**
   * Build an application
   */
  async build(context: BuildContext): Promise<BuildResult> {
    const startedAt = new Date();
    const stages: BuildStageResult[] = [];
    const errors: BuildError[] = [];
    const warnings: string[] = [];
    let outputPath: string | null = null;

    // Check concurrent build limit
    if (this.activeBuilds.size >= this.config.maxConcurrentBuilds) {
      return this.createFailedResult(
        startedAt,
        [{ stage: 'pre-build', message: 'Maximum concurrent builds reached', code: 'MAX_BUILDS' }],
        []
      );
    }

    // Find appropriate strategy
    const strategy = this.findStrategy(context);
    if (!strategy) {
      return this.createFailedResult(
        startedAt,
        [{ stage: 'pre-build', message: `No build strategy found for type: ${context.appType}`, code: 'NO_STRATEGY' }],
        []
      );
    }

    // Setup abort controller for cancellation
    const abortController = new AbortController();

    // Track active build
    const activeBuild: ActiveBuild = {
      context,
      status: 'running',
      currentStage: null,
      progress: 0,
      startedAt,
      abortController,
    };
    this.activeBuilds.set(context.appName, activeBuild);

    // Generate a build ID
    const buildId = `build-${context.appName}-${Date.now()}`;

    // Emit build started event
    eventBus.publish('build:started', {
      appId: context.appName,
      buildId,
    });

    try {
      // Execute build stages
      for (let i = 0; i < BUILD_STAGES.length; i++) {
        const stage = BUILD_STAGES[i];
        activeBuild.currentStage = stage;
        activeBuild.progress = Math.round((i / BUILD_STAGES.length) * 100);

        // Emit progress
        eventBus.publish('build:progress', {
          appId: context.appName,
          buildId,
          step: stage,
          progress: activeBuild.progress,
          message: `Running ${stage}...`,
        });

        const stageResult = await this.executeStage(
          stage,
          context,
          strategy,
          abortController.signal
        );

        stages.push(stageResult);

        if (stageResult.status === 'failed') {
          errors.push({
            stage,
            message: stageResult.error || 'Stage failed',
          });

          // Stop on failure
          break;
        }
      }

      // Determine output path
      outputPath = strategy.getOutputDirectory(context);

      // Check if build was successful
      const success = errors.length === 0;
      const status: BuildStatus = success ? 'success' : 'failed';

      // Emit completion event (carries success so subscribers don't start a
      // failed build). Also emit build:failed on stage failures so external
      // consumers and the dashboard see the failure, not just exceptions.
      eventBus.publish('build:completed', {
        appId: context.appName,
        buildId,
        durationMs: Date.now() - startedAt.getTime(),
        success,
      });
      if (!success) {
        eventBus.publish('build:failed', {
          appId: context.appName,
          buildId,
          error: new Error(errors[0]?.message || 'Build failed'),
        });
      }

      return {
        success,
        status,
        duration: Date.now() - startedAt.getTime(),
        stages,
        artifacts: outputPath ? [outputPath] : [],
        outputPath,
        errors,
        warnings,
        startedAt,
        completedAt: new Date(),
      };
    } catch (error) {
      const errorObj = error instanceof Error ? error : new Error('Unknown error');

      errors.push({
        stage: activeBuild.currentStage || 'pre-build',
        message: errorObj.message,
        code: 'EXCEPTION',
      });

      eventBus.publish('build:failed', {
        appId: context.appName,
        buildId,
        error: errorObj,
      });

      return this.createFailedResult(startedAt, errors, stages);
    } finally {
      this.activeBuilds.delete(context.appName);
    }
  }

  /**
   * Cancel a running build
   */
  async cancel(appName: string): Promise<void> {
    const activeBuild = this.activeBuilds.get(appName);
    if (activeBuild) {
      activeBuild.abortController.abort();
      activeBuild.status = 'cancelled';
      // Note: build:cancelled event not in event bus types, handled internally
    }
  }

  /**
   * Get the status of a build
   */
  getStatus(appName: string): BuildStatus | null {
    const activeBuild = this.activeBuilds.get(appName);
    return activeBuild?.status ?? null;
  }

  /**
   * Get all active builds
   */
  getActiveBuilds(): Map<string, ActiveBuild> {
    return new Map(this.activeBuilds);
  }

  /**
   * Register a custom build strategy
   */
  registerStrategy(strategy: BuildStrategy): void {
    // Remove existing strategy with same name
    const existingIndex = this.strategies.findIndex(s => s.name === strategy.name);
    if (existingIndex >= 0) {
      this.strategies.splice(existingIndex, 1);
    }

    this.strategies.push(strategy);
  }

  /**
   * Get registered strategies
   */
  getStrategies(): BuildStrategy[] {
    return [...this.strategies];
  }

  /**
   * Get configuration
   */
  getConfig(): BuilderConfig {
    return { ...this.config };
  }

  private registerBuiltinStrategies(): void {
    this.strategies.push(nodejsBuildStrategy);
    this.strategies.push(pythonBuildStrategy);
    this.strategies.push(goBuildStrategy);
    this.strategies.push(staticBuildStrategy);
    this.strategies.push(dockerBuildStrategy);
  }

  private findStrategy(context: BuildContext): BuildStrategy | null {
    for (const strategy of this.strategies) {
      if (strategy.canBuild(context)) {
        return strategy;
      }
    }
    return null;
  }

  private async executeStage(
    stage: BuildStage,
    context: BuildContext,
    strategy: BuildStrategy,
    signal: AbortSignal
  ): Promise<BuildStageResult> {
    const startTime = Date.now();

    try {
      switch (stage) {
        case 'pre-build':
          return await this.executePreBuild(context, strategy, startTime);

        case 'environment':
          return await this.executeEnvironment(context, startTime);

        case 'install':
          return await this.executeInstall(context, strategy, signal, startTime);

        case 'build':
          return await this.executeBuild(context, strategy, signal, startTime);

        case 'optimize':
          return this.createSkippedResult(stage, startTime);

        case 'post-build':
          return await this.executePostBuild(context, strategy, startTime);

        case 'validate':
          return await this.executeValidate(context, strategy, startTime);

        default:
          return this.createSkippedResult(stage, startTime);
      }
    } catch (error) {
      return {
        stage,
        status: 'failed',
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async executePreBuild(
    context: BuildContext,
    strategy: BuildStrategy,
    startTime: number
  ): Promise<BuildStageResult> {
    // Execute custom pre-build hooks
    if (context.config.preBuild?.length) {
      for (const hook of context.config.preBuild) {
        const result = await executeCommand(hook, context.appPath, context.env);
        if (result.exitCode !== 0) {
          return {
            stage: 'pre-build',
            status: 'failed',
            duration: Date.now() - startTime,
            error: `Pre-build hook failed: ${hook}\n${result.stderr}`,
          };
        }
      }
    }

    // Execute strategy pre-build
    if (strategy.preBuild) {
      await strategy.preBuild(context);
    }

    return {
      stage: 'pre-build',
      status: 'success',
      duration: Date.now() - startTime,
    };
  }

  private async executeEnvironment(
    context: BuildContext,
    startTime: number
  ): Promise<BuildStageResult> {
    // Merge environment variables
    const env = {
      ...process.env,
      ...context.config.env,
      ...context.env,
      NODE_ENV: 'production',
    };

    // Update context with merged env
    context.env = env as Record<string, string>;

    return {
      stage: 'environment',
      status: 'success',
      duration: Date.now() - startTime,
    };
  }

  private async executeInstall(
    context: BuildContext,
    strategy: BuildStrategy,
    signal: AbortSignal,
    startTime: number
  ): Promise<BuildStageResult> {
    const installCommand = strategy.getInstallCommand(context);

    if (!installCommand) {
      return this.createSkippedResult('install', startTime);
    }

    this.emitLog(context.appName, 'install', 'info', `Running: ${installCommand}`);

    const result = await executeCommand(
      installCommand,
      context.appPath,
      context.env,
      signal,
      (data, type) => {
        this.emitLog(context.appName, 'install', type === 'stderr' ? 'warn' : 'info', data);
      }
    );

    if (result.exitCode !== 0) {
      return {
        stage: 'install',
        status: 'failed',
        duration: result.duration,
        output: result.stdout,
        error: result.stderr || `Install failed with exit code ${result.exitCode}`,
      };
    }

    return {
      stage: 'install',
      status: 'success',
      duration: result.duration,
      output: result.stdout,
    };
  }

  private async executeBuild(
    context: BuildContext,
    strategy: BuildStrategy,
    signal: AbortSignal,
    startTime: number
  ): Promise<BuildStageResult> {
    const buildCommand = strategy.getBuildCommand(context);

    if (!buildCommand) {
      return this.createSkippedResult('build', startTime);
    }

    this.emitLog(context.appName, 'build', 'info', `Running: ${buildCommand}`);

    const timeout = context.config.timeout || this.config.defaultTimeout;

    try {
      // executeCommand enforces the timeout internally and kills the child
      // process tree on expiry, so a hung build can't leak.
      const result = await executeCommand(
        buildCommand,
        context.appPath,
        context.env,
        signal,
        (data, type) => {
          this.emitLog(context.appName, 'build', type === 'stderr' ? 'warn' : 'info', data);
        },
        timeout
      );

      if (result.exitCode !== 0) {
        return {
          stage: 'build',
          status: 'failed',
          duration: result.duration,
          output: result.stdout,
          error: result.stderr || `Build failed with exit code ${result.exitCode}`,
        };
      }

      return {
        stage: 'build',
        status: 'success',
        duration: result.duration,
        output: result.stdout,
      };
    } catch (error) {
      return {
        stage: 'build',
        status: 'failed',
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Build failed',
      };
    }
  }

  private async executePostBuild(
    context: BuildContext,
    strategy: BuildStrategy,
    startTime: number
  ): Promise<BuildStageResult> {
    // Execute strategy post-build
    if (strategy.postBuild) {
      const outputPath = strategy.getOutputDirectory(context) || '.';
      await strategy.postBuild(context, outputPath);
    }

    // Execute custom post-build hooks
    if (context.config.postBuild?.length) {
      for (const hook of context.config.postBuild) {
        const result = await executeCommand(hook, context.appPath, context.env);
        if (result.exitCode !== 0) {
          return {
            stage: 'post-build',
            status: 'failed',
            duration: Date.now() - startTime,
            error: `Post-build hook failed: ${hook}\n${result.stderr}`,
          };
        }
      }
    }

    return {
      stage: 'post-build',
      status: 'success',
      duration: Date.now() - startTime,
    };
  }

  private async executeValidate(
    context: BuildContext,
    strategy: BuildStrategy,
    startTime: number
  ): Promise<BuildStageResult> {
    if (!strategy.validate) {
      return this.createSkippedResult('validate', startTime);
    }

    const outputPath = strategy.getOutputDirectory(context) || '.';
    const isValid = await strategy.validate(context, outputPath);

    if (!isValid) {
      return {
        stage: 'validate',
        status: 'failed',
        duration: Date.now() - startTime,
        error: 'Build validation failed - output not found',
      };
    }

    return {
      stage: 'validate',
      status: 'success',
      duration: Date.now() - startTime,
    };
  }

  private createSkippedResult(stage: BuildStage, startTime: number): BuildStageResult {
    return {
      stage,
      status: 'skipped',
      duration: Date.now() - startTime,
    };
  }

  private createFailedResult(
    startedAt: Date,
    errors: BuildError[],
    stages: BuildStageResult[]
  ): BuildResult {
    return {
      success: false,
      status: 'failed',
      duration: Date.now() - startedAt.getTime(),
      stages,
      artifacts: [],
      outputPath: null,
      errors,
      warnings: [],
      startedAt,
      completedAt: new Date(),
    };
  }

  private emitLog(
    _appName: string,
    _stage: BuildStage,
    level: 'info' | 'warn' | 'error',
    message: string
  ): void {
    // Log to console for now - build:log event type not in event bus
    const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    logFn(`[build] ${message}`);
  }
}

// Factory function
export function createBuilderService(config?: Partial<BuilderConfig>): BuilderService {
  return new BuilderService(config);
}

// Singleton instance
let builderInstance: BuilderService | null = null;

export function getBuilder(config?: Partial<BuilderConfig>): BuilderService {
  if (!builderInstance) {
    builderInstance = new BuilderService(config);
  }
  return builderInstance;
}

export function resetBuilder(): void {
  builderInstance = null;
}
