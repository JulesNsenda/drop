# PRD-024: Token Expiry Handling

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-024 |
| Feature | Token Expiry Handling |
| Status | Pending |
| Priority | P0 |
| Created | 2026-03-19 |

---

## Overview

When any API call returns 401, detect token expiry and redirect the user
to the login page with a "Session expired" message. Currently users hit
silent failures after the JWT expires (24h).

## Changes

1. **Response interceptor** - Add 401 interceptor in `useApi` hook that catches expired tokens
2. **Auth cleanup** - Clear localStorage token and user data on 401
3. **Redirect to login** - Navigate to `/login` with location state carrying expiry message
4. **Login page banner** - Show "Session expired, please sign in again" when redirected from expiry
5. **Skip on login/signup** - Interceptor should not fire on auth endpoints themselves
