# PRD-021: Change Password

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-021 |
| Feature | Change Password |
| Status | Draft |
| Priority | P1 |
| Created | 2026-03-19 |

---

## Overview

Allow authenticated users to change their password from the dashboard settings
page. Requires current password verification before accepting a new password.

## Changes

1. **Change password endpoint** - `PUT /api/v1/auth/password` accepts `{ currentPassword, newPassword }`
2. **Validation** - New password minimum 8 characters, current password must match
3. **Settings page form** - Change password section with current password, new password, and confirm fields
4. **Success feedback** - Toast notification on successful change
