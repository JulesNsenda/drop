/**
 * Types for the DROP mailer (DROP-154 Slice B).
 *
 * Fixed templates — no caller-supplied subject, HTML or body (plan
 * §5). Each template's variable set is its own interface so a caller cannot
 * pass an unenumerated value through; `templates.ts` HTML-escapes every
 * field at render time regardless of upstream grammar.
 */

/** The only templates that exist. */
export type MailTemplate = 'share-notification' | 'test' | 'guest-invite';

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

/**
 * Sent to a person with NO DROP account, inviting them to one app (DROP-155).
 *
 * Note what is ABSENT: there is no `appUrl`. The invite link points at the
 * PLATFORM's own origin, and the app's real hostname never appears in this
 * message at all — `computeAppUrl` resolves from the app's own drop.yaml
 * `domains` / `customDomain`, which are tenant-authored, and this mail is
 * already carrying an attacker-choosable app name inside a DKIM/SPF-aligned
 * message from the operator's relay. `renderGuestInvite` enforces the
 * platform-origin rule on `inviteUrl` itself rather than trusting its caller
 * to have built the URL correctly (DROP-155 plan §C).
 */
export interface GuestInviteVars {
  /** `AppState.name` — constrained by `isValidAppName` upstream. */
  appName: string;
  /** `getUserById(createdBy).username` — constrained by the signup grammar upstream. */
  inviterName: string;
  /**
   * `https://<platform>/api/v1/app-access/invite/<id>#<secret>`.
   *
   * Carries the invite SECRET in its fragment, which is why it must be on
   * the platform's own origin and nowhere else — enforced at render time,
   * not assumed.
   */
  inviteUrl: string;
  /** `getPublicUrl()` — operator-set, normalized. The origin `inviteUrl` is checked against. */
  platformUrl: string;
  /** `INVITE_TTL_HOURS`. Passed rather than hardcoded so the copy cannot drift from the real TTL. */
  expiresInHours: number;
}

/** Sent by `POST /admin/mail/test` to confirm relay settings actually work. */
export interface TestMailVars {
  /** `getPublicUrl()` — operator-set, normalized. */
  platformUrl: string;
}

/** Maps a template name to its variable shape, so `renderTemplate`/`sendTemplatedMail` overloads stay in sync. */
export interface MailTemplateVars {
  'share-notification': ShareNotificationVars;
  test: TestMailVars;
  'guest-invite': GuestInviteVars;
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Internal detail of a relay-conversation failure — a connection refusal, an
 * auth failure, a TLS failure, a deadline timeout, or the relay's own SMTP
 * reply (e.g. `550 5.1.1 user unknown`). `reason` may therefore carry the
 * same bounce text the enumeration-oracle rule below exists to keep out of a
 * response.
 *
 * ADMIN-FACING ONLY. `POST /admin/mail/test` is the one caller allowed to
 * return this to its response body — the operator both owns the relay and
 * supplied the recipient address themselves, so there is no third party to
 * enumerate against. Any other caller (e.g. the share-notification path,
 * where the recipient is someone else's address) MUST NOT surface this on a
 * tenant-reachable response; log it instead via `logActivityFor`.
 */
export interface MailFailureDetail {
  reason: string;
}

/**
 * `attempted` means "handed to the relay and awaited" — NOT "the relay
 * accepted it" in the sense of guaranteed delivery (see "What DROP tells
 * you" caveats). `status` is deliberately never derived from the SMTP reply
 * (plan §2): surfacing 550/552 to a caller turns any send path into a
 * directory enumeration oracle against the operator's mail domain.
 * `unavailable` means local config (host/from/credential) was missing, the
 * relay host was refused before any conversation started, or an input failed
 * validation — none of these ever dial the relay.
 *
 * `attempted`'s optional `failure` carries WHY the relay conversation itself
 * didn't succeed: a connection refusal, an auth/TLS failure, the relay's own
 * rejection, or a deadline timeout with no relay contact at all — all four
 * are populated (`mailer.ts` synthesizes a generic reason for the timeout
 * case, since no relay error arrived to report). See `MailFailureDetail` for
 * who is allowed to see it. `attempted` with NO `failure` is the one
 * unambiguous case: the relay conversation settled without error before the
 * deadline.
 */
export type MailSendResult =
  | { status: 'attempted'; failure?: MailFailureDetail }
  | { status: 'unavailable' };
