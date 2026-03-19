# TASKS-027: App Limit Indicator

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-027 |
| PRD | PRD-027 |
| Branch | `feature/DROP-027-app-limit-indicator` |
| Created | 2026-03-19 |

---

## Tasks

### 1. Usage API Endpoint

- [ ] Add `GET /api/v1/usage` route (authenticated)
- [ ] Query user's deployed app count and their configured limit
- [ ] Return JSON `{ used: number, limit: number }`
- [ ] Admin users: return total platform app count (or omit limit)

### 2. Dashboard Usage Indicator

- [ ] Create `UsageBadge` component showing "X / Y apps"
- [ ] Fetch from `GET /api/v1/usage` on mount
- [ ] Place in dashboard header or top of apps list page
- [ ] Normal state: neutral/default badge color
- [ ] Warning state (>=80% capacity): amber/yellow badge
- [ ] At-limit state (100%): red badge

### 3. Deploy Page Integration

- [ ] On deploy page, fetch usage and display current count
- [ ] If at limit, show warning message and disable deploy button
- [ ] Message: "App limit reached (X/Y). Remove an app or contact admin."

### 4. Build & Test

- [ ] `/api/v1/usage` returns correct counts for regular user
- [ ] Badge displays correctly in header
- [ ] Warning colors appear at 80%+ and 100%
- [ ] Deploy page blocks deploy when at limit
- [ ] Dashboard builds clean
- [ ] TypeScript compiles
