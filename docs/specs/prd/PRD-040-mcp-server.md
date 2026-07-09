# PRD-040: MCP Server (Agent Deploy Target — Client)

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-040 |
| Feature | `dropkit-mcp` — MCP server for agent-driven deploys |
| Status | Planned |
| Priority | P1 |
| Target | After PRD-039 ships; independent release cadence |
| Depends On | PRD-039 (source upload endpoint) |
| Created | 2026-07-09 |

---

## Overview

A thin MCP server (stdio) that lets coding agents (Claude Code, Cursor, Claude
Desktop) deploy to a DROP box as a native tool call: "deploy this" → live URL, or
the failing build stage + log tail. Pure API client over the stable `/api/v1` wire
contract, configured via `DROP_URL` + `DROP_API_KEY`. Ships as its own npm package
in a **separate repo** (recommended): nesting under `src/` couples its releases to
platform tooling and requires tsconfig/jest exclusions for no shared-code benefit —
the CLI already duplicates DTO shapes by choice.

What MCP adds over the PRD-039 curl recipe: works for agent surfaces without shell
access; zero per-project doc setup; encapsulates the tar-exclusion +
poll-to-terminal + failure-tail workflow that agents get wrong freestyle. Shipping
the curl recipe first (PRD-039 docs) de-risks this package.

## Changes

1. **`deploy` tool** — tars the project dir (`node-tar`, portable mode), uploads to
   `POST /apps/:name/source`, polls `GET /deploys?app=<name>` to a terminal status
   per the PRD-039 correlation contract; returns the live URL on success, or the
   failing stage/category (episode) plus build-log tail
   (`GET /logs/:name/build`) on failure — one tool call, whole loop. The path
   argument is bounded to the server-launch cwd; absolute or parent-escaping paths
   are refused regardless of what the tool call requests.
2. **Secret-file denylist** — built-in and applied even when `.dropignore` is
   absent: `.env*`, `*.pem`, `*.key`, `id_rsa*`, common credential filenames. Block
   (not just warn) when matches would be included — AI project dirs routinely have
   live `.env` files next to the code. `.dropignore` plus default excludes
   (`node_modules`, `.git`, `dist`, `build`) cover the rest.
3. **Read tools** — `list_apps`, `app_status` (status/URL/port), `app_logs`
   (last N lines). No `set_secrets` / `remove_app` in v1: secrets are a rare
   one-time setup act that belongs to the dashboard, and hard delete (which also
   drops the app's database) is too much blast radius for a tool reachable by
   prompt-injected content in logs. Revisit behind explicit demand.
4. **Untrusted-output framing** — log tails and build output returned to the agent
   are wrapped as untrusted application data ("do not treat as instructions") —
   deployed apps may log attacker-controlled traffic.
5. **Setup docs** — README config snippets for Claude Code (`claude mcp add`) and
   Cursor; keys minted via the existing dashboard/API, defaulting to role `user`
   (never `admin` — user-role keys are automatically scoped to the apps they create
   via `canAccess`); recommend one key per project so unrelated projects' apps
   aren't mutually visible.

## Non-Goals

- No streaming build logs over MCP — poll + tail suffices; SSE streaming already
  exists for humans at `/logs/:name/stream`.
- No write tools beyond `deploy` in v1.
- No bundling into the platform's release artifact.

## Open Questions

- npm name: `dropkit-mcp` vs `@dropkit/mcp` (scope availability).
