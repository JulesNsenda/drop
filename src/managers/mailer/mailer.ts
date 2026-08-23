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
 * operation — this function never throws.
 *
 * Transport security is forced, not configured: `requireTLS` and
 * `tls.rejectUnauthorized` are always on unless the operator has explicitly
 * opted out via `DROP_SMTP_ALLOW_INSECURE_TLS=true` (an env, deliberately
 * NOT one of `MailSettings`' admin-clickable fields — relaxing certificate
 * validation is a rare, deliberate operator decision for an internal relay
 * with a self-signed cert, not something that belongs one click away in the
 * dashboard). Without this, `smtpSecure: false` on port 587 is opportunistic
 * STARTTLS, which an on-path attacker strips to harvest the relay password
 * and every message body in cleartext.
 */

import nodemailer from 'nodemailer';
import { getSettingsManager } from '../settings/settings-manager';
import { getMailCredentialStore } from './mail-credential';
import { renderTemplate } from './templates';
import { tryLogActivity } from '../activity/activity-log';
import type {
  MailTemplate,
  MailTemplateVars,
  MailSendResult,
  ShareNotificationVars,
  InviteMailVars,
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

/** `share-notification` and `invite` carry an `appName`; `test` does not — narrows `vars` for the failure-log write below. */
function isAppNamedTemplate(
  template: MailTemplate,
  _vars: MailTemplateVars[MailTemplate]
): _vars is ShareNotificationVars | InviteMailVars {
  return template === 'share-notification' || template === 'invite';
}

function resolveDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
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

  const password = await getMailCredentialStore().resolveMailPassword();
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
    requireTLS: !allowInsecureTls,
    tls: { rejectUnauthorized: !allowInsecureTls },
    connectionTimeout: SEND_DEADLINE_MS,
    greetingTimeout: SEND_DEADLINE_MS,
    socketTimeout: SEND_DEADLINE_MS,
  });

  // `status` is fixed here, before the relay conversation even starts (see
  // the file header and `MailSendResult`) — nothing below this line can
  // change what we return.
  const result: MailSendResult = { status: 'sent' };

  const sendPromise = transport
    .sendMail({ from: mailSettings.from, to, subject, html, text })
    .then(() => {
      console.log(`[mailer] send attempt completed for template=${template}`);
    })
    .catch((err) => {
      // Relay diagnostics go to the log, never to the return value — see the
      // file header. console.error stays (an unowned sibling test asserts on
      // it); ActivityLog is the durable, admin-visible home for the same
      // diagnostic — `tryLogActivity` is used directly (no `AuthContext` is
      // available inside this function) and never throws, so a logging
      // failure can't turn into a second, unrelated send failure. Note this
      // write is inside the same floating `.catch()` chain that
      // `resolveDeadline` abandons past the deadline below — a caller
      // observing `sendTemplatedMail` resolve is NOT a guarantee this entry
      // has been written yet.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[mailer] send attempt failed for template=${template}:`, message);
      void tryLogActivity({
        action: 'mail-send-failed',
        appName: isAppNamedTemplate(template, vars) ? vars.appName : undefined,
        detail: `template=${template} to=${to}: ${message}`,
      });
    })
    .finally(() => {
      transport.close();
    });

  // Await up to the deadline; a still-pending attempt is abandoned here (its
  // own .catch/.finally above still runs whenever it eventually settles) —
  // the caller is never made to wait past SEND_DEADLINE_MS.
  await resolveDeadline(sendPromise, SEND_DEADLINE_MS);

  return result;
}
