# PRD-038: SSL for All Apps

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-038 |
| Feature | SSL for All Apps |
| Status | Planned |
| Priority | P1 |
| Depends On | PRD-032 |
| Created | 2026-03-19 |

---

## Overview

HTTPS is mandatory for every deployed app. Caddy auto-provisions Let's Encrypt
certificates including a wildcard cert for `*.baseDomain`. HTTP requests are
force-redirected to HTTPS.

## Changes

1. **Wildcard certificate** - Configure Caddy with DNS challenge for `*.baseDomain` wildcard cert
2. **Per-app HTTPS** - Every app route uses HTTPS by default (no opt-in needed)
3. **HTTP redirect** - Global Caddy rule redirects all HTTP (port 80) to HTTPS (port 443)
4. **Dashboard URLs** - All displayed app URLs use `https://` scheme
5. **Cert status** - Dashboard shows certificate status per app; warning if cert provisioning fails
6. **DNS challenge config** - Platform config accepts DNS provider API token for wildcard cert provisioning
