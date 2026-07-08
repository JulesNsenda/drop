# Git redeploys & custom domains

Operator guide for the two most common "day 2" questions: how a git-deployed
app picks up new commits, and how to point a custom domain at an app.

## How git-deployed apps update

**DROP never polls your repository.** After the initial `git` deploy, new
commits reach the platform in exactly two ways:

### 1. Manual redeploy

- **Dashboard**: open the app → **Redeploy** button (shown for git-sourced apps).
- **API**: `POST /api/v1/git/redeploy/:name` (requires `user` role).

Both pull the configured branch and rebuild/restart the app.

### 2. GitHub webhook (auto-redeploy)

Auto-redeploy is **webhook-driven only**. Pushing to GitHub does nothing until
a webhook is configured on both ends:

**Server side (once per platform):**

```bash
# generate a secret
openssl rand -hex 32

# add it to /etc/drop/drop.env
DROP_GITHUB_WEBHOOK_SECRET=<the generated value>

# restart the platform
systemctl restart drop
```

The webhook endpoint is **fail-closed**: while `DROP_GITHUB_WEBHOOK_SECRET` is
unset, `POST /api/v1/git/webhook` answers `503` and no auto-redeploy can
happen, even if GitHub is already sending events.

**GitHub side (once per repository):**

Repo → *Settings* → *Webhooks* → *Add webhook*:

| Field | Value |
|---|---|
| Payload URL | `https://<your-platform-domain>/api/v1/git/webhook` |
| Content type | `application/json` |
| Secret | the same `DROP_GITHUB_WEBHOOK_SECRET` value |
| Events | *Just the push event* |

Signatures are verified from the `X-Hub-Signature-256` header
(HMAC-SHA256 over the raw body, timing-safe compare).

**Matching rules** — a push triggers a redeploy for every app where:

- the app was deployed from git with **Auto-redeploy** enabled (the deploy
  form checkbox; on by default, stored in `gitSource.autoRedeploy`),
- the pushed repository URL matches the app's repo URL (case-insensitive,
  trailing `.git` ignored),
- the pushed branch **exactly** matches the app's configured branch.

One webhook covers all apps deployed from that repository.

## Custom domains

### 1. DNS (at your registrar)

Point the hostname at the DROP server **before** anything else — the
Let's Encrypt HTTP challenge needs the name resolving to the box:

| You want | Record | Value |
|---|---|---|
| `app.example.com` (subdomain) | `CNAME` | your platform hostname (e.g. `dropkit.sh`) |
| `app.example.com` (alternative) | `A` | the server's public IP |
| `example.com` (apex/root) | `A` (or `ALIAS`/`ANAME` if offered) | the server's public IP |

Apex domains cannot use CNAME. Verify with `nslookup app.example.com` before
continuing.

### 2. Declare the domain in the app's `drop.yaml`

Create/edit `drop.yaml` in the **app root** (next to `package.json` /
`index.html`):

```yaml
domains:
  - app.example.com
```

List every hostname the app should answer on. The app always keeps its
default `<app>.<platform-domain>` hostname in addition.

### 3. Redeploy the app

Routes are configured when the app (re)starts through the deploy pipeline —
use the dashboard **Redeploy** button (git apps) or redeploy the folder. Under
docker isolation a plain *Restart* is **not** sufficient to configure routing.

Caddy then provisions the Let's Encrypt certificate automatically (ports
80/443 must be reachable, which the standard install handles).

### Notes & caveats

- **Cross-tenant guard**: a domain already claimed by another app is refused
  (logged as a warning); the app stays reachable on its default hostname.
- **Custom certificates**: `tls: { certFile, keyFile }` in `drop.yaml` uses
  your own cert instead of Let's Encrypt; `tls: { disabled: true }` turns TLS
  off for that app.
- **Dashboard "Custom Domain" field**: currently only changes the URL shown in
  the dashboard/API and certificate visibility — it does **not** configure
  routing. Use `drop.yaml` `domains:` for actual routing (known gap, tracked
  for a future release).
