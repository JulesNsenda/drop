# TASKS-024: Token Expiry Handling

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-024 |
| PRD | PRD-024 |
| Status | Completed |
| Branch | `feature/DROP-024-token-expiry-handling` |
| Created | 2026-03-19 |
| Updated | 2026-06-19 |

> **Status note (2026-06-19):** Verified implemented. Uses a custom `drop:unauthorized`
> event + global listener (`api/client.ts`, `App.tsx`) and a `sessionExpired` flag rather
> than the literal `location.state.message`; expiry banner on `LoginPage.tsx` is styled green
> (shared with the signup banner) rather than amber. Behavior matches the PRD.

---

## Tasks

### 1. Response Interceptor in useApi

- [x] In `useApi` (or shared fetch wrapper), add response interceptor
- [x] On any response with status 401, check that the request URL is not `/auth/login` or `/auth/signup`
- [x] Clear `localStorage` items: `token`, `user` (and any other auth keys)
- [x] Redirect to `/login` with `location.state = { message: 'Session expired, please sign in again' }`
- [x] Ensure interceptor runs before any per-call error handling

### 2. Login Page Expiry Banner

- [x] In Login component, read `location.state?.message`
- [x] If message exists, show a yellow/amber banner above the form with the message
- [x] Clear the location state after displaying so refresh does not re-show
- [x] Style banner consistent with existing toast/alert patterns

### 3. Build & Test

- [x] Expired token triggers redirect to `/login` with banner visible
- [x] Normal 401 on wrong credentials does not trigger redirect loop
- [x] Auth endpoints (login, signup) are excluded from interceptor
- [x] Dashboard builds clean
- [x] TypeScript compiles
