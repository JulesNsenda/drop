# Deploying to DROP from a coding agent (or any remote client)

DROP accepts source uploads over the REST API: tar your project, POST it, poll
until the deploy episode reaches a terminal state, and read the build log on
failure. No git repo required. This is the recipe coding agents (Claude Code,
Cursor) can follow directly from a shell; a native MCP client (`dropkit-mcp`,
PRD-040) will wrap the same calls.

## Prerequisites

- A DROP box with the API reachable (default port 3000, `https://<host>/api/v1`
  behind Caddy).
- An API key with role `user` (mint one in the dashboard, or
  `POST /api/v1/auth/api-keys` as admin). A `user`-role key is automatically
  scoped to the apps it creates — never hand an agent an `admin` key.
- Send the key as `Authorization: Bearer <key>` on every call.

## The loop

### 1. Pack the source

```bash
tar --exclude node_modules --exclude .git --exclude dist --exclude build \
    -czf app.tar.gz -C ./my-app .
```

Do **not** include `.env` files, keys, or credentials — anything in the
archive lands on the server in the app's directory. Inject secrets via the
secrets API instead (`PUT /api/v1/secrets/<app>`).

### 2. Upload

```bash
curl -sS -X POST "$DROP_URL/api/v1/apps/my-app/source" \
  -H "Authorization: Bearer $DROP_API_KEY" \
  -H "Content-Type: application/gzip" \
  --data-binary @app.tar.gz
```

Response is `202 Accepted`:

```json
{ "success": true, "data": { "app": "my-app", "acceptedAt": "2026-07-09T12:00:00.000Z", "isNew": true } }
```

First upload creates the app (owned by your key); later uploads to the same
name redeploy it — files not present in the new archive are removed. Use the
app's `DROP_DATA_DIR` for anything that must survive redeploys.

### 3. Poll the deploy episode

```bash
curl -sS "$DROP_URL/api/v1/deploys?app=my-app&limit=1" \
  -H "Authorization: Bearer $DROP_API_KEY"
```

Wait for an episode with `startedAt >= acceptedAt` whose `status` is terminal
(`succeeded` / `failed` / `superseded`). Poll every 2–3 s; give up after ~10
minutes. The episode's `stages` array tells you which stage failed
(detect / build / start / route) and its failure category.

### 4. On success — the URL

`GET /api/v1/apps/my-app` returns the app's URL (default
`<app>.<baseDomain>`, HTTPS when Caddy is enabled).

### 5. On failure — read the build log, fix, re-upload

```bash
curl -sS "$DROP_URL/api/v1/logs/my-app/build" -H "Authorization: Bearer $DROP_API_KEY"   # latest build log
curl -sS "$DROP_URL/api/v1/logs/my-app?lines=100" -H "Authorization: Bearer $DROP_API_KEY" # runtime stdout/stderr
```

Fix the code, repack, POST to `/source` again. Redeploys bypass the watcher
cooldown, so a rapid fix→redeploy loop works.

## Errors you may hit

| Status | Meaning | What to do |
|--------|---------|------------|
| 400 | Archive rejected (not gzip, unsafe entries, empty, path collisions) or invalid app name | Repack; check the message's reason |
| 404 | App exists but isn't yours (or truly doesn't exist and the name is taken — treat as "pick another name") | Use a different app name |
| 409 | App is mid-build, or was explicitly stopped | Wait and retry; a stopped app must be started or removed first |
| 413 | Archive exceeds the upload cap (default 100 MB compressed) | Trim the archive; check excludes |
| 429 | An upload from your user is already in flight, or rate limit hit | Wait for the in-flight deploy |
| 507 | Server disk watermark reached | Operator action needed |

Caps are operator-configurable: `DROP_MAX_UPLOAD_SIZE_MB` (compressed, default
100), `DROP_MAX_UPLOAD_UNPACKED_MB` (decompressed, default 1024). Archives are
hard-limited to 20,000 entries; symlinks and other non-regular entries are
rejected outright.

## CLAUDE.md snippet for agent projects

Drop this into a project's `CLAUDE.md` so a shell-capable agent can deploy
unaided (set `DROP_URL` and `DROP_API_KEY` in its environment):

```markdown
## Deploying
Deploy this app to DROP when asked:
1. `tar --exclude node_modules --exclude .git -czf /tmp/app.tar.gz -C . .`
2. `curl -X POST "$DROP_URL/api/v1/apps/<APP_NAME>/source" -H "Authorization: Bearer $DROP_API_KEY" -H "Content-Type: application/gzip" --data-binary @/tmp/app.tar.gz`
3. Poll `GET $DROP_URL/api/v1/deploys?app=<APP_NAME>&limit=1` (same auth header) until the newest episode with startedAt >= the acceptedAt from step 2 is terminal.
4. If it failed: `GET $DROP_URL/api/v1/logs/<APP_NAME>/build`, fix, and redeploy from step 1.
5. Report the app URL from `GET $DROP_URL/api/v1/apps/<APP_NAME>`.
Never include .env/keys in the tarball; set secrets via PUT $DROP_URL/api/v1/secrets/<APP_NAME>.
```

## Caveats

- **Windows hosts**: re-uploading over a *running* app is best-effort — files
  held open by the running process can fail to replace (EPERM/EBUSY). If a
  redeploy fails this way, stop the app first, re-upload, then start it. Linux
  hosts don't have this restriction.
- **Isolation**: on multi-user boxes DROP requires `isolation: docker`
  (v2 posture). Even on a single-user box, prefer docker isolation when the
  deploys are agent-generated — code nobody read shouldn't run unsandboxed.
- **App names**: 1–64 chars, alphanumeric plus `-` and `_`.
