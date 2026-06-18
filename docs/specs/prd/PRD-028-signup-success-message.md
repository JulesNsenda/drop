# PRD-028: Signup Success Message

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-028 |
| Feature | Signup Success Message |
| Status | Completed |
| Priority | P2 |
| Created | 2026-03-19 |

---

## Overview

After successful signup, redirect the user to `/login` with a success
message confirming their account was created. Currently signup may leave
the user unclear on next steps.

## Changes

1. **Signup redirect** - After successful `POST /auth/signup`, redirect to `/login` with state message
2. **Login success banner** - Login page reads `location.state.message` and shows a green banner
3. **Message text** - "Account created successfully. Sign in to get started."
