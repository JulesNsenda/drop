# PRD-046: Auth Screens Redesign (Login / Signup / Change Password)

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-046 |
| Feature | Redesign the login, signup, and change-password screens to `Login.dc.html` |
| Status | Not Started |
| Phase | Design / Frontend |
| Priority | P2 |
| Target | v2.1+ |
| Depends On | PRD-045 (design system + `AuthLayout`) |
| Related | PRD-017 (landing/auth), PRD-021 (change password), PRD-028 (signup success), PRD-049 (design-implied auth affordances) |
| Created | 2026-07-10 |

---

## 1. Overview

### 1.1 Summary

Restyle the three authentication screens to the **`Login.dc.html`** mockup from the
"DROP Platform Design" project: a split-screen with a branding panel on the left and the form on
the right. The visual change is significant; the behavior change is **zero**. Every existing auth
capability — most importantly **MFA/TOTP** — must survive the restyle.

The mockup only depicts a login form. Our real auth surface is larger (MFA challenge, signup,
forced password change, session-expired notice). Those are **preserved and restyled**, not
dropped. The mockup also shows three affordances we do **not** implement (API-key login mode,
"Forgot?", "Continue with SSO"); those are handled per §2.4 and specced separately in **PRD-049**
— this PRD must not fake them.

### 1.2 Goals

- [ ] `LoginPage` uses `AuthLayout`: branding panel + form panel, theme toggle in the corner.
- [ ] Preserve the **two-step login**: credentials step → **TOTP step** when `login()` returns
      `mfaRequired`, verifying via `verifyMfa(challengeToken, code)`. Challenge token stays in a
      `useRef`, never `localStorage`.
- [ ] Preserve the **session-expired notice** (green badge when `state.sessionExpired` / a
      `message` is passed), the login **error banner**, and loading button states.
- [ ] `SignupPage` restyled in `AuthLayout`; preserve validation (username pattern, email,
      password ≥ 8, confirm match), signup-disabled handling, and the success redirect to
      `/login` with the "Account created" message (PRD-028).
- [ ] `ChangePasswordPage` restyled in `AuthLayout`; preserve the forced-change flow (PRD-021):
      temp password + new + confirm, `clearMustChangePassword()` then redirect to `/apps`.
- [ ] Preserve the "Sign up" / "Sign in" / "← Back to home" cross-links.
- [ ] Restyle inputs/buttons via PRD-045 primitives; focus ring uses `--accent`.
- [ ] Fonts/theme via the shared layer; renders correctly when the API is unreachable.

### 1.3 Non-Goals

- Implementing SSO, password reset, or API-key login — see PRD-049. This PRD may render those as
  visibly **disabled / "coming soon"** or omit them; it must not present non-functional controls
  as working.
- Changing the auth API, token storage, or `useAuth()` contract.
- Redesigning the in-`Settings` "Account" tab (change-password + MFA management) — that's the
  authenticated app, covered in PRD-047. This PRD is the standalone/forced auth screens only.

---

## 2. Technical Design

### 2.1 Layout

Wrap each page in `AuthLayout` (PRD-045). Left branding panel: animated diamond, headline
"Drop a folder. / Get a URL." (mono), a one-line description, and the host-status footer
(`drop-node-01 · v2.0.0-rc.1 · self-hosted` — the version string should be sourced, not
hardcoded, if a version is already exposed to the client; otherwise a static constant is fine).
Right panel: the form, with the theme toggle top-right (reusing `useTheme()` + the same
`isDark` reconciliation the landing uses).

### 2.2 Preserved functionality (control-by-control — the spine)

**This section is the acceptance checklist.** Shipping the split-screen while dropping any row
below is a failure.

**LoginPage**

| Control / state | Behavior to preserve |
|---|---|
| Username + password inputs | required; placeholder "admin" on username |
| "Sign in" button | disabled + "Signing in…" while loading |
| **MFA/TOTP step** | on `mfaRequired`, switch to 6-digit code entry (numeric, `pattern [0-9]{6}`, maxLength 6, centered mono); "Verify" disabled until 6 digits; "← Back to sign in" |
| Challenge token | held in `useRef`, never persisted |
| Session-expired notice | green badge when `state.sessionExpired` or a `message` is present |
| Error banner | red banner on failed login / wrong code |
| Links | "Don't have an account? Sign up", "← Back to home" |
| Post-success | route guard in `App.tsx` handles redirect (to `/apps` or `/change-password`) — unchanged |

**SignupPage**

| Control / state | Behavior to preserve |
|---|---|
| Username | required, minLength 3, pattern `^[a-zA-Z0-9_-]+$` |
| Email | required, type email |
| Password + confirm | required, ≥ 8; client-side mismatch error before API call |
| Error banner | username-taken / invalid-email / mismatch |
| "Create account" button | "Creating account…" while loading |
| Success | redirect to `/login` with `{ message: 'Account created. Sign in to continue.' }` |
| Signup-disabled | if signups are disabled, keep the existing disabled/hidden handling |
| Links | "Already have an account? Sign in", "← Back to home" |

**ChangePasswordPage**

| Control / state | Behavior to preserve |
|---|---|
| Temp / new / confirm inputs | required; new ≥ 8; mismatch validation |
| Error banner | incl. the special `MUST_CHANGE_PASSWORD` (403) message |
| "Set password" button | "Saving…" while loading |
| Success | `clearMustChangePassword()` then navigate `/apps` (replace) |

### 2.3 Theme & CSP

Same as landing: theme via `useTheme()` + `html.dark`; fonts self-hosted (CSP blocks external).
`AuthLayout` must paint even when `/api/v1/*` is unreachable (the auth provider resolves
`loading:false` on network failure).

### 2.4 Design-implied affordances not yet built

The mockup shows a **Password / API-key** segmented toggle, a **"Forgot?"** link, and
**"⌥ Continue with SSO."** None are implemented. For this redesign:

- **Recommended:** omit them, OR render them **visually disabled** with a "coming soon" affordance
  that does nothing. Do **not** wire fake behavior.
- Each is specced (open questions only) in **PRD-049**. If any is built later, this page adopts it
  then.

Rationale: a login screen that *looks* like it offers SSO but silently fails is worse than one
that doesn't show it. Honesty over fidelity where a control would be non-functional.

---

## 3. Implementation Plan

### 3.1 Files to Create/Modify

- `src/dashboard/src/pages/LoginPage.tsx` — restyle into `AuthLayout`; preserve two-step + states.
- `src/dashboard/src/pages/SignupPage.tsx` — restyle; preserve validation + success redirect.
- `src/dashboard/src/pages/ChangePasswordPage.tsx` — restyle; preserve forced-change flow.
- `src/dashboard/src/components/AuthLayout.tsx` — consumed here (created in PRD-045).
- (Reuse) PRD-045 primitives (`Button`, `Input`, `Card`).

### 3.2 Design source of truth

- Claude Design project `DROP Platform Design` (`b2fbbdb6-c229-4d84-8ed2-e05b9b6460f3`), file
  `Login.dc.html`.

### 3.3 Verification

- Headless-Chrome harness (as used for the landing): stub `/api/v1/auth/status` → enabled; drive
  the login form; **exercise the MFA path** by stubbing `login` → `mfaRequired` then `verifyMfa`
  → success. Check dark/light/mobile and API-unreachable paint.

---

## 4. Risks & Open Questions

- **Dropping the MFA step is the top risk.** The mockup has no MFA; an implementer restyling from
  it alone would omit the TOTP step. Mitigation: the §2.2 matrix + a verification step that
  exercises MFA before merge.
- **Session-expired / must-change redirects** are wired in `App.tsx`, not the page — don't move
  that logic into the page during the restyle.
- **Version string** in the branding footer: prefer sourcing from a real value; a hardcoded
  `v2.0.0-rc.1` will drift.
- **Non-functional affordances** (SSO/reset/API-key): the temptation is to include them for
  fidelity. Hold to §2.4 — disabled or omitted, never faked.
