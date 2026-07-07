# TASKS-025: 404 Page

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-025 |
| PRD | PRD-025 |
| Status | Completed |
| Branch | `feature/DROP-025-404-page` |
| Created | 2026-03-19 |
| Updated | 2026-06-19 |

> **Status note (2026-06-19):** Verified implemented. Component is `pages/NotFoundPage.tsx`
> (not `NotFound.tsx`) and the "Back to dashboard" link targets `/apps` (the actual dashboard
> landing route) rather than `/dashboard`. Catch-all `<Route path="*">` is wired in `App.tsx`.

---

## Tasks

### 1. NotFound Component

- [x] Create `src/dashboard/src/pages/NotFound.tsx`
- [x] Large "404" heading with "Page Not Found" subtext
- [x] Brief message: "The page you're looking for doesn't exist."
- [x] "Back to Dashboard" button linking to `/dashboard`
- [x] Support dark mode via existing theme context
- [x] Center content vertically and horizontally

### 2. Catch-All Route

- [x] In `App.tsx`, add a `<Route path="*" element={<NotFound />} />` as the last route
- [x] Ensure it does not interfere with existing routes or nested routing

### 3. Build & Test

- [x] Navigating to `/nonexistent` shows the 404 page
- [x] "Back to Dashboard" link works
- [x] Page renders correctly in both dark and light mode
- [x] Dashboard builds clean
- [x] TypeScript compiles
