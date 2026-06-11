# TASKS-028: Signup Success Message

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-028 |
| PRD | PRD-028 |
| Branch | `feature/DROP-028-signup-success-message` |
| Created | 2026-03-19 |

---

## Tasks

### 1. Signup Redirect

- [ ] In the signup form submit handler, on successful 201 response, navigate to `/login`
- [ ] Pass `location.state = { message: 'Account created successfully. Sign in to get started.' }`
- [ ] Do not auto-login; require explicit sign-in

### 2. Login Page Success Banner

- [ ] In Login component, read `location.state?.message`
- [ ] If message exists, show a green success banner above the form
- [ ] Clear location state after displaying to prevent re-show on refresh
- [ ] Reuse the same banner pattern added in TASKS-024 (expiry banner) if available

### 3. Build & Test

- [ ] Successful signup redirects to `/login` with green banner visible
- [ ] Message text reads "Account created successfully. Sign in to get started."
- [ ] Refreshing `/login` after banner shown does not re-display the message
- [ ] Dashboard builds clean
- [ ] TypeScript compiles
