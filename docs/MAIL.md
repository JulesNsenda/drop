# Mail — sending through your own relay

DROP can send a handful of transactional messages: a test message so you can
confirm a relay is configured correctly, and (opt-in) a notice to someone an
owner has just shared an app with. This page is about what those messages
need to actually arrive, and what the stored credential does and does not
protect.

---

## Relay only — DROP does not deliver mail itself

DROP has no outbound mail identity of its own. `PUT /api/v1/admin/settings/mail`
points it at an SMTP relay you already control — Google Workspace, Microsoft
365, Amazon SES, Postmark, or any provider that accepts SMTP AUTH — and every
message goes out through that relay's reputation, not DROP's.

This isn't a missing feature; it's the only workable design. A self-hosted box
sending unauthenticated mail directly to recipients' inbox providers gets
spam-filtered or outright rejected almost immediately, and the failure mode
compounds: once a sending IP earns a bad reputation, it stays bad long after
the underlying problem is fixed, and it can drag every other tenant sharing
that IP down with it. Relaying through a provider that already does the work
of maintaining sender reputation is the only path that reliably lands in an
inbox.

## DNS records the relay needs — deliverability is not a code property

Pointing DROP at a relay is necessary but not sufficient. Whatever domain
`mailFrom` uses, that domain's DNS needs to authorize the relay to send on its
behalf, or receiving mail servers will flag or drop the message regardless of
anything this codebase does:

- **SPF** — a `TXT` record on the sending domain listing the relay as an
  authorized sender (e.g. `v=spf1 include:_spf.google.com ~all` for Workspace).
  Without it, a receiving server can't tell your relay's send from a spoofed
  one.
- **DKIM** — the relay signs each message with a private key, and the
  domain publishes the matching public key as a `TXT` record (the relay's
  onboarding flow gives you the exact record — usually a
  `<selector>._domainkey.<domain>` name). This is what proves the message
  wasn't altered in transit and really came from where it claims.
- **DMARC** — a `TXT` record at `_dmarc.<domain>` stating what a receiver
  should do when SPF/DKIM fail (`p=none`, `p=quarantine`, or `p=reject`) and
  where to send aggregate reports. Start at `p=none` while you confirm SPF and
  DKIM are both passing, then tighten it.

Get these three right with your relay provider **before** relying on
`POST /api/v1/admin/mail/test` succeeding as proof that real recipients will
receive mail — a successful relay handshake only means the relay accepted the
message for delivery, not that it survived the receiving side's spam
filtering. If invites or notifications aren't arriving, check these records
first; DROP has nothing further to diagnose on its end (see "What DROP tells
you" below).

## What DROP tells you when a send doesn't work

`sendTemplatedMail`'s status is decided **before** the relay conversation
starts, and is never derived from the SMTP reply. A 550 (unknown recipient) or
552 (mailbox full) response is never surfaced to a caller — doing so would
turn any send path into an oracle for enumerating valid addresses on the
operator's own mail domain. So a grant, an invite, or a test send will report
`'sent'` once DROP has successfully handed the message to the relay, and
`'unavailable'` when it couldn't even attempt that (no relay configured, no
stored/env credential, or the input failed validation) — never a bounce
reason. Relay diagnostics (including the real SMTP response) go to the
platform log only. If you need to confirm actual delivery, check the relay
provider's own delivery/bounce reporting, not DROP.

---

## What the stored password's encryption does and does not buy

The SMTP password is encrypted at rest with AES-256-GCM using the platform's
`encryption.key`, in its own `data/drop-svc/mail-credential.json` (mode
`0600`) — not in `settings.json`. It's set via its own write-only route,
`PUT /api/v1/admin/settings/mail/credential`; `GET /api/v1/admin/settings`
reports only a boolean, `mail.credentialConfigured`, never the value.

Be clear-eyed about the threat model this covers. `encryption.key` lives in
the **same** `0700` `data/drop-svc/` directory as the ciphertext it protects.
Anyone with read access to that directory — root on the box, or anyone who can
read a `drop backup` archive — can decrypt it exactly as DROP itself does.
What the encryption actually buys is narrower than "the password is safe at
rest": it protects the password from a `drop backup` artifact **leaving the
box** (a backup file copied somewhere else, uploaded, or emailed on for
support) without the key alongside it. It is not a substitute for controlling
who can read the box's filesystem.

Two operational implications follow directly:

- **`DROP_SMTP_PASSWORD` is the documented production path.** Setting the
  password via this environment variable means it is never written to disk by
  DROP at all — it's read fresh from the environment on every send and always
  wins over anything stored. If your process manager or secrets store already
  keeps environment variables out of ordinary file access, this is a strictly
  better posture than the on-disk store.
- **Exclude `encryption.key` from the backup bundle**, or a `drop backup`
  archive is self-decrypting: an attacker who obtains the archive gets both
  the ciphertext and the key needed to read it, and the encryption bought
  nothing for that specific artifact. (`encryption.key` also protects the TOTP
  and other secrets under `data/drop-svc/` — this isn't mail-specific advice,
  but it's worth restating here since the mail credential is the reason you're
  reading this page.)

## TLS is forced, not configured

Every send requires `requireTLS: true` and `tls.rejectUnauthorized: true` —
these are not admin-settable fields, and there is no dashboard toggle for
either. Without a forced STARTTLS upgrade, `smtpSecure: false` on port 587 is
*opportunistic* STARTTLS: an on-path attacker can strip the upgrade attempt
and force the session to stay in plaintext, at which point both the relay
password and every message body cross the network readable.

The one escape hatch is `DROP_SMTP_ALLOW_INSECURE_TLS=true`, an environment
variable only — deliberately not exposed anywhere in the dashboard or the
settings API. It exists for a narrow, deliberate case: an internal relay
reachable only on a trusted network, presenting a self-signed or
otherwise-unverifiable certificate. Relaxing certificate validation should
require editing the box's environment and restarting the platform, not be one
click away for anyone with admin access to the dashboard.

## Changing the relay host clears the stored password

`PUT /api/v1/admin/settings/mail` clears the stored SMTP password whenever
`host` changes, and requires the password to be re-entered (via
`PUT /api/v1/admin/settings/mail/credential`) against the new host.

This isn't a UX rough edge — it's the fix for a real exfiltration path. If the
stored password instead traveled forward automatically, an admin account (or
anyone who can reach the settings API with an admin credential) could point
`host` at a host they control and immediately trigger
`POST /api/v1/admin/mail/test`, which would authenticate to *that* host using
the *old* relay's credential — handing the real relay password to any
attacker-chosen destination. Forcing re-entry means the credential can never
be redirected somewhere it wasn't explicitly placed.

---

## The share-notification consumer defaults OFF

When `shareNotificationsEnabled` is on, granting someone access to an app
(`PUT /apps/:name/share`) sends them a notice naming the app and who shared
it. The setting defaults to **off**, and that default is a deliberate,
documented tradeoff rather than an oversight:

**DROP does not verify email addresses.** `createUser` enforces no uniqueness
on `email`, and `updateUser` writes it unvalidated. On a box with signups
enabled, nothing stops a stranger from registering an account using a
colleague's real email address. If notifications were on by default, that
stranger would receive a message naming an app their colleague was just
granted access to and who granted it.

The notification carries no credential and no way to open the app — it
discloses only the app's name and the sharer's username. That's a smaller
exposure than a leaked password, but an app's name can itself be sensitive
(e.g. it can reveal an internal project, a client, or a product that hasn't
shipped yet), so it isn't nothing either.

Turning `shareNotificationsEnabled` on is an operator explicitly accepting
that tradeoff — appropriate on a box where signup is closed or where every
user is already known and trusted, less appropriate on an open-signup
install. It is not a decision DROP makes for you by defaulting it on. It's set
together with the relay fields, in the same `PUT /api/v1/admin/settings/mail`
call shown below.

---

## Setting it up

```bash
# Configure the relay (host/port/secure/user/from, plus the notification
# toggle). A field left out of the body is left untouched; `GET
# /api/v1/admin/settings`'s `mail` object reports these back, along with a
# `credentialConfigured` boolean — never the password.
curl -X PUT https://<your-drop>/api/v1/admin/settings/mail \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{
    "host": "smtp.gmail.com",
    "port": 465,
    "secure": true,
    "user": "drop@yourdomain.com",
    "from": "drop@yourdomain.com",
    "shareNotificationsEnabled": true
  }'

# The password is a SEPARATE, write-only call — never bundled into the body
# above, and never returned by any GET.
curl -X PUT https://<your-drop>/api/v1/admin/settings/mail/credential \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"password": "an-app-specific-password"}'

# Confirm the relay actually accepts a send. This only proves DROP could hand
# the message to the relay — see "What DROP tells you" above for what it does
# NOT prove.
curl -X POST https://<your-drop>/api/v1/admin/mail/test \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"to": "you@yourdomain.com"}'
```

Prefer `DROP_SMTP_PASSWORD` over the API-set password wherever your deployment
already keeps environment variables off the box's ordinary filesystem — see
"What the stored password's encryption does and does not buy" above.
