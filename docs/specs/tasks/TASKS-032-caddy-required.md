# TASKS-032: Caddy Required

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-032 |
| PRD | PRD-032 |
| Branch | `feature/DROP-032-caddy-required` |
| Created | 2026-03-19 |

---

## Tasks

### 1. Caddy Auto-Install
- [ ] Add `src/managers/router/caddy-installer.ts`
- [ ] Detect OS and architecture, download correct Caddy binary from GitHub releases
- [ ] Install to platform bin directory (`data/drop-svc/bin/caddy`)
- [ ] Verify installation with `caddy version`
- [ ] Run auto-install on platform startup if binary not found

### 2. Base Domain Configuration
- [ ] Add `baseDomain` field to platform config (drop.yaml / env var `DROP_BASE_DOMAIN`)
- [ ] Default to `localhost` for development (uses HTTP, no certs)
- [ ] Validate domain format on startup

### 3. Automatic Route Generation
- [ ] On `app:started` event, generate Caddy site block: `appname.baseDomain -> localhost:port`
- [ ] On app stop/remove, remove the site block and reload
- [ ] Use Caddy admin API (`POST /load`) for zero-downtime config reload
- [ ] Store generated Caddyfile in `data/appconf/Caddyfile`

### 4. Dashboard URL Display
- [ ] Compute app URL as `https://appname.baseDomain` (or `http://` for localhost)
- [ ] Update app list and detail pages to show clickable URL
- [ ] Remove raw port display from main UI (keep in advanced/debug section)

### 5. Caddy Lifecycle
- [ ] Start Caddy process on platform startup (after install check)
- [ ] Stop Caddy on platform shutdown
- [ ] Restart Caddy if it crashes (basic supervision)
- [ ] Health check via Caddy admin API

### 6. Build & Test
- [ ] Unit test: Caddyfile generation for various app configs
- [ ] Unit test: auto-install logic (mock download)
- [ ] Integration test: deploy app, verify Caddy route serves traffic
- [ ] Dashboard builds clean
- [ ] TypeScript compiles
