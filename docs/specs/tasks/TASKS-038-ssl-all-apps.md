# TASKS-038: SSL for All Apps

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-038 |
| PRD | PRD-038 |
| Branch | `feature/DROP-038-ssl-all-apps` |
| Created | 2026-03-19 |

---

## Tasks

### 1. Wildcard Certificate Configuration
- [ ] Add `dns_challenge` block to Caddy global config for `*.baseDomain`
- [ ] Add `dnsProvider` and `dnsApiToken` fields to platform config
- [ ] Support common providers: Cloudflare, Route53, DigitalOcean
- [ ] Download Caddy with DNS provider plugin if wildcard is configured

### 2. HTTPS Enforcement
- [ ] Generate all Caddy site blocks with HTTPS (Caddy default behavior)
- [ ] Add global HTTP-to-HTTPS redirect rule in Caddyfile
- [ ] Verify HSTS header is set by Caddy on all responses

### 3. Certificate Status Monitoring
- [ ] Query Caddy admin API for certificate status per domain
- [ ] Add `certStatus` field to app API response: `active | provisioning | error`
- [ ] Log certificate provisioning failures as platform warnings
- [ ] Retry provisioning on transient failures

### 4. Dashboard Integration
- [ ] Display all app URLs with `https://` prefix
- [ ] Show cert status badge (green/yellow/red) on app list and detail
- [ ] Warning banner when a cert fails to provision
- [ ] Link to troubleshooting docs for DNS challenge setup

### 5. Local Development Mode
- [ ] When `baseDomain` is `localhost`, skip wildcard cert and use Caddy self-signed
- [ ] Dashboard shows `https://appname.localhost` with browser trust instructions
- [ ] No DNS challenge required in local mode

### 6. Build & Test
- [ ] Unit test: Caddyfile generation includes TLS directives
- [ ] Unit test: HTTP redirect rule is present
- [ ] Integration test: deployed app responds on HTTPS
- [ ] Dashboard builds clean
- [ ] TypeScript compiles
