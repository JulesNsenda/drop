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
filtering. If invites or notifications aren't arriving, run
`POST /admin/mail/test` first: a `failure` in its response is the relay
telling you something concrete (see "What DROP tells you" below). If it comes
back `'attempted'` with no `failure`, DROP has nothing further to diagnose on
its end — check these DNS records next.

## What DROP tells you when a send doesn't work

`sendTemplatedMail` reports one of two statuses, `'attempted'` or
`'unavailable'` — there is no `'sent'`, because that name implied a
delivery guarantee the code never actually observed: even a deadline timeout
with no relay contact at all used to come back as `'sent'`. `'attempted'`
means a relay conversation was started and awaited (up to a 5s deadline) —
not that the relay accepted the message for delivery, still less that it
reached an inbox. `'unavailable'` means DROP never dialed the relay at all:
no host/from configured, no usable credential (see the host-binding trap
below), the relay host was refused before any conversation started (see
`DROP_SMTP_ALLOW_PRIVATE_RELAY` below), or the input failed validation.

`status` alone is still decided **before** the relay conversation and is
never derived from the SMTP reply — a 550 (unknown recipient) or 552
(mailbox full) response never flips `'attempted'` to something else, because
surfacing that distinction to an arbitrary caller would turn any send path
into an oracle for enumerating valid addresses on the operator's own mail
domain. What changed is that `'attempted'` now carries an optional `failure`
alongside it — a connection refusal, an auth/TLS failure, the relay's own
rejection text, or a timeout with no response — and there is exactly one
caller allowed to see it: `POST /admin/mail/test` returns
`{ status, failure }` in its response body, because the caller there both
owns the relay and supplied the recipient address themselves, so there's no
third party to enumerate against. Every other send path (the share
notification) still never surfaces `failure` to anyone it responds to.

Whether or not `failure` reaches a response, the same reason string always
goes to two places for the operator to find: the platform's own stderr
(`[mailer] send attempt failed for template=...`, so `journalctl` on a
systemd box, not a file DROP manages), and — for `POST /admin/mail/test`
specifically — the activity log, as an `mail-test-sent` entry whose `detail`
includes `failure=<reason>` whenever the send didn't cleanly succeed. If
invites or notifications aren't arriving even though a test send comes back
`'attempted'` with no `failure`, that's exactly the case DROP has nothing
further to diagnose on — check the DNS records above and the relay
provider's own delivery/bounce reporting instead.

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

- **`DROP_SMTP_PASSWORD` is the documented production path — but it is
  REQUIRED to travel together with `DROP_SMTP_HOST`.** Setting the password
  via this environment variable means it is never written to disk by DROP at
  all — it's read fresh from the environment on every send. But unlike the
  stored credential (below), an env-set password has no `settings.json`
  record of which host it was meant for, so DROP will only honour it when
  `DROP_SMTP_HOST` is also set and strict-equals (case-insensitively) the
  currently-configured `smtpHost`. This isn't a formality: without that
  binding, an admin who repoints `smtpHost` at a host they control — or a
  hijacked admin session doing the same — could immediately trigger
  `POST /admin/mail/test` and have it authenticate to *that* host using the
  real relay password, exactly the redirection the host-change-clears-the-
  password rule below exists to prevent for the on-disk credential. Set both
  or neither: if `DROP_SMTP_PASSWORD` is set without a matching
  `DROP_SMTP_HOST`, every send reports `'unavailable'` rather than falling
  back to a stored credential that may be for a different relay entirely —
  and, sharper still, `GET /admin/settings`'s `mail.credentialConfigured`
  does **not** apply this binding check, so it can report `true` (something
  is configured) while every actual send fails, because that boolean only
  answers "is *a* credential present," not "would a send succeed right now."
  If your process manager or secrets store already keeps environment
  variables out of ordinary file access, the env path (both variables) is a
  strictly better posture than the on-disk store.
- **Exclude `encryption.key` from the backup bundle**, or a `drop backup`
  archive is self-decrypting: an attacker who obtains the archive gets both
  the ciphertext and the key needed to read it, and the encryption bought
  nothing for that specific artifact. (`encryption.key` also protects the TOTP
  and other secrets under `data/drop-svc/` — this isn't mail-specific advice,
  but it's worth restating here since the mail credential is the reason you're
  reading this page.)

## TLS is forced, not configured

Every send requires `requireTLS: true` — this is **unconditional**: there is
no env var, admin-settable field, or dashboard toggle that turns it off.
Without a forced STARTTLS upgrade, `smtpSecure: false` on port 587 is
*opportunistic* STARTTLS: an on-path attacker can strip the upgrade attempt
and force the session to stay in plaintext, at which point both the relay
password and every message body cross the network readable. A relay that
doesn't advertise STARTTLS now fails the connection outright — it never gets
downgraded to cleartext, regardless of any escape hatch below.

The one escape hatch, `DROP_SMTP_ALLOW_INSECURE_TLS=true` (an environment
variable only, deliberately not exposed anywhere in the dashboard or the
settings API), relaxes **only** `tls.rejectUnauthorized` — certificate
verification. It does not, and cannot, touch `requireTLS`. That's narrower
than it may sound at first, and deliberately so: an earlier version of this
flag also disabled `requireTLS`, which meant a relay that simply didn't
advertise STARTTLS got the session in cleartext — exactly the outcome this
whole section says DROP doesn't permit. It exists for one legitimate case: an
internal relay reachable only on a trusted network, presenting a self-signed
or otherwise-unverifiable certificate, where you still want the STARTTLS
upgrade enforced, just not against a public CA. Relaxing certificate
validation should require editing the box's environment and restarting the
platform, not be one click away for anyone with admin access to the
dashboard.

## Refusing to dial a relay on your own network

`POST /admin/mail/test` lets an admin name an arbitrary `smtpHost` (via
`PUT /admin/settings/mail`) and then have DROP connect to it — which, left
unchecked, makes the platform a usable port scanner against its own private
network: an admin (or a hijacked admin session) can point `host` at
`127.0.0.1`, a `10.x`/`172.16.x`/`192.168.x` address, or a link-local
address, and time the connection attempt to learn what's listening there.
DROP refuses to dial a relay host that resolves into a
loopback/link-local/private range — the same shared SSRF guard that already
blocks tenant-controlled URLs (webhooks, git clones, `depends_on`) — and
reports `'unavailable'` rather than attempting the connection.

For the legitimate case — an actual internal relay on a private range — set
`DROP_SMTP_ALLOW_PRIVATE_RELAY=true`. Like the TLS escape hatch, it's an
environment variable only, a per-box opt-in rather than anything reachable
through the admin API.

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
attacker-chosen destination. Forcing re-entry means the **stored** credential
can never be redirected somewhere it wasn't explicitly placed. The
`DROP_SMTP_PASSWORD` env path has no host to clear on a `PUT` — it gets the
equivalent guarantee from the `DROP_SMTP_HOST` binding described above
instead.

---

## Outbound volume is capped, separately from deploys

Every mail send — the share notification and `POST /admin/mail/test` alike —
is metered against a mail-specific quota, two rolling one-hour windows: how
many sends a single principal (an API key, an agent session) has made
(`DROP_MAX_MAILS_PER_HOUR`, default 20), and how many a single human has made
across every credential and session they hold (`DROP_MAX_MAILS_PER_HOUR_PER_USER`,
default 50). Exceeding either refuses the send with a structured 429 (on
`POST /admin/mail/test`) or a silent skip (on the share notification, which
never fails the grant it's attached to).

These are **deliberately separate** from `DROP_MAX_REDEPLOYS_PER_HOUR` and
`DROP_MAX_REDEPLOYS_PER_HOUR_PER_USER`, the equivalent deploy-guardrail
limits — an operator tightening redeploy quotas after a build-storm incident
must not silently tighten outbound mail too, a coupling between two unrelated
controls nobody would expect. `POST /admin/mail/test` also sits behind its
own dedicated rate-limit bucket (10 requests/minute, independent of the
general admin traffic bucket) — the quota and the rate limit are different
controls for different reasons: the bucket caps *how fast* one caller can
hit the route, the quota caps *how much* real relay send volume any principal
or user burns over an hour, however they're spread out.

---

## The share-notification consumer defaults OFF

When `shareNotificationsEnabled` is on, granting someone access to an app
(`POST /apps/:name/share`) sends them a notice naming the app and who shared
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

## Configuration reference

Mail configuration is spread across three different stores, each with a
reason: `settings.json` for anything an admin may click, its own encrypted
file for the one secret, and env-only for anything that is either a
credential or a safety opt-out an admin session should not be able to flip.
The API body field names also don't match the `settings.json` keys they're
stored under — that mismatch is the single biggest reason it's hard to
predict where to look, so both are listed here.

| Setting | `PUT /admin/settings/mail` body field | `settings.json` key | Env var | Notes |
|---|---|---|---|---|
| Relay hostname | `host` | `smtpHost` | — | Changing this clears the stored credential (see above). |
| Relay port | `port` | `smtpPort` | — | 1-65535. |
| Implicit TLS vs. STARTTLS | `secure` | `smtpSecure` | — | `true` = implicit TLS (typically 465); `false` = STARTTLS (typically 587) — `requireTLS` is forced either way. |
| Auth username | `user` | `smtpUser` | — | Falls back to `from` if unset. |
| `From:` address | `from` | `mailFrom` | — | Also the domain your SPF/DKIM/DMARC records need to authorize. |
| Share-grant notification toggle | `shareNotificationsEnabled` | `shareNotificationsEnabled` | — | Defaults **off**. |
| Relay password | — (own route: `PUT /admin/settings/mail/credential`) | never — its own `mail-credential.json`, AES-256-GCM | `DROP_SMTP_PASSWORD` | A set env password preempts the stored value entirely — it does NOT fall back to the stored credential if `DROP_SMTP_HOST` is unset/mismatched; every send just fails `'unavailable'`. See above. |
| Env password's host binding | — | — | `DROP_SMTP_HOST` | **Required** alongside `DROP_SMTP_PASSWORD`; without a match, every send is `'unavailable'`. |
| Certificate verification relaxation | — | — | `DROP_SMTP_ALLOW_INSECURE_TLS` | Relaxes `tls.rejectUnauthorized` only — `requireTLS` is never affected. |
| Private/internal relay allowance | — | — | `DROP_SMTP_ALLOW_PRIVATE_RELAY` | Opt-in past the SSRF guard that otherwise refuses loopback/link-local/private-range relay hosts. |
| Mail volume, per principal | — | — | `DROP_MAX_MAILS_PER_HOUR` | Default 20/hour. Separate from the deploy quota. |
| Mail volume, per human | — | — | `DROP_MAX_MAILS_PER_HOUR_PER_USER` | Default 50/hour, across every credential/session that human holds. |

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
# NOT prove. The response is `{"status": "attempted"}` on a clean send, or
# `{"status": "attempted", "failure": {"reason": "..."}}` when the relay
# conversation itself errored (auth, TLS, connection, or a bounce) — this is
# the one route that echoes the relay's own diagnostic back to the caller.
curl -X POST https://<your-drop>/api/v1/admin/mail/test \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"to": "you@yourdomain.com"}'
```

Prefer `DROP_SMTP_PASSWORD` over the API-set password wherever your deployment
already keeps environment variables off the box's ordinary filesystem — see
"What the stored password's encryption does and does not buy" above. Set
`DROP_SMTP_HOST` alongside it, matching the `host` configured above exactly
(case-insensitive) — without it, DROP treats the env password as
unconfigured rather than falling back to a stored credential for a
possibly-different relay.
