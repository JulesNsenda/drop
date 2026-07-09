# TASKS-040: Hosted MCP Server

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-040 |
| PRD | PRD-040 (revised 2026-07-09: hosted endpoint, not a separate stdio package) |
| Branch | `feature/DROP-040-hosted-mcp` |
| Created | 2026-07-09 |

---

## Tasks

### 1. Endpoint plumbing
- [ ] Add `@modelcontextprotocol/sdk` dependency (must work under the repo's CommonJS tsconfig)
- [ ] `POST /api/v1/mcp` — Streamable HTTP transport in stateless mode, bridged from the Hono/@hono/node-server request
- [ ] `authMiddleware('user')` on `/mcp` (never anonymous; auth-disabled boxes behave like every other mutating route) + a dedicated rate-limit bucket
- [ ] GET/DELETE `/mcp` → 405 (stateless mode has no sessions/streams)

### 2. Tool core (`src/api/mcp/`)
- [ ] Per-request server instance over a shared tool registry, with the request's `AuthContext` injected into tool execution
- [ ] `deploy_files { name, files: [{path, content}] }` — caps (≤48 files, ≤1.5 MB total), per-path containment validation, staging dir → gzipped tarball → shared upload preflight → `UploadDeployService.deploy` → poll episode to terminal (bounded wait, default 120 s, `DROP_MCP_DEPLOY_WAIT_MS`) → URL on success; failing stage + build-log tail (untrusted-framed) on failure; "still building, check app_status" on wait timeout
- [ ] `deploy_from_git { name?, url, branch? }` — wraps `GitDeployService.deploy`, then the same episode wait/result shape
- [ ] `list_apps`, `app_status { name }`, `app_logs { name, lines? }` (untrusted-framed), `restart_app { name }` — same manager/service layer as the REST routes, `canAccess` enforced, foreign/unknown app → same not-found text (no existence oracle)
- [ ] Untrusted-output framing helper for all app-derived content

### 3. Shared preflight
- [ ] Extract the `POST /apps/:name/source` guard sequence (ownership/404, stopped-app 409, app limit, in-progress, per-user concurrency, disk watermark) into one helper consumed by both the REST route and `deploy_files` — policy must not drift between surfaces

### 4. Tests
- [ ] Unit: tool handlers with mocked services — authz (foreign app), caps, path-escape rejection, stopped-app, result shapes
- [ ] Integration (proof-of-life): MCP SDK `Client` + `StreamableHTTPClientTransport` against a live `ApiServer` on an ephemeral port — `listTools()` shows the 6 tools; `deploy_files` round-trips through a mocked service layer
- [ ] REST regression: `apps.source.test.ts` still green after the preflight extraction

### 5. Docs & verification
- [ ] `docs/AGENT-DEPLOY.md`: hosted-MCP section — Claude Code (`claude mcp add --transport http`) and Cursor config, key hygiene, tool list, MCP vs curl guidance
- [ ] TypeScript compiles, lint clean, full suite green, dashboard builds
