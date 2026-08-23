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
    default: {
      const exhaustive: never = template as never;
      throw new Error(`mailer: unknown template "${String(exhaustive)}"`);
    }
  }
}
