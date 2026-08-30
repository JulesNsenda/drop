# Access gate — putting a sign-in in front of an app

DROP can require a sign-in before anyone reaches a deployed app. The app itself
needs no code change and no awareness of it: the gate runs in the reverse proxy,
and the app is told who the visitor is through request headers.

This is **who may OPEN an app** — deliberately a different question from who may
*manage* it. Gating an app to a review board does not let that board deploy,
restart, or read its secrets.

---

## Turning it on

**Dashboard** → the app → **Access** → tick the people who may open it →
**Require sign-in**.

The owner and any administrator can always open the app. The list is everyone
*else*.

The same thing over the API, admin credential required:

```bash
# user ids, not usernames — a username can be reassigned
curl -s https://<your-drop>/api/v1/auth/users -H "Authorization: Bearer $ADMIN"

curl -X PUT https://<your-drop>/api/v1/apps/<app>/access \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"allow":["<user-id>"],"reviewBy":"2026-12-01"}'
```

**An empty list is not the same as no gate.** An empty list still requires a
sign-in and admits the owner and administrators. Removing the gate lets anyone
who can reach the app open it.

---

## Letting owners share their own app

By default, only an administrator can gate an app or edit its allow-list — the
`/access` route above is admin-only. A separate, admin-controlled toggle lets
an app's **owner** manage their own app's allow-list without filing an admin
ticket for every add or remove:

```bash
curl -X PUT https://<your-drop>/api/v1/admin/settings/app-sharing \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"enabled":true}'
```

This ships **disabled by default** — a new product surface, not something
turned on to preserve existing behaviour. Once enabled, an app's owner can, at
`/apps/<app>/share`:

- turn a gate on or off for their own app, and add or remove entries they
  themselves granted;
- see their own grant plus a count of everyone else's — never another user's
  id or username.

An owner can never touch an entry an administrator placed on their app, and
`reviewBy` and removing a policy that carries any admin-authored entry both
stay admin-only — an owner-reachable route governs only what the owner
themselves granted, never the admin-authored governance list.

---

## Inviting someone with no DROP account

An owner can also admit a person who has no account here at all. They receive an
email, click it, press a button, and are in the app — with no password, no
signup, and access an owner or admin can take away at any time.

This is a **second** admin toggle, on top of app sharing, and it ships disabled:

```bash
curl -X PUT https://<your-drop>/api/v1/admin/settings/guest-invites \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"enabled":true}'
```

It is separate from `app-sharing` deliberately. That one gates mail to an
address DROP already holds, put there by an admin at user creation. This one
lets an owner have DROP send mail to **any address on the internet**, from your
relay, over your SPF/DKIM alignment. Those are different things to consent to,
and an operator may reasonably want the first without the second.

Once on, an owner invites at the same route as an ordinary share:

```bash
curl -X POST https://<your-drop>/api/v1/apps/<app>/share \
  -H "Authorization: Bearer $OWNER" -H 'Content-Type: application/json' \
  -d '{"email":"visitor@example.com"}'
```

**If no SMTP relay is configured, the response carries the invitation link and
the owner has to deliver it themselves.** The secret exists in plaintext exactly
once, in that response — nothing stores it — so this is also the only way to
invite anyone on a platform without mail. When a relay *is* configured the link
is never returned.

### What an operator should know

- **An invitation is single-use and expires in 24 hours.** A guest session lasts
  8 hours, the same as an account holder's. There is no self-service re-entry:
  the recovery path for a lost or expired invitation is the owner pressing
  **Resend**, which mints a fresh link.
- **A guest belongs to exactly one app.** The same address invited to a second
  app is a separate record with a separate grant.
- **An address cannot be both.** DROP refuses to invite an address that belongs
  to an account, and refuses to give an account an address a guest holds —
  otherwise one mailbox would map to two principals with different
  authorization paths. Both refusals are deliberately vague, because a specific
  one would let a caller enumerate who is on the platform.
- **Guest records expire.** Ninety days after a guest last opened the app — or
  after the invitation was sent, if they never did — the record and its grant
  are reaped. Set `DROP_GUEST_RETENTION_DAYS` to change the window, or `0` to
  keep guests indefinitely. This is the only retention DROP applies to guest
  email; the activity log records guest **ids**, not addresses, so revoking a
  guest really does remove their address from the platform.
- **Volume is bounded per person**, not globally: `DROP_MAX_INVITES_PER_HOUR`
  (10) and `DROP_MAX_INVITES_PER_HOUR_PER_USER` (25). Refused attempts count,
  so a loop cannot mint for free.

### Revoking, and the difference between revoke and disable

An **owner** can revoke a guest they invited — the grant and the record go, and
any unredeemed invitation goes with them. Nothing stops them inviting the same
address again afterwards.

An **admin** can *disable* a guest instead:

```bash
curl -X PATCH https://<your-drop>/api/v1/apps/<app>/share/guests/<guestId> \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"disabled":true}'
```

Disabling ends every live session for that guest immediately and leaves a record
the owner cannot delete, so re-inviting the address resolves back to the
disabled one rather than creating a fresh, enabled guest. That is the difference:
a revoke is an owner changing their mind, a disable is an administrator's
decision that the owner cannot undo. It is one-way — to reverse it, an admin
deletes the record and the owner re-invites.

Turning `guest-invites` **off** is a full stop, not just a stop on new
invitations: unredeemed invitations stop working, and every existing guest
session stops opening its app. Nothing is deleted, so turning it back on
restores exactly what was there.

---

## Turning the whole gate off

`DROP_FEATURE_ACCESS_GATE` (env, boot-time, default **on**) is the operator
kill switch for the feature as a whole — distinct from clearing an individual
app's policy. Set it to `false` to disable the gate platform-wide:

- **guards are withdrawn at the next boot sweep or route re-emission** — an
  existing policy is not deleted, just no longer carried into Caddy;
- **the verify hop admits every request** in the meantime, so nobody is locked
  out behind a guard that Caddy is still holding stale (the flag is read live,
  not only at emission);
- **the routing narrowing a gated app normally gets is lifted** — an app
  carrying a policy is ordinarily kept off any plaintext or reserved hostname
  so it can't disable its own gate by adding one; with the kill switch off,
  that narrowing is relaxed too, so the app keeps serving instead of being
  routed nowhere.

Turning it back on does not retroactively re-apply anything — it takes effect
the same way turning an individual app's gate on does, at the next route
emission.

---

## Why it might refuse

A gate lives in Caddy, so it protects exactly what Caddy is the only way in to.
Several ordinary configurations break that, and DROP refuses rather than
emitting a control that does not hold — a gate that silently fails is worse
than none, because the dashboard would report the app as protected either way.

| Refusal | What to do |
|---|---|
| not running in docker isolation | Under `isolation: none` each app binds its own port on the host and is reachable directly, bypassing the proxy entirely. |
| API authentication disabled | There is no principal to gate on. |
| the app is not served over HTTPS | The session cookie is `Secure`; a browser would drop it and the visitor would loop through the login forever. |
| inter-container traffic is enabled on `drop-net` | Any tenant container can reach this app directly. Restart DROP with no running containers to re-disable it. |
| the app is a monorepo child or container | Group children share one hostname, so gating one leaves its siblings open on the same origin. |
| no public URL configured | There is nowhere to send a visitor to sign in. |
| the app is routed on more than one hostname | The session cookie is host-only, so a visitor arriving on any other hostname would loop. |

The API returns these as a `409` naming every failed premise at once, so you
can fix them in one pass rather than discovering them one at a time.

---

## What an operator should know before turning it on

**A gated app is unavailable while DROP itself is restarting.** The gate asks
DROP's own API on every request, so a platform deploy or restart takes every
gated app down for that window — while ungated apps keep serving from the proxy
as usual. This is a real coupling between control-plane and tenant availability,
and it is a property of asking a live service on every request rather than
something a configuration change removes.

What *has* changed is what the visitor sees. Measured against Caddy 2 with the
verify upstream unreachable, the response used to be an HTTP 502 with an empty
body and no `Content-Type` — a blank tab. It is now a page saying the app is
temporarily unavailable, with `Retry-After: 10`, which reloads itself and lands
the visitor back in the app once DROP returns.

**It still fails closed.** The page replaces the *presentation* of the failure,
never the decision: it fires only on the 502/503/504 that an unreachable
upstream produces, so a real refusal (401, 403, the gate's own redirect) passes
through untouched, and it serves no tenant content and proxies nothing.
Verified against a live Caddy in all four combinations — verify up and allowing
(200, app served), up and refusing (401), and down either way (503, page).

One caveat worth knowing: that page is served for *any* 502/503/504 on a gated
app, including one from the tenant's own upstream. Caddy cannot distinguish them
at that point, so the wording says "temporarily unavailable" rather than naming
a cause it cannot know.

Plan gated apps' maintenance windows around platform deploys regardless — a
retrying page is better than a blank one, but it is still downtime.

**A gated app's MCP endpoint answers `401`, not a redirect.** Machine clients
present a token and hold no browser session, so they get the challenge that
starts their OAuth flow rather than a login page they cannot follow. Browser
traffic to the same app is unaffected.

**Revocation is immediate, and it is account-level or list-level.** Removing
someone from the allow-list, disabling their account, or suspending them stops
them opening the app on their *next request* — the platform re-reads the live
user record every time rather than trusting the session. There is no
"revoke this one session" action today.

**Sessions last 8 hours** and are scoped to one app: a session for `app-a` is
not a session for `app-b`, and it is not a DROP control-plane credential.

---

## What the app receives

On an admitted request the app is given the identity of whoever was let in.

An account holder:

```
X-Drop-Session-User-Id: <the DROP user id>
X-Drop-Session-Username: <their username>
```

A guest — a **different header name**, and none of the account-holder ones:

```
X-Drop-Guest-Id: guest:<uuid>
```

The names differ so an app tells the two apart by which header arrived, rather
than by interpreting a value. A guest id is namespaced `guest:` and is not a
DROP user id; matching one against your own user table finds nothing.

DROP's own cookies and credentials are stripped on the hop to the app, so a
compromised app cannot harvest them from its own inbound traffic. All three
identity headers are stripped from the incoming request and re-added by DROP
after it has authenticated, so an app can trust them.

> **One caveat, on apps gated before this feature shipped.** The strip and
> re-add are written into each app's proxy configuration when its route is
> emitted. An app whose configuration predates guest support does not strip
> `X-Drop-Guest-Id`, so a client could send one itself — the app would see the
> client's value. Such an app receives no *account-holder* headers for a guest
> either way, so it fails closed rather than confusing a guest for a user. Any
> deploy, restart or platform reboot re-emits the configuration and closes it.

---

## Checking whether it is actually working

The Access tab distinguishes three things that are easy to conflate, and you
want all three:

- **enforceable** — this platform *could* carry a gate for this app;
- **enforced** — this build puts one in front of traffic;
- **gate applied** — the last route change actually reached the proxy.

A capable platform whose last route emission the proxy rejected shows as
**Gate NOT applied**, with a warning rather than a green shield. That is the
state worth acting on: a policy exists and traffic is not being gated.

The tab also shows who has opened the app recently, and when it was last opened
at all — the signal a stale-app review is really asking about.
