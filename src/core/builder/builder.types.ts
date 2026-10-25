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
  /**
   * Platform-minted deploy id for the deploy this build belongs to. Carried
   * through onto the build:started/completed/failed payloads so DeployTracker
   * correlates the episode to the same id the caller already knows — rather
   * than minting its own, which nothing upstream could reference.
   *
   * Optional: the builder is callable without one (tests, direct use), and
   * the tracker falls back to minting.
   */
  deployId?: string;
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
   *
   * REQUIRED, though it may be `undefined`. Deliberately not optional: this is
   * the boundary that decides whether a tenant-authored install/build command
   * runs inside the build container or as a host process owned by the platform
   * user (who is in the `docker` group, i.e. root-equivalent, on an
   * isolation=docker box). `handleAppUpdate` once omitted it silently — every
   * redeploy of an existing app therefore built on the host — and nothing
   * caught that because the property was optional. Making it required turns
   * that entire regression class into a compile error at every call site, in
   * every module, instead of something a test has to remember to look for.
   * Pass `execCommand: undefined` explicitly when host execution is intended.
   */
  execCommand: ExecCommandFn | undefined;
  /**
   * Id of the Node toolchain this build installs dependencies with
   * (`node-abi-<modules>-<platform>-<arch>-<libc>`, see core/builder/toolchain.ts).
   * The strategies use it to wipe a `node_modules` built for a different Node
   * before installing, and to stamp the tree after a successful JS install.
   *
   * REQUIRED, though it may be `null`, for the same reason as `execCommand`: a
   * build site that forgets it must be a compile error, not a build that
   * silently reuses a stale-ABI tree. `null` means UNKNOWN (the host probe
   * failed, or the build image has no ABI entry): no wipe and no stamp, i.e.
   * today's behaviour. The platform returns it together with `execCommand` from
   * one helper.
   */
  toolchainId: string | null;
  /**
   * The app's aside ROOT: a platform-owned directory OUTSIDE the app tree and the
   * watcher (`<dropRoot>/data/temp/.node-modules-aside/<app>`; the leading dot
   * cannot be an app name). A build parks a stale node_modules in ITS OWN slot
   * under it (`<root>/<hash of appPath>/parked`, see core/builder/toolchain.ts),
   * and everything else under the root is swept at the start of a build, so the
   * caller must guarantee one build per app at a time. The root need not exist.
   * `undefined` means there is nowhere to park a tree, so one that has to go is
   * removed in place and a failed build cannot put it back.
   *
   * REQUIRED, though it may be `undefined`, like `execCommand` and `toolchainId`:
   * a build site that forgets it must be a compile error, not a build that
   * silently loses the ability to restore. The platform sets it at every build
   * site, from the same helper that returns them.
   */
  nodeModulesAsideDir: string | undefined;
  /**
   * Optional callback for build log lines (install/build output).
   * Called by BuilderService.emitLog() when set. Used by the platform to
   * persist build output to per-deploy log files.
   */
  onBuildLog?: (line: string) => void;
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
  /** Set by nodejs strategy when lockfile hash is unchanged — skips the install stage. */
  skipInstall?: boolean;
  /**
   * Set by the docker strategy in preBuild — the specific Dockerfile/Containerfile
   * or compose file it detected, so validate() can re-check it. Lives on the
   * per-build context (NOT on the strategy instance, which is a shared singleton).
   */
  dockerFile?: string;
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
  /** Process exit code, when this stage ran a command that reported one. */
  exitCode?: number;
  /**
   * The command this stage ran. DROP-generated (composed from the strategy and
   * the app's drop.yaml `build`), never raw process output — so unlike
   * `error`/`output` it is safe to carry into a persisted deploy row.
   */
  command?: string;
}

/**
 * Error during build
 */
export interface BuildError {
  stage: BuildStage;
  message: string;
  code?: string;
  details?: string;
  /** See BuildStageResult.exitCode. */
  exitCode?: number;
  /** See BuildStageResult.command. */
  command?: string;
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
 * What a strategy's dependency step left to settle. The state (a tree parked,
 * whether this build may stamp) is held by the handle object itself (a class
 * private to toolchain.ts), never on the strategy singleton or a module. BuilderService.build() drives it:
 *  - `beforeInstall`: called right before the install command actually runs
 *    (never when the install is skipped), after every drop.yaml hook, so the step
 *    can re-check what the hooks left behind. Never throws.
 *  - `commit`: the whole build succeeded (and was not cancelled); retire what the
 *    step parked. A successful build whose install was SKIPPED also commits.
 *  - `rollback`: anything else (a failed stage, a throw, an abort); put back what
 *    the step parked. A no-op when nothing was parked.
 * `commit` and `rollback` are called at most once, in one `finally`; a throw is
 * logged and never replaces the build's own result.
 */
export interface DependencySettle {
  beforeInstall(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
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
   * The dependency step: runs BEFORE the drop.yaml `preBuild` hooks and before
   * `preBuild`, so a hook never sees a dependency tree that is about to be
   * replaced. A throw fails the build (and nothing it did survives: it must not
   * throw after moving something aside). The handle it returns is owned by
   * BuilderService.build(), which settles it exactly once when the build ends.
   */
  prepareDependencies?(context: BuildContext): Promise<DependencySettle | void>;

  /**
   * Execute pre-build setup (e.g., environment setup)
   */
  preBuild?(context: BuildContext): Promise<void>;

  /**
   * Runs only after a successful (non-skipped) install stage — the place to
   * persist install-skip markers such as the lockfile hash. Never called for
   * failed installs, so a marker can't outlive the install it describes.
   * `deps` is the handle `prepareDependencies` returned for this build, if any.
   * Best-effort: the builder logs and swallows a throw from this hook — it
   * must not be able to fail a build whose install already succeeded.
   */
  postInstall?(context: BuildContext, deps?: DependencySettle): Promise<void>;

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
