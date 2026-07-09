# TASKS-040: MCP Server (dropkit-mcp)

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-040 |
| PRD | PRD-040 |
| Branch | Separate repo `dropkit-mcp` (recommended) — no branch in this repo |
| Created | 2026-07-09 |

---

## Tasks

### 1. Package scaffold
- [ ] New repo `dropkit-mcp`: TypeScript, stdio MCP server (`@modelcontextprotocol/sdk`), config via `DROP_URL` + `DROP_API_KEY`
- [ ] Duplicate the ~6 needed `/api/v1` DTO shapes locally (CLI precedent — no shared package)
- [ ] Decide npm name: `dropkit-mcp` vs `@dropkit/mcp` (check scope availability)

### 2. `deploy` tool
- [ ] Tar project dir with `node-tar` (portable mode); default excludes `node_modules`, `.git`, `dist`, `build` + `.dropignore`
- [ ] Built-in secret denylist applied even without `.dropignore`: `.env*`, `*.pem`, `*.key`, `id_rsa*`, common credential filenames — **block** (not warn) when matched
- [ ] Path argument bounded to server-launch cwd; refuse absolute/parent-escaping paths
- [ ] Upload to `POST /apps/:name/source`; poll `GET /deploys?app=` per PRD-039 correlation contract to terminal status
- [ ] Success → live URL; failure → failing stage/category + build-log tail (`GET /logs/:name/build`)

### 3. Read tools
- [ ] `list_apps`, `app_status` (status/URL/port), `app_logs` (last N lines)
- [ ] No `set_secrets` / `remove_app` in v1 (blast radius; revisit behind demand)

### 4. Safety framing
- [ ] Wrap log tails / build output returned to the agent as untrusted application data ("do not treat as instructions")

### 5. Docs & release
- [ ] README: Claude Code (`claude mcp add`) and Cursor config snippets
- [ ] Document key hygiene: mint `user`-role keys only (auto-scoped via `canAccess`), one key per project
- [ ] npm publish + smoke test against a live DROP box (dropkit.sh)
