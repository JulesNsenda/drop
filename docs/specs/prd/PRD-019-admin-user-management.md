# PRD-019: Admin User Management

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-019 |
| Feature | Admin User Management |
| Status | Draft |
| Priority | P1 |
| Created | 2026-03-19 |

---

## Overview

Provide an admin-only dashboard page to view and manage all registered users.
Admin can see user details (app count, last login, role) and disable or enable accounts.

## Changes

1. **Users API** - `GET /api/v1/auth/users` returns all users (admin only)
2. **Toggle endpoint** - `PUT /api/v1/auth/users/:id` with `{ enabled: boolean }` to disable/enable accounts
3. **User model updates** - Add `enabled` (default true) and `lastLogin` fields to user records
4. **Login gate** - Reject login for disabled users with 403
5. **Dashboard Users page** - New sidebar item (admin only) showing user table with name, email, role, app count, last login, and enable/disable toggle
