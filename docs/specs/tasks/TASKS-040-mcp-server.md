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
- [x] Add `@modelcontextprotocol/sdk` dependency (must work under the repo's CommonJS tsconfig)
- [x] `POST /api/v1/mcp` — Streamable HTTP transport in stateless mode, bridged from the Hono/@hono/node-server request
- [x] `authMiddleware('user')` on `/mcp` (never anonymous; auth-disabled boxes behave like every other mutating route) + a dedicated rate-limit bucket
- [x] GET/DELETE `/mcp` → 405 (stateless mode has no sessions/streams)

### 2. Tool core (`src/api/mcp/`)
- [x] Per-request server instance over a shared tool registry, with the request's `AuthContext` injected into tool execution
- [x] `deploy_files { name, files: [{path, content}] }` — caps (≤48 files, ≤1.5 MB total), per-path containment validation, staging dir → gzipped tarball → shared upload preflight → `UploadDeployService.deploy` → poll episode to terminal (bounded wait, default 120 s, `DROP_MCP_DEPLOY_WAIT_MS`) → URL on success; failing stage + build-log tail (untrusted-framed) on failure; "still building, check app_status" on wait timeout
- [x] `deploy_from_git { name?, url, branch? }` — wraps `GitDeployService.deploy`, then the same episode wait/result shape
- [x] `list_apps`, `app_status { name }`, `app_logs { name, lines? }` (untrusted-framed), `restart_app { name }` — same manager/service layer as the REST routes, `canAccess` enforced, foreign/unknown app → same not-found text (no existence oracle)
- [x] Untrusted-output framing helper for all app-derived content

### 3. Shared preflight
- [x] Extract the `POST /apps/:name/source` guard sequence (ownership/404, stopped-app 409, app limit, in-progress, per-user concurrency, disk watermark) into one helper consumed by both the REST route and `deploy_files` — policy must not drift between surfaces

### 4. Tests
- [x] Unit: tool handlers with mocked services — authz (foreign app), caps, path-escape rejection, stopped-app, result shapes
- [x] Integration (proof-of-life): MCP SDK `Client` + `StreamableHTTPClientTransport` against a live `ApiServer` on an ephemeral port — `listTools()` shows the 6 tools; `deploy_files` round-trips through a mocked service layer
- [x] REST regression: `apps.source.test.ts` still green after the preflight extraction

### 5. Docs & verification
- [x] `docs/AGENT-DEPLOY.md`: hosted-MCP section — Claude Code (`claude mcp add --transport http`) and Cursor config, key hygiene, tool list, MCP vs curl guidance
- [x] TypeScript compiles, lint clean, full suite green, dashboard builds (build:server verified; dashboard unaffected by this change)

## Implementation notes (2026-07-09)

- SDK: `@modelcontextprotocol/sdk@1.29.0`. It ships ESM-only top-level
  `exports` (no `main`/`types`); this repo's classic `moduleResolution: node`
  can't see the `exports` map. Workaround: import the deep, `require`-safe
  paths directly (e.g. `@modelcontextprotocol/sdk/server/mcp.js`,
  `.../server/streamableHttp.js`, `.../client/index.js`,
  `.../client/streamableHttp.js`, `.../types.js`) — these resolve correctly
  under tsc (via the SDK's `typesVersions` fallback to `dist/esm`), ts-jest,
  and plain Node `require` (via the SDK's `exports` wildcard to `dist/cjs`) —
  verified empirically against all three resolvers. No tsconfig/jest.config
  changes were needed.
- `zod` had to be pinned to the exact patch `3.25.67` (was floating on
  `^3.24.0`, which resolved to `3.25.76`) — zod's public type surface changed
  starting at `3.25.68` in a way that makes `registerTool`'s generics blow
  past TypeScript's instantiation-depth limit (TS2589), a known upstream
  regression (colinhacks/zod#4984, modelcontextprotocol/typescript-sdk#1180).
- Body-size limit: `/api/v1/mcp` is carved out to a 2 MB cap (not skipped
  entirely, unlike the raw-tarball `/apps/*/source` carve-out) so
  `deploy_files`'s 1.5 MB summed-content cap plus JSON-RPC overhead fits
  under it, while every other route keeps the global 1 MB limit.
- Transport bridging: `@hono/node-server` exposes the raw
  `IncomingMessage`/`ServerResponse` on `c.env` (`{ incoming, outgoing }`);
  `transport.ts` hands those directly to `StreamableHTTPServerTransport.
  handleRequest`, with the JSON-RPC body pre-parsed by Hono and passed as
  `parsedBody` (so the transport never re-reads the request stream). Because
  `handleRequest` writes straight to `outgoing`, the Hono handler returns a
  `Response` with the `x-hono-already-sent` header so the adapter doesn't
  also try to write its own response — this is `@hono/node-server`'s
  documented bridge for handlers that drive the raw Node response
  themselves. Verified end-to-end by `mcp.integration.test.ts`, which starts
  a real `ApiServer` on a real TCP port and drives it with the SDK's own
  `Client` + `StreamableHTTPClientTransport`.
