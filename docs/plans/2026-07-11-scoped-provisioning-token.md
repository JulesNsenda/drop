# Plan (PR2): scoped per-app provisioning token

**Date:** 2026-07-11
**Status:** DRAFT — awaiting approval (do not implement yet)
**Slug:** `scoped-provisioning-token`
**Companion to:** `2026-07-10-drop-api-reachability-from-containers.md` (PR1). PR1 ships the
reachability fix first; **this PR2 lands before the waitlist app is repointed off its
current admin key.**

## Goal

Today a hosted app that provisions DROP accounts holds a **full admin key** (manually set
as a secret). The `admin` role bypasses all ownership (`access.ts:15`), and `POST
/auth/users` lets an admin create users of **any** role (`auth.ts:249-261`) — so any
RCE/dependency vuln in that one app converts to full cross-tenant platform takeover.

Replace that with a **least-privilege token** DROP mints and injects: it can create
`user`-role DROP accounts **and nothing else**. No app ever holds an admin key.

Decisions locked with the user:
- **Q1 = the app genuinely needs real DROP platform users** → build the token.
- **Q2 = admin-conferred grant, default none** — a tenant cannot self-grant `users:create`.
- **Q3 = inject `DROP_API_KEY`, app sends `X-API-Key`** — do **not** broaden the `Bearer`
  path platform-wide.

## Honest residual (this token is not "insert-only")

The caller sets the new user's password and `POST /auth/login` is public (rate-limited
only). So a holder of `users:create` can create a user with a known password and then log
in as a **user-tier** session — deploying apps up to `maxApps`, with **no global cap on
user count**. So a leaked scoped key → account/app spam bounded only by rate limits +
`maxApps` (not nil), but **vastly** smaller than the admin key's cross-tenant takeover.
This plan bounds it further (rate-limit `/auth/users`, force `user` role) but does not
claim to eliminate it.

## Approach

Two orthogonal axes: **role** (hierarchy: `readonly < user < admin`) stays for tiered
access; a new **capability/scope** axis authorizes specific actions. The provisioning key
has a scope but **no role standing**, so every existing `authMiddleware(role)` gate rejects
it and only an explicit capability check admits it.

### 1. Capability model (scopes orthogonal to role)

In `middleware/auth.ts`:
- Add `scopes?: string[]` to `ApiKey` **and** to `AuthContext`. Do **not** touch `User`
  (no "service users"), do **not** add a role to the shared `User.role` union.
- Widen **only** `ApiKey['role']` and `AuthContext['role']` to include `'none'` (a
  scope-only marker; `User['role']` is unchanged).
- **Harden the role check** in `authMiddleware` (this is load-bearing):
  ```ts
  const roleHierarchy = { admin: 3, user: 2, readonly: 1 } as const;
  const rank = roleHierarchy[authContext.role] ?? 0;      // 'none'/unknown → 0
  if (requiredRole && rank < roleHierarchy[requiredRole]) return 403;
  ```
  Today `roleHierarchy['none']` is `undefined` and `undefined < 1` is `false`, so an
  unknown role would **pass** every gate. The `?? 0` closes that (and any malformed role)
  — a scope-only key ranks 0 and is rejected by every `authMiddleware('readonly'|'user'|
  'admin')`. Propagate `scopes` into `AuthContext` in **both** `authMiddleware` and
  `optionalAuthMiddleware`.
- Add `requireCapability(cap: string)` — a middleware that requires authentication and
  admits iff `auth.role === 'admin' || auth.scopes?.includes(cap)`.
- `createApiKey(name, role, expiresInDays?, scopes?)` — accept optional `scopes`.

> Note: scope-only keys still pass **role-less** `authMiddleware()` gates (`/auth/me`,
> `/auth/password`, `/auth/mfa/*`). These are self-scoped to the *key's* identity
> (`userId = key.id`), which owns nothing and matches no user record, so they no-op /
> 401 harmlessly. Called out so review doesn't mistake it for a hole.

### 2. `POST /auth/users` — capability gate + forced role

In `routes/auth.ts`:
- Replace `authMiddleware('admin')` with `requireCapability('users:create')`.
- In the handler, branch on caller type:
  - **admin** → unchanged (may create any role).
  - **scope-based (non-admin)** → the requested `role` must be exactly `'user'`. If the
    body requests `admin`/`readonly`, **reject with 403** (explicit — not a silent coerce),
    so a scoped caller asking for elevation gets a clear failure. Default when omitted:
    `'user'`.
- `GET /auth/users` (list) stays `authMiddleware('admin')` — a scope-only key must not
  enumerate users.

### 3. Stricter rate limiting on user creation

In `server.ts`, add `authRateLimitMiddleware()` to `POST /auth/users` (today only
`/auth/login`, `/auth/signup`, `/auth/mfa/*` get it). Bounds programmatic account-creation
spam — the main residual above. Apply to POST specifically (don't throttle admin `GET`
listing).

### 4. Admin-conferred grant (Q2), stored per-app

- Add `grantedApiScopes?: string[]` to the per-app config (`AppConfigService` /
  `app-config` types) — the **source of truth**, persisted, survives restarts.
- New **admin-only** endpoint: `PUT /api/v1/apps/:name/capabilities`
  `{ scopes: ['users:create'] }` (mounted with `authMiddleware('admin')`, like the other
  admin-only app routes in `server.ts`). Sets/clears the grant and triggers a restart so
  the key is (re)injected. Default for every app: **no** grant → no key.
- **`drop.yaml` self-declaration is NOT implemented in PR2** (decision during
  implementation). Q2 = admin-conferred, explicitly *not* `drop.yaml` self-service — so the
  admin `PUT /apps/:name/capabilities` endpoint is the **sole** grant mechanism. Honoring a
  `drop.yaml api.scopes` request (even gated to admin owners) is deferred; it would only be a
  convenience for an admin who could already call the endpoint, and adds owner-role lookup +
  drop.yaml-parsing coupling for no security benefit.

### 5. Mint + rotate + inject the key

- New helper (mirrors `writeLocalCliKey`, `platform.ts:2598`): for an app whose
  `grantedApiScopes` is non-empty, mint an `ApiKey` named `app:<appName>:provision`,
  `role: 'none'`, `scopes: ['users:create']`, **rotating on every deploy/start**
  (`deleteApiKeysByName('app:<appName>:provision')` then `createApiKey(...)`). Rotation
  invalidates the previous key each deploy — good hygiene; plaintext is never persisted
  (only injected into the env at start).
- In `buildStartSpec()` inject `DROP_API_KEY=<freshKey>` **after `...secretEnvVars`**
  (platform-authoritative, same as `DROP_API_URL` in PR1) — **only** when the app is
  granted. Ungranted apps get `DROP_API_URL` (from PR1) but **no** `DROP_API_KEY`.
- The app sends it as `X-API-Key: $DROP_API_KEY` (one-line change in the waitlist app;
  documented). `authMiddleware`'s existing `X-API-Key` path already produces an
  `AuthContext` carrying the key's `scopes`.

## File-level changes

- `src/api/middleware/auth.ts` — `scopes?` on `ApiKey` + `AuthContext`; widen `ApiKey`/
  `AuthContext` role to include `'none'`; `?? 0` role-rank hardening; propagate `scopes`
  in both middlewares; `createApiKey(..., scopes?)`; `requireCapability(cap)`.
- `src/api/routes/auth.ts` — `POST /auth/users`: `requireCapability('users:create')` +
  forced `user` role with **403 on elevation** for scope callers; admins unchanged.
- `src/api/server.ts` — `authRateLimitMiddleware()` on `POST /auth/users`; mount
  `PUT /apps/:name/capabilities` under `authMiddleware('admin')`.
- `src/api/routes/apps.ts` (or `admin.ts`) — `PUT /apps/:name/capabilities` handler
  (set/clear grant → persist → restart).
- `src/managers/app/app-config.ts` (+ types) — `grantedApiScopes?: string[]`.
- `src/core/platform.ts` — mint/rotate `app:<name>:provision` key when granted; inject
  `DROP_API_KEY` in `buildStartSpec` (after secrets, granted-only). (`drop.yaml` self-declaration
  deferred — admin endpoint is the sole grant path.)
- **Tests:**
  - `auth` middleware — `requireCapability` admits admin + scoped, rejects role-only and
    unauth; scope-only (`role:'none'`) key is rejected by `authMiddleware('readonly')`
    (proves the `?? 0` fix); `scopes` land in `AuthContext` for both JWT and API-key paths.
  - `routes/auth` — scoped caller creating a `user` succeeds; scoped caller requesting
    `admin`/`readonly` gets **403**; admin still creates any role; `GET /auth/users`
    rejects a scope-only key.
  - `platform` — `DROP_API_KEY` injected **only** when `grantedApiScopes` includes
    `users:create`; absent otherwise; rotated (old key name deleted) each start.
  - capabilities endpoint — admin-only; sets/clears grant; non-admin → 403.
  - rate-limit — `POST /auth/users` is throttled.
- **Docs:** `DROP_API_KEY` in the injected-env list; the capability grant + the admin
  endpoint; the app's `X-API-Key` usage; the residual-risk note.

## Verification plan

1. Unit tests (above) green.
2. **Privilege containment (the real gate).** With a minted scoped key:
   `POST /auth/users {role:'user'}` → 201; `POST /auth/users {role:'admin'}` → **403**;
   `GET /auth/users` → 403; `GET /apps` → 403; `POST /auth/api-keys` → 403;
   `GET /secrets/*` → 403. Prove the key can do exactly one thing.
3. **Grant gating.** Ungranted app → no `DROP_API_KEY` in `docker exec … env`; after
   `PUT /apps/:name/capabilities` (as admin) + restart → present and functional;
   non-admin calling the endpoint → 403.
4. **Rotation.** Redeploy → new key works, previous key value → 401.
5. **End-to-end.** Repoint the waitlist app to `X-API-Key: $DROP_API_KEY`, remove its
   admin-key secret, confirm signup provisioning still works. **Only then** is PR2 done.
6. **Regression.** Existing admin flows (dashboard user/key management) unaffected;
   `role:'none'` change doesn't break existing `admin/user/readonly` keys or JWTs.

## Risks & open questions

- **R1 — `role:'none'` blast radius across the codebase.** Any code doing
  `roleHierarchy[role]` or assuming role ∈ {admin,user,readonly} must tolerate `'none'`.
  The `?? 0` default is the safety net; audit for direct `role ===` comparisons and
  hierarchy lookups. Ship a test that a `'none'` key is rejected everywhere except its one
  capability route.
- **R2 — residual user-tier escalation** (see "Honest residual"): known-password + public
  login → user-tier session; account/app spam bounded by rate limit + `maxApps`, no global
  user cap. Mitigations here (rate-limit, forced role) reduce but don't remove it; a global
  user-count / per-grant creation quota is a possible follow-up.
- **R3 — rotation vs. in-flight requests.** Re-minting on every start briefly invalidates
  the old key; the app is restarting anyway, so the window is inside its own downtime.
  Acceptable.
- **R4 — grant persistence & reconciliation.** `grantedApiScopes` lives in app config (the
  port source-of-truth layer), so it survives restarts and the config>PM2>state
  reconciliation. Confirm the capabilities endpoint writes through `AppConfigService`, not
  just runtime state.
- **R5 — `Bearer` not broadened (Q3).** The app must use `X-API-Key`; if a future app
  insists on `Bearer`, revisit — but not silently widened here.

## Agent critiques considered

The core design was pressure-tested with the advisor (stronger reviewer) rather than a
fresh subagent panel (the earlier panel was lost to session limits, and the advisor noted
the remaining opens were **user decisions**, now resolved). Points adopted:
- **Two-PR sequencing** — don't let the bug fix wait behind this capability (would recreate
  the rejected Option C).
- **Requirement first** — confirmed the app truly needs platform users (Q1), so the build
  is justified rather than speculative.
- **Escalatable-to-user-tier residual** stated honestly, not described as insert-only.
- **Scopes orthogonal to role**, no `'service'` in the shared union.
- **Reject (403), don't silently coerce** elevation.
- **Grant scoped to the real trust model** (admin-conferred, not a general
  hostile-multi-tenant capability system).
- **Don't broaden `Bearer`** — inject `DROP_API_KEY`, document `X-API-Key`.
