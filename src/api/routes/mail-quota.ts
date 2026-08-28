/**
 * The mail quota's admission prologue, shared by every caller that sends mail.
 *
 * A LEAF MODULE, deliberately — the same argument `access-limits.ts` makes for
 * itself. Both callers today are route files (`admin.ts`'s POST /mail/test and
 * `apps.share.ts`'s notifyShareGrant), and a route importing another route is
 * how a require cycle starts: `apps.ts` already imports `apps.share.ts` to
 * mount it, so `apps.share.ts -> admin.ts` only stays acyclic by accident of
 * who imports whom today. Slice C adds a third caller; this is where it goes.
 *
 * It stops at ADMISSION on purpose, because the callers genuinely diverge on
 * what happens next: POST /mail/test refuses with a structured 429 and is the
 * operator's own request, while notifyShareGrant logs the refusal and skips
 * silently, never failing the grant it hangs off. Folding those together would
 * mean one of them lying about what it did.
 *
 * `sendMeteredMail` below is Slice C paying off the DROP-154 Gate 5 debt: the
 * check -> send -> record-only-if-dialed sequence in ONE place, so a caller can
 * neither forget to meter nor get the ordering wrong. It lives here rather than
 * inside `sendTemplatedMail` because the mailer's own header states it has no
 * `AuthContext` — and the quota is keyed on one. Wrapping gets the
 * can't-forget-it property without widening the mailer's type surface, which
 * was the Gate 5 proposal's actual cost.
 */

import { getMailQuota } from '../../managers/guardrail/principal-quota';
import type { QuotaKey } from '../../managers/guardrail/principal-quota';
import { sendTemplatedMail } from '../../managers/mailer/mailer';
import type {
  MailTemplate,
  MailTemplateVars,
  MailFailureDetail,
} from '../../managers/mailer/mailer.types';

export interface MailQuotaActor {
  principalId?: string;
  actorUserId?: string;
}

export type MailQuotaAdmission =
  | { allowed: true; keys: QuotaKey[] }
  | { allowed: false; reason: string; retryAfterSeconds?: number };

/**
 * `getMailQuota()` -> `keysFor()` -> the not-metered refusal -> `check()` ->
 * the exceeded refusal.
 *
 * The not-metered arm is not dead code here the way it is on the deploy path:
 * the mail instance is built with `unmeteredWithoutPrincipal: false`
 * precisely so an actor with no principal is REFUSED rather than waved
 * through — an unmetered outbound channel is not the same thing as automation
 * with nothing to attribute volume to.
 */
export function checkMailQuota(actor: MailQuotaActor): MailQuotaAdmission {
  const quota = getMailQuota();
  const keys = quota.keysFor({ principalId: actor.principalId, actorUserId: actor.actorUserId });
  if (!keys.metered) {
    return { allowed: false, reason: keys.reason };
  }
  const verdict = quota.check(keys.keys);
  if (!verdict.allowed) {
    return {
      allowed: false,
      reason: verdict.reason ?? 'limit_exceeded',
      retryAfterSeconds: verdict.retryAfterSeconds,
    };
  }
  return { allowed: true, keys: keys.keys };
}

/**
 * The quota's own arm, kept structurally distinct from the mailer's two.
 *
 * `refused` means NOTHING WAS SENT and no relay was dialed — a different
 * fact from `unavailable` (local config missing, or an input the mailer
 * refused), which callers already treat differently: `POST /admin/mail/test`
 * answers a structured 429 for one and a 200-with-status for the other.
 * Folding them into a single "didn't send" would erase exactly the
 * distinction both callers branch on.
 */
export type MeteredMailResult =
  | { status: 'refused'; reason: string; retryAfterSeconds?: number }
  | { status: 'attempted'; failure?: MailFailureDetail }
  | { status: 'unavailable' };

/**
 * Check the quota, send, and charge the allowance — in that order, once.
 *
 * THE ORDERING IS THE CONTROL, and it is the thing two hand-written copies
 * of this sequence had already got wrong once (DROP-154 Gate 5):
 *
 *  - the quota is checked BEFORE anything is rendered or dialed, so a
 *    refusal costs no relay conversation and leaks no timing;
 *  - the allowance is charged only when the relay was ACTUALLY dialed
 *    (`status !== 'unavailable'`). An unconfigured relay never opens a
 *    socket, and counting those would refuse the first REAL sends the moment
 *    an operator finally configures mail — the bug `POST /admin/mail/test`
 *    shipped with.
 *
 * Never throws: `sendTemplatedMail` is documented not to, and the quota calls
 * are synchronous bookkeeping. Callers still decide what a refusal MEANS —
 * this deliberately stops at the result, because the callers genuinely
 * diverge (a 429 for the operator's own request; a logged, silent skip for a
 * best-effort notification that must never fail the grant it hangs off).
 */
export async function sendMeteredMail<T extends MailTemplate>(
  actor: MailQuotaActor,
  template: T,
  to: string,
  vars: MailTemplateVars[T]
): Promise<MeteredMailResult> {
  const admission = checkMailQuota(actor);
  if (!admission.allowed) {
    return {
      status: 'refused',
      reason: admission.reason,
      retryAfterSeconds: admission.retryAfterSeconds,
    };
  }

  const result = await sendTemplatedMail(template, to, vars);
  if (result.status !== 'unavailable') {
    getMailQuota().record(admission.keys);
  }
  return result;
}
