/**
 * The mailer (DROP-154 §1-3). A function, not a service.
 *
 * One-shot transport per send (no `pool` option — see the comment at the
 * `createTransport` call) — no singleton, no connection pool, no
 * `platform.ts` diff. A pooled singleton would hold sockets and
 * timers into `platform.stop()`, whose ordering has already caused a
 * fail-open on every deploy once, and would add an open handle to a test
 * suite already running `--forceExit`. Invite/notification volume is a
 * handful of messages — a pool is premature.
 *
 * `status` is decided BEFORE the relay conversation, never from the SMTP
 * reply (see `MailSendResult` in `mailer.types.ts`): surfacing 550/552 to a
 * caller turns any send path into a directory enumeration oracle against the
 * operator's mail domain. A send failure never fails its caller's
 * operation — this function never throws. The relay-conversation detail
 * (connection refusal, auth/TLS failure, or the relay's own reply) is
 * returned alongside `status` as an OPTIONAL `failure` — see
 * `MailFailureDetail` in `mailer.types.ts` for exactly who is allowed to
 * read it. This module has no `AuthContext` and does not write to
 * `ActivityLog` itself; each caller logs with its own actor via
 * `logActivityFor`.
 *
 * Transport security is forced, not configured: `requireTLS` is always on,
 * unconditionally — there is no env or setting that relaxes it, because a
 * relay that doesn't advertise STARTTLS must fail the connection, not fall
 * back to cleartext. `tls.rejectUnauthorized` is the ONLY thing
 * `DROP_SMTP_ALLOW_INSECURE_TLS=true` relaxes (an env, deliberately NOT one
 * of `MailSettings`' admin-clickable fields — relaxing certificate
 * validation is a rare, deliberate operator decision for an internal relay
 * with a self-signed cert, not something that belongs one click away in the
 * dashboard).
 *
 * The relay host is validated before every dial (`isRelayHostAllowed`)
 * against the same private/loopback/link-local ranges `ssrf-guard.ts`
 * already blocks for tenant-controlled URLs — an admin-set `smtpHost` (or an
 * admin-supplied `to` on the test route) must not turn this module into an
 * internal-network scanner reachable through the admin API. Opt out per-box
 * with `DROP_SMTP_ALLOW_PRIVATE_RELAY=true`, for the legitimate case of an
 * internal relay on a private range.
 */

import nodemailer from 'nodemailer';
import { getSettingsManager } from '../settings/settings-manager';
import { getMailCredentialStore } from './mail-credential';
import { renderTemplate } from './templates';
import { hostnameResolvesToBlockedIp } from '../../utils/ssrf-guard';
import type {
  MailTemplate,
  MailTemplateVars,
  MailSendResult,
  MailFailureDetail,
} from './mailer.types';

/**
 * Hard total deadline for a send attempt. Enforced by OUR OWN race, not by
 * nodemailer's connection/greeting/socket timeouts (set below as a
 * defense-in-depth backstop, not the primary control) — the plan is explicit
 * that the tests must cover this rather than assuming nodemailer's own
 * timeouts save us.
 */
export const SEND_DEADLINE_MS = 5000;

const HEADER_INJECTION_RE = /[\r\n\0]/;
// `,`/`;` are the address-LIST separators nodemailer itself honours (it fans
// out to every address it finds). `updateUser` writes `User.email`
// unvalidated today, so a caller reaching `to` from that field could turn
// one grant into mail fanned out to N attacker-chosen recipients — this
// function is that boundary's backstop, and this repo's DROP-150 lesson is
// exactly "a denylist protecting an unbounded set isn't enough" applied to a
// different field, so the check is a single-address ALLOWLIST shape rather
// than a longer denylist.
const ADDRESS_SEPARATOR_RE = /[,;]/;

/** Rejects (throws) CR/LF/NUL in an address/header input — independent of whatever nodemailer itself does with it. */
function assertNoHeaderInjection(field: string, value: string): void {
  if (!value || HEADER_INJECTION_RE.test(value)) {
    throw new Error(`mailer: rejected ${field} — empty, or contains CR/LF/NUL`);
  }
}

/** Same as `assertNoHeaderInjection`, plus refuses a `,`/`;`-separated address list — every send here is to exactly one recipient. */
function assertSingleAddress(field: string, value: string): void {
  assertNoHeaderInjection(field, value);
  if (ADDRESS_SEPARATOR_RE.test(value)) {
    throw new Error(`mailer: rejected ${field} — multiple addresses are not supported`);
  }
}

/**
 * True if `host` is safe to dial — mirrors the private/loopback/link-local
 * blocklist `ssrf-guard.ts` already applies to tenant-controlled URLs
 * (webhooks, git clones, `depends_on`). An admin-set `smtpHost` reaches this
 * same check on every send: without it, the admin API becomes a usable
 * internal-network probe (an admin-supplied host + any port, distinguishable
 * by timing — instant `ECONNREFUSED` vs. the full deadline on an
 * open-but-silent port). `DROP_SMTP_ALLOW_PRIVATE_RELAY=true` is the
 * explicit, box-level opt-out for a legitimate internal relay.
 */
async function isRelayHostAllowed(host: string): Promise<boolean> {
  if (process.env.DROP_SMTP_ALLOW_PRIVATE_RELAY === 'true') return true;
  return !(await hostnameResolvesToBlockedIp(host));
}

/**
 * Races `promise` against a `ms` deadline and reports which one won —
 * `'timeout'` is itself a distinct, reportable outcome (a deadline with no
 * relay contact at all is one of the failure modes `MailFailureDetail`
 * exists to surface, not silence), not merely "the same as no error yet".
 */
function resolveDeadline(promise: Promise<unknown>, ms: number): Promise<'settled' | 'timeout'> {
  return new Promise<'settled' | 'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve('settled');
      },
      () => {
        clearTimeout(timer);
        resolve('settled');
      }
    );
  });
}

export function sendTemplatedMail<T extends MailTemplate>(
  template: T,
  to: string,
  vars: MailTemplateVars[T]
): Promise<MailSendResult> {
  return doSend(template, to, vars);
}

async function doSend(
  template: MailTemplate,
  to: string,
  vars: MailTemplateVars[MailTemplate]
): Promise<MailSendResult> {
  const mailSettings = getSettingsManager().getMailSettings();

  if (!mailSettings.host || !mailSettings.from) {
    return { status: 'unavailable' };
  }

  if (!(await isRelayHostAllowed(mailSettings.host))) {
    console.error(
      `[mailer] refused to dial relay host — private/loopback/link-local address: ${mailSettings.host}`
    );
    return { status: 'unavailable' };
  }

  const password = await getMailCredentialStore().resolveMailPassword(mailSettings.host);
  if (!password) {
    return { status: 'unavailable' };
  }

  let subject: string, html: string, text: string;
  try {
    assertSingleAddress('to', to);
    assertSingleAddress('from', mailSettings.from);
    const rendered = renderTemplate(template, vars);
    assertNoHeaderInjection('subject', rendered.subject);
    ({ subject, html, text } = rendered);
  } catch (err) {
    console.error('[mailer] refused to send — invalid input:', err instanceof Error ? err.message : err);
    return { status: 'unavailable' };
  }

  const allowInsecureTls = process.env.DROP_SMTP_ALLOW_INSECURE_TLS === 'true';
  const secure = mailSettings.secure ?? false;

  const transport = nodemailer.createTransport({
    host: mailSettings.host,
    port: mailSettings.port ?? (secure ? 465 : 587),
    secure,
    // Credential is mandatory (checked above) — the relay's own auth
    // username defaults to the From address when the operator hasn't set one
    // explicitly, since most relays require SOME username.
    auth: { user: mailSettings.user || mailSettings.from, pass: password },
    // No `pool` key here — `SMTPTransport.Options` (nodemailer's own type)
    // doesn't declare one; pooling is a DIFFERENT class (`SMTPPool`) that
    // nodemailer's own `createTransport` only switches to when `options.pool`
    // is truthy (see `nodemailer.js`'s `if (options.pool) { ... } else {
    // transporter = new SMTPTransport(options); }`). Omitting it is what
    // gives the one-shot, non-pooled transport this module is built around.
    //
    // `requireTLS` is unconditional — see the file header. Only
    // `rejectUnauthorized` moves with `DROP_SMTP_ALLOW_INSECURE_TLS`.
    requireTLS: true,
    tls: { rejectUnauthorized: !allowInsecureTls },
    connectionTimeout: SEND_DEADLINE_MS,
    greetingTimeout: SEND_DEADLINE_MS,
    socketTimeout: SEND_DEADLINE_MS,
  });

  // `status` is fixed here, before the relay conversation even starts (see
  // the file header and `MailSendResult`) — nothing below this line can
  // change what we return. `failure` is populated if the relay conversation
  // errors, OR (below, after the race) if the deadline elapses with no
  // response at all — the only case left unpopulated is a genuine success.
  let failure: MailFailureDetail | undefined;

  const sendPromise = transport
    .sendMail({ from: mailSettings.from, to, subject, html, text })
    .then(() => {
      console.log(`[mailer] send attempt completed for template=${template}`);
    })
    .catch((err) => {
      // The relay diagnostic (which may be the raw SMTP reply, e.g. "550 no
      // such user") goes to the log always, and to `failure` for the caller
      // to decide who gets to see it — see `MailFailureDetail`'s doc for why
      // this module itself never writes it anywhere durable: it has no
      // `AuthContext` to attribute the write to, and `to` is exactly the
      // recipient the enumeration-oracle rule exists to protect. Note this
      // assignment is inside the same floating `.catch()` chain that
      // `resolveDeadline` abandons past the deadline below — a relay error
      // that arrives after the deadline is never reflected in the value this
      // function already returned.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[mailer] send attempt failed for template=${template}:`, message);
      failure = { reason: message };
    })
    .finally(() => {
      transport.close();
    });

  // Await up to the deadline; a still-pending attempt is abandoned here (its
  // own .catch/.finally above still runs whenever it eventually settles,
  // possibly setting `failure` after this function has already returned) —
  // the caller is never made to wait past SEND_DEADLINE_MS. A deadline with
  // no relay contact at all is itself a failure mode (plan §1), not silence:
  // synthesize a generic `failure` for it rather than leaving the caller
  // unable to tell "the relay accepted it" from "we gave up waiting".
  const outcome = await resolveDeadline(sendPromise, SEND_DEADLINE_MS);
  if (outcome === 'timeout' && !failure) {
    failure = { reason: `no relay response within ${SEND_DEADLINE_MS}ms` };
  }

  return failure ? { status: 'attempted', failure } : { status: 'attempted' };
}
