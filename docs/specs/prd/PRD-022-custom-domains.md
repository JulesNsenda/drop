# PRD-022: Custom Domains

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-022 |
| Feature | Custom Domains |
| Status | Draft |
| Priority | P2 |
| Created | 2026-03-19 |

---

## Overview

Allow users to assign a custom domain to their deployed app. Caddy automatically
configures reverse proxy and provisions HTTPS via ACME for the custom domain.

## Changes

1. **Domain endpoint** - `PUT /api/v1/apps/:name/domain` accepts `{ domain: "myapp.example.com" }`
2. **Domain removal** - `DELETE /api/v1/apps/:name/domain` removes custom domain
3. **AppState field** - Add optional `customDomain` to app state
4. **Caddy config** - RouterService generates additional server block for custom domain pointing to app port
5. **Dashboard UI** - Domain input field on app detail page with save/remove buttons
6. **DNS instructions** - Show required CNAME/A record instructions after domain is set
