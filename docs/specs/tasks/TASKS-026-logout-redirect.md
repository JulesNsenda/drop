# TASKS-026: Logout Redirect

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-026 |
| PRD | PRD-026 |
| Status | Completed |
| Branch | `feature/DROP-026-logout-redirect` |
| Created | 2026-03-19 |
| Updated | 2026-06-19 |

> **Status note (2026-06-19):** Verified implemented. `handleLogout` (`components/Layout.tsx`)
> clears all auth keys, fires the "Signed out" toast directly (before navigation) rather than
> via landing-page location state, then `navigate('/', { replace: true })`. Net user-visible
> behavior (signed-out toast, no re-show on refresh) matches the PRD.

---

## Tasks

### 1. Logout Handler Update

- [x] In the logout handler (auth context or header component), clear all auth localStorage keys (`token`, `user`)
- [x] Navigate to `/` (landing page) instead of `/login`
- [x] Pass location state or query param to signal signed-out status

### 2. Landing Page Toast

- [x] On landing page mount, check for signed-out state/param
- [x] Show "Signed out" toast using existing toast system
- [x] Clear the state after showing so refresh does not re-trigger

### 3. Build & Test

- [x] Clicking logout clears localStorage auth data
- [x] User is redirected to landing page `/`
- [x] "Signed out" toast appears on landing page
- [x] Revisiting `/` after toast does not re-show the message
- [x] Dashboard builds clean
- [x] TypeScript compiles
