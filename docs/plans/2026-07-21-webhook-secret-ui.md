# Plan: GitHub webhook secret — generate & configure from the dashboard

**Date:** 2026-07-21 · **Branch:** `feature/DROP-061-webhook-secret-ui` (from `develop`)
**Status:** awaiting approval

## Goal

An admin can generate (or paste) the GitHub webhook HMAC secret from the dashboard,
copy it and the payload URL straight into GitHub's webhook form, and have the receiver
(`POST /api/v1/git/webhook`) use it immediately — no platform restart, no SSH session.
`DROP_GITHUB_WEBHOOK_SECRET` remains supported as a fallback for headless/bootstrap
setups.

## Approach

**Storage — deliberate decision.** The secret is stored **plaintext** in
`data/drop-svc/settings.json` via `SettingsManager`, protected by file mode `0600`
(not encryption). Rationale: an HMAC secret must be recoverable; on default installs the
encryption key (`data/drop-svc/encryption.key`) sits beside the file and is bundled into
the same backups (`backup.ts:59`), so at-rest encryption with it is theater. The genuine
encrypted alternative (SecretManager under a `__platform__` pseudo-app) was considered and
rejected: it leaks the secret into the per-app secrets API surface and lifecycle, which
would need its own guards. Operators who keep secrets out of files (e.g. `DROP_MASTER_KEY`
setups) keep the env-var path. If platform-level secrets accrete (SMTP, OAuth client
secrets…), that is the trigger to build a proper platform scope in SecretManager — not now.

**Precedence.** Stored (UI) value wins over the env var; `GET /admin/settings` reports the
effective `source` (`'stored' | 'env' | 'unset'` — matching the existing `SettingsSource`
vocabulary), and the UI warns before generate/set when the current source is `env`
("this moves the secret from the environment into DROP's on-disk settings"), so an
env-configured operator opts in knowingly. Fail-closed 503 when neither is set — unchanged.

## File-level changes

### M1 — SettingsManager: field, parsing, permissions
- [x] `src/managers/settings/settings-manager.ts`
  - Add `githubWebhookSecret?: string` to `PlatformSettings`.
  - **Extend `parseSettings` (lines 45–50) to parse the new key** with a
    `typeof x === 'string' && x.length > 0` guard (empty string → `undefined`).
    ⚠ Without this, the whitelist drops the secret on every restart and the next
    `setPublicUrl` save erases it from disk.
  - Add `getGithubWebhookSecret(): string | undefined` (never returns `''`) and
    `setGithubWebhookSecret(secret: string | undefined): Promise<void>` — persist-then-
    commit-in-memory, same shape as `setPublicUrl` (lines 87–105).
  - Write `settings.json` with `{ mode: 0o600 }` in `doSave` (peers `secrets.json`,
    `api-credentials.json`, `webhooks.json` all do; today it inherits umask → 0644).
- [x] `src/core/platform.ts:626` — create `data/drop-svc/` with mode `0o700` (all platform
  components run as the drop user; no-op on Windows).
- [x] `src/managers/settings/settings-manager.test.ts` — round-trip test that **reloads via
  a fresh `new SettingsManager().load()`** (same-instance get/set would mask the
  `parseSettings` bug); empty-string normalization; 0600 mode asserted (skip on win32).

### M2 — Receiver resolution + admin API
- [x] `src/api/routes/git-deploy.ts`
  - Line 139: effective secret =
    `getSettingsManager().getGithubWebhookSecret() ?? process.env.DROP_GITHUB_WEBHOOK_SECRET`.
    (Fail-closed branch is lines 152–166; HMAC verification unchanged.)
  - Update the one-time-warning + 503 message texts (lines 33, 162) to mention the
    dashboard path (Settings → Git webhooks) alongside the env var.
- [x] `src/api/routes/admin.ts`
  - New `buildGithubWebhookPayload()` →
    `{ configured: boolean, source: 'stored'|'env'|'unset', payloadUrl: string | null }`;
    `payloadUrl` = `<getPublicUrl()>/api/v1/git/webhook` or `null` when public URL unset
    (`getPublicUrl()` is fail-closed, `runtime-config.ts:92–98`). Spread into the
    `GET /admin/settings` response **only** — the public-url PUT responses keep their
    current shape.
  - `POST /admin/settings/github-webhook-secret/generate` —
    `crypto.randomBytes(32).toString('hex')`, persist, return `{ secret }` **once**
    (reveal-once; secret appears in no other response). Audit via `tryLogActivity`
    (action only, never the value).
  - `PUT /admin/settings/github-webhook-secret` — `{ secret: string | null }`; `null`/empty
    clears (mirrors the public-url PUT — no separate DELETE). Validation: trim; 8–256
    chars; printable characters only (reject control chars; interior spaces allowed —
    GitHub permits them). Error messages state the rule, never echo the value; the
    too-short message suggests "generate one instead". Audit set/cleared.
  - Both already admin-only via `authMiddleware('admin')` on `/admin/*` (`server.ts:284`).
- [x] `src/api/routes/admin.settings.test.ts` — **update the five full-payload `toEqual`
  assertions** (lines ~102–193) for the new `githubWebhook` block; new tests: generate
  returns 64-hex; secret absent from the full `GET /admin/settings` payload; PUT
  validation + clear; non-admin 401/403; audit entries contain no secret value.
- [x] `src/api/routes/git-deploy.webhook.test.ts` — new cases: signature verifies against a
  stored secret; stored overrides env; env fallback when nothing stored; neither → 503.
  Setup **must** pass `getSettingsManager({ settingsFilePath: <tempdir> })` (the default
  path writes to the real `C:\drop`/`/var/drop`) + `resetSettingsManager()` hygiene.

### M3 — Dashboard
- [x] New admin-gated **"Git webhooks" tab** on SettingsPage (own tab like API Keys — the
  reveal-once flow and payload URL don't fit the read-only System cards; placement keeps
  the publicUrl dependency visible via an inline hint linking to where Public URL is set
  when `payloadUrl` is `null`).
  - Status line from `GET /admin/settings` (`apiJson` client convention, not raw `fetch`):
    Configured (dashboard) / Configured (environment variable) / Not configured.
  - Payload URL (server value; fall back to `window.location.origin` + hint when `null`)
    with copy button; GitHub form hints (content type `application/json`, push event only).
  - Generate → reveal-once panel (ApiKeysTab `idle|reveal` pattern,
    `navigator.clipboard.writeText` + toast, "you won't see this again"); confirm dialog
    when a secret already exists ("existing GitHub webhooks fail until updated") or when
    current source is `env` (posture warning). "Use my own secret" input (PUT) + Clear.
- [x] `src/dashboard/src/pages/DeployPage.tsx:461` — static hint by the auto-redeploy
  checkbox linking to Settings → Git webhooks (no status fetch — the endpoint is
  admin-only and DeployPage isn't).

### M4 — Docs
- [x] `docs/GIT-REDEPLOY-AND-CUSTOM-DOMAINS.md:26–48` — dashboard flow becomes the primary
  instruction; env var documented as fallback with stored-over-env precedence.

## Risks & open questions

- **Plaintext at rest** — deliberate, see Approach; the boundary is 0600 + the residual
  content-leak paths are closed (value never logged, never in GET payloads, audit logs
  action-only; runtime data dir lives outside any git repo).
- **Concurrent settings writes** (PUT vs generate vs setPublicUrl) are read-modify-write
  races in SettingsManager — last write wins, cross-field lost update possible. Known
  limitation; single-admin store, tiny window; not addressed now.
- **Regenerate breaks GitHub until updated** — confirm dialog warns; deliveries 401 in the
  interim (fail-closed, safe).
- **Wrong payload URL behind exotic proxies** when Public URL unset — origin fallback +
  hint; copyable text, user can edit on the GitHub side.
- Existing webhook tests keep passing unchanged (they only set the env var; the lazy
  singleton yields `undefined` → env fallback; Jest isolates modules per file).

## Agent critiques considered

- **security-critic** (revise): settings.json written 0644 today vs 0600 peers — co-tenant
  app could read the global secret and forge redeploy triggers → **adopted** (0600 file,
  0700 dir). Encryption-adds-nothing rationale over-stated → **adopted** (reframed as
  deliberate no-at-rest-protection + residual paths closed). Stored-over-env can silently
  relocate an operator's out-of-file secret to disk → **adopted** (UI posture warning when
  source is `env`). Validation must not echo the value; empty-string `'' ?? env` footgun →
  **adopted**. Authz/CSRF/audit-body-capture: clean.
- **architecture-critic** (revise): `parseSettings` whitelist drops the new key on restart →
  **adopted** (M1, plus fresh-instance reload test). Prefer SecretManager `__platform__`
  scope for real at-rest protection → **rejected with reason** (per-app API surface/
  lifecycle exposure outweighs a benefit that only materializes on `DROP_MASTER_KEY`
  hosts, which keep the env path; framed as deliberate decision + future trigger).
  Drop DELETE, fold clear into PUT like public-url → **adopted**. Separate payload builder,
  `'unset'` not `null` for source → **adopted**. System-tab placement creates cross-tab
  publicUrl dependency → **adopted via own tab + inline hint** (not co-location in the MCP
  tab — discoverability).
- **correctness auditor** (revise): `parseSettings` gap independently confirmed (+ disk
  erasure via later `setPublicUrl`); five `toEqual` payload assertions break; new tests must
  use temp `settingsFilePath`; `payloadUrl` must be `string | null` (template-stringing
  `undefined` bug); stale line-range in draft corrected (152–166); 16-char minimum/whitespace
  ban would block faithful migration of legitimate GitHub secrets → **all adopted**
  (validation relaxed to 8–256 printable, interior spaces allowed). DeployPage discovery
  hint → **adopted**. Concurrent-write race → **documented as known limitation**.
