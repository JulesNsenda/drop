# TASKS-039: Source Upload Deploy

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-039 |
| PRD | PRD-039 |
| Branch | `feature/DROP-039-source-upload-deploy` |
| Created | 2026-07-09 |
| Completed | 2026-07-09 |

---

## Tasks

### 0. Preconditions (separate branches, land first)
- [x] Fix `POST /git/redeploy/:name` missing `canAccess` check (bugfix branch — pre-existing IDOR) — *merged via PR #57*
- [x] P0-6: validate `drop.yaml` `domains:` claims against existing apps/tenants (audit remediation) — *already landed pre-branch: `getDomainOwners()` (app-config.ts) + the hijack-rejection gate in `handleConfigureRoute` (platform.ts). Remaining audit sub-item (Caddy reload errors logged but not surfaced) is pre-existing behavior, out of this PRD's scope.*

### 1. Upload endpoint
- [x] `UploadDeployService` in `src/core/upload-deploy/` (mirror `src/core/git-deploy/` structure)
- [x] `POST /api/v1/apps/:name/source` route, `authMiddleware('user')`, never anonymous
- [x] Stream request body to `data/temp/upload-archives/` with incremental byte cap (default 100 MB compressed, `DROP_MAX_UPLOAD_SIZE_MB`) — no `formData()` buffering, no trust in `Content-Length` — *raw `application/gzip` body, not multipart*
- [x] Exempt/branch the upload path in the global `validateBodySize` middleware (it 413s at 1 MB before routes run)
- [x] gzip magic-bytes check before extraction

### 2. Extraction hardening (merge gate)
- [x] Add `tar` (node-tar v7) dependency (never shell to system tar)
- [x] Entry filter: reject symlink/hardlink/FIFO/device/socket entries; only regular files + dirs
- [x] Per-entry resolved-path containment via `path.resolve` prefix check (don't rely on library internals)
- [x] Reject case-insensitive / Unicode-NFC path collisions within one tarball
- [x] Incremental caps on decompressed bytes (`DROP_MAX_UPLOAD_UNPACKED_MB`, default 1024) and entry count (20,000) — abort mid-stream
- [x] Wall-clock timeout on the whole extraction (60 s)
- [x] Merge-gate test suite: tar-slip, symlink escape, gzip bomb, entry-count bomb, collision, magic-bytes — *14 tests, malicious archives hand-crafted from raw ustar headers*

### 3. Guards & ownership
- [x] Redeploy of existing app: explicit `canAccess`; foreign-or-unknown app → `404` (no existence oracle, mirror deploys.ts)
- [x] First-time create: per-user app limit + name validation; register app + `userId` atomically **before** files land (git-deploy pattern)
- [x] Synchronous `409` when app is already building (`isAppInProgress` added to platform-ops seam)
- [x] Disk watermark re-checked by the service before landing, not only at the route preflight
- [x] Per-user upload concurrency of 1 (`429`); stricter route-specific rate limit (10/min bucket)
- [x] *(added during implementation)* Upload to a user-stopped app → deterministic `409` (its rebuilds are deliberately dropped by the platform; a `202` would poll forever)

### 4. Landing & pipeline integration
- [x] `activeUploads` guard consulted by `app:detected`/`app:update` subscribers and `handleAppUpdate` (all three `isCloning` sites mirrored)
- [x] Land files into `data/webapps/<name>/` (rename with EXDEV copy fallback for new apps; copy + prune-stale sync for redeploys)
- [x] Publish `app:detected {origin:'upload'}` (new) or `app:update {reason:'upload deploy', bypassCooldown:true}` (redeploy) deterministically after landing — not watcher-mediated — *guard clears before the publish (EventBus dispatch is synchronous); regression-tested*
- [x] Coordinate with watcher `knownApps`/`markAppKnown` so the direct publish doesn't double-onboard

### 5. Correlation & observability
- [x] `202` response body: `{ app, acceptedAt, isNew }` (server clock)
- [x] Extend `DeployTrigger` union with `'upload'` (`deriveTrigger`, DTO, dashboard `DeployTimeline`)
- [x] Document polling contract: `GET /deploys?app=<name>&limit=1` until episode with `startedAt >= acceptedAt` is terminal — *docs/AGENT-DEPLOY.md*

### 6. Docs & verification
- [x] API doc page: curl recipe (tar → upload → poll → `GET /logs/:name/build` tail on failure) + CLAUDE.md snippet for shell-capable agents — *docs/AGENT-DEPLOY.md*
- [x] Document Windows hot re-upload caveat (files held open by running process; stop-first fallback) — *docs/AGENT-DEPLOY.md*
- [x] Unit + integration tests for route (authz, limits, 409/404/413/429 paths) — *11 route tests + 3 body-limit carve-out tests + 2 guard-ordering regression tests*
- [x] TypeScript compiles, lint clean (0 errors), dashboard builds, full suite 77 suites / 1181 tests green
