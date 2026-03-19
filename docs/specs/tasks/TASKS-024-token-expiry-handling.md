# TASKS-024: Token Expiry Handling

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-024 |
| PRD | PRD-024 |
| Branch | `feature/DROP-024-token-expiry-handling` |
| Created | 2026-03-19 |

---

## Tasks

### 1. Response Interceptor in useApi

- [ ] In `useApi` (or shared fetch wrapper), add response interceptor
- [ ] On any response with status 401, check that the request URL is not `/auth/login` or `/auth/signup`
- [ ] Clear `localStorage` items: `token`, `user` (and any other auth keys)
- [ ] Redirect to `/login` with `location.state = { message: 'Session expired, please sign in again' }`
- [ ] Ensure interceptor runs before any per-call error handling

### 2. Login Page Expiry Banner

- [ ] In Login component, read `location.state?.message`
- [ ] If message exists, show a yellow/amber banner above the form with the message
- [ ] Clear the location state after displaying so refresh does not re-show
- [ ] Style banner consistent with existing toast/alert patterns

### 3. Build & Test

- [ ] Expired token triggers redirect to `/login` with banner visible
- [ ] Normal 401 on wrong credentials does not trigger redirect loop
- [ ] Auth endpoints (login, signup) are excluded from interceptor
- [ ] Dashboard builds clean
- [ ] TypeScript compiles
