/**
 * Structured deploy results for the MCP deploy tools (Step 3).
 *
 * FIELD DISCIPLINE — read before adding a field.
 *
 * PRD-040's rule was "all application output is inside a fence". A structured
 * result INVERTS the trust default: every field here is unfenced, so it reads
 * to a model as trusted tool output rather than as something an app produced.
 * The fence is no longer the boundary — this module's field list is.
 *
 * Therefore every field below is DROP-GENERATED: an enum, a number DROP read
 * from a process, a name DROP composed, or a string from a static table. The
 * one piece of application output, `output_tail`, is passed through
 * `wrapUntrusted` and stays fenced even in here.
 *
 * Three specific traps this exists to avoid:
 *
 *  - `command` is NOT the command line. A tenant's drop.yaml `build:` override
 *    is attacker-authored text, and putting it in a trusted field would let an
 *    app write instructions the model reads as DROP's own. It is an enum
 *    derived from the failing stage; the literal command stays inside the
 *    fenced tail.
 *  - `hint` is a lookup in a static table keyed off `error_code`. NEVER
 *    interpolated from output, and there is a test asserting the table's
 *    values are literals.
 *  - `next_actions` is a closed union of tool-name literals. Never derived
 *    from output, and never carries arguments.
 *
 * `file` and `line` come from the log classifier, which validates them at the
 * point of extraction — `path.relative` alone does NOT make an extracted path
 * safe, so `classify.ts` additionally requires an allowlist match. Absent
 * whenever safety could not be proven.
 */

import type { DeployErrorCode } from '../../managers/deploy-tracker';
import type { BuildStage } from '../../core/builder/builder.types';

export type DeployResultStatus =
  | 'succeeded'
  | 'succeeded_unverified'
  | 'failed'
  | 'needs_config'
  | 'in_progress';

/** Closed union of tool names. Never derived from output, never with arguments. */
export type DeployNextAction =
  | 'get_deploy_logs'
  | 'app_logs'
  | 'app_status'
  | 'restart_app'
  | 'list_apps';

/** DROP-generated stand-in for the command line. Never the literal command. */
export type DeployCommandKind = 'prebuild' | 'install' | 'build' | 'validate';

export interface DeployResult {
  ok: boolean;
  deploy_id?: string;
  app: string;
  status: DeployResultStatus;
  phase?: 'build' | 'boot';
  error_code?: DeployErrorCode;
  stage?: BuildStage;
  exit_code?: number;
  command?: DeployCommandKind;
  /**
   * Relative source path from the classifier. VALIDATED there
   * (`safeRelativePath`) — it is extracted from tenant build output and lands
   * in this unfenced field, so `path.relative` containment alone is NOT
   * sufficient. Absent whenever it could not be proven safe.
   */
  file?: string;
  line?: number;
  hint?: string;
  /** Application output. FENCED — the one untrusted field here. */
  output_tail?: string;
  url?: string;
  next_actions?: DeployNextAction[];
}

/** Failing stage -> command kind. Total, so a new stage is a compile error. */
export function commandKindForStage(stage: BuildStage): DeployCommandKind {
  switch (stage) {
    case 'pre-build':
    case 'environment':
      return 'prebuild';
    case 'install':
      return 'install';
    case 'build':
    case 'optimize':
    case 'post-build':
      return 'build';
    case 'validate':
      return 'validate';
  }
}

/**
 * Static hint table. Every value is a LITERAL — nothing here is interpolated
 * from application output, a filename, or an error message. That is what makes
 * `hint` safe to render unfenced.
 */
const HINTS: Record<DeployErrorCode, string> = {
  NO_STRATEGY:
    'DROP has no build strategy for this app type. Add a drop.yaml with a supported `type`, or a recognized manifest (package.json, requirements.txt, go.mod, Dockerfile, index.html).',
  MAX_BUILDS:
    'The build queue was full, so this deploy was deferred rather than failed. It will be retried automatically.',
  PREBUILD_FAILED:
    'The deploy failed before the build ran — detection, the environment, or drop.yaml parsing. Check the log tail for the specific step.',
  INSTALL_FAILED:
    'Dependency installation failed. The log tail names the failing package; a lockfile out of sync with the manifest is the usual cause.',
  BUILD_FAILED: 'The build command exited non-zero. The log tail has the compiler or bundler output.',
  POSTBUILD_FAILED:
    'The build itself succeeded but a post-build step did not. Output may be incomplete.',
  VALIDATE_FAILED: 'The build produced no usable output in the expected directory.',
  PROCESS_EXITED:
    'The app started and then exited before it was ready. This is almost always a crash at startup — check the runtime logs, not the build log.',
  CRASH_LOOPED:
    'The app restarted repeatedly at startup. A missing environment variable or an unreachable dependency is the usual cause.',
  OOM_KILLED:
    'The kernel killed this app for exceeding its memory limit. Reduce what the app holds in memory, or ask an admin to raise the limit — restarting unchanged will hit the same ceiling. DROP reports this only when the container runtime confirmed it, so it is a fact rather than an inference.',
  INSTALL_MISSING_DEP:
    'A dependency could not be resolved from the registry. Check the package name and version — a typo, a private package, or a version that does not exist are the usual causes.',
  BUILD_TYPE_ERROR:
    'The build failed on a compile or module-resolution error. If a file and line are reported, start there.',
  MIGRATION_FAILED:
    'This looks like a database migration failure. DROP infers this from the log, so treat it as a strong hint rather than a certainty — the migration may have partially applied.',
  UNKNOWN:
    'DROP could not classify this failure. The phase, stage and log tail are still accurate.',
};

export function hintFor(code: DeployErrorCode): string {
  return HINTS[code] ?? HINTS.UNKNOWN;
}

/**
 * What a caller should do next. Derived from the phase, never from output.
 *
 * Build failures point at the build log; boot failures point at the RUNTIME
 * log, because the build succeeded and the build log will not contain the
 * crash.
 */
export function nextActionsFor(status: DeployResultStatus, phase?: 'build' | 'boot'): DeployNextAction[] {
  if (status === 'succeeded') return [];
  if (status === 'succeeded_unverified') return ['app_status', 'app_logs'];
  // get_deploy_logs FIRST for any failure: it returns the output of THIS
  // deploy, where app_logs returns whatever the app is doing now — which for a
  // failed deploy is usually nothing, and for a build failure is structurally
  // the wrong log. restart_app stays for a boot failure, where retrying is a
  // plausible next move; it is not, for a build that cannot compile.
  if (phase === 'boot') return ['get_deploy_logs', 'restart_app'];
  return ['get_deploy_logs'];
}
