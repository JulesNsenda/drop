# PRD-018: Multi-Tenant SaaS

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-018 |
| Feature | Multi-Tenant SaaS |
| Status | In Progress |
| Priority | P0 |
| Created | 2026-03-19 |

---

## Overview

Enable multi-tenant usage where users sign up, deploy their own apps,
and only see their own dashboard. Admin sees everything.

## Changes

1. **Self-service signup** - Public registration endpoint + page
2. **App ownership** - `userId` on AppState, set on deploy/clone
3. **Filtered API** - Users see only their apps, admin sees all
4. **Dashboard signup page** - Registration form on landing page
5. **User context** - Login returns userId, dashboard stores it
