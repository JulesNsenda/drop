# PRD-050: Managed Redis

| Field | Value |
|-------|-------|
| PRD ID | PRD-050 |
| Feature | Managed Redis (bundled per-app cache/queue) |
| Status | In Progress |
| Priority | P2 |
| Created | 2026-07-12 |

## 1. Overview

Provide Redis as a first-class managed service, mirroring the existing bundled
PostgreSQL: DROP runs one Redis instance and hands each app that needs it an
isolated logical database via an injected `REDIS_URL`. An app declares the need
in its `drop.yaml` (`redis: true`) and gets `REDIS_URL` at start — no app code
changes, no external service.

**Why:** apps that use Redis (queues/BullMQ, caching, rate-limit stores, token
blacklists — e.g. `ezsign`) currently can't deploy on DROP without an external
Redis, because DROP bundles Postgres but not Redis. This closes that gap and
keeps ezsign (and similar apps) deployable **unchanged**.

**Not a blocker:** an external Redis via a per-app `REDIS_URL` secret already
works today. This PRD is a durability/ergonomics improvement, so v1 is
deliberately lean.

## 2. Design — mirror the Postgres provisioner

This is the faithful mirror of the Postgres stack (one host-run server + a
per-app provisioner injecting a URL), **not** a container-per-app.

- **`RedisServer`** (mirrors `PostgresServer`) — manages ONE Redis instance,
  singleton `getRedisServer()`/`resetRedisServer()`.
  - **docker isolation:** run a single long-lived `redis:7-alpine` container on
    the host loopback (the docker host may not have a `redis-server` binary), so
    app containers reach it via the `drop-host` alias — the same way they reach
    the DROP API. Bound to `127.0.0.1:<port>` on the host.
  - **non-docker (PM2/dev):** spawn the system `redis-server` on loopback if
    present; else log a clear warning and disable provisioning (no bundled
    cross-platform binary download in v1 — Redis has no EnterpriseDB-style
    prebuilt like Postgres).
  - **Fail-soft:** if Redis can't start, log and continue; apps that need Redis
    get a warning and no `REDIS_URL` (identical posture to Postgres-unavailable).
- **`RedisProvisioner`** (mirrors `DatabaseProvisioner`) — the fully
  unit-testable core:
  - `provisionAppRedis(appName)`: assign the next free **logical DB** (1..15;
    DB 0 reserved for control-plane/health), record it, persist the map.
  - `getEnvVars(appName)`: `{ REDIS_URL: redis://<host>:<port>/<db> }`
    (`redis://…/<db>` selects the logical DB — honored by ioredis and BullMQ).
    Host is `drop-host` in docker mode, `127.0.0.1` otherwise.
  - `deprovisionAppRedis(appName)`: connect to the app's DB, `FLUSHDB`, free the
    number. Best-effort, fail-soft.
  - `isProvisioned`, persisted to `data/drop-svc/redis-allocations.json` (0600).
- **Platform wiring** (`platform.ts`): start `RedisServer` in
  `initializeServices` (fail-soft); `appNeedsRedis(appPath)`; provision + inject
  `REDIS_URL` alongside `dbEnvVars` in the start path; deprovision in
  `teardownApp`. `REDIS_URL` is a platform-authoritative var (placed with
  `dbEnvVars`, not overridable by a tenant secret).
- **Manifest:** add `redis?: boolean` to `drop.yaml` (strict parser + manifest
  detector). Per-service `redis` under `services.<name>` for monorepo children.
- **Config:** `enableRedis` (default true), `redisPort` (default 6380 to avoid
  clashing with a system Redis on 6379), `maxRedisPerUser`.

## 3. Isolation model & known limitations (v1)

- **Functional isolation is real:** each app gets its own logical DB, so
  keyspaces don't collide (e.g. two apps' BullMQ queues stay separate).
- **Security isolation is NOT hard yet:** Redis ACLs cannot restrict *which*
  logical DB a connection selects, so a misbehaving app could `SELECT` a
  neighbour's DB. This is proportionate for DROP's current single-operator
  self-hosting model and matches "functional, not multi-tenant-hardened".
  **Hardening path (future):** per-app ACL user + key-prefix restriction on the
  one instance (the real "safe to share" direction) — tracked separately, NOT
  per-app containers.
- **Cap:** 15 apps needing Redis (logical DBs 1..15). Documented; raise later via
  the ACL/prefix model.

## 4. Non-goals (v1)
- Per-app ACL/key-prefix isolation, per-app instances, Redis persistence tuning,
  cross-node/replicated Redis, a bundled cross-platform Redis binary download.

## 5. Validation status (be explicit)
The provisioner logic (DB assignment, URL construction, teardown, cap, persistence)
is unit-tested. The `RedisServer` container/process management is **not
live-tested** — like the rest of the recent docker-isolation work, it has not run
end-to-end on a live platform (no docker/Caddy available in the dev environment).
Commit messages and this PRD say so; the human push-gate reviews before shipping.

## Changelog
| Date | Author | Changes |
|------|--------|---------|
| 2026-07-12 | Claude (Opus) | Initial: managed Redis v1 (Option A, per advisor) |
