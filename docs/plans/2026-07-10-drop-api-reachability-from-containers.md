# Plan: make DROP's control-plane API reachable from isolated app containers

**Date:** 2026-07-10
**Status:** DRAFT — awaiting approval (do not implement yet)
**Slug:** `drop-api-reachability-from-containers`

## Goal

A hosted app (the `drop-waitlist` container) calls back into DROP's control-plane API
to provision user accounts and fails at runtime with:

```
DROP API request failed: ECONNREFUSED
POST ${DROP_API_URL}/api/v1/auth/users   Authorization: Bearer <admin key>
```

Make it so a hosted app running under **`isolation: docker`** can reliably reach DROP's
own REST API, without the app hardcoding a bridge IP or guessing a port — and without
breaking the non-isolated (`isolation: none` / PM2) local-dev path where
`http://127.0.0.1:3000` already works.

## Diagnosis — which case is it?

**Confirmed case (c): an injection gap, with an accompanying reachability gap.** This is
**code-derived**, not observed on the running box.

Ruled out:

- **(a) API process down.** ECONNREFUSED to `127.0.0.1:3000` is fully explained by
  container-loopback (below) regardless of whether the API is up, so "the process died"
  is not the mechanism. (The dashboard/API being reachable on the box is consistent but
  not required for this conclusion.)
- **(b) Bind-to-loopback bug.** The API binds **`0.0.0.0`**, and this is **hardcoded** at
  `src/core/platform.ts:964` (`host: '0.0.0.0'`) with **no env override** — unlike
  `apiPort`, which reads `DROP_API_PORT`. So on *every* deployment the API listens on all
  host interfaces including the bridge-gateway interface. There is no configuration where
  it is loopback-only. (b) is impossible.

Root cause, in two parts:

1. **Injection gap (primary).** `buildStartSpec()` (`src/core/platform.ts:2252-2259`)
   assembles the app env — `NODE_ENV`, `PORT`, `DROP_DATA_DIR`, DB vars, dep URLs,
   secrets — but **never sets `DROP_API_URL`**. `ContainerManager.start()`
   (`src/managers/runtime/container-manager.ts:109-110`) passes only `spec.env` + `PORT`.
   So the app's client falls back to its default `http://127.0.0.1:3000`
   (confirmed pattern at `src/cli/api-client.ts:208`:
   `process.env.DROP_API_URL ?? http://localhost:${apiPort}`). Inside the container,
   `127.0.0.1` is the container's **own** loopback namespace — a closed port — so the
   connection is refused and the request never leaves the container.

2. **Reachability gap (must fix together).** DROP deliberately isolates app containers:
   ports are published to `127.0.0.1` on the host only
   (`container-manager.ts:180`), inter-container communication is **disabled**
   (`enable_icc=false`, `container-manager.ts:438`), and the bundled Postgres is reached
   via a **bind-mounted unix socket**, not TCP (`platform.ts:1524-1528`,
   `database-provisioner.ts:441-460`). There is **no `ExtraHosts` / `host.docker.internal`
   mapping anywhere** in the codebase, and the `pgHost: 'host-gateway'` TCP path in
   `database-provisioner.ts:463-466` is **dead legacy** — never passed in production. So
   even once the app knows to use a hostname, the container currently has **no name or
   route that resolves to the host API**. Injection alone is not sufficient; the container
   also needs a working route to the host.

## Approach

Two coordinated changes, isolation-aware, mirroring the existing `PORT`/`DROP_DATA_DIR`
injection mechanism.

### 1. Give docker containers a route+name to the host API

**Primary (recommended): pin drop-net's subnet+gateway, then alias it as `drop-host`.**
Rather than *inspecting* the auto-allocated gateway (fragile — see R1), create `drop-net`
with an **explicit** IPAM config so the gateway is a known constant:

```
createNetwork({
  Name: 'drop-net',
  Driver: 'bridge',
  Options: { 'com.docker.network.bridge.enable_icc': 'false' },
  IPAM: { Config: [{ Subnet: DROP_NET_SUBNET, Gateway: DROP_NET_GATEWAY }] },
})
```

Then on every container:

```
HostConfig.ExtraHosts = [`${HOST_ALIAS}:${DROP_NET_GATEWAY}`]   // e.g. 'drop-host:10.83.0.1'
```

so `drop-host` resolves to the constant gateway inside the container — no `docker network
inspect`, no per-start IPAM edge cases. The gateway is the container's **own same-subnet
default route**, and traffic to it is delivered on the host **INPUT** path — so
`enable_icc=false` and any `DOCKER-USER` rule (both FORWARD-only) provably cannot block it.
The API listens on that gateway interface (it binds `0.0.0.0` today; see R5/R2).

Subnet choice: pick a high, uncommon /24 (e.g. `10.83.0.0/24`) to minimize collision with
operator networks, and make it overridable via env (`DROP_NET_SUBNET` / `DROP_NET_GATEWAY`).

**Migration note (live box) — SUPERSEDED by the DROP-052 follow-up.** The shipped PR1
required recreating `drop-net` with the pinned subnet on a clean restart with no attached
containers. In practice a normal CI/CD deploy does NOT do that, so an upgraded box kept its
legacy subnet while containers were injected `drop-host → 10.83.0.1` (a dead IP) — turning
`ECONNREFUSED` into a connect timeout. The follow-up
(`feature/DROP-052-api-reachability-gateway`) removes the dependency entirely: `drop-host`
is now mapped to `drop-net`'s **actual** gateway (resolved at container start via
`resolveHostGatewayIp()`), so a legacy subnet works with no migration. The pinned subnet is
kept only for freshly created networks (cosmetic), and `ensureNetwork()` no longer recreates
an existing network over a subnet mismatch (only over an ICC regression).

**No-migration alternative: defensive inspection.** If pinning's one-time recreate is
undesirable, inspect instead — but robustly: select the **IPv4** `IPAM.Config` entry
(Gateway without `:`), fall back to deriving `.1` from its Subnet, and **fail loudly**
(not soft — see R3) if no gateway can be resolved under docker isolation. Pinning is
preferred because it makes every one of those edge cases unreachable.

**Documented fallback only: `host.docker.internal:host-gateway`.** Simpler
(`ExtraHosts: ['host.docker.internal:host-gateway']`, inject
`http://host.docker.internal:PORT`) but **`host-gateway` resolves to the docker0 gateway
(172.17.0.1), not drop-net's** — a cross-bridge hop that works only "by accident" (API on
`0.0.0.0` happens to listen there; depends on docker0 existing and rp_filter on the
asymmetric return path). Strictly weaker than the pinned gateway; used only if the
empirical test somehow forces it.

**Rejected: run the API as a container on drop-net (service DNS).** Self-defeating — an API
container on drop-net is container↔container on the same bridge, so its inbound SYN is
dropped by the very `enable_icc=false` rule. Would require punching an ICC exception or a
second network. **Also considered: unix-socket HTTP** (like the Postgres socket) — most
network-robust and zero iptables surface, but it breaks the "any HTTP client works"
contract (no universal unix-socket URL convention for HTTP), so it only works if DROP ships
a socket-aware client shim. Kept on the roadmap as the long-term most-secure option; not
this change.

### 2. Inject an isolation-aware `DROP_API_URL`

In `buildStartSpec()`, compute:

- `isolation === 'docker'` → `http://drop-host:${this.config.apiPort}` (primary option)
  *(or `http://host.docker.internal:${apiPort}` if the fallback is chosen)*
- otherwise → `http://127.0.0.1:${this.config.apiPort}` (unchanged local-dev behavior)

Place `DROP_API_URL` **after** `...secretEnvVars` so it is **platform-authoritative** —
exactly like `PORT` and `DROP_DATA_DIR`. A tenant secret must **not** be able to redirect
`DROP_API_URL`, because it is the destination of an admin `Bearer` credential; a
tenant-overridable value there is a footgun (R6). If a genuine external-endpoint override
is ever needed, add an explicit allowlisted mechanism, not an implicit secret override.

```ts
env: {
  ...secretEnvVars,
  NODE_ENV: 'production',
  PORT: port.toString(),
  DROP_DATA_DIR: dataDir,
  DROP_API_URL: dropApiUrl,   // platform-authoritative; a tenant secret must not override it
  ...dbEnvVars,
  ...depEnvVars,
}
```

`apiPort` and `isolation` are both already on `this.config`, so no new plumbing to
`buildStartSpec`. The `ExtraHosts` alias name (`drop-host`) and gateway are shared
constants (see §1); only `ContainerManager` writes the `ExtraHosts` entry.

*(Note: `depEnvVars` still spreads last, so a `depends_on` entry literally named
`DROP_API_URL` would win — acceptable because deps are operator-authored config, not tenant
secrets, but worth a guard/log if we want it strictly locked.)*

### 3. Gate the pre-auth fleet-enumeration endpoints (cheap, in this change)

`GET /health/apps` (`health.ts:187-209`) and `/health/stats` are mounted **before** any
auth wiring (`server.ts:188`) and return **every** tenant's app name, port, and status
anonymously. Today that's only reachable from host/loopback; after §1 it's reachable from
every tenant container. Cheap fix, bundled here: either require auth on these two routes,
or strip `name`/`port` from the anonymous response. (`/health` liveness stays public.)

### 4. The credential blast radius — the real decision (see "Key decision" below)

The dominant risk is **not** created by this change but is **normalized** by it: the app
holds a **full admin key** (manually set as a secret), and the `admin` role **bypasses all
ownership** (`access.ts:15` — `if (auth.role === 'admin') return true`). So any
RCE/SSRF/dependency vuln in that one tenant already converts to full cross-tenant takeover
(mint admin keys via `POST /auth/api-keys`, create admins via `POST /auth/users`, read
every tenant's secrets, drop any DB). Crucially, **the network path already exists today**
— a compromised container can find the gateway (`ip route show default`) and reach the API
without any help from this change. What §1 changes is that it makes that path *official,
named, and actively used by benign code*, encouraging the admin-key-in-tenant pattern.

`writeLocalCliKey()` (`platform.ts:2598`) mints an admin key only for the **local CLI**,
not for apps — so there is no existing per-app-token mechanism to lean on, and DROP's
finest auth grain today is the **role** (`readonly`/`user`/`admin`); user-creation is
admin-gated, so a provisioning app currently *needs* admin. A properly scoped per-app token
therefore requires **new auth-capability work** (its own PRD), which is why it can't be a
trivial add here. The security review's position: shipping reachability with **neither** a
scoped token **nor** a network boundary is a blocker. The counter-argument: the path is
pre-existing, so the *incremental* risk of the URL injection is modest, and the cheap
mitigations (§3) plus a committed follow-up may be an acceptable posture. **This is a
risk-appetite + scope call for the user** — surfaced explicitly below rather than decided
unilaterally.

## Key decision — RESOLVED: Option B, sequenced as two PRs

The user chose **Option B** (functional fix **plus** a scoped per-app provisioning token so
apps never hold a full admin key). Per the advisor, B is delivered as **two sequenced PRs**,
not one atomic bundle (the user chose B, *not* C — "hold the fix until the token exists" —
so the ECONNREFUSED fix must not wait behind the new auth capability):

- **PR1 — this plan.** §1 (pinned gateway + route) + §2 (`DROP_API_URL` injection) + §3
  (gate `/health/apps`/`/health/stats`). Ships and fixes the runtime bug now. `DROP_API_URL`
  is injected in **both** modes; no `DROP_API_KEY` is injected yet, so the app keeps using
  its current (manually-set) key until PR2.
- **PR2 — companion plan** `docs/plans/2026-07-11-scoped-provisioning-token.md` (to be
  written after the three decisions below). New scope/capability so DROP mints+injects a
  least-privilege `DROP_API_KEY`; the app is repointed off the admin key **before** PR2 is
  considered done. Must not be rushed inside the connectivity fix — its own design +
  review + sign-off.

**Rejected Option C** (network-only boundary via `DOCKER-USER`/iptables): weaker than a
scoped token and complex with dynamic container IPs.

### Decisions that shape PR2 — RESOLVED

1. **Requirement:** the app **does** need real DROP platform users → PR2 proceeds.
2. **Grant mechanism:** **admin-conferred** per-app, default none (not `drop.yaml`
   self-service).
3. **Auth header:** inject `DROP_API_KEY`, app sends `X-API-Key` — **no** broadening of the
   `Bearer` path.

Full PR2 design: `docs/plans/2026-07-11-scoped-provisioning-token.md`.

### Honest residual on the scoped token (for the PR2 plan)

`users:create` is **not** "can only insert rows": the caller sets the new user's password
and `/auth/login` is public, so a scoped key can create a user with a known password and log
in as a **user-tier** session (deploy apps up to `maxApps`; no global cap on user count). So
a leaked scoped key → account/app spam bounded only by `maxApps` and rate limits — far
better than admin/cross-tenant takeover, but not nil. PR2 must: force `role:'user'` and
**reject** (403) any elevation attempt, verify `maxApps`/quotas apply to programmatically
created users, and consider putting `/auth/users` behind `authRateLimitMiddleware`.

## File-level changes

- **`src/managers/runtime/container-config.ts`** — add exported constants:
  `HOST_ALIAS = 'drop-host'`, `DROP_NET_SUBNET` (default `10.83.0.0/24`, env-overridable),
  `DROP_NET_GATEWAY` (default `10.83.0.1`, env-overridable).
- **`src/managers/runtime/container-manager.ts`** —
  (a) `ensureNetwork()`: create `drop-net` with pinned
  `IPAM: { Config: [{ Subnet: DROP_NET_SUBNET, Gateway: DROP_NET_GATEWAY }] }`, and extend
  the existing options-mismatch check (currently ICC-only, `418-429`) to also require the
  pinned subnet so a legacy auto-subnet network is recreated on a clean restart.
  (b) `start()`: add `HostConfig.ExtraHosts = ['${HOST_ALIAS}:${DROP_NET_GATEWAY}']`
  (constant — no inspect). Under docker isolation, if the network/gateway can't be
  established, **fail the deploy loudly** rather than starting an app that provably can't
  reach the control plane (R3) — do not fail-soft.
- **`src/core/platform.ts`** — in `buildStartSpec()`, compute `dropApiUrl` from
  `this.config.isolation` + `this.config.apiPort` and add `DROP_API_URL` to the returned
  `env` **after `...secretEnvVars`** (platform-authoritative — R6).
- **`src/api/routes/health.ts` + `src/api/server.ts`** — gate `/health/apps` and
  `/health/stats` behind auth (or strip `name`/`port` from the anonymous payload). §3.
- **Tests:**
  - `container-manager.test.ts` — assert `ExtraHosts` contains `drop-host:<DROP_NET_GATEWAY>`
    and that `createNetwork` is called with the pinned IPAM subnet/gateway.
  - `platform` spec test — assert `buildStartSpec` sets `DROP_API_URL` to the docker value
    under docker isolation and the `127.0.0.1` value under `none`; assert a tenant
    `DROP_API_URL` **secret does NOT override** the platform value (R6).
  - `platform.restart.test.ts` — assert `DROP_API_URL` is present after `restartApp`
    (confirms the single-chokepoint coverage).
  - health route test — `/health/apps` requires auth (or is scrubbed).
- **Docs:** note `DROP_API_URL` in the "Env vars injected into deployed apps" section of
  `.claude/CLAUDE.md` / README and the public docs (`DocsContent.tsx`) alongside
  `PORT` / `DROP_DATA_DIR` / `DATABASE_URL`.

### Deferred to a follow-up PRD (not this change)

- **Per-app scoped provisioning token.** New auth capability: a token that can create
  `user`-role accounts for one tenant and nothing else, minted+injected by DROP as
  `DROP_API_KEY`, so apps never hold a full admin key. Requires finer-than-role scoping in
  `middleware/auth.ts` + `access.ts`. This is the real fix for the blast radius in §4.

### Optional (same change or a fast follow): build-time reachability

The failing call is **runtime-only**, so this does not block the bug. If we want a build
step to reach the API too, add the same `ExtraHosts` to the build container
(`container-build-runner.ts:120-133`) and pass `DROP_API_URL` **as an explicit override**
in the build `env` — note `sanitizeBuildEnv` (`strategies/base.ts:18-28`) **strips any
`DROP_`-prefixed var inherited from `process.env`**, so it must be passed in `overrides`,
never relied on via inheritance.

## Verification plan

1. **Unit tests** (above) — green.
2. **Empirical reachability test (the real gate).** Reproduce the exact condition rather
   than trusting the code review:
   - On the box (or a local Linux repro): create/confirm the ICC-disabled `drop-net`
     bridge, start a container with `ExtraHosts: ['drop-host:<gateway>']`, and from inside
     it: `curl -sf http://drop-host:3000/api/v1/health` → expect `200`. Also test the
     fallback `host.docker.internal:host-gateway` form; whichever reaches the API wins and
     becomes primary in the final code.
   - Confirm the host has no `ufw`/`firewalld` default-deny on the INPUT path that would
     block container→gateway:3000 (`install.sh` sets none, but the box may).
3. **End-to-end on dropkit.sh.** Redeploy `drop-waitlist`, confirm `DROP_API_URL` is in
   its container env (`docker exec drop-waitlist env | grep DROP_API_URL`), and confirm
   the `POST /api/v1/auth/users` callback now succeeds (user created; no ECONNREFUSED).
4. **Non-isolated regression.** With `isolation: none`, confirm `DROP_API_URL` is
   `http://127.0.0.1:3000` and an app can still reach the API locally.
5. **Rate-limit source-IP check (R7).** From inside a container, hit `/api/v1/...` and
   inspect the audit log / rate-limit key: confirm each container is bucketed by its own
   bridge IP (not a shared gateway IP) on the real Linux host — do **not** generalize from
   a Windows/Docker-Desktop dev box.
6. **Health-gating regression (§3).** Confirm `/health` liveness stays public while
   `/health/apps` / `/health/stats` no longer leak app names/ports anonymously.

## Risks & open questions

- **R1 — gateway resolution (load-bearing, now mitigated by pinning).** Auto-inspected
  IPAM gateway is fragile (absent field, IPv6 `[0]`, recreate churn). **Resolved** by
  pinning the subnet+gateway (§1) so `drop-host` is a constant. `host-gateway` maps to
  docker0, not drop-net — fallback only. The empirical curl test (verify step 2) is still
  the decider; **do not declare fixed on code review alone.**
- **R2 — host INPUT firewall (the one real network blocker).** `enable_icc=false` and
  `DOCKER-USER` are **FORWARD-only** and provably cannot block container→gateway (that
  traffic is delivered on the host **INPUT** path). The only default-path blocker is a host
  INPUT default-deny (`ufw`/`firewalld`). Checked in verify step 2; if blocked, add an
  explicit INPUT allow for the drop-net subnet → apiPort (documented, not a silent change).
- **R3 — no silent fail-soft.** With a pinned gateway the ExtraHost is deterministic. Under
  docker isolation, if the host route genuinely can't be established, **fail the deploy
  loudly** — never start an app with `DROP_API_URL` pointing at an unresolvable name (that
  ships the original bug as "green").
- **R4 — control-plane reachable from every tenant (BLOCKER per security review; see §4
  and Key decision).** The `admin` role bypasses all ownership (`access.ts:15`); the app
  holds a full admin key; the network path is pre-existing but this change normalizes it.
  Resolution options: per-app scoped token (best, own PRD), a bridge→apiPort firewall
  boundary, or accept-with-followup given the path is latent. **User's call.**
- **R5 — `0.0.0.0` bind is pre-existing and in tension with hardening.** The API already
  binds all interfaces (`platform.ts:964`); external `:3000` is closed by the cloud
  firewall (install.sh opens only 80/443). This change doesn't worsen *external* exposure —
  only the in-container name. But the obvious hardening (bind `127.0.0.1`) would **break**
  this fix (nothing would listen on the gateway). Pinning the gateway (§1) makes a future
  **`127.0.0.1` + pinned-gateway** bind possible; a multi-interface listener is a small
  server refactor, deferred — noted so review doesn't conflate the two concerns.
- **R6 — `DROP_API_URL` is platform-authoritative.** Placed **after** secrets so a tenant
  secret cannot redirect the admin-credential destination (adopted; was the reverse in the
  first draft). `depEnvVars` still spreads last — operator-authored, acceptable, guard if
  we want it strict.
- **R7 — rate-limit keying (verified sound on Linux, confirm empirically).** container→host
  is **not** MASQUERADEd, so each tenant keeps its own bridge IP → its **own** rate-limit
  bucket (`rate-limit.ts:53-72`); `isLocalPeer` only trusts XFF from loopback, so a
  container can't spoof another's bucket. The "shared gateway IP" worry does **not** hold
  on Linux prod — but it's topology-dependent (Docker Desktop/userland-proxy can NAT
  differently), so confirm on the real host (curl API from a container, check the audit-log
  source IP). Not a blocker. CORS is **not** a control here (a container isn't a browser).

## Agent critiques considered

### Integration / injection-sufficiency (verified directly)

A reviewer flagged that there are more start paths than a single `buildStartSpec` (it
named `buildFreshStartSpec` / `restartApp` / `platform-ops`). Verified in code — and the
conclusion **strengthens** the plan: all three start paths converge on `buildStartSpec`,
so a single injection point covers everything:

- **Deploy** → `platform.ts:1557` → `buildStartSpec` ✓
- **Hot-reload / `app:update`** → `platform.ts:1910` → `buildFreshStartSpec` (1955) →
  `buildStartSpec` (1978) ✓
- **Restart (`restartApp`)** → `platform.ts:2039` → `buildFreshStartSpec` → `buildStartSpec` ✓

`buildFreshStartSpec` is a thin wrapper (allocate port → delegate to `buildStartSpec`),
written expressly so hot-reload and restart "can't drift apart" (comment at
`platform.ts:1944`). The three `runtime.start()` sites (1558 / 1911 / 2040) are each
preceded by it; there is no fourth `runtime.start()` that assembles env inline. Restart
therefore **re-injects `DROP_API_URL` fresh** every time (consistent with the
2026-07-08 restart-env-reinjection work and `platform.restart.test.ts`) — no stale-env
risk. **Action:** keep the single injection point in `buildStartSpec`; add a restart test
asserting `DROP_API_URL` is present after `restartApp`.

### Networking correctness

- **Confirmed the mechanism works and is robust:** container→gateway is delivered on the
  host **INPUT** path, so `enable_icc=false` and `DOCKER-USER` (both FORWARD-only) cannot
  block it — even a `FORWARD policy DROP` box works. Only a host INPUT default-deny blocks
  it (→ R2, empirical gate).
- **Adopted P1 (pin, don't inspect):** `IPAM.Config[0].Gateway` is fragile (absent field,
  IPv6 `[0]`, recreate churn); pinning the subnet+gateway removes every case. The alias
  buys no robustness by itself (ExtraHosts is baked at container-create from a snapshot);
  *pinning* is the real robustness lever. → §1, file-level changes.
- **Adopted P2/P5 (bind tension):** noted the `0.0.0.0` bind conflicts with loopback
  hardening; pinning makes a future `127.0.0.1`+gateway bind possible. → R5.
- **Adopted P3 (no fail-soft):** don't ship an app with an unresolvable `DROP_API_URL`. → R3.
- **Rejected alternatives with reasons:** API-container-on-drop-net is self-defeating (its
  own inbound SYN is ICC-dropped); unix-socket HTTP is most robust but breaks the generic
  HTTP-client contract → roadmap only. host.docker.internal is strictly weaker → fallback.

### Security blast-radius

- **Reframed the threat model (key correction):** `enable_icc=false` was never a control
  against container→host; the path is **pre-existing** (a container can already find the
  gateway). This change *normalizes* it. So the injection itself is modest *incremental*
  risk — the dominant risk is the **admin key in a tenant container** + `admin` bypassing
  ownership (`access.ts:15`). → §4, R4.
- **Adopted #4 (cheap, in-scope):** gate `/health/apps` + `/health/stats` — pre-auth fleet
  enumeration, now tenant-reachable. → §3.
- **Adopted #1/#3 as the Key decision:** ship with a compensating control (scoped token or
  bridge firewall) vs. accept-with-followup given the latent path. Surfaced to the user.
- **Refuted two earlier worries:** rate-limit buckets are **per-container-IP** on Linux
  (not shared) → R7; self-signup grants only `user` tier with ownership enforced → not a
  distinct escalation. CORS is not a control for non-browser clients.
- **Disagreement surfaced:** the security agent calls the change a hard **BLOCKER** without
  a compensating control; the networking/latent-path analysis argues the *incremental*
  network risk is modest because the path already exists. The plan does **not** paper this
  over — it routes the call to the user (Key decision) with a recommendation, rather than
  picking silently.

### Process note

The first adversarial pass (3 agents) was lost to a day-boundary **session limit** (2
agents) and a **stream stall** (1). The integration angle was then verified **by hand**
(single-chokepoint proof above); networking and security were **re-run successfully**. So
all three angles are covered, one directly rather than by agent.
