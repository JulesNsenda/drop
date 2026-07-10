# Dashboard API key management

**Date:** 2026-07-10
**Status:** Implemented and merged (PR #61, commit `4856a95`, merged to `develop` as `56983d2`)
**Branch (for implementation):** `feature/DROP-042-dashboard-api-keys` from `develop` (merged, deleted)

## Goal

Let admins generate, inspect, and revoke DROP API keys from the web dashboard: list existing keys, create a new key (name, role, optional expiry), see the plaintext key exactly once with copy-to-clipboard, and delete keys. Today this is only possible via raw API calls; the backend endpoints (`POST/GET/DELETE /api/v1/auth/api-keys`, admin-only) already exist and are tested.

## Approach

**Home: an admin-only "API Keys" tab in SettingsPage — not a new page.**
`SettingsPage.tsx` already builds a role-conditional tab list (System and Activity are admin-only) and already handles deep-link fallback when a non-admin requests a forbidden tab. API keys are flat CRUD configuration — exactly the shape of the existing Settings tabs — and this avoids adding a 4th top-level nav item and dissolves the route-guard question entirely (the draft plan's "guard like /users" premise was false: `/users` has **no** route guard, only a hidden nav link). Zero changes to `App.tsx` and `Layout.tsx`.

**UI vocabulary: inline reveal-card, not a modal.**
The dashboard has no form-modals; its precedent for revealing a one-time secret is the MFA setup flow in SettingsPage — an inline card with an `idle → form → reveal` state machine and a selectable code block. The tab mirrors that:

- **Idle:** "Create API key" button above the key list.
- **Form:** name (trimmed, required, `maxLength` 64, reject reserved name `cli-local`), role select (`readonly` default / `user` / `admin`), optional "Expires in (days)" number input (blank ⇒ field omitted from the request; else integer 1–3650). Client-side validation mirrors the new server-side validation below.
- **Reveal:** full plaintext key in a selectable monospace block, copy button (`navigator.clipboard.writeText` in try/catch — error toast on failure, never a false success; no `execCommand` fallback since the block is always selectable), prominent "You won't see this key again" warning, explicit **Done** button (no backdrop/misclick dismissal is possible with a card). Key is cleared from React state on Done and never placed in a toast (toasts are `aria-live` and linger in the DOM).

**Key list:** name, prefix (12 chars, e.g. `drop_a1b2c3d`), role badge, created, last used ("Never" when unset; value is throttled server-side so treat as approximate), expires ("Never", or date with a red **Expired** badge when past). The `cli-local` row gets a "System (CLI)" badge; deleting it is allowed but the ConfirmDialog copy warns it breaks local CLI auth until the next platform restart. Delete uses the existing `useConfirm` + Toast pattern. Errors from the API are surfaced via toast — no silent empty tables (the UsersPage behavior we're explicitly not copying).

**Fetch layer: `apiJson` + `jsonBody` from `api/client.ts`** (the ChangePasswordPage pattern), *not* UsersPage's raw `fetch`, which bypasses the central 401 session-expiry redirect. `apiJson` returns the `{ success, data | error }` envelope without throwing; every call checks `json.success` and toasts `json.error?.message`. Note: insufficient role comes back as HTTP 403 with error code `UNAUTHORIZED` (there is no `FORBIDDEN` code) — branch on status/`success`, not on a `FORBIDDEN` code.

**Small backend hardening (the one scope addition, deliberately included):**
`POST /auth/api-keys` currently accepts any truthy name and passes `expiresInDays` through unvalidated — a non-numeric value reaches `new Date(NaN).toISOString()` and **throws a 500**; `0` silently means "never expires"; negatives create born-dead keys; and a key named `cli-local` is silently destroyed by the platform's startup key rotation (`platform.ts` re-mints `cli-local` on every boot). Client-side checks can't protect API callers. Add route-level validation throwing `ValidationError` (400): name trimmed non-empty, ≤ 64 chars, ≠ `cli-local`; `expiresInDays`, when present, an integer in 1–3650. Also fix the stale "First 8 chars" comment on `ApiKey.prefix` (actual value is 12 chars).

**Out of scope (consciously):** per-user self-service keys (keys are platform-scoped with their own role; endpoints are admin-only — a future PRD if wanted), sorting/search/pagination (key counts are single-digit), shared Table/Badge component extraction (against the codebase's copy-local convention), dashboard test infra (none exists; standing up jsdom/RTL for one screen is scope creep), blocking deletion of `cli-local` server-side (warn-only for now).

## File-level changes

| File | Change |
|---|---|
| `src/dashboard/src/components/ApiKeysTab.tsx` | **Add.** Key list + inline idle→form→reveal create flow + delete-with-confirm. Uses `apiJson`/`jsonBody`, `useConfirm`, `Toast`, lucide `KeyRound`. |
| `src/dashboard/src/pages/SettingsPage.tsx` | **Edit (~4 lines).** Import, admin-only tab entry `{ id: 'api-keys', label: 'API Keys', icon: KeyRound }`, render branch. |
| `src/api/routes/auth.ts` | **Edit.** Validation in `POST /auth/api-keys`: name trim/length/reserved-name, `expiresInDays` integer 1–3650. |
| `src/api/routes/auth.test.ts` | **Edit.** Tests: reserved name rejected, whitespace-only name rejected, >64-char name rejected, non-numeric / 0 / negative / huge `expiresInDays` rejected (no more 500 path). |
| `src/api/middleware/auth.ts` | **Edit (comment only).** Fix `prefix` doc comment: 12 chars, not 8. |

Build note: dashboard changes require `npm run build` (not `build:server`); `cd src/dashboard && npm install` once if dashboard deps aren't installed.

## Response envelopes (verified against code)

- `POST` → 201 `{ success: true, data: { key, id, name, prefix, role, createdAt, expiresAt? } }` — `key` appears only here.
- `GET` → 200 `{ success: true, data: ApiKeyRecord[] }` (no `keyHash`).
- `DELETE` → 200 `{ success: true, data: { message } }`; 404 `{ success: false, error: { code: 'NOT_FOUND', … } }`.
- Validation → 400 `{ success: false, error: { code: 'VALIDATION_ERROR', message } }`. Rate limit: general 100 req/min bucket only.

## Risks & open questions

- **`cli-local` deletion still possible** from the UI (warned, not blocked). Blocking server-side would also block the platform's own rotation path unless special-cased — deferred.
- **Client role gating is cosmetic** (`drop-role` in localStorage is spoofable). Security is enforced server-side by `authMiddleware('admin')` on all three endpoints; the tab additionally surfaces 403s as an error state rather than an empty list.
- **Auth-disabled instances** (`DROP_DISABLE_AUTH=true`): handlers throw "Auth not initialized" → 500. Tab is hidden anyway (no role); same preexisting behavior as `/users`. Not addressed here.
- **`lastUsed` is approximate** (60s flush throttle; unflushed values lost on restart) — displayed as-is, no promise of precision.
- Backend validation is a **behavior change** for existing API callers sending garbage `expiresInDays` (500 → 400) or `cli-local` names (silent success → 400). Both are strict improvements but noted.

## Agent critiques considered

Three adversarial reviewers ran against the draft (new page + create modal, "guarded like /users", no backend changes):

1. **Edge-case/security auditor** — found the `cli-local` reserved-name collision with startup key rotation (HIGH), the `expiresInDays` 500/silent-never/born-expired paths (HIGH), the missing route guard + UsersPage's silent-403-empty-table pattern (HIGH), modal misclick losing the one-time key, clipboard failure on plain-HTTP deployments, key-in-toast/aria-live leak, missing name validation, stale key in React state. **All adopted**: reserved-name + expiry validation moved server-side, reveal-card with explicit Done replaces the modal, copy failure keeps the key selectable with an error toast, key cleared from state, 403s surfaced. Its suggested "disable Done until copy clicked" guard was **rejected** as over-guarding — the card can't be dismissed accidentally.
2. **Simplicity critic** — argued firmly for a Settings tab over a new page (role-conditional tabs + deep-link fallback already exist; sidebar stays at 3 items; the guard problem dissolves) and for the MFA-style inline reveal card over the dashboard's first-ever form-modal; cut the `execCommand` clipboard fallback; keep role/expiry badges; accept local duplication over extracting shared components; confirmed the no-dashboard-tests stance (zero test infra exists). **All adopted.** Its suggestion to consider the Settings "divide-y row list" over a table is left to implementation taste.
3. **Integration reviewer** — pinned exact response envelopes (prefix is 12 chars, stale comment), found that `apiJson` returns envelopes rather than throwing and that UsersPage bypasses it via raw fetch (**exemplar corrected to ChangePasswordPage**), confirmed the admin guard lives inline in `routes/auth.ts` not `server.ts`, confirmed lucide-react/`KeyRound`, no code-splitting concerns, CORS/body-cap/rate-limit all fine, audit log never sees the plaintext key, and independently confirmed the `cli-local` blast radius (CLI auth breaks until restart if deleted). **All adopted.**

**Where reviewers disagreed:** the draft's no-backend-changes rule vs. the auditor's finding that the 500 path and reserved-name collision can't be fixed client-side. Resolved in favor of the small backend validation block — it's ~15 lines in an already-tested route and protects non-dashboard API callers too.
