/**
 * Fixed mail templates (DROP-154 §5). No caller ever supplies a subject,
 * HTML body or text body — only the enumerated variables per template, and
 * every one of them is HTML-escaped here at render time regardless of
 * upstream grammar (an app name, username or URL is validated elsewhere,
 * but this is the transport boundary and re-checks rather than trusting
 * that validation held).
 *
 * CR/LF/NUL are rejected outright (not stripped) in every variable, not just
 * ones known to land in a header today — a template edited later to lift a
 * variable into the subject line must not silently reopen header injection.
 * `mailer.ts` separately re-checks the recipient address for the same
 * reason: this is a backstop that must hold on its own, not a rule with one
 * enforcement point.
 */

import type {
  MailTemplate,
  MailTemplateVars,
  RenderedMail,
  ShareNotificationVars,
  TestMailVars,
  GuestInviteVars,
} from './mailer.types';

const HEADER_INJECTION_RE = /[\r\n\0]/;

/** Rejects (throws) rather than strips — a caller passing a bad value has a bug worth surfacing, not silently laundering. */
function safe(field: string, value: string): string {
  if (HEADER_INJECTION_RE.test(value)) {
    throw new Error(`mailer: rejected template variable "${field}" — contains CR/LF/NUL`);
  }
  return value;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderShareNotification(vars: ShareNotificationVars): RenderedMail {
  const appName = safe('appName', vars.appName);
  const sharerName = safe('sharerName', vars.sharerName);
  const appUrl = safe('appUrl', vars.appUrl);
  const platformUrl = safe('platformUrl', vars.platformUrl);

  const subject = `${sharerName} shared "${appName}" with you`;
  const html =
    `<p>${escapeHtml(sharerName)} gave you access to <strong>${escapeHtml(appName)}</strong>.</p>` +
    `<p><a href="${escapeHtml(appUrl)}">${escapeHtml(appUrl)}</a></p>` +
    `<p style="color:#666;font-size:0.9em">Sent by your DROP platform at ${escapeHtml(platformUrl)}.</p>`;
  const text = `${sharerName} gave you access to ${appName}.\n\n${appUrl}\n\nSent by your DROP platform at ${platformUrl}.`;

  return { subject, html, text };
}

/**
 * The platform-origin rule for the guest invite, enforced HERE rather than
 * trusted from the caller (DROP-155 plan §C).
 *
 * The invite link is the one URL in DROP's outbound mail that carries a live
 * secret, and the §C chain exists specifically so that link lands on the
 * OPERATOR's origin and never on a tenant-controlled hostname. That is a
 * property of the message, so it is checked at the message boundary — the
 * same argument this file's header already makes for re-escaping and
 * re-checking every variable regardless of upstream validation. A caller
 * that builds the URL from anything tenant-authored fails here, loudly,
 * instead of shipping a phishing-grade link signed by the operator's relay.
 *
 * Throws (never launders) — `sendTemplatedMail` catches render failures and
 * returns `unavailable` with a server-side log, so the mail is simply not
 * sent.
 *
 * Origin equality is the whole check: no https requirement is imposed on top,
 * because a dev/localhost box legitimately runs the entire flow over http and
 * `getPublicUrl()` is the operator's own declared base. Whether that base is
 * https is the operator's decision and is enforced (or not) where the public
 * URL is set, not here.
 */
function assertPlatformOrigin(inviteUrl: string, platformUrl: string): void {
  let invite: URL;
  let platform: URL;
  try {
    invite = new URL(inviteUrl);
    platform = new URL(platformUrl);
  } catch {
    throw new Error(
      'mailer: rejected guest invite — inviteUrl and platformUrl must both be absolute URLs'
    );
  }
  if (invite.origin !== platform.origin) {
    throw new Error(
      `mailer: rejected guest invite — inviteUrl origin (${invite.origin}) is not the platform origin (${platform.origin})`
    );
  }
}

function renderGuestInvite(vars: GuestInviteVars): RenderedMail {
  const appName = safe('appName', vars.appName);
  const inviterName = safe('inviterName', vars.inviterName);
  const inviteUrl = safe('inviteUrl', vars.inviteUrl);
  const platformUrl = safe('platformUrl', vars.platformUrl);
  assertPlatformOrigin(inviteUrl, platformUrl);

  // A number, not a string, so there is nothing to inject — but a non-finite
  // one would render as "NaN hours", so refuse it the same way `safe`
  // refuses a bad string rather than printing nonsense to a stranger.
  if (!Number.isFinite(vars.expiresInHours) || vars.expiresInHours <= 0) {
    throw new Error('mailer: rejected template variable "expiresInHours" — not a positive number');
  }
  const hours = String(Math.floor(vars.expiresInHours));

  const subject = `${inviterName} invited you to "${appName}"`;
  const html =
    `<p>${escapeHtml(inviterName)} invited you to <strong>${escapeHtml(appName)}</strong>.</p>` +
    `<p><a href="${escapeHtml(inviteUrl)}">Accept the invitation</a></p>` +
    `<p style="color:#666;font-size:0.9em">This invitation is single-use and expires in ${hours} hours. ` +
    `If it expires, ask ${escapeHtml(inviterName)} to send you another one.</p>` +
    `<p style="color:#666;font-size:0.9em">Sent by your DROP platform at ${escapeHtml(platformUrl)}. ` +
    `If you were not expecting this, you can ignore it. Nothing happens until you open the link.</p>`;
  const text =
    `${inviterName} invited you to ${appName}.\n\n${inviteUrl}\n\n` +
    `This invitation is single-use and expires in ${hours} hours. ` +
    `If it expires, ask ${inviterName} to send you another one.\n\n` +
    `Sent by your DROP platform at ${platformUrl}. If you were not expecting this, you can ` +
    `ignore it. Nothing happens until you open the link.`;

  return { subject, html, text };
}

function renderTest(vars: TestMailVars): RenderedMail {
  const platformUrl = safe('platformUrl', vars.platformUrl);

  const subject = 'DROP test email';
  const html =
    `<p>This is a test email from your DROP platform at ${escapeHtml(platformUrl)}.</p>` +
    `<p>If you received this, outbound mail is configured correctly.</p>`;
  const text = `This is a test email from your DROP platform at ${platformUrl}.\n\nIf you received this, outbound mail is configured correctly.`;

  return { subject, html, text };
}

export function renderTemplate<T extends MailTemplate>(
  template: T,
  vars: MailTemplateVars[T]
): RenderedMail {
  // Widened to the concrete union for the switch: a generic `T extends
  // MailTemplate` doesn't narrow to `never` in the default branch the way a
  // literal-union parameter would, which is all this cast is working around.
  switch (template as MailTemplate) {
    case 'share-notification':
      return renderShareNotification(vars as ShareNotificationVars);
    case 'test':
      return renderTest(vars as TestMailVars);
    case 'guest-invite':
      return renderGuestInvite(vars as GuestInviteVars);
    default: {
      const exhaustive: never = template as never;
      throw new Error(`mailer: unknown template "${String(exhaustive)}"`);
    }
  }
}
