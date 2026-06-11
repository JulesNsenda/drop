# PRD-016: Git Deploy (GitHub Integration)

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-016 |
| Feature | Git Deploy |
| Status | Not Started |
| Phase | 4 - Production Readiness |
| Priority | P1 |
| Owner | TBD |
| Created | 2026-03-19 |
| Updated | 2026-03-19 |

---

## 1. Overview

### 1.1 Summary
Git Deploy enables users to deploy applications directly from GitHub repositories. Instead of manually dropping folders, users paste a repo URL and DROP clones, detects, builds, and starts the app using the existing pipeline. Supports auto-redeploy via GitHub webhooks on push.

### 1.2 Goals
- [ ] Deploy apps from public GitHub repos with zero auth config
- [ ] Deploy from private repos using Personal Access Tokens (PATs)
- [ ] Auto-redeploy on push via GitHub webhook integration
- [ ] Dashboard UI for git-based deployments (paste URL, pick branch, deploy)
- [ ] CLI command for git-based deployments
- [ ] Store git metadata (repo URL, branch, commit SHA) in app state

### 1.3 Non-Goals
- GitHub App / OAuth integration (future enhancement)
- PR preview deployments (branch-per-environment)
- GitLab / Bitbucket support (future, but design for extensibility)
- Monorepo support (subdirectory deploys)
- Git LFS support
- In-dashboard code editing or diff viewing

### 1.4 Success Metrics
- Deploy a public repo in under 60 seconds (clone + build + start)
- Deploy a private repo with PAT in under 90 seconds
- Auto-redeploy triggers within 5 seconds of webhook receipt
- Zero additional configuration for repos with `drop.yaml`

---

## 2. Background

### 2.1 Problem Statement
DROP currently requires users to manually place application files in the `webapps/` directory. This works well for local development but is impractical for deploying from remote repositories. Users must manually `git clone` into the webapps folder, and redeployments require SSH access to `git pull` and restart. A first-class git integration eliminates this friction while preserving DROP's "paste and deploy" simplicity.

### 2.2 User Stories

```
As a developer
I want to paste a GitHub repo URL into the dashboard
So that my app deploys without manual file management
```

```
As a developer
I want my app to auto-redeploy when I push to main
So that I get continuous deployment without CI/CD setup
```

```
As a developer with private repos
I want to add a GitHub token once
So that DROP can clone any repo I have access to
```

```
As a CLI user
I want to run `drop deploy --git <url>`
So that I can deploy from GitHub without the dashboard
```

### 2.3 Reference
- Specification: `docs/specs/DROP-PAAS-SPECIFICATION.md`
- Related PRDs: PRD-003 (Builder), PRD-011 (Dashboard), PRD-009 (REST API)
- Existing: Webhook system (v0.3.0), Secret Manager (v0.2.0)

---

## 3. Technical Design

### 3.1 Architecture

The git deploy feature integrates as a new deployment source that feeds into the existing pipeline. The app folder is real (required for build/run), but DROP tracks that its source is a git repo.

```
Dashboard/CLI/API                    GitHub
      │                                │
      ▼                                │
 ┌──────────┐     git clone        ┌───┴────┐
 │ Git      │ ◄──────────────────► │ GitHub │
 │ Deploy   │     git pull         │ API    │
 │ Service  │                      └───┬────┘
 └────┬─────┘                          │
      │ writes to webapps/             │ webhook POST
      ▼                                ▼
 ┌──────────┐                    ┌──────────┐
 │ Watcher  │                    │ Webhook  │
 │ Service  │                    │ Receiver │
 └────┬─────┘                    └────┬─────┘
      │                               │
      ▼                               ▼
 ┌──────────────────────────────────────────┐
 │        Existing Pipeline                  │
 │  Detect → Build → Start → Route          │
 └──────────────────────────────────────────┘
```

### 3.2 Interfaces

```typescript
// Git source configuration stored per-app
interface GitSource {
  repoUrl: string;         // https://github.com/user/repo
  branch: string;          // default: 'main'
  lastCommitSha?: string;  // tracks deployed commit
  lastClonedAt?: string;   // ISO timestamp
  autoRedeploy: boolean;   // trigger redeploy on webhook push
  tokenId?: string;        // reference to stored PAT (encrypted)
}

// Extended AppState
interface AppState {
  // ... existing fields
  gitSource?: GitSource;   // present if deployed from git
}

// API request to deploy from git
interface GitDeployRequest {
  repoUrl: string;
  branch?: string;         // default: 'main'
  name?: string;           // app name override (default: repo name)
  autoRedeploy?: boolean;  // default: true
  tokenId?: string;        // for private repos
}

// GitHub token management
interface GitHubToken {
  id: string;
  name: string;            // user-friendly label
  token: string;           // encrypted PAT
  createdAt: string;
}

// Git deploy service
interface GitDeployService {
  deploy(request: GitDeployRequest): Promise<AppState>;
  redeploy(appName: string): Promise<AppState>;
  setToken(name: string, token: string): Promise<GitHubToken>;
  removeToken(id: string): Promise<boolean>;
  listTokens(): Promise<Array<{ id: string; name: string; createdAt: string }>>;
}
```

### 3.3 Dependencies
- Internal: WatcherService, BuilderService, ProcessManager, SecretManager, AppStateManager, WebhookManager
- External: `git` CLI (must be installed on host)

### 3.4 Data Model

**App state extension** (in `apps.json`):
```json
{
  "name": "my-app",
  "type": "nodejs",
  "status": "running",
  "path": "C:\\drop\\data\\webapps\\my-app",
  "gitSource": {
    "repoUrl": "https://github.com/user/my-app",
    "branch": "main",
    "lastCommitSha": "abc123f",
    "lastClonedAt": "2026-03-19T12:00:00Z",
    "autoRedeploy": true
  }
}
```

**GitHub tokens** (stored via SecretManager, encrypted at rest):
```json
{
  "id": "tok_abc123",
  "name": "My GitHub PAT",
  "createdAt": "2026-03-19T12:00:00Z"
}
```
Token values are encrypted with AES-256-GCM via the existing SecretManager.

---

## 4. Implementation Plan

### 4.1 File Structure
```
src/
├── core/git-deploy/
│   ├── index.ts              # Public exports
│   ├── git-deploy.ts         # GitDeployService implementation
│   ├── git-deploy.types.ts   # Interfaces and types
│   ├── git-client.ts         # Git CLI wrapper (clone, pull, checkout)
│   ├── github-webhook.ts     # GitHub webhook payload handler
│   └── git-deploy.test.ts    # Unit tests
├── api/routes/
│   └── git-deploy.ts         # REST API routes
├── dashboard/src/
│   ├── pages/
│   │   └── GitDeployPage.tsx  # Deploy from GitHub UI
│   └── components/
│       ├── GitDeployForm.tsx  # Repo URL + branch form
│       └── GitTokenManager.tsx # PAT management UI
```

### 4.2 Key Components

1. **GitClient** (`git-client.ts`): Thin wrapper around the `git` CLI. Handles clone, pull, checkout, rev-parse. Injects PAT into HTTPS URLs for private repos (`https://<token>@github.com/user/repo`). Never logs tokens.

2. **GitDeployService** (`git-deploy.ts`): Orchestrates the deploy flow:
   - Validates repo URL format
   - Resolves app name from repo name (or user override)
   - Clones repo into `webapps/<name>/`
   - Updates app state with `gitSource` metadata
   - Lets existing pipeline handle detect → build → start
   - For redeploy: `git pull` + rebuild

3. **GitHub Webhook Handler** (`github-webhook.ts`): Receives GitHub `push` events, verifies signature (HMAC-SHA256), matches repo URL to deployed apps, triggers redeploy for apps with `autoRedeploy: true`.

4. **Token Manager**: Uses existing SecretManager to store PATs encrypted at rest. Tokens are platform-level (not per-app) so one token can deploy multiple private repos.

### 4.3 API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/v1/git/deploy` | Deploy from a GitHub repo |
| POST | `/api/v1/git/redeploy/:name` | Redeploy (git pull + rebuild) |
| POST | `/api/v1/git/webhook` | GitHub webhook receiver |
| GET | `/api/v1/git/tokens` | List stored GitHub tokens (no values) |
| POST | `/api/v1/git/tokens` | Store a new GitHub PAT |
| DELETE | `/api/v1/git/tokens/:id` | Remove a stored token |

### 4.4 CLI Commands

| Command | Description |
|---------|-------------|
| `drop deploy --git <url> [--branch <branch>] [--name <name>]` | Deploy from GitHub |
| `drop redeploy <name>` | Git pull + rebuild for a git-deployed app |
| `drop git:token add <name>` | Add a GitHub PAT (prompted securely) |
| `drop git:token list` | List stored tokens |
| `drop git:token remove <id>` | Remove a token |

### 4.5 Dashboard UI

**Deploy from GitHub page** (`/dashboard/deploy/git`):
- Input field for repo URL with validation (GitHub URL format)
- Branch selector (text input, defaults to `main`)
- Optional app name override
- Toggle for auto-redeploy
- Dropdown to select stored token (for private repos)
- Deploy button → shows progress (clone → detect → build → start)

**App detail page** (existing, extended):
- Show git source info (repo URL as link, branch, last commit SHA)
- "Redeploy" button (git pull + rebuild)
- "Disconnect from Git" option (keeps files, removes git tracking)

**Settings page** (existing, extended):
- GitHub tokens management section
- Webhook URL display with copy button

### 4.6 Deploy Flow

```
1. User submits repo URL + branch
2. Validate URL format (must be github.com)
3. Resolve app name: repo name or user override
4. Check for name conflicts with existing apps
5. If private: inject PAT into clone URL
6. git clone --depth 1 --branch <branch> <url> webapps/<name>/
7. Write gitSource to app state
8. Watcher detects new folder → existing pipeline kicks in
9. On completion: read commit SHA, update state
```

### 4.7 Redeploy Flow

```
1. Triggered by: API call, dashboard button, webhook, or CLI
2. Stop running process (if any)
3. cd webapps/<name> && git pull origin <branch>
4. Read new commit SHA, update state
5. Trigger rebuild → restart via existing pipeline
```

### 4.8 Webhook Flow

```
1. GitHub POSTs to /api/v1/git/webhook
2. Verify X-Hub-Signature-256 header (HMAC-SHA256)
3. Parse push event: extract repo URL and branch
4. Find all apps with matching gitSource.repoUrl and branch
5. For each app with autoRedeploy: trigger redeploy
```

---

## 5. Testing Strategy

### 5.1 Unit Tests
- [ ] GitClient: clone, pull, checkout commands generated correctly
- [ ] GitClient: PAT injection into HTTPS URLs
- [ ] GitClient: PAT never appears in logs or errors
- [ ] GitDeployService: validates repo URL format
- [ ] GitDeployService: resolves app name from repo URL
- [ ] GitDeployService: rejects duplicate app names
- [ ] GitHub webhook: signature verification (valid/invalid/missing)
- [ ] GitHub webhook: matches push events to deployed apps
- [ ] Token storage: encrypt/decrypt round-trip

### 5.2 Integration Tests
- [ ] Deploy a public repo end-to-end (clone → detect → build → start)
- [ ] Redeploy after simulated push
- [ ] Webhook triggers redeploy for correct app
- [ ] Delete a git-deployed app (cleans up folder, state, config)
- [ ] Deploy with invalid URL returns clear error

### 5.3 Edge Cases
- Repo URL with `.git` suffix vs without: normalize both
- Branch doesn't exist: fail with clear error before clone
- Network failure during clone: clean up partial folder
- Clone into existing app name: reject with conflict error
- Very large repo: shallow clone (`--depth 1`) by default
- Repo with no detectable app type: error after clone, suggest `drop.yaml`
- Token deleted while app still deployed: redeploy fails with clear error, manual fix possible

---

## 6. Security Considerations

- [ ] PATs encrypted at rest via SecretManager (AES-256-GCM)
- [ ] PATs never logged, never returned in API responses
- [ ] PATs injected into clone URL in-memory only, never written to disk
- [ ] Webhook signature verified before processing (HMAC-SHA256)
- [ ] Repo URL validated (must be `https://github.com/...` format)
- [ ] Clone runs with `--depth 1` to minimize data transfer
- [ ] Same trust boundary as folder drop: user code runs on host
- [ ] Token scoping documented: recommend `repo:read` only
- [ ] Rate limiting on webhook endpoint (reuse existing rate limiter)
- [ ] Audit logging for deploy/redeploy/token operations

---

## 7. Rollout Plan

### 7.1 Feature Flag
- Config: `enableGitDeploy: true/false` in platform config
- Default: `true`

### 7.2 Rollout Stages
1. Core git client + deploy service (backend only)
2. REST API endpoints
3. CLI commands
4. Dashboard UI
5. GitHub webhook auto-redeploy
6. Token management UI

---

## 8. Open Questions

- [ ] Should we support `--depth 1` (shallow clone) by default or full clone? Shallow is faster but breaks `git log`. Recommendation: shallow by default, full clone as option.
- [ ] Should redeploy preserve or reset environment variables set via dashboard? Recommendation: preserve, since env vars are stored separately from the app folder.
- [ ] Future: GitHub App integration for better UX (no PAT management). Defer to post-v1.0.
- [ ] Future: GitLab/Bitbucket support. Design GitClient interface to be provider-agnostic.

---

## 9. Differentiation from Vercel/Netlify

| Aspect | DROP Git Deploy | Vercel/Netlify |
|--------|----------------|----------------|
| Hosting | Self-hosted, your server | Their cloud |
| Runtime | Full process (server, workers) | Serverless/edge functions |
| Database | Auto-provisioned PostgreSQL | External service required |
| Git integration | Clone + build (simple) | Deep (PR previews, checks) |
| Auth | PAT (simple) | GitHub App (complex) |
| Cost | Free (your server) | Per-seat pricing |
| Setup | Paste URL, click deploy | Connect account, import repo |
| Auto-deploy | Webhook-based | Built-in |

DROP's value: **Vercel-like simplicity, self-hosted with batteries included.**

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2026-03-19 | Claude | Initial draft |
