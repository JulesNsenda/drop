# TASKS-021: Change Password

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-021 |
| PRD | PRD-021 |
| Branch | `feature/DROP-021-change-password` |
| Created | 2026-03-19 |

---

## Tasks

### 1. Change Password API
- [ ] Add `PUT /api/v1/auth/password` route (authenticated)
- [ ] Validate request body with zod: `{ currentPassword: string, newPassword: string }`
- [ ] Verify `currentPassword` matches stored hash (bcrypt compare)
- [ ] Validate `newPassword` minimum 8 characters
- [ ] Hash new password and update user record
- [ ] Return 200 on success, 400 on validation failure, 401 on wrong current password

### 2. Dashboard Settings Form
- [ ] Add "Change Password" section to Settings page
- [ ] Form fields: current password, new password, confirm new password
- [ ] Client-side validation: new password min 8 chars, confirm must match
- [ ] Submit calls `PUT /api/v1/auth/password`
- [ ] Show success toast on change
- [ ] Show error toast with message on failure

### 3. Build & Test
- [ ] Wrong current password returns 401
- [ ] Short new password returns 400
- [ ] Successful change allows login with new password
- [ ] Dashboard builds clean
- [ ] TypeScript compiles
