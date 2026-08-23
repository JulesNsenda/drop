/**
 * Types for the DROP mailer (DROP-154 Slice B).
 *
 * Three fixed templates — no caller-supplied subject, HTML or body (plan
 * §5). Each template's variable set is its own interface so a caller cannot
 * pass an unenumerated value through; `templates.ts` HTML-escapes every
 * field at render time regardless of upstream grammar.
 */

/** The only templates that exist. `invite` is unused until Slice C — included now so that slice adds a caller, not a template. */
export type MailTemplate = 'share-notification' | 'test' | 'invite';

/** Sent to the recipient of an owner's `PUT /apps/:name/share` grant. */
export interface ShareNotificationVars {
  /** `AppState.name` — constrained by `isValidAppName` upstream. */
  appName: string;
  /** `getUserById(grantedBy).username` — constrained by the signup grammar (`^[A-Za-z0-9_-]+$`) upstream. */
  sharerName: string;
  /** `computeAppUrl` output — derived, https-forced. */
  appUrl: string;
  /** `getPublicUrl()` — operator-set, normalized. */
  platformUrl: string;
}

/** Sent by `POST /admin/mail/test` to confirm relay settings actually work. */
export interface TestMailVars {
  /** `getPublicUrl()` — operator-set, normalized. */
  platformUrl: string;
}

/**
 * Unused until Slice C's guest-invite flow. Shape mirrors
 * `ShareNotificationVars` plus the one-time invite link, so the template
 * exists ahead of its caller rather than being invented alongside it.
 */
export interface InviteMailVars {
  /** `AppState.name` — constrained by `isValidAppName` upstream. */
  appName: string;
  /** `getUserById(grantedBy).username` — constrained by the signup grammar upstream. */
  sharerName: string;
  /** One-time invite acceptance URL — https-forced. */
  inviteUrl: string;
  /** `getPublicUrl()` — operator-set, normalized. */
  platformUrl: string;
}

/** Maps a template name to its variable shape, so `renderTemplate`/`sendTemplatedMail` overloads stay in sync. */
export interface MailTemplateVars {
  'share-notification': ShareNotificationVars;
  test: TestMailVars;
  invite: InviteMailVars;
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

/**
 * `sent` means "handed to the relay and awaited" — NOT "the relay accepted
 * it". `status` is deliberately never derived from the SMTP reply (plan §2):
 * surfacing 550/552 to a caller turns any send path into a directory
 * enumeration oracle against the operator's mail domain. `unavailable` means
 * local config (host/from/credential) was missing, or an input failed
 * validation, BEFORE any relay conversation was attempted.
 */
export type MailSendResult = { status: 'sent' } | { status: 'unavailable' };
