# TASKS-022: Custom Domains

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-022 |
| PRD | PRD-022 |
| Branch | `feature/DROP-022-custom-domains` |
| Created | 2026-03-19 |

---

## Tasks

### 1. App State Update
- [ ] Add optional `customDomain` field to AppState type
- [ ] Add zod validation for domain format (valid hostname)
- [ ] Persist `customDomain` in app state via AppStateManager

### 2. Custom Domain API
- [ ] Add `PUT /api/v1/apps/:name/domain` route (authenticated, owner or admin)
- [ ] Validate `{ domain: string }` body, reject invalid hostnames
- [ ] Check domain is not already assigned to another app
- [ ] Save domain to app state and trigger Caddy reload
- [ ] Add `DELETE /api/v1/apps/:name/domain` route to remove domain
- [ ] Return updated app state on success

### 3. Caddy Configuration
- [ ] Update RouterService to include custom domain server block
- [ ] Custom domain block: reverse proxy to same app port
- [ ] Enable automatic HTTPS (Caddy default ACME)
- [ ] Regenerate Caddyfile and reload on domain add/remove

### 4. Dashboard UI
- [ ] Add "Custom Domain" section to app detail page
- [ ] Input field for domain with Save and Remove buttons
- [ ] Show current domain if set
- [ ] After saving, display DNS instructions panel:
  - CNAME record pointing to DROP server hostname
  - Note about DNS propagation time
- [ ] Show success/error toasts

### 5. Build & Test
- [ ] Setting domain updates Caddyfile with new server block
- [ ] Removing domain removes server block and reloads
- [ ] Duplicate domain returns 409
- [ ] Dashboard builds clean
- [ ] TypeScript compiles
