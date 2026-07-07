# TASKS-028: Signup Success Message

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-028 |
| PRD | PRD-028 |
| Status | Completed |
| Branch | `feature/DROP-028-signup-success-message` |
| Created | 2026-03-19 |
| Updated | 2026-06-19 |

> **Status note (2026-06-19):** Verified implemented. `SignupPage.tsx` checks `json.success`
> (rather than HTTP 201) and navigates to `/login` with state message "Account created. Sign in
> to continue." (wording differs from the spec's "Account created successfully. Sign in to get
> started."). `LoginPage.tsx` shows it in the shared green banner. No auto-login.

---

## Tasks

### 1. Signup Redirect

- [x] In the signup form submit handler, on successful 201 response, navigate to `/login`
- [x] Pass `location.state = { message: 'Account created successfully. Sign in to get started.' }`
- [x] Do not auto-login; require explicit sign-in

### 2. Login Page Success Banner

- [x] In Login component, read `location.state?.message`
- [x] If message exists, show a green success banner above the form
- [x] Clear location state after displaying to prevent re-show on refresh
- [x] Reuse the same banner pattern added in TASKS-024 (expiry banner) if available

### 3. Build & Test

- [x] Successful signup redirects to `/login` with green banner visible
- [x] Message text reads "Account created successfully. Sign in to get started."
- [x] Refreshing `/login` after banner shown does not re-display the message
- [x] Dashboard builds clean
- [x] TypeScript compiles
