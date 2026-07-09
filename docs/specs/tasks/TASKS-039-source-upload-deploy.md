# TASKS-039: Source Upload Deploy

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-039 |
| PRD | PRD-039 |
| Branch | `feature/DROP-039-source-upload-deploy` |
| Created | 2026-07-09 |

---

## Tasks

### 0. Preconditions (separate branches, land first)
- [ ] Fix `POST /git/redeploy/:name` missing `canAccess` check (bugfix branch — pre-existing IDOR)
- [ ] P0-6: validate `drop.yaml` `domains:` claims against existing apps/tenants (audit remediation)

### 1. Upload endpoint
- [ ] `UploadDeployService` in `src/core/upload-deploy/` (mirror `src/core/git-deploy/` structure)
- [ ] `POST /api/v1/apps/:name/source` route, `authMiddleware('user')`, never anonymous
- [ ] Stream request body to `data/temp/` with incremental byte cap (default 100 MB compressed, configurable) — no `formData()` buffering, no trust in `Content-Length`
- [ ] Exempt/branch the upload path in the global `validateBodySize` middleware (it 413s at 1 MB before routes run)
- [ ] gzip magic-bytes check before extraction

### 2. Extraction hardening (merge gate)
- [ ] Add `node-tar` dependency (never shell to system tar)
- [ ] Entry filter: reject symlink/hardlink/FIFO/device/socket entries; only regular files + dirs
- [ ] Per-entry resolved-path containment via `isPathWithin` pattern (don't rely on library internals)
- [ ] Reject case-insensitive / Unicode-normalization path collisions within one tarball
- [ ] Incremental caps on decompressed bytes and entry count (abort mid-stream)
- [ ] Wall-clock timeout on the whole extraction
- [ ] Merge-gate test suite: tar-slip, symlink escape, gzip bomb, entry-count bomb, collision, magic-bytes

### 3. Guards & ownership
- [ ] Redeploy of existing app: explicit `canAccess`; foreign-or-unknown app → `404` (no existence oracle, mirror deploys.ts)
- [ ] First-time create: per-user app limit + name validation; register app + `userId` atomically **before** files land (git-deploy pattern)
- [ ] Synchronous `409` when app is already building (extend platform-ops seam with in-progress check)
- [ ] Disk watermark re-checked during extraction, not only before
- [ ] Per-user upload concurrency of 1; stricter route-specific rate limit

### 4. Landing & pipeline integration
- [ ] `activeUploads` guard consulted by `app:detected`/`app:update` subscribers (generalize git-deploy's `isCloning` seam into one landing-files check)
- [ ] Land files into `data/webapps/<name>/` (in-place sync for redeploys — delete stale entries; `EXDEV` copy fallback safe under guard)
- [ ] Publish `app:detected` (new) or `app:update{bypassCooldown: true}` (redeploy) deterministically after landing — not watcher-mediated
- [ ] Coordinate with watcher `knownApps`/`markAppKnown` so the direct publish doesn't double-onboard

### 5. Correlation & observability
- [ ] `202` response body: `{ app, acceptedAt }` (server clock)
- [ ] Extend `DeployTrigger` union with `'upload'` (`deriveTrigger`, DTO, dashboard `DeployTimeline`)
- [ ] Document polling contract: `GET /deploys?app=<name>&limit=1` until episode with `startedAt >= acceptedAt` is terminal

### 6. Docs & verification
- [ ] API doc page: curl recipe (tar → upload → poll → `GET /logs/:name/build` tail on failure) + CLAUDE.md snippet for shell-capable agents
- [ ] Document Windows hot re-upload caveat (files held open by running process; stop-first fallback)
- [ ] Unit + integration tests for route (authz, limits, 409/404/413 paths)
- [ ] TypeScript compiles, lint clean, dashboard builds
