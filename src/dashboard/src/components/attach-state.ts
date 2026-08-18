/**
 * Pure attach-state logic for the Database tab's Attach controls (DROP-151
 * Phase 2 dashboard). Extracted into its own `.ts` sibling for the same
 * reason as `db-format.ts` and `../lib/catalog-filter.ts` /
 * `../lib/availability-label.ts`: `src/dashboard` has no test runner of its
 * own, but the root jest project covers plain `.ts` with no JSX/React import.
 * This is the one piece of client logic in the Attach UI that decides what a
 * reader sees and whether a button actually works, so `DatabaseTab.tsx`
 * should do as little deciding as possible and mostly render what these
 * functions return.
 *
 * The dashboard is a separate npm package from the server (see root
 * CLAUDE.md), so this file declares its own copies of the relevant wire
 * shapes (`AttachServiceResult`'s `reason` union, the quota shape) rather
 * than importing `src/api/platform-ops.ts` — keep the two in sync by hand if
 * the server's contract changes.
 */

export type ServiceId = 'postgres' | 'redis';

/** Mirrors `AppConfig['services'][id]` (platform.ts) — the owner's persisted
 * attach/detach intent for one service. A missing key (not the same as an
 * explicit value) means "no explicit intent yet". */
export type ServiceIntent = 'attached' | 'detached';

/** Mirrors `serviceQuotaState`'s return shape (`src/api/routes/db.ts`). */
export interface QuotaState {
  used: number;
  limit: number;
  constrained: boolean;
}

/** Mirrors `AttachServiceResult`'s refusal `reason` union
 * (`src/api/platform-ops.ts`). */
export type AttachRefusalReason =
  | 'ephemeral'
  | 'has-own-database-url'
  | 'has-own-redis-url'
  | 'quota-exceeded'
  | 'no-app-config'
  | 'service-unavailable';

export interface AttachCardInput {
  /**
   * Whether the service is CURRENTLY provisioned — `overview.provisioned`
   * for postgres, `overview.redis.provisioned` for redis. This, not
   * `intent`, is what decides whether the Attach control renders at all
   * (plan correctness finding C5: a persisted 'attached' intent with nothing
   * actually provisioned is not "attached", so the UI must not derive
   * attachment from intent alone — and the converse holds too, a provisioned
   * service is never offered Attach again regardless of intent).
   */
  provisioned: boolean;
  /** The owner's persisted intent (`services[id]`), if the app has one. */
  intent?: ServiceIntent;
  quota: QuotaState;
  role?: 'admin' | 'user' | 'readonly';
}

export type AttachDisabledReason = 'readonly' | 'quota-exceeded';

export interface AttachCardView {
  /** True once the service is actually provisioned — render a status badge,
   * never an Attach control, regardless of what `intent` says. */
  attached: boolean;
  /** Whether the Attach control should be enabled. Always false when
   * `attached` is true. */
  canAttach: boolean;
  /** Why the control is disabled, when it is. Undefined when `attached` or
   * `canAttach` is true. */
  disabledReason?: AttachDisabledReason;
  /** `services[id] === 'detached'` — a real, distinct state from an app that
   * has never had an explicit intent recorded. Only meaningful when
   * `attached` is false; kept even when `attached` is true so a future caller
   * can't accidentally read it as "not detached" for a provisioned app. */
  previouslyDetached: boolean;
  /** Button label — distinguishes "never attached" from "re-attaching after
   * an explicit detach" without the component deciding wording itself. */
  actionLabel: string;
}

/**
 * Render-state for one service's Attach control. `provisioned` is the only
 * input that decides whether a control shows at all — never render Attach
 * for a service that already exists (an app that already has Postgres
 * provisioned must not offer Attach for it). `role` and `quota` decide
 * whether the control that DOES render is enabled, checked in that order so
 * a readonly viewer sees "your role" rather than "quota" when both apply.
 * `intent` only changes wording, distinguishing "never touched" from
 * "explicitly detached before".
 */
export function describeAttachCard(input: AttachCardInput): AttachCardView {
  const previouslyDetached = input.intent === 'detached';

  if (input.provisioned) {
    return {
      attached: true,
      canAttach: false,
      previouslyDetached,
      actionLabel: 'Attach',
    };
  }

  const actionLabel = previouslyDetached ? 'Re-attach' : 'Attach';

  if (input.role === 'readonly') {
    return {
      attached: false,
      canAttach: false,
      disabledReason: 'readonly',
      previouslyDetached,
      actionLabel,
    };
  }

  if (input.quota.constrained && input.quota.used >= input.quota.limit) {
    return {
      attached: false,
      canAttach: false,
      disabledReason: 'quota-exceeded',
      previouslyDetached,
      actionLabel,
    };
  }

  return {
    attached: false,
    canAttach: true,
    previouslyDetached,
    actionLabel,
  };
}

/** `${used} of ${limit} used` — shared by the proactive quota badge (from
 * `GET /db/:name`'s `quota.<service>`) and a `quota-exceeded` refusal's
 * returned numbers (`error.details.quota`), so both read identically. */
export function formatQuotaUsage(quota: { used: number; limit: number }): string {
  return `${quota.used} of ${quota.limit} used`;
}

/**
 * Fallback copy per refusal reason, used only when the server's own
 * `error.message` (`AttachServiceResult['detail']` on the wire) is missing
 * or blank. In the ordinary case that message IS reader-facing text already
 * — unlike the platform-scope `availability` reasons in
 * `../lib/availability-label.ts`, whose route deliberately sends no message
 * at all — so it is shown verbatim rather than re-worded here.
 *
 * Indexed defensively: a reason value the server adds after this bundle was
 * built is a real input a cached dashboard tab can receive, not a
 * hypothetical — the same lesson `availability-label.ts` carries from its own
 * escaped bug (a direct index there threw and blanked the whole card).
 */
const REFUSAL_FALLBACK: Record<AttachRefusalReason, string> = {
  ephemeral: 'This app is ephemeral and cannot have a service attached.',
  'has-own-database-url': 'This app already has its own database connection configured.',
  'has-own-redis-url': 'This app already has its own Redis connection configured.',
  'quota-exceeded': 'The quota for this service has been reached.',
  'no-app-config': 'This app has no saved platform configuration yet.',
  'service-unavailable': 'This service is not available on this platform.',
};

/** User-facing text for a failed `POST /apps/:name/services/:id`. */
export function describeAttachRefusal(
  reason: string | undefined,
  message: string | undefined
): string {
  const trimmed = message?.trim();
  if (trimmed) return trimmed;
  if (reason && Object.prototype.hasOwnProperty.call(REFUSAL_FALLBACK, reason)) {
    return REFUSAL_FALLBACK[reason as AttachRefusalReason];
  }
  return 'Could not attach this service.';
}
