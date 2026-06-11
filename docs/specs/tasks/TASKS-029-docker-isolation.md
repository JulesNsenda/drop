# TASKS-029: Docker Isolation

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-029 |
| PRD | PRD-029 |
| Branch | `feature/DROP-029-docker-isolation` |
| Created | 2026-03-19 |

---

## Tasks

### 1. Docker Availability Check
- [ ] Add `DockerRuntime` class in `src/managers/process/docker-runtime.ts`
- [ ] Detect Docker presence at startup (`docker info`)
- [ ] Expose `isAvailable(): boolean` method
- [ ] Log warning and fall back to PM2 when Docker is missing

### 2. Dockerfile Generation
- [ ] Create `src/core/builder/dockerfile/` with templates per app type
- [ ] Node.js template: multi-stage build, `npm ci`, `npm start`
- [ ] Python template: pip install, gunicorn/uvicorn entrypoint
- [ ] Static template: nginx-based serving
- [ ] Skip generation when app already contains a Dockerfile

### 3. Image Build
- [ ] Build image via `docker build -t drop-<appname>:<hash> .`
- [ ] Stream build output to build log (PRD-034)
- [ ] Tag images with git SHA or file content hash
- [ ] Prune old images after successful build

### 4. Container Lifecycle
- [ ] Replace PM2 start/stop/restart with `docker run`/`docker stop`/`docker rm`
- [ ] Apply `--memory` and `--cpus` flags from app config (default 256m / 0.5)
- [ ] Map assigned host port to container port with `-p`
- [ ] Inject app environment variables with `--env-file`
- [ ] Health check via container health status or HTTP probe

### 5. Network Isolation
- [ ] Create Docker bridge network per tenant on first deploy
- [ ] Attach app containers to tenant network only
- [ ] Connect app container to shared `drop-services` network for database access
- [ ] Clean up tenant network when last app is removed

### 6. ProcessManager Abstraction
- [ ] Extract `RuntimeStrategy` interface (`start`, `stop`, `restart`, `status`, `logs`)
- [ ] Implement `PM2Strategy` (existing logic)
- [ ] Implement `DockerStrategy` (new container logic)
- [ ] Select strategy at startup based on Docker availability

### 7. Build & Test
- [ ] Unit tests for DockerRuntime and strategy selection
- [ ] Integration test: build image, start container, hit HTTP endpoint, stop
- [ ] Verify PM2 fallback works when Docker is absent
- [ ] TypeScript compiles
