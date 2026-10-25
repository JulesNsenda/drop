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
  DependencySettle,
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

/**
 * Cap on the `command` carried in a build:failed payload. The command is
 * DROP-composed, but an app's drop.yaml `build` is app-authored and
 * unbounded, and this value ends up in a persisted deploy row.
 */
const MAX_FAILED_COMMAND_CHARS = 512;

const truncateCommand = (cmd?: string): string | undefined =>
  cmd === undefined ? undefined : cmd.slice(0, MAX_FAILED_COMMAND_CHARS);

/**
 * Where the pre-build stage leaves the handle its strategy's dependency step
 * returned. A stage that throws is turned into a failed result by executeStage,
 * so the handle has to be captured outside the stage's return value.
 */
interface DependencyStepRef {
  settle?: DependencySettle;
}

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

    // Generate a build ID up front: the NO_STRATEGY path below needs it to
    // report a failure, and it must match the one used for the rest of the run.
    const buildId = `build-${context.appName}-${Date.now()}`;

    // One build per app. The dependency step parks a tree in a slot that the next
    // build's sweep deletes as a leftover, and its aside root is per APP, so two
    // overlapping builds of one app would delete each other's only copy of the
    // old dependencies (the platform's appsInProgress is the first line of
    // defense; this is the backstop). Like the cap below, a refusal emits NO
    // events and runs before any dependency step: it is not THIS build's failure.
    if (this.activeBuilds.has(context.appName)) {
      return this.createFailedResult(
        startedAt,
        [{ stage: 'pre-build', message: 'A build of this app is already running', code: 'BUILD_IN_PROGRESS' }],
        []
      );
    }

    // Check concurrent build limit.
    // Deliberately emits NO events: this is a DEFERRAL, not a failure — the
    // platform re-queues the app (see handleBuildApp's MAX_BUILDS branch) and
    // the retry opens its own episode. Publishing build:started here would
    // leave an episode that only ever derives as 'superseded', and publishing
    // build:failed would report a queue wait as a failed deploy.
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
      // Terminal failure, so it MUST open and close a deploy episode. Returning
      // here without publishing left DeployTracker with nothing to correlate:
      // the caller's later setAppStatus('errored') hit handleAppUpdated's
      // orphan guard and no-opped, so no episode ever closed and every MCP
      // deploy tool polled for its full wait budget (~120s) before reporting
      // "still building". Reachable today: drop.yaml accepts `type: rust` and
      // `type: php` (manifest.ts), neither of which has a build strategy.
      eventBus.publish('build:started', {
        appId: context.appName,
        buildId,
        deployId: context.deployId,
      });

      const noStrategy: BuildError = {
        stage: 'pre-build',
        message: `No build strategy found for type: ${context.appType}`,
        code: 'NO_STRATEGY',
      };

      eventBus.publish('build:failed', {
        appId: context.appName,
        buildId,
        error: new Error(noStrategy.message),
        deployId: context.deployId,
        stage: noStrategy.stage,
        code: noStrategy.code,
      });

      return this.createFailedResult(startedAt, [noStrategy], []);
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

    // Emit build started event
    eventBus.publish('build:started', {
      appId: context.appName,
      buildId,
      deployId: context.deployId,
    });

    try {
      // The strategy's dependency step hands back a handle (stage pre-build);
      // this method is its one owner and settles it in the finally below.
      const dependencyStep: DependencyStepRef = {};
      let stagesRan = false;
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
            abortController.signal,
            dependencyStep
          );

          stages.push(stageResult);

          if (stageResult.status === 'failed') {
            errors.push({
              stage,
              message: stageResult.error || 'Stage failed',
              exitCode: stageResult.exitCode,
              command: stageResult.command,
            });

            // Stop on failure
            break;
          }
        }
        stagesRan = true;
      } finally {
        // Settled BEFORE the completion/failure events below: a subscriber that
        // starts the app on build:completed must see the finished tree, and a
        // failed deploy must see the restored one. Commit when every stage
        // passed and the build was not cancelled; a failed, thrown or cancelled
        // build rolls back, which is a no-op when nothing was parked. A
        // cancelled build is a FAILED one (not a success on the old tree): some
        // stages (the drop.yaml hooks, validate) ignore the signal and would
        // otherwise run to a "success" whose tree was just rolled back. A
        // successful build whose install was SKIPPED after a move still commits:
        // nodejs only skips over a tree that reads `match` after the hooks (one a
        // hook restored), and a static site that turned out pre-built never loads
        // node_modules, so putting the stale tree back would undo a correct build.
        const cancelled = abortController.signal.aborted;
        if (stagesRan && errors.length === 0 && cancelled) {
          errors.push({
            stage: activeBuild.currentStage ?? 'pre-build',
            message: 'Build cancelled',
            code: 'CANCELLED',
          });
        }
        await this.settleDependencyStep(
          context,
          dependencyStep.settle,
          stagesRan && errors.length === 0 && !cancelled
        );
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
        outputPath: outputPath ?? undefined,
        deployId: context.deployId,
      });
      if (!success) {
        eventBus.publish('build:failed', {
          appId: context.appName,
          buildId,
          error: new Error(errors[0]?.message || 'Build failed'),
          deployId: context.deployId,
          // The stage was known here all along and simply never left the
          // builder — this is Gap A.
          stage: errors[0]?.stage ?? 'build',
          exitCode: errors[0]?.exitCode,
          command: truncateCommand(errors[0]?.command),
          code: errors[0]?.code,
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
        deployId: context.deployId,
        code: 'EXCEPTION',
        // Whatever stage was running when it threw. activeBuild.currentStage is
        // null only before the loop's first iteration, i.e. still pre-build.
        stage: activeBuild.currentStage ?? 'pre-build',
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
    signal: AbortSignal,
    dependencyStep: DependencyStepRef
  ): Promise<BuildStageResult> {
    const startTime = Date.now();

    try {
      switch (stage) {
        case 'pre-build':
          return await this.executePreBuild(context, strategy, startTime, dependencyStep);

        case 'environment':
          return await this.executeEnvironment(context, startTime);

        case 'install':
          return await this.executeInstall(context, strategy, signal, startTime, dependencyStep);

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
    startTime: number,
    dependencyStep: DependencyStepRef
  ): Promise<BuildStageResult> {
    // The dependency step comes first: a drop.yaml hook must not run against a
    // tree the strategy is about to replace. Its handle is settled by build().
    if (strategy.prepareDependencies) {
      dependencyStep.settle = (await strategy.prepareDependencies(context)) ?? undefined;
    }

    // Execute custom pre-build hooks
    if (context.config.preBuild?.length) {
      const exec = context.execCommand ?? executeCommand;
      for (const hook of context.config.preBuild) {
        const result = await exec(hook, context.appPath, context.env);
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
    // Merge environment variables.
    //
    // `process.env` is deliberately NOT merged in here. It used to be, and that
    // silently defeated the platform's only secret boundary: `sanitizeBuildEnv`
    // strips DROP_*/AWS_*/CF_* out of the parent env and then spreads the
    // caller's overrides back on top — so seeding `context.env` from
    // `process.env` laundered every stripped secret straight back into the
    // environment handed to tenant-authored install/build commands, on BOTH the
    // host and container runners. `DROP_MASTER_KEY` (the passphrase for every
    // app's encrypted secrets), the GitHub webhook secret and the DNS API
    // tokens were all reachable from a one-line `postinstall`.
    //
    // Nothing is lost by dropping it: the parent env (PATH, SystemRoot,
    // proxies, npm_config_*, …) is still supplied — filtered — by
    // `sanitizeBuildEnv` at the point each command is actually executed. What
    // remains here is exactly what SHOULD be an override: the app's own
    // drop.yaml `env`/`build_env`, its depends_on URLs, and NODE_ENV.
    const env = {
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
    startTime: number,
    dependencyStep: DependencyStepRef
  ): Promise<BuildStageResult> {
    const installCommand = strategy.getInstallCommand(context);

    if (!installCommand) {
      return this.createSkippedResult('install', startTime);
    }

    this.emitLog(context.appName, 'install', 'info', `Running: ${installCommand}`, context);

    // Builds need the dev toolchain (tsc/vite/webpack are devDependencies). NODE_ENV=production
    // (forced by executeEnvironment for the compile, and/or set via the app's drop.yaml env) makes npm
    // omit devDependencies, so the build step can't find its compiler. Force dev deps in for INSTALL
    // only; the build/compile stage keeps context.env (NODE_ENV=production) so output stays a production
    // bundle. sanitizeBuildEnv (base.ts) preserves npm_config_*; npm>=7 include=dev overrides the omit.
    const installEnv = { ...context.env, npm_config_include: 'dev' };

    // The install really runs from here (not for a skipped one): the dependency
    // step re-checks what the drop.yaml hooks left behind, and so decides
    // whether this install may be stamped.
    await dependencyStep.settle?.beforeInstall();

    const exec = context.execCommand ?? executeCommand;
    const result = await exec(
      installCommand,
      context.appPath,
      installEnv,
      signal,
      (data, type) => {
        this.emitLog(context.appName, 'install', type === 'stderr' ? 'warn' : 'info', data, context);
      }
    );

    if (result.exitCode !== 0) {
      return {
        stage: 'install',
        status: 'failed',
        duration: result.duration,
        output: result.stdout,
        error: result.stderr || `Install failed with exit code ${result.exitCode}`,
        exitCode: result.exitCode,
        command: installCommand,
      };
    }

    // Only a successful install may persist install-skip markers (lockfile
    // hash). Persisting earlier lets a failed install mark its lockfile as
    // "installed", and every later build then skips install into a missing or
    // broken node_modules. The marker is a pure perf optimization, so a
    // failure here must never fail the (already successful) install — worst
    // case the next build re-installs.
    try {
      await strategy.postInstall?.(context, dependencyStep.settle);
    } catch (err) {
      this.emitLog(
        context.appName,
        'install',
        'warn',
        `postInstall skipped: ${err instanceof Error ? err.message : String(err)}`,
        context
      );
    }

    return {
      stage: 'install',
      status: 'success',
      duration: result.duration,
      output: result.stdout,
    };
  }

  /**
   * Settle the handle the strategy's dependency step returned: commit when the
   * build as a whole succeeded, roll back otherwise. A failure is logged as a
   * generic warning and never replaces the build's own result or error.
   */
  private async settleDependencyStep(
    context: BuildContext,
    settle: DependencySettle | undefined,
    commit: boolean
  ): Promise<void> {
    if (!settle) return;
    try {
      await (commit ? settle.commit() : settle.rollback());
    } catch {
      this.emitLog(
        context.appName,
        'install',
        'warn',
        commit
          ? 'Could not clean up the previous dependencies.'
          : 'Could not restore the previous dependencies.',
        context
      );
    }
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

    this.emitLog(context.appName, 'build', 'info', `Running: ${buildCommand}`, context);

    const timeout = context.config.timeout || this.config.defaultTimeout;

    try {
      const exec = context.execCommand ?? executeCommand;
      const result = await exec(
        buildCommand,
        context.appPath,
        context.env,
        signal,
        (data, type) => {
          this.emitLog(context.appName, 'build', type === 'stderr' ? 'warn' : 'info', data, context);
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
          exitCode: result.exitCode,
          command: buildCommand,
        };
      }

      return {
        stage: 'build',
        status: 'success',
        duration: result.duration,
        output: result.stdout,
      };
    } catch (error) {
      // A throw (timeout, spawn failure) yields no exit code — but the command
      // is still known and is the more useful of the two for a caller.
      return {
        stage: 'build',
        status: 'failed',
        duration: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Build failed',
        command: buildCommand,
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

    // Execute custom post-build hooks.
    //
    // Routed through `context.execCommand` like preBuild/install/build above —
    // this was the one hook site still calling `executeCommand` directly, i.e.
    // on the host regardless of isolation. Not currently reachable (nothing
    // populates `config.postBuild`: platform.ts passes only buildCommand and
    // installCommand, and drop.yaml has no such key), so this is closing the
    // hole before it opens rather than fixing a live one — but the day
    // `postBuild` is wired to drop.yaml it would otherwise be a silent host
    // escape for a tenant-authored command.
    if (context.config.postBuild?.length) {
      const exec = context.execCommand ?? executeCommand;
      for (const hook of context.config.postBuild) {
        const result = await exec(hook, context.appPath, context.env);
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
    message: string,
    context?: BuildContext
  ): void {
    const logFn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    logFn(`[build] ${message}`);
    context?.onBuildLog?.(message);
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
