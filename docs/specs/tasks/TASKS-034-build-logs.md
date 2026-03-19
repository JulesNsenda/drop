# TASKS-034: Build Logs

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-034 |
| PRD | PRD-034 |
| Branch | `feature/DROP-034-build-logs` |
| Created | 2026-03-19 |

---

## Tasks

### 1. Build Log Writer
- [ ] Create `src/core/builder/build-logger.ts`
- [ ] Open write stream to `data/logs/builds/<appname>/<timestamp>.log`
- [ ] Pipe subprocess stdout and stderr to the log file and to console
- [ ] Close stream and record final path when build completes

### 2. Builder Integration
- [ ] Pass `BuildLogger` instance to builder strategies
- [ ] All strategies write install + build output through the logger
- [ ] On build failure, flush and close log before emitting error event
- [ ] Store build log path on AppState (`lastBuildLog`)

### 3. API Endpoint
- [ ] Add `GET /api/v1/apps/:name/build-logs` route
- [ ] Default: return contents of latest build log as plain text
- [ ] Query param `?deploy=<timestamp>` to fetch a specific log
- [ ] Add `GET /api/v1/apps/:name/build-logs/list` returning available log timestamps
- [ ] Return 404 if no build logs exist for the app

### 4. Dashboard Build Log Viewer
- [ ] Add build log panel to app detail page
- [ ] Render log content in a scrollable monospace container
- [ ] Support ANSI color codes (use `ansi-to-html` or similar)
- [ ] Auto-show build log on deploy failure

### 5. Log Rotation
- [ ] After writing a new build log, count existing logs for that app
- [ ] Delete oldest logs beyond the retention limit (default: 10)
- [ ] Make retention limit configurable via platform config

### 6. Build & Test
- [ ] Unit test: BuildLogger writes to correct path
- [ ] Unit test: log rotation deletes oldest files
- [ ] API test: endpoint returns log content
- [ ] Dashboard builds clean
- [ ] TypeScript compiles
