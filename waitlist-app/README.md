# DROP beta waitlist

A tiny, **zero-dependency** app that runs **on DROP** and powers the beta
waitlist for DROP itself. Drop the folder in, get a URL — that's the whole pitch,
dogfooded.

- Public landing page with a join form → `GET /`
- Admin view (token-gated) → `GET /admin`
- On approve, it creates a real DROP account via DROP's admin API and emails the
  person their login. First dashboard login forces a password change.

No `npm install` needed — Node 18+ built-ins only.

## Deploy on DROP

Copy the folder into the watched webapps directory (or git-deploy it):

```bash
scp -r ./waitlist-app drop@<server>:/var/drop/data/webapps/dropkit   # name = subdomain
# → served at https://dropkit.<your-domain> within seconds
```

To make it the **apex** site (`dropkit.sh`) with the dashboard on a subdomain,
point the apex Caddy route at this app instead of the dashboard (see
`docs/HETZNER-DEPLOY.md` → the apex host file) and move the dashboard route to
e.g. `app.dropkit.sh`.

## Configuration (set as DROP per-app secrets — injected as env)

| Env | Required | Purpose |
|---|---|---|
| `PORT` | auto | Injected by DROP. |
| `DROP_DATA_DIR` | auto | Injected by DROP; `waitlist.json` is stored here (survives upgrades). |
| `WAITLIST_ADMIN_TOKEN` | **yes** | Gate for `/admin`. Admin endpoints fail closed (403) if unset. |
| `DROP_ADMIN_API_KEY` | for invites | A DROP **admin** API key (create one in the dashboard) used to create beta accounts. |
| `DROP_API_URL` | no | DROP API base (default `http://127.0.0.1:3000`). Use the host gateway under Docker isolation. |
| `DASHBOARD_URL` | no | Base for the dashboard link in the welcome email (defaults to `DROP_API_URL`). |
| `RESEND_API_KEY` | for email | [Resend](https://resend.com) API key. Without it, approve still works and returns the temp password to send manually. |
| `EMAIL_FROM` | no | Sender, e.g. `DROP <noreply@dropkit.sh>` (verify the domain in Resend for deliverability). |
| `WAITLIST_INVITES_ENABLED` | no | **Safety gate, default off.** While off, approving only marks entries `approved` and creates **no** accounts. |

Set secrets via the dashboard (Settings → Secrets) or the CLI, then restart the app.

## ⚠️ Before you flip `WAITLIST_INVITES_ENABLED=true`

Approving creates a `user`-role DROP account that can **deploy code**. Running
user code without container isolation is host code execution. **Stand up Docker
isolation (`DROP_ISOLATION=docker`) on the server first**, then enable invites.
Until then, leave invites off — you can still collect signups and approve
(mark) people; no accounts are minted.

## Endpoints
- `GET /` — landing page
- `POST /api/join` `{email, name?}` — public, idempotent
- `GET /admin` — admin UI
- `GET /api/admin/entries` — token-gated list
- `POST /api/admin/approve` `{id}` — token-gated approve/invite
- `GET /health` — `{ok:true}`
