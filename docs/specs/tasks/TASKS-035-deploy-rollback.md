# TASKS-035: Deploy Rollback

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-035 |
| PRD | PRD-035 |
| Branch | `feature/DROP-035-deploy-rollback` |
| Created | 2026-03-19 |

---

## Tasks

### 1. Deployment History Model
- [ ] Add `deployments` array to AppState (or SQLite table if PRD-033 is done)
- [ ] Each entry: `{ id, hash, timestamp, status, gitSha?, source }`
- [ ] Record a new entry on each successful deploy
- [ ] Trim entries beyond retention limit (default: 3)

### 2. Snapshot Storage
- [ ] For git apps: store the git SHA per deployment (no extra storage needed)
- [ ] For folder apps: copy built artifacts to `data/build-cache/<appname>/snapshots/<id>/`
- [ ] Delete snapshot when it falls off the retention window

### 3. Rollback API
- [ ] Add `POST /api/v1/apps/:name/rollback` endpoint
- [ ] Optional body `{ deploymentId }` to pick a specific version; default is previous
- [ ] For git apps: `git checkout <sha>`, rebuild, restart
- [ ] For folder apps: restore snapshot, restart (skip build)
- [ ] Return 400 if no previous deployment exists
- [ ] Record rollback as a new deployment entry

### 4. Deployment History API
- [ ] Add `GET /api/v1/apps/:name/deployments` returning the history list
- [ ] Include current active deployment indicator

### 5. Dashboard UI
- [ ] Add deployment history section to app detail page
- [ ] Show list of past deployments with timestamp, hash, and status
- [ ] Rollback button per entry, confirmation dialog before executing
- [ ] Disable rollback button when only one deployment exists

### 6. Build & Test
- [ ] Unit test: deployment history records and trims correctly
- [ ] Unit test: rollback restores previous git SHA
- [ ] API test: rollback endpoint returns updated app state
- [ ] Dashboard builds clean
- [ ] TypeScript compiles
