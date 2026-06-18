# TASKS-029: Docker Isolation

## Document Info

| Field | Value |
|-------|-------|
| Task ID | TASKS-029 |
| PRD | PRD-029 |
| Status | Completed (alternate design) |
| Branch | `feature/DROP-029-docker-isolation` |
| Created | 2026-03-19 |
| Updated | 2026-06-19 |

> **Status note (2026-06-19):** Container isolation is fully implemented and tested, but via a
> runtime-abstraction seam rather than the exact files/approach in the checklist below — so the
> boxes are left unticked as a record of the design delta:
> - Runtime strategy: `src/managers/runtime/app-runtime.ts` (interface), `pm2-runtime.ts`,
>   `container-manager.ts` (dockerode), selected via `getAppRuntime()` / `DROP_ISOLATION`
>   (`platform.ts`) — not a `DockerRuntime` in `src/managers/process/docker-runtime.ts`.
> - Docker availability is fail-closed in `docker` mode via `src/core/startup-constraints.ts`
>   (`checkDockerReachable`), falling back to PM2 when `isolation: 'none'`.
> - **No Dockerfile-template generation** (`src/core/builder/dockerfile/` does not exist) — uses
>   pinned base images in `container-config.ts` instead; images are pulled, not built per content hash.
> - Resource limits (`--memory`/`--cpus`/pids-limit), loopback port publishing, env injection,
>   Docker HEALTHCHECK, and a shared `drop-net` bridge with inter-container comms disabled are all present.
> - Untrusted builds run in-container via `src/core/builder/container-build-runner.ts`.
> - Tests: `container-manager.test.ts`, `pm2-runtime.test.ts`, `runtime-migrator.test.ts`.

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
