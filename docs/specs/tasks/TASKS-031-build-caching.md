# TASKS-031: Build Caching

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-031 |
| PRD | PRD-031 |
| Branch | `feature/DROP-031-build-caching` |
| Created | 2026-03-19 |

---

## Tasks

### 1. Content Hash Utility
- [ ] Create `src/core/builder/content-hash.ts`
- [ ] For git apps: use current HEAD SHA as hash
- [ ] For folder apps: hash all source files (exclude node_modules, .git)
- [ ] Separate lockfile hash for `package-lock.json` / `requirements.txt`

### 2. Build Cache Store
- [ ] Create `src/core/builder/build-cache.ts`
- [ ] Store cache metadata in `data/build-cache/<appname>/cache.json`
- [ ] Fields: `contentHash`, `lockfileHash`, `buildTimestamp`, `appType`
- [ ] Methods: `get(appName)`, `set(appName, metadata)`, `invalidate(appName)`

### 3. Builder Integration
- [ ] Before build, compute content hash and compare with cached hash
- [ ] If content hash matches, skip build entirely and log cache hit
- [ ] If only lockfile changed, run install but skip build command
- [ ] If content hash differs, run full build and update cache

### 4. Platform Restart
- [ ] On `DropPlatform.start()`, load known apps from state manager
- [ ] For each app with valid cache, call process manager start directly (skip build)
- [ ] For apps with invalid or missing cache, run full build pipeline
- [ ] Log which apps were cache-started vs rebuilt

### 5. Cache Invalidation API
- [ ] Add `POST /api/v1/apps/:name/rebuild` endpoint
- [ ] Invalidate cache and trigger full rebuild
- [ ] Add rebuild button to dashboard app detail page

### 6. Build & Test
- [ ] Unit test: cache hit skips build
- [ ] Unit test: lockfile change triggers install only
- [ ] Unit test: content change triggers full build
- [ ] Verify platform restart uses cache
- [ ] TypeScript compiles
