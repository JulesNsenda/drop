# TASKS-020: Per-User App Limits

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-020 |
| PRD | PRD-020 |
| Branch | `feature/DROP-020-per-user-app-limits` |
| Created | 2026-03-19 |

---

## Tasks

### 1. Platform Config
- [ ] Add `maxAppsPerUser` to platform config schema (number, default 5)
- [ ] Expose via `GET /api/v1/config` for dashboard consumption

### 2. Limit Enforcement
- [ ] Create `checkAppLimit(userId): { allowed: boolean, current: number, max: number }` utility
- [ ] Count apps owned by user from AppStateManager
- [ ] Admin role always returns `allowed: true`
- [ ] Add limit check to folder deploy endpoint, return 429 with message
- [ ] Add limit check to git deploy endpoint, return 429 with message
- [ ] Add limit check in WatcherService before triggering deploy pipeline

### 3. Usage API
- [ ] Add `appUsage: { current, max }` to `GET /api/v1/auth/me` response
- [ ] Return `max: null` for admin users (unlimited)

### 4. Dashboard Usage Indicator
- [ ] Show `current/max apps` badge in dashboard header bar
- [ ] Show "Unlimited" for admin users
- [ ] Show warning styling when at 80%+ capacity
- [ ] Show error toast when deploy is rejected due to limit

### 5. Build & Test
- [ ] Deploy rejected at limit returns 429
- [ ] Admin can deploy beyond limit
- [ ] Dashboard builds clean
- [ ] TypeScript compiles
