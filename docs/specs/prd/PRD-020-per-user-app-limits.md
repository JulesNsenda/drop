# PRD-020: Per-User App Limits

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-020 |
| Feature | Per-User App Limits |
| Status | Draft |
| Priority | P1 |
| Created | 2026-03-19 |

---

## Overview

Enforce a configurable maximum number of apps each user can deploy. Prevents
resource exhaustion on shared instances. Admin users are exempt from the limit.

## Changes

1. **Platform config** - New `maxAppsPerUser` setting (default: 5)
2. **Deploy check** - Reject folder and git deploys when user is at limit, return 429
3. **Watcher check** - Skip auto-deploy for users at limit, log warning
4. **Usage display** - Dashboard header shows `3/5 apps` usage indicator
5. **Admin exempt** - Admin role bypasses the limit entirely
