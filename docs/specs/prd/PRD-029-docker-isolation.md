# PRD-029: Docker Isolation

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-029 |
| Feature | Docker Isolation |
| Status | Planned |
| Priority | P0 |
| Created | 2026-03-19 |

---

## Overview

Run each user app in its own Docker container instead of bare PM2 processes.
Provides security isolation, resource limits, and network separation required
for multi-tenant SaaS.

## Changes

1. **Container runtime** - Build a per-app Docker image, start it as a container with `--memory` and `--cpus` flags
2. **Container lifecycle** - Manage build → start → stop → remove through ProcessManager, replacing direct PM2 calls
3. **Network isolation** - Create a Docker bridge network per tenant; containers cannot reach each other
4. **Port mapping** - Assign host port per app, map to container's internal port (same port pool as today)
5. **Fallback mode** - Detect Docker availability at startup; fall back to PM2 if Docker is not installed
6. **Dockerfile generation** - Auto-generate a Dockerfile per app type (Node.js, Python, static) when none exists
