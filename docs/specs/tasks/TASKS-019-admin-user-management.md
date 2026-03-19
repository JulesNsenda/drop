# TASKS-019: Admin User Management

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-019 |
| PRD | PRD-019 |
| Branch | `feature/DROP-019-admin-user-management` |
| Created | 2026-03-19 |

---

## Tasks

### 1. User Model Updates
- [ ] Add `enabled` field (boolean, default true) to user schema
- [ ] Add `lastLogin` field (ISO timestamp, nullable) to user schema
- [ ] Update login handler to set `lastLogin` on successful login
- [ ] Update login handler to reject disabled users with 403

### 2. Admin Users API
- [ ] Add `GET /api/v1/auth/users` route (admin only)
- [ ] Return list: `{ id, username, role, enabled, lastLogin, appCount }`
- [ ] Compute `appCount` by counting apps with matching `userId`
- [ ] Add `PUT /api/v1/auth/users/:id` route (admin only)
- [ ] Accept `{ enabled: boolean }` body, validate with zod
- [ ] Prevent admin from disabling themselves

### 3. Dashboard Users Page
- [ ] Create `UsersPage.tsx` component with user table
- [ ] Columns: username, role, app count, last login, status, actions
- [ ] Enable/disable toggle button per user row
- [ ] Show confirmation dialog before disabling a user
- [ ] Add "Users" item to sidebar (visible only to admin role)

### 4. Build & Test
- [ ] API returns 403 for non-admin callers
- [ ] Disabled user cannot log in
- [ ] Dashboard builds clean
- [ ] TypeScript compiles
