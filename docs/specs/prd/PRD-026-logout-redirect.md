# PRD-026: Logout Redirect

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-026 |
| Feature | Logout Redirect |
| Status | Pending |
| Priority | P1 |
| Created | 2026-03-19 |

---

## Overview

After logout, redirect the user to the landing page (`/`) and show a
"Signed out" toast confirmation. Currently logout may leave the user on
an authenticated route or redirect inconsistently.

## Changes

1. **Clear auth data** - Remove token, user, and any session data from localStorage on logout
2. **Redirect to landing** - Navigate to `/` (landing page) after clearing auth
3. **Signed-out toast** - Show a "Signed out" toast on the landing page after redirect
