# PRD-036: Resource Limits

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-036 |
| Feature | Resource Limits |
| Status | Planned |
| Priority | P2 |
| Created | 2026-03-19 |

---

## Overview

Per-app memory and CPU limits to prevent a single app from starving the host.
Configurable via drop.yaml, API, or dashboard. Enforced via Docker (preferred)
or cgroups.

## Changes

1. **Default limits** - Every app gets 256MB RAM and 0.5 CPU by default
2. **Per-app config** - `resources` block in drop.yaml: `{ memory: "256m", cpus: "0.5" }`
3. **API** - `PUT /api/v1/apps/:name/resources` to update limits, triggers container restart
4. **Global defaults** - Admin sets global defaults via `PUT /api/v1/config/resource-defaults`
5. **Enforcement** - Docker `--memory`/`--cpus` flags (PRD-029); cgroups fallback for PM2 mode
6. **Dashboard** - Resource usage display (current memory/CPU) and limit editor in app detail
