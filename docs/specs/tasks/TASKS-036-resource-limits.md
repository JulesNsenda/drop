# TASKS-036: Resource Limits

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-036 |
| PRD | PRD-036 |
| Branch | `feature/DROP-036-resource-limits` |
| Created | 2026-03-19 |

---

## Tasks

### 1. Resource Config Model
- [ ] Add `resources` field to AppState: `{ memory: string, cpus: string }`
- [ ] Add global defaults to platform config: `resourceDefaults.memory`, `resourceDefaults.cpus`
- [ ] Validate resource values (memory: "64m"-"4g", cpus: "0.1"-"4.0")
- [ ] Merge: per-app config overrides global defaults

### 2. Docker Enforcement
- [ ] Pass `--memory` and `--cpus` to `docker run` from app resource config
- [ ] On limit update, restart container with new flags
- [ ] Read current usage via `docker stats --no-stream` for monitoring

### 3. Cgroups Fallback (PM2 Mode)
- [ ] When running without Docker, apply memory limit via PM2 `max_memory_restart`
- [ ] Log warning that CPU limits are not enforced in PM2 mode
- [ ] Document cgroups v2 manual setup for full enforcement

### 4. Resource API
- [ ] Add `PUT /api/v1/apps/:name/resources` endpoint
- [ ] Accept `{ memory?: string, cpus?: string }` body, validate with zod
- [ ] Update app state and restart app to apply new limits
- [ ] Add `PUT /api/v1/config/resource-defaults` (admin only)
- [ ] Add `GET /api/v1/apps/:name/resources/usage` returning current memory/CPU usage

### 5. Dashboard UI
- [ ] Add resource section to app detail page showing current limits and usage
- [ ] Editable memory and CPU fields with save button
- [ ] Usage bar chart or gauge (memory used vs limit)
- [ ] Admin page for global resource defaults

### 6. Build & Test
- [ ] Unit test: resource config merging (per-app over global)
- [ ] Unit test: validation rejects invalid values
- [ ] Integration test: container starts with correct resource flags
- [ ] Dashboard builds clean
- [ ] TypeScript compiles
