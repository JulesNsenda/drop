/**
 * Deploy error taxonomy.
 *
 * A CLOSED union with `UNKNOWN` as a first-class member, derived purely from
 * signals DROP itself generated — the failing build stage (Step 1), the
 * builder's own error code, and the readiness verdict category (Step 2c).
 * Nothing here is pattern-matched out of process output.
 *
 * `UNKNOWN` is first-class on purpose: a classifier miss must never change the
 * deploy verdict. A caller that cannot name the cause still knows the deploy
 * failed, at which stage, and with what exit code.
 *
 * SCOPE — this is the half of the plan's taxonomy that is derivable today.
 * Deliberately absent, each pending the step that can populate it:
 *   - INSTALL_MISSING_DEP / BUILD_TYPE_ERROR / MIGRATION_FAILED — need the
 *     log-matching classifier (Step 5).
 *   - BUILD_TIMEOUT / BUILD_ABORTED / DISK_FULL / DETECT_FAILED / NEEDS_CONFIG /
 *     CAPACITY_REACHED — reachable, but the failure paths that produce them do
 *     not yet carry a distinguishing signal into build:failed.
 *   - OOM_KILLED / PROBABLE_OOM — Step 8.
 *   - GUARDRAIL_TRIPPED / QUOTA_EXCEEDED — Steps 7 / 8.
 * Adding a member that no producer can reach would be the same
 * unreachable-value defect as a field whose value is a constant.
 *
 * NOTE on RUNTIME_NEVER_ANSWERED, which the plan lists under boot: it is NOT
 * here, because an app that binds but never answers HTTP is not a failure at
 * all — `awaitReadiness` resolves it `{ ok: true, warning }` and it becomes
 * `AppState.readinessUnverified` (DROP-063 leniency). It belongs to the
 * succeeded-unverified projection, not to this taxonomy.
 */

import type { BuildStage } from '../../core/builder/builder.types';
import type { DeployFailureReason } from '../../core/event-bus/event-bus.types';

export type DeployErrorCode =
  // Build phase
  | 'NO_STRATEGY'
  | 'MAX_BUILDS'
  | 'PREBUILD_FAILED'
  | 'INSTALL_FAILED'
  | 'BUILD_FAILED'
  | 'POSTBUILD_FAILED'
  | 'VALIDATE_FAILED'
  // Boot phase
  | 'PROCESS_EXITED'
  | 'CRASH_LOOPED'
  // Fallback
  | 'UNKNOWN';

/** Build-stage → code. Total over BuildStage, so a new stage is a compile error here. */
function codeForStage(stage: BuildStage): DeployErrorCode {
  switch (stage) {
    case 'pre-build':
    case 'environment':
      return 'PREBUILD_FAILED';
    case 'install':
      return 'INSTALL_FAILED';
    case 'build':
      return 'BUILD_FAILED';
    case 'optimize':
    case 'post-build':
      return 'POSTBUILD_FAILED';
    case 'validate':
      return 'VALIDATE_FAILED';
  }
}

/** Readiness verdict → code. Total over DeployFailureReason. */
function codeForReason(reason: DeployFailureReason): DeployErrorCode {
  switch (reason) {
    case 'process-exited':
      return 'PROCESS_EXITED';
    case 'crash-looped':
      return 'CRASH_LOOPED';
  }
}

export interface ErrorCodeInput {
  phase: 'build' | 'boot';
  stage?: BuildStage;
  reason?: DeployFailureReason;
  /** The builder's own BuildError code, when it had one. */
  builderCode?: string;
}

/**
 * Derive the error code. Pure, total, never throws.
 *
 * The builder's own code wins over the stage when it names something the stage
 * cannot: 'pre-build' covers both a genuinely unbuildable app type and any
 * other pre-build failure, and those are very different answers for a caller.
 */
export function deriveErrorCode(input: ErrorCodeInput): DeployErrorCode {
  if (input.builderCode === 'NO_STRATEGY') return 'NO_STRATEGY';
  if (input.builderCode === 'MAX_BUILDS') return 'MAX_BUILDS';

  if (input.phase === 'boot') {
    return input.reason ? codeForReason(input.reason) : 'UNKNOWN';
  }

  // 'EXCEPTION' deliberately falls through to the stage: it says the builder
  // threw rather than a command exiting non-zero, which is a mechanism, not a
  // cause. The stage is the more useful answer.
  return input.stage ? codeForStage(input.stage) : 'UNKNOWN';
}
