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
 * What is NOT here, and is the deeper fix: metering inside `sendTemplatedMail`
 * itself, so a caller cannot forget to meter and cannot get the ordering wrong.
 * The DROP-154 Gate 5 review argued for it after finding the two call sites had
 * already diverged — POST /mail/test recorded BEFORE the send, so an
 * unconfigured relay burned allowance for a message that never left, which is
 * exactly what notifyShareGrant's own comment says must not happen. Both now
 * record only after the relay was actually dialed. Deferred to Slice C, where
 * the invite path arrives and the result type has to change anyway.
 */

import { getMailQuota } from '../../managers/guardrail/principal-quota';
import type { QuotaKey } from '../../managers/guardrail/principal-quota';

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
