# PRD-030: Deploy Transaction

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-030 |
| Feature | Deploy Transaction |
| Status | Planned |
| Priority | P0 |
| Created | 2026-03-19 |

---

## Overview

Git deploy should bypass the watcher and own the full pipeline as one atomic
transaction: clone → detect → build → start. Eliminates race conditions between
the watcher and deploy API permanently.

## Changes

1. **DeployTransaction class** - Orchestrates clone → detect → build → start as a single unit; rolls back on failure
2. **Watcher exclusion** - Watcher ignores paths that are mid-deploy (lock file or in-memory set)
3. **Deploy status tracking** - Each deploy has a status enum: `cloning | detecting | building | starting | running | failed`
4. **API integration** - `POST /apps/deploy` creates a DeployTransaction instead of cloning and relying on watcher
5. **Folder deploy path** - Folder drops still go through watcher; only git/API deploys use the transaction path
6. **Idempotency** - Re-deploying the same git repo + branch updates in place without duplicating apps
