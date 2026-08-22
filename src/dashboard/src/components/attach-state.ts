/**
 * Pure attach/detach-state logic for the Database tab's backing-service
 * controls (DROP-151 Phase 2 attach + Phase 3 detach dashboard). Extracted
 * into its own `.ts` sibling for the same reason as `db-format.ts` and
 * `../lib/catalog-filter.ts` / `../lib/availability-label.ts`: `src/dashboard`
 * has no test runner of its own, but the root jest project covers plain `.ts`
 * with no JSX/React import. This is the one piece of client logic in the
 * Attach/Detach UI that decides what a reader sees and whether a button
 * actually works, so `DatabaseTab.tsx` should do as little deciding as
 * possible and mostly render what these functions return.
 *
 * The dashboard is a separate npm package from the server (see root
 * CLAUDE.md). `src/api/platform-ops.ts` itself is off-limits — it pulls in
 * `../managers/runtime` (the PM2/Docker adapters) — but its wire-only types
 * live in the zero-import leaf module `src/api/services-wire.types.ts`
 * instead, which this file imports `type`-only for the two refusal-reason
 * unions below (`AttachRefusalReason`, `DetachRefusalReason`): both are
 * plain string-literal unions extractable straight from the server's own
 * types, so there is nothing left to drift. `QuotaState` (no server
 * counterpart exists as an exported type) and `DetachServiceSuccess` (a
 * deliberately FLATTENED, all-optional-fields view of the server's
 * discriminated success union — importing the raw union would require this
 * file's callers to narrow on `deprovisioned` before touching any other
 * field) stay hand-mirrored; `services-wire-contract.test.ts` pins
 * `DetachServiceSuccess` and the restart-outcome union against the server's
 * real types so a hand-mirror drift still fails the suite.
 */

import type { AttachServiceResult, DetachServiceResult } from '../../../api/services-wire.types';

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

/** `AttachServiceResult`'s refusal `reason` union, extracted directly from
 * the server's own type (`src/api/services-wire.types.ts`) rather than
 * hand-copied — see this file's header. */
export type AttachRefusalReason = Extract<AttachServiceResult, { attached: false }>['reason'];

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
  /**
   * Set when `GET /db/:name` reports a stale registry entry for this service
   * — currently only postgres's `database-missing` (the `broken` marker):
   * the database itself is gone, but its
   * credentials — and the quota slot they occupy — are still on record, so
   * `provisioned` reads false even though something real remains to clear.
   * `DELETE /apps/:name/services/:id` still succeeds here (its own
   * `isProvisioned()` check is credentials-based, not liveness-based), so
   * Detach must still render — hiding it left that as the one working repair
   * path with no button to reach it.
   */
  broken?: 'database-missing';
}

export type AttachDisabledReason = 'readonly' | 'quota-exceeded';

export interface AttachCardView {
  /** True once the service is actually provisioned AND nothing is pending —
   * render a status badge, never an Attach control, regardless of what
   * `intent` says. False for a service mid-detach (`detachIncomplete`), even
   * though it is still physically provisioned — see that field's doc. */
  attached: boolean;
  /** Whether the Attach control should be enabled. Always false when
   * `attached` or `detachIncomplete` is true. */
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
  /**
   * True when the service is still provisioned but the owner's last recorded
   * intent is `'detached'` (DROP-151 Phase 3's persist-first design writes
   * intent BEFORE destroying anything, so a detach that fails partway — e.g.
   * a dump timeout — leaves exactly this combination). Deriving `attached`
   * from `provisioned` alone here would render a plain "Attached" badge and
   * hide the only repair affordance, so this gets its own card state instead
   * of being folded into `attached`. Only meaningful when `canDetach` is
   * true.
   */
  detachIncomplete: boolean;
  /** Whether a Detach control should render at all — true when a registry
   * entry exists for the service (provisioned, detach-incomplete, OR a stale
   * `broken: 'database-missing'` record) AND the viewer's role
   * allows it, false otherwise. Role is folded in here rather than
   * re-checked in DatabaseTab.tsx, symmetric with how `canAttach`/
   * `disabledReason: 'readonly'` already gate the Attach control — same
   * "component stays logic-free" reason. */
  canDetach: boolean;
  /** Detach button label — distinguishes a first detach attempt from a retry
   * after a prior one didn't finish. Only meaningful when `canDetach` is
   * true. */
  detachActionLabel: string;
}

/**
 * Render-state for one service's Attach/Detach controls. `provisioned` is
 * the primary input that decides whether a control shows at all — never
 * render Attach for a service that already exists (an app that already has
 * Postgres provisioned must not offer Attach for it), and never render
 * Detach for one that doesn't (except a stale `broken` record — see
 * `registryEntryExists` below). `role` and `quota` decide whether the
 * Attach control that DOES render is enabled, checked in that order so a
 * readonly viewer sees "your role" rather than "quota" when both apply.
 * `intent` only changes wording for a provisioned=false service ("never
 * touched" vs. "explicitly detached before") — EXCEPT when the service is
 * still provisioned and intent is `'detached'`, which is its own state
 * (`detachIncomplete`) rather than a wording variant of "Attached". `canAttach`
 * being disabled by quota does not imply `canDetach` should be too — a
 * quota-limited owner with a stale `broken` record still has the one working
 * repair path (`DELETE .../services/:id`) and must still see it offered.
 */
export function describeAttachCard(input: AttachCardInput): AttachCardView {
  const previouslyDetached = input.intent === 'detached';
  const isReadonly = input.role === 'readonly';
  const quotaFull = input.quota.constrained && input.quota.used >= input.quota.limit;

  // A stale registry entry (`broken`) has no live database, but its
  // credentials — the thing `DELETE .../services/:id` actually needs to
  // find something to clear — are still on record, the same as a cleanly
  // provisioned service. Detach must earn the same gating in that case even
  // though `provisioned` itself reads false. This also covers the
  // `provisioned: true` case (a cleanly attached or detach-incomplete
  // service always has a registry entry), so `canDetach` below can use it
  // uniformly across all four card states.
  const registryEntryExists = input.provisioned || input.broken === 'database-missing';

  // Still provisioned, but the owner's last recorded intent is 'detached'
  // (DROP-151 Phase 3's persist-first design writes intent BEFORE destroying
  // anything, so a detach that fails partway — e.g. a dump timeout — leaves
  // exactly this combination). Only meaningful when `provisioned` is true: a
  // genuinely unprovisioned, previously-detached service is the ordinary
  // "Re-attach" state below, not this one.
  const detachIncomplete = input.provisioned && previouslyDetached;

  // Precedence when `provisioned` is false: role ahead of quota, so a
  // readonly viewer sees "your role" rather than "quota" when both apply.
  // Always undefined when `provisioned` is true — a cleanly attached or
  // detach-incomplete service never offers Attach in the first place, so
  // there is no "disabled" reason to give for it.
  const disabledReason: AttachDisabledReason | undefined = input.provisioned
    ? undefined
    : isReadonly
      ? 'readonly'
      : quotaFull
        ? 'quota-exceeded'
        : undefined;

  return {
    // False for a service mid-detach (`detachIncomplete`) even though it is
    // still physically provisioned — never render a plain "Attached" badge
    // that hides the repair affordance.
    attached: input.provisioned && !detachIncomplete,
    canAttach: !input.provisioned && !isReadonly && !quotaFull,
    ...(disabledReason ? { disabledReason } : {}),
    previouslyDetached,
    // 'Re-attach' only for a genuinely unprovisioned, previously-detached
    // service — a provisioned one never shows an Attach control at all, so
    // its label stays the default regardless of `previouslyDetached`.
    actionLabel: !input.provisioned && previouslyDetached ? 'Re-attach' : 'Attach',
    detachIncomplete,
    canDetach: registryEntryExists && !isReadonly,
    detachActionLabel: detachIncomplete ? 'Retry detach' : 'Detach',
  };
}

/** `${used} of ${limit} used` — shared by the proactive quota badge (from
 * `GET /db/:name`'s `quota.<service>`) and a `quota-exceeded` refusal's
 * returned numbers (`error.details.quota`), so both read identically. */
export function formatQuotaUsage(quota: { used: number; limit: number }): string {
  return `${quota.used} of ${quota.limit} used`;
}

/** One service's refusal banner (ServiceRow's `refusal` prop). `quota` is
 * only ever set by an attach refusal — a detach refusal never carries one. */
export interface ServiceRefusal {
  message: string;
  quota?: { used: number; limit: number };
}

/** DatabaseTab.tsx's per-service refusal-banner state — ONE map shared by
 * both attach and detach, not two. See `recordServiceRefusal`'s doc for why. */
export type ServiceRefusals = Partial<Record<ServiceId, ServiceRefusal>>;

/**
 * Write (or, with `refusal: undefined`, clear) one service's refusal banner
 * into the shared map, leaving every other service untouched.
 *
 * Attach and detach used to keep SEPARATE maps (`attachRefusals`/
 * `detachRefusals`), rendered as `attachRefusals[id] ?? detachRefusals[id]`.
 * That let a stale attach refusal outlive a LATER detach refusal on the same
 * service: `handleDetach` only ever cleared `detachRefusals[id]`, so a
 * detach that failed after an earlier attach had already failed left the
 * `??` still finding the old attach banner and rendering the wrong reason.
 * A single map, written by both handlers through this one function, makes
 * "the most recent refusal for this service" the only state there is to
 * read — there is no second map left to go stale.
 */
export function recordServiceRefusal(
  prev: ServiceRefusals,
  service: ServiceId,
  refusal: ServiceRefusal | undefined
): ServiceRefusals {
  return { ...prev, [service]: refusal };
}

/** DatabaseTab.tsx's single in-flight slot — one attach/detach action across
 * BOTH service rows, since `ConfirmProvider` holds exactly one pending
 * `resolve` (see that component's own comment). */
export interface PendingServiceAction {
  service: ServiceId;
  kind: 'attach' | 'detach';
}

/**
 * Whether ONE specific control (a given service's Attach button, or its
 * Detach/Retry-detach button) should be disabled because a DIFFERENT action
 * is currently in flight. The previous check only compared
 * `service`, so while postgres's own Attach was pending, postgres's own
 * Detach button stayed enabled too — a click on it would silently no-op
 * (handleDetach's single in-flight guard swallows a second call rather than
 * queuing it), which is exactly the failure this guard exists to prevent.
 * The control that IS the in-flight action is never blocked by itself — it
 * has its own `loading` state instead — so this compares BOTH `service` and
 * `kind`, not just `service`.
 */
export function isControlBlocked(
  pending: PendingServiceAction | null,
  service: ServiceId,
  kind: 'attach' | 'detach'
): boolean {
  if (!pending) return false;
  return pending.service !== service || pending.kind !== kind;
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

/**
 * Shared shape behind `describeAttachRefusal` and `describeDetachRefusal`:
 * the server's own message wins verbatim when present, else a defensively-
 * indexed lookup into a per-reason fallback table, else a generic message.
 * Indexed defensively rather than trusting `reason` to be a key of `table` —
 * a reason value the server adds after this bundle was built is a real input
 * a cached dashboard tab can receive, not a hypothetical (the same lesson
 * `availability-label.ts` carries from its own escaped bug: a direct index
 * there threw and blanked the whole card).
 */
function resolveRefusalCopy<T extends string>(
  reason: string | undefined,
  message: string | undefined,
  table: Record<T, string>,
  generic: string
): string {
  const trimmed = message?.trim();
  if (trimmed) return trimmed;
  if (reason && Object.prototype.hasOwnProperty.call(table, reason)) {
    return table[reason as T];
  }
  return generic;
}

/** User-facing text for a failed `POST /apps/:name/services/:id`. */
export function describeAttachRefusal(
  reason: string | undefined,
  message: string | undefined
): string {
  return resolveRefusalCopy(reason, message, REFUSAL_FALLBACK, 'Could not attach this service.');
}

/**
 * Detach confirm-dialog detail sentence for one service (DROP-151 Phase 3
 * dashboard). Per-service copy: postgres names WHERE the backup goes and that
 * it happens before the drop; redis is explicit that there is no backup at
 * all — never let a reader infer a redis dump exists. `ephemeral` overrides
 * the postgres branch: `DropPlatform.detachService` passes
 * `skipBackup: config?.ephemeral === true` (platform.ts), so an ephemeral
 * app's Postgres detach drops the database with NO dump — the dialog must
 * say that plainly rather than repeat the non-ephemeral promise (the dialog
 * used to promise a backup an ephemeral app never gets, so the owner
 * consented to DROP's only irreversible action here on a false premise).
 * `GET /db/:name`'s `ephemeral` field is what makes this
 * decidable client-side at all.
 */
export function describeDetachConfirm(serviceId: ServiceId, ephemeral: boolean): string {
  if (serviceId === 'redis') {
    return 'Redis data for this app is flushed immediately. There is NO backup.';
  }
  if (ephemeral) {
    return 'This app is ephemeral, so no backup is written — the database is dropped immediately.';
  }
  return (
    'A compressed backup dump is written under the platform backup directory before the ' +
    'database is dropped.'
  );
}

/**
 * Mirrors the success arm of `DELETE /apps/:name/services/:id` (DROP-151
 * Phase 3, "detach: final plan", step 12's result shape — see
 * `DetachServiceResult`'s success arms in `src/api/platform-ops.ts`, which
 * this is kept in sync with by hand). `backup.file` is optional, matching the
 * server: it is present only when a dump was actually attempted and
 * succeeded (absent for a skipped-backup ephemeral detach, or when the
 * cleanup arm found no database to dump). A structural equivalence pin
 * against the server's real type lives in
 * `src/api/services-wire-contract.test.ts`, since the dashboard is a
 * separate npm package and can't import platform-ops.ts directly.
 */
export interface DetachServiceSuccess {
  detached: true;
  deprovisioned: boolean;
  databaseDropped?: boolean;
  roleDropped?: boolean;
  /** redis only. `false` is a real, honest SUCCESS outcome, not a
   * refusal: a failed FLUSHDB still frees the allocation and tombstones the
   * logical DB number, so the detach itself completed — the data just could
   * not be cleared immediately. `describeDetachOutcome` renders this case
   * explicitly rather than reporting a plain "detached" that hides it. */
  flushed?: boolean;
  /** `file` is a basename only — the server deliberately never sends a host
   * path over the wire. Optional: absent when the backup was skipped
   * (ephemeral app) or nothing was found to dump. */
  backup?: { written: boolean; file?: string };
  manifestConflict?: boolean;
  /** `'not-needed'` is the `deprovisioned: false` arm's own restart outcome —
   * nothing was ever provisioned, so there is nothing a restart would accomplish, distinct
   * from `'not-restarted'` (which does describe a real app that was simply
   * not running). `describeDetachOutcome` renders no extra line for it: the
   * `!deprovisioned` branch above already says nothing was removed. */
  restart: 'restarted' | 'failed' | 'needs-config' | 'not-restarted' | 'not-needed';
}

/**
 * `DetachServiceResult`'s refusal `reason` union across all its refusal
 * arms, extracted directly from the server's own type (same reason as
 * `AttachRefusalReason` above) rather than hand-copied — a closed set: the
 * DELETE route (`apps.ts`, DROP-151 Phase 3) has landed, so every reason it
 * can return is enumerable here.
 *
 * `'flush-failed'` is deliberately ABSENT: a failed Redis FLUSHDB is no
 * longer a refusal on the server — the allocation was freed and the number
 * tombstoned regardless, so it returns as a SUCCESS with `flushed: false`
 * instead (`DetachServiceSuccess.flushed`), not a member of this union.
 * `'deprovision-failed'` is its replacement for what remains a genuine
 * refusal: the runtime failing to stop before deprovisioning ever ran, or a
 * THROWN (not just reported) redis deprovision error — a really-unreachable
 * Redis, as opposed to a reported flush failure, which is the success case
 * above.
 */
export type DetachRefusalReason = Extract<DetachServiceResult, { detached: false }>['reason'];

/**
 * Best-effort fallback copy for a detach refusal reason, used only when the
 * server's own message is missing/blank — mirrors `REFUSAL_FALLBACK`'s role
 * for attach. Indexed defensively in `describeDetachRefusal` below, same
 * reason as `REFUSAL_FALLBACK`: a reason value the server adds after this
 * bundle was built is a real input a cached dashboard tab can receive.
 */
const DETACH_REFUSAL_FALLBACK: Record<DetachRefusalReason, string> = {
  'group-app': 'Group containers and their child apps cannot be detached from the dashboard.',
  'service-unavailable': 'This service is not available on this platform.',
  'credentials-missing':
    'This app has a live database DROP no longer holds credentials for — contact an administrator.',
  'no-app-config': 'This app has no saved platform configuration yet.',
  'not-found': 'This application could not be found.',
  'detach-limit': 'Too many detach attempts for this app right now.',
  'backup-failed':
    'The backup dump failed before the database could be dropped, so nothing was removed. Retry once the issue is resolved.',
  'deprovision-failed':
    'The service could not be removed. Retry once the issue is resolved.',
};

/**
 * User-facing text for a failed `DELETE /apps/:name/services/:id`. Same
 * verbatim-message-first, reason-fallback-second shape as
 * `describeAttachRefusal`, plus a `retryAfterSeconds` suffix for the
 * `'detach-limit'` (429) refusal — the one useful fact a rate-limited caller
 * needs is when to retry, not just that it was refused (plan architecture
 * finding A21). `reason` stays `string | undefined`, not `DetachRefusalReason`
 * — a cached dashboard build can receive a reason value added to the server's
 * union after this bundle shipped, and that must fall through to the generic
 * message below rather than fail to type-check or throw.
 */
export function describeDetachRefusal(
  reason: string | undefined,
  message: string | undefined,
  retryAfterSeconds?: number
): string {
  const base = resolveRefusalCopy(
    reason,
    message,
    DETACH_REFUSAL_FALLBACK,
    'Could not detach this service.'
  );

  if (reason === 'detach-limit' && typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0) {
    return `${base} Try again in ${retryAfterSeconds}s.`;
  }
  return base;
}

/**
 * Toast copy for a successful `DELETE /apps/:name/services/:id`. Composes
 * the independent partial-outcome flags (nothing was provisioned to remove,
 * a backup file, `roleDropped === false`, `flushed === false`, a
 * non-`'restarted'` `restart` arm) into one honest sentence —
 * DatabaseTab.tsx should not decide when to call a detach "complete" versus
 * "partial", the same reason `describeAttachRefusal` exists instead of a
 * component-level switch. `label` is the caller's own display name for the
 * service (e.g. `SERVICE_LABEL[id]`) — kept out of this file so it stays
 * free of UI constants that already live in DatabaseTab.tsx.
 */
export function describeDetachOutcome(label: string, result: DetachServiceSuccess): string {
  const lines: string[] = [];

  if (!result.deprovisioned) {
    lines.push(`${label} detach recorded — nothing was provisioned to remove.`);
  } else if (result.backup?.file) {
    lines.push(`${label} detached. Backup written: ${result.backup.file}.`);
  } else {
    lines.push(`${label} detached from the app.`);
  }

  if (result.roleDropped === false) {
    lines.push('Role cleanup incomplete — retained for retry.');
  }

  // Fix X5: `flushed: false` is a real SUCCESS outcome, not a refusal — the
  // allocation was freed and the logical DB number tombstoned either way.
  // Say plainly what actually happened (the data could not be cleared right
  // now) and where the guarantee actually lives (flushed before reuse), not
  // "nothing was removed" — that would contradict this same detach having
  // just freed the allocation and restarted the app without REDIS_URL.
  if (result.flushed === false) {
    lines.push(
      `${label} data could not be flushed immediately. It stays isolated and is flushed before this logical database is reused.`
    );
  }

  if (result.restart === 'needs-config') {
    lines.push('The app needs configuration before it can restart.');
  } else if (result.restart === 'failed') {
    lines.push('The app failed to restart — check its status.');
  } else if (result.restart === 'not-restarted') {
    lines.push('The app was not running, so it was not restarted.');
  }

  // `manifestConflict` was computed by the platform on every detach but never
  // rendered anywhere (dead data across four layers). The point: the detach
  // WINS over a drop.yaml that still declares this service
  // — the manifest is not silently reasserting it — and re-attaching hands
  // authority back to that manifest.
  if (result.manifestConflict) {
    lines.push(
      `This app's drop.yaml still declares ${label} — that declaration is ignored for now; ` +
        're-attaching would hand authority back to it.'
    );
  }

  return lines.join(' ');
}
