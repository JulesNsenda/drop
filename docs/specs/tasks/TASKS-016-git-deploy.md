# TASKS-016: Git Deploy (GitHub Integration)

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-016 |
| Feature | Git Deploy |
| PRD | PRD-016 |
| Status | Not Started |
| Branch | `feature/DROP-016-git-deploy` |
| Assignee | TBD |
| Created | 2026-03-19 |
| Updated | 2026-03-19 |

---

## Progress Summary

| Category | Total | Completed | Remaining |
|----------|-------|-----------|-----------|
| Setup | 3 | 0 | 3 |
| Implementation | 8 | 0 | 8 |
| Testing | 3 | 0 | 3 |
| Documentation | 2 | 0 | 2 |
| **Total** | **16** | **0** | **16** |

---

## Pre-Implementation Checklist

- [ ] Read PRD-016 thoroughly
- [ ] Verify `git` CLI is available on host
- [ ] Review existing SecretManager API for token storage
- [ ] Review existing webhook system for GitHub payload handling
- [ ] Create feature branch: `git checkout -b feature/DROP-016-git-deploy`

---

## Tasks

### 1. Setup Tasks

#### 1.1 Create Directory Structure
- [ ] Create `src/core/git-deploy/` directory
- [ ] Create `src/core/git-deploy/index.ts`
- [ ] Create `src/core/git-deploy/git-deploy.types.ts`

**Completion**: _Not started_
**Commit**: _N/A_

#### 1.2 Extend App State
- [ ] Add `GitSource` interface to app state types
- [ ] Add `gitSource?` field to `AppState` interface
- [ ] Ensure `apps.json` serialization handles new field

**Completion**: _Not started_
**Commit**: _N/A_

#### 1.3 Verify Dependencies
- [ ] Verify `git` CLI detection at startup (log warning if missing)
- [ ] No new npm dependencies needed (uses child_process for git)

**Completion**: _Not started_
**Commit**: _N/A_

---

### 2. Implementation Tasks

#### 2.1 Git Client
- [ ] Implement `GitClient` class in `src/core/git-deploy/git-client.ts`
- [ ] `clone(url, dest, branch, token?)` - shallow clone with optional PAT
- [ ] `pull(repoPath, branch)` - pull latest changes
- [ ] `getCommitSha(repoPath)` - read HEAD commit SHA
- [ ] `getBranch(repoPath)` - read current branch
- [ ] PAT injection into HTTPS URL (in-memory only, never logged)
- [ ] Error handling: network failures, invalid URLs, auth failures
- [ ] Sanitize all git output to strip tokens before logging

**Completion**: _Not started_
**Commit**: _N/A_

#### 2.2 Git Deploy Service
- [ ] Implement `GitDeployService` in `src/core/git-deploy/git-deploy.ts`
- [ ] `deploy(request)` - validate URL, resolve name, clone, update state
- [ ] `redeploy(appName)` - stop process, git pull, trigger rebuild
- [ ] URL validation (must be `https://github.com/...` format)
- [ ] App name resolution from repo URL (strip `.git`, use repo name)
- [ ] Conflict detection (app name already exists)
- [ ] Partial clone cleanup on failure (remove incomplete folder)
- [ ] Singleton pattern with `getGitDeployService()` / `resetGitDeployService()`

**Completion**: _Not started_
**Commit**: _N/A_

#### 2.3 Token Management
- [ ] Store tokens via SecretManager (platform-level, not per-app)
- [ ] `setToken(name, token)` - encrypt and store PAT
- [ ] `removeToken(id)` - delete stored token
- [ ] `listTokens()` - return id + name only (never expose token value)
- [ ] `getToken(id)` - decrypt and return token (internal use only)

**Completion**: _Not started_
**Commit**: _N/A_

#### 2.4 GitHub Webhook Handler
- [ ] Implement webhook handler in `src/core/git-deploy/github-webhook.ts`
- [ ] Parse GitHub `push` event payload
- [ ] Verify `X-Hub-Signature-256` header (HMAC-SHA256)
- [ ] Match push event repo URL + branch to deployed apps
- [ ] Trigger redeploy for matching apps with `autoRedeploy: true`
- [ ] Ignore non-push events gracefully

**Completion**: _Not started_
**Commit**: _N/A_

#### 2.5 REST API Routes
- [ ] Create `src/api/routes/git-deploy.ts`
- [ ] `POST /api/v1/git/deploy` - deploy from repo URL
- [ ] `POST /api/v1/git/redeploy/:name` - redeploy existing git app
- [ ] `POST /api/v1/git/webhook` - GitHub webhook receiver
- [ ] `GET /api/v1/git/tokens` - list tokens
- [ ] `POST /api/v1/git/tokens` - add token
- [ ] `DELETE /api/v1/git/tokens/:id` - remove token
- [ ] Input validation with Zod schemas
- [ ] Mount routes in API server

**Completion**: _Not started_
**Commit**: _N/A_

#### 2.6 CLI Commands
- [ ] Add `--git <url>` flag to `drop deploy` command
- [ ] Add `--branch <branch>` flag (default: `main`)
- [ ] Add `drop redeploy <name>` command
- [ ] Add `drop git:token add <name>` command (secure prompt for token)
- [ ] Add `drop git:token list` command
- [ ] Add `drop git:token remove <id>` command

**Completion**: _Not started_
**Commit**: _N/A_

#### 2.7 Dashboard UI - Deploy Page
- [ ] Create `GitDeployPage.tsx` at `/dashboard/deploy/git`
- [ ] Repo URL input with GitHub URL validation
- [ ] Branch input (default: `main`)
- [ ] Optional app name override
- [ ] Auto-redeploy toggle (default: on)
- [ ] Token selector dropdown (for private repos)
- [ ] Deploy button with progress feedback
- [ ] Error states: invalid URL, clone failure, name conflict
- [ ] Add navigation link in sidebar/header

**Completion**: _Not started_
**Commit**: _N/A_

#### 2.8 Dashboard UI - Extensions
- [ ] App detail page: show git source info (repo link, branch, commit SHA)
- [ ] App detail page: "Redeploy" button for git-deployed apps
- [ ] App detail page: "Disconnect from Git" option
- [ ] Settings page: GitHub tokens management section
- [ ] Settings page: webhook URL display with copy button

**Completion**: _Not started_
**Commit**: _N/A_

---

### 3. Testing Tasks

#### 3.1 Unit Tests
- [ ] Create `src/core/git-deploy/git-deploy.test.ts`
- [ ] GitClient: clone/pull command generation
- [ ] GitClient: PAT injection and sanitization
- [ ] GitDeployService: URL validation
- [ ] GitDeployService: app name resolution
- [ ] GitDeployService: duplicate name rejection
- [ ] Webhook handler: signature verification
- [ ] Webhook handler: repo-to-app matching
- [ ] Token manager: encrypt/decrypt round-trip

**Completion**: _Not started_
**Commit**: _N/A_

#### 3.2 Integration Tests
- [ ] Deploy public repo end-to-end
- [ ] Redeploy via API
- [ ] Webhook triggers redeploy
- [ ] Delete git-deployed app cleans up completely
- [ ] Invalid URL returns clear error

**Completion**: _Not started_
**Commit**: _N/A_

#### 3.3 API Tests
- [ ] All 6 API endpoints: happy path
- [ ] Auth required for token management
- [ ] Validation errors return proper format

**Completion**: _Not started_
**Commit**: _N/A_

---

### 4. Documentation Tasks

#### 4.1 Code Documentation
- [ ] JSDoc for all public APIs in git-deploy module
- [ ] Inline comments for PAT handling (security-sensitive)

**Completion**: _Not started_
**Commit**: _N/A_

#### 4.2 Update Project Docs
- [ ] Update PRD-016 status to "Completed"
- [ ] Update FEATURE-INDEX.md
- [ ] Add to CHANGELOG.md

**Completion**: _Not started_
**Commit**: _N/A_

---

## Blockers & Dependencies

| Blocker | Status | Resolution |
|---------|--------|------------|
| `git` CLI must be installed on host | Open | Detect at startup, log warning if missing |
| SecretManager must be initialized | Resolved | Already initialized in platform startup |

---

## Code Review Checklist

Before marking as complete:
- [ ] All tasks checked off
- [ ] PATs never logged or exposed in API responses
- [ ] Tests passing (`npm run test`)
- [ ] Linting passing (`npm run lint`)
- [ ] Build successful (`npm run build`)
- [ ] Dashboard rebuilt (`npm run build:dashboard`)
- [ ] Code reviewed by peer
- [ ] PR merged to develop

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2026-03-19 | Claude | Initial task breakdown |
