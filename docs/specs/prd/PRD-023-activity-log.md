# PRD-023: Activity Log

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-023 |
| Feature | Activity Log |
| Status | Draft |
| Priority | P2 |
| Created | 2026-03-19 |

---

## Overview

Record significant platform actions (deploy, start, stop, delete, login, signup)
in a persistent activity log. Admin can view the log via API and dashboard.

## Changes

1. **Activity logger** - New `ActivityLogger` service writing to `activity-log.json`
2. **Tracked actions** - deploy, start, stop, delete, login, signup
3. **Entry format** - `{ id, userId, action, appName?, timestamp, detail? }`
4. **Retention** - Keep last 500 entries, prune oldest on write
5. **Admin API** - `GET /api/v1/admin/activity` with pagination (`?page=1&limit=20`)
6. **Dashboard feed** - Activity log panel on admin dashboard (settings or dedicated page)
