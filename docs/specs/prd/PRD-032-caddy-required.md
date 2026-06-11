# PRD-032: Caddy Required

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-032 |
| Feature | Caddy Required |
| Status | Planned |
| Priority | P1 |
| Created | 2026-03-19 |

---

## Overview

Make Caddy a required component that is auto-installed if missing. Every deployed
app automatically gets `appname.yourdomain.com` with HTTPS via Let's Encrypt.
Dashboard shows real URLs instead of port numbers.

## Changes

1. **Auto-install** - On platform startup, check for Caddy binary; download and install if missing
2. **Domain config** - Platform config gains a `baseDomain` setting (e.g. `drop.example.com`)
3. **Automatic routing** - On deploy, add `appname.baseDomain` reverse proxy entry to Caddyfile
4. **Auto HTTPS** - Caddy handles Let's Encrypt provisioning automatically for each subdomain
5. **Dashboard URLs** - App list and detail pages show `https://appname.baseDomain` instead of `localhost:port`
6. **Config reload** - Caddy config reloaded (not restarted) on deploy and app removal
