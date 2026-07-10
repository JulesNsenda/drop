# PRD-040: MCP Server (Agent Deploy Target — Hosted)

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-040 |
| Feature | Hosted MCP endpoint (`/api/v1/mcp`) on the DROP API server |
| Status | Completed |
| Priority | P1 |
| Target | v2.1 |
| Depends On | PRD-039 (source upload pipeline), PRD-016 (git deploy) |
| Created | 2026-07-09 |
| Revised | 2026-07-09 — direction change, see below |

---

## Revision note (2026-07-09)

v1 of this PRD specified a separate-repo stdio npm package (`dropkit-mcp`) that
tars the developer's local project. Direction changed on the owner's call: the
MCP server is **hosted by the DROP platform itself**, inside this repo, served
over MCP's Streamable HTTP transport on the existing API server. Rationale: the
platform is already a long-running TLS-terminated service with API-key auth —
a `/api/v1/mcp` mount is a remote MCP server with zero extra deployment, usable
from any MCP client (Claude Code/Desktop, Cursor) via
`--transport http` + an `Authorization: Bearer <key>` header, including
surfaces with no shell and no local DROP tooling.

The trade-off: a remote MCP cannot read the agent's local filesystem, so
"tar my local folder" is not a hosted tool. Small AI-generated apps deploy via
inline file contents (`deploy_files`); larger projects use `deploy_from_git`
or the curl recipe in `docs/AGENT-DEPLOY.md`. A thin local stdio package
(original v1 scope) is **deferred** as a possible follow-up — it adds packaging
convenience, not capability, now that the REST recipe and hosted endpoint exist.

## Overview

Mount an MCP server at `POST /api/v1/mcp` (Streamable HTTP, stateless mode) on
the existing Hono API server, gated by the same `authMiddleware('user')` and a
rate limit. Tools execute with the caller's identity — the API key's `userId`
flows through the existing `canAccess` ownership model, so a `user`-role key
only sees and touches its own apps. Tool output that contains application data
(logs, build output) is framed as untrusted content.

## Changes

1. **Endpoint** — `/api/v1/mcp` served via the MCP SDK's
   `StreamableHTTPServerTransport` in stateless mode (no session state; each
   request builds a server instance over the shared tool registry). Auth
   `user`+ (never anonymous), stricter rate-limit bucket, mounted in
   `server.ts` alongside the other route groups.
2. **`deploy_files` tool** — input `{ name, files: [{ path, content }] }`,
   capped (≤ 48 files, ≤ 1.5 MB total, text content); validates each relative
   path (containment, no absolute/`..`), writes the files to a staging dir,
   packs a gzipped tarball, and hands it to the **existing PRD-039 pipeline**
   (same preflight guards as `POST /apps/:name/source` — ownership/404,
   app-limit, in-progress 409, stopped-app 409, disk watermark — then
   `UploadDeployService.deploy`). Waits for the deploy episode to reach a
   terminal state and returns the app URL, or the failing stage + build-log
   tail (untrusted-framed) on failure.
3. **`deploy_from_git` tool** — wraps the existing `GitDeployService.deploy`
   (GitHub URL + optional branch), same result shape as `deploy_files`.
4. **Read/manage tools** — `list_apps`, `app_status { name }`,
   `app_logs { name, lines }` (untrusted-framed), `restart_app { name }` —
   all through the same manager/service layer the REST routes use, with
   `canAccess` enforced. No `set_secrets`, no `remove_app` (unchanged from v1:
   destructive/blast-radius tools stay off the MCP surface).
5. **Shared preflight** — extract the upload-route guard sequence into a
   helper both `POST /apps/:name/source` and `deploy_files` call, so policy
   can't drift between the REST and MCP surfaces.
6. **Docs** — extend `docs/AGENT-DEPLOY.md` with the hosted-MCP setup
   (Claude Code / Cursor config lines, key hygiene, tool list, when to use
   MCP vs the curl recipe).

## Non-Goals

- No OAuth — claude.ai web connectors want OAuth flows; v1 authenticates with
  API keys via headers (Claude Code/Desktop/Cursor support this). OAuth is a
  candidate follow-up.
- No local stdio npm package in this iteration (deferred, see revision note).
- No `set_secrets` / `remove_app` tools.
- No SSE session resumption/streaming — stateless request/response only.

## Open Questions

- None blocking. (npm name question from v1 is moot; `@dropkit/mcp` on the
  public registry is a third party's package — avoid implying affiliation.)
