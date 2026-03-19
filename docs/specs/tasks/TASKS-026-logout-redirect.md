# TASKS-026: Logout Redirect

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-026 |
| PRD | PRD-026 |
| Branch | `feature/DROP-026-logout-redirect` |
| Created | 2026-03-19 |

---

## Tasks

### 1. Logout Handler Update

- [ ] In the logout handler (auth context or header component), clear all auth localStorage keys (`token`, `user`)
- [ ] Navigate to `/` (landing page) instead of `/login`
- [ ] Pass location state or query param to signal signed-out status

### 2. Landing Page Toast

- [ ] On landing page mount, check for signed-out state/param
- [ ] Show "Signed out" toast using existing toast system
- [ ] Clear the state after showing so refresh does not re-trigger

### 3. Build & Test

- [ ] Clicking logout clears localStorage auth data
- [ ] User is redirected to landing page `/`
- [ ] "Signed out" toast appears on landing page
- [ ] Revisiting `/` after toast does not re-show the message
- [ ] Dashboard builds clean
- [ ] TypeScript compiles
