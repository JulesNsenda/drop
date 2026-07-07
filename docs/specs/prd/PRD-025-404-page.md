# PRD-025: 404 Page

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-025 |
| Feature | 404 Not Found Page |
| Status | Completed |
| Priority | P1 |
| Created | 2026-03-19 |

---

## Overview

Create a proper 404 Not Found page for unknown routes. Currently unknown
routes render a blank page or fall through. A professional 404 page guides
users back to the dashboard.

## Changes

1. **NotFound component** - Full-page 404 with DROP branding, message, and "Back to Dashboard" link
2. **Catch-all route** - Add `*` route in App.tsx that renders the NotFound component
3. **Consistent styling** - Match existing DROP dark/light theme and layout
