# PRD-027: App Limit Indicator

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-027 |
| Feature | App Limit Indicator |
| Status | Pending |
| Priority | P1 |
| Created | 2026-03-19 |

---

## Overview

Show an "X / Y apps" usage indicator in the dashboard so users know how
many apps they have deployed relative to their limit. Show a warning when
approaching capacity and surface the info before deploying.

## Changes

1. **Usage API endpoint** - Add `GET /api/v1/usage` returning `{ used, limit }` for the authenticated user
2. **Header indicator** - Display "3/5 apps" badge in the dashboard header or apps page
3. **Warning state** - Show amber warning badge when usage is at 80%+ capacity
4. **Deploy page check** - Show current usage on the deploy page before the user initiates a deploy
