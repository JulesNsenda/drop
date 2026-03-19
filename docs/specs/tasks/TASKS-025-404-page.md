# TASKS-025: 404 Page

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-025 |
| PRD | PRD-025 |
| Branch | `feature/DROP-025-404-page` |
| Created | 2026-03-19 |

---

## Tasks

### 1. NotFound Component

- [ ] Create `src/dashboard/src/pages/NotFound.tsx`
- [ ] Large "404" heading with "Page Not Found" subtext
- [ ] Brief message: "The page you're looking for doesn't exist."
- [ ] "Back to Dashboard" button linking to `/dashboard`
- [ ] Support dark mode via existing theme context
- [ ] Center content vertically and horizontally

### 2. Catch-All Route

- [ ] In `App.tsx`, add a `<Route path="*" element={<NotFound />} />` as the last route
- [ ] Ensure it does not interfere with existing routes or nested routing

### 3. Build & Test

- [ ] Navigating to `/nonexistent` shows the 404 page
- [ ] "Back to Dashboard" link works
- [ ] Page renders correctly in both dark and light mode
- [ ] Dashboard builds clean
- [ ] TypeScript compiles
