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
as usual. This is a real coupling between control-plane and tenant availability
and it is not currently mitigated. Plan gated apps' maintenance windows around
platform deploys.

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

On an admitted request the app is given two headers:

```
X-Drop-Session-User-Id: <the DROP user id>
X-Drop-Session-Username: <their username>
```

DROP's own cookies and credentials are stripped on the hop to the app, so a
compromised app cannot harvest them from its own inbound traffic. Client-sent
copies of those two headers are stripped before DROP sets them, so an app can
trust them.

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
