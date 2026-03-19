# TASKS-030: Deploy Transaction

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-030 |
| PRD | PRD-030 |
| Branch | `feature/DROP-030-deploy-transaction` |
| Created | 2026-03-19 |

---

## Tasks

### 1. DeployTransaction Class
- [ ] Create `src/core/deploy/deploy-transaction.ts`
- [ ] Constructor accepts `{ repoUrl, branch, appName, userId }`
- [ ] Methods: `execute()` runs the full pipeline, `rollback()` cleans up on failure
- [ ] Each stage updates deploy status via `setStage(stage)`
- [ ] On failure at any stage, remove cloned folder and reset app state

### 2. Deploy Status Tracking
- [ ] Add `deployStatus` field to AppState: `cloning | detecting | building | starting | running | failed`
- [ ] Add `deployError` field (nullable string) for failure messages
- [ ] Expose status in `GET /api/v1/apps/:name` response
- [ ] Emit `deploy:stage-changed` event on each transition

### 3. Watcher Exclusion
- [ ] Add `deploysInProgress: Set<string>` to WatcherService
- [ ] Before watcher processes a path, check if it is in the set and skip if so
- [ ] DeployTransaction adds path before clone, removes after pipeline completes
- [ ] Expose `addExclusion(path)` / `removeExclusion(path)` methods

### 4. API Integration
- [ ] Refactor `POST /api/v1/apps/deploy` to create and execute a DeployTransaction
- [ ] Return deploy status immediately (202 Accepted) with app name
- [ ] Client polls `GET /api/v1/apps/:name` for status updates
- [ ] On re-deploy of same repo+branch, update existing app instead of creating new

### 5. Folder Deploy Unchanged
- [ ] Verify watcher-based folder deploy still works end to end
- [ ] Add integration test: drop folder while git deploy is running, both succeed

### 6. Build & Test
- [ ] Unit test: DeployTransaction succeeds end to end (mock git, builder, process manager)
- [ ] Unit test: failure at build stage triggers rollback
- [ ] Unit test: watcher skips excluded paths
- [ ] TypeScript compiles
