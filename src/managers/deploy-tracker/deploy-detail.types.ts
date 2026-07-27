/**
 * DeployDetail Types
 *
 * The per-deploy diagnostic record that sits alongside DeployTracker's flat
 * milestone rows. Rows answer "what happened, when"; a detail answers "why it
 * failed, specifically".
 *
 * FIELD DISCIPLINE — read before adding one.
 *
 * The plan's Step 2 sketch lists more fields than appear here: `errorCode`,
 * `classificationPending`, `file`, `line`, `hint` (Step 5's classifier) and
 * `principalId` (Step 6's identity). They are deliberately ABSENT rather than
 * present-and-empty, because shipping a documented field whose value is
 * structurally constant is exactly the defect Step 1 removed — `category` was
 * documented as three values while the producer hardcoded one, and
 * `GET /api/v1/deploys` reported a constant as though it discriminated
 * (ARCH-13).
 *
 * The rule: a field with no CONSUMER yet is fine, as long as its VALUE is
 * real. A field whose value cannot yet vary is not. Add each of the above in
 * the step that can actually populate it.
 *
 * Same never-store-a-raw-error-message invariant as DeployRow: every field
 * here is DROP-generated — a stage name, an exit code, a command DROP itself
 * composed, or a closed-set reason. Process output does not land here.
 */

import type { BuildStage } from '../../core/builder/builder.types';
import type { DeployFailurePhase, DeployFailureReason } from '../../core/event-bus/event-bus.types';
import type { DeployErrorCode } from './deploy-error-code';

/**
 * Where this deploy's runtime output starts.
 *
 * Runtime log files are per-app and per-DAY (`<app>-YYYY-MM-DD-{out,err}.log`),
 * shared by every deploy that day, so a file path alone cannot identify one
 * deploy's output. The byte offset recorded immediately before the process
 * started is what separates this deploy's lines from the previous one's.
 */
export interface RuntimeLogOffsets {
  outFile: string;
  errFile: string;
  outStartOffset: number;
  errStartOffset: number;
}

export interface DeployDetail {
  deployId: string;
  appName: string;
  /**
   * Owner snapshot taken when the detail was created, NOT a live lookup.
   * Callers MUST tenant-filter on this snapshot — filtering by a live
   * `getApp(appName).userId` leaks a deleted tenant's history to whoever
   * registers the freed name next. Same rule as DeployEpisode.userId.
   */
  userId?: string;
  /** Which phase the deploy died in. */
  phase: 'build' | 'boot';
  /**
   * Closed-union cause, derived from DROP-generated signals only — never
   * pattern-matched out of process output. `UNKNOWN` is a first-class member:
   * a miss must not change the verdict.
   */
  errorCode: DeployErrorCode;
  /** Build phase only: the stage that failed (from build:failed). */
  stage?: BuildStage;
  /** Build phase only: exit code of the failing command, when it reported one. */
  exitCode?: number;
  /** Build phase only: the failing command, already truncated by the publisher. */
  command?: string;
  /** Boot phase only: closed-set category from deploy:failed. */
  reason?: DeployFailureReason;
  /**
   * Where to start reading this deploy's runtime output. Absent for a build
   * failure — nothing was ever started, so there is no runtime log.
   *
   * CLEARED at teardown. `outFile` is keyed on the APP NAME and teardown frees
   * that name, so leaving the offsets in place would let a retained record
   * resolve to a path the NEXT tenant is now writing to (SEC-3).
   *
   * The plan also specifies copying the bytes into a private, deployId-keyed
   * file so the output survives teardown. That is deliberately NOT done yet —
   * nothing reads it (`get_deploy_logs` is a later step), and writing durable
   * uncapped copies of tenant stdout with no consumer is pure cost. It also
   * would make `?keepData=false` create a fresh copy of output that routinely
   * contains DATABASE_URL and injected secrets, which is both against the
   * user's stated intent and against the invariant below. The copy belongs
   * with its reader.
   */
  runtimeLog?: RuntimeLogOffsets;
  /**
   * When this record may be swept. Set at teardown — a live app's details are
   * kept as long as the app is.
   */
  retainUntil?: string;
  createdAt: string;
}

export type { DeployFailurePhase, DeployFailureReason };
export type { DeployErrorCode } from './deploy-error-code';
