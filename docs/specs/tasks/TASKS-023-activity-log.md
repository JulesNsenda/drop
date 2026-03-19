# TASKS-023: Activity Log

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-023 |
| PRD | PRD-023 |
| Branch | `feature/DROP-023-activity-log` |
| Created | 2026-03-19 |

---

## Tasks

### 1. Activity Logger Service
- [ ] Create `src/managers/activity/activity-logger.ts`
- [ ] Define `ActivityEntry` type: `{ id, userId, action, appName?, timestamp, detail? }`
- [ ] Define `ActivityAction` union: `deploy | start | stop | delete | login | signup`
- [ ] Implement `log(entry)` method that appends to `activity-log.json`
- [ ] Implement retention: prune to last 500 entries on each write
- [ ] Implement `getEntries(page, limit)` method with pagination
- [ ] Singleton pattern: `getActivityLogger()` / `resetActivityLogger()`

### 2. Integrate with Platform Events
- [ ] Log `deploy` on `build:completed` event (include appName, userId)
- [ ] Log `start` on `app:started` event
- [ ] Log `stop` on `app:stopped` event
- [ ] Log `delete` on app deletion API call
- [ ] Log `login` on successful login
- [ ] Log `signup` on successful registration

### 3. Admin Activity API
- [ ] Add `GET /api/v1/admin/activity` route (admin only)
- [ ] Query params: `page` (default 1), `limit` (default 20)
- [ ] Return `{ entries: ActivityEntry[], total: number, page, limit }`

### 4. Dashboard Activity Feed
- [ ] Create `ActivityFeed.tsx` component
- [ ] Display entries as timeline: icon per action type, timestamp, user, app name
- [ ] Add pagination controls (next/prev)
- [ ] Add "Activity" item to admin sidebar or embed in Settings page
- [ ] Auto-refresh every 30 seconds

### 5. Build & Test
- [ ] Activity entries persist across restarts
- [ ] Retention caps at 500 entries
- [ ] Non-admin gets 403 on activity endpoint
- [ ] Dashboard builds clean
- [ ] TypeScript compiles
