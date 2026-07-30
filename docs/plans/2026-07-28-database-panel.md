# Plan: Database panel under App Details

**Date:** 2026-07-28 · **Branch:** `feature/DROP-120-database-panel` (from `develop`)
**Status:** **APPROVED 2026-07-28** — M1 only, v2 scope, after a 4-critic
adversarial panel. M2 deferred to its own plan.

**Approved decisions on the two open questions:**
- **Risk 3 — the connection-string reveal is NOT in M1.** It is a new read path
  to a cleartext password that DROP cannot rotate and that is deliberately
  reserved out of the secrets API. Overview + tables answer the motivating
  question without it. It becomes easy and defensible once a rotation path
  exists; until then it is not worth the primitive.
- **Risk 2 — greppable `[db-panel]` log lines are IN M1**; the `/health`
  `pg_stat_activity` probe is a follow-up (it changes a separate surface).

> **What changed in v2.** The panel found a factual error at the centre of the v1
> design and enough new surface on the query runner to change the recommendation.
> **M1 (visibility) is proposed for build. M2 (query runner) is deferred** to its
> own plan and its own review — not cancelled, but not approvable on this
> evidence. Rationale in _Why M2 is deferred_ below.

## Goal

An operator can open an app in the dashboard and see its database: whether one is
provisioned, what tables exist, roughly how many rows each holds, and — on an
explicit, audited action — a connection string that actually works.

The gap is concrete. DROP provisions a database, injects `DATABASE_URL`, and then
offers no way to confirm any of it happened. A live instance of exactly that
question — a todo app logging `[db] connection source: NOT FOUND` (DROP-119) — is
what prompted this.

## Approach

### The one rule

**Every connection this feature opens is made as the app's own role, using the
app's own credentials — never the platform's superuser control-plane pool**
(`postgres-server.ts:384` `getPool()`, which connects to the `postgres` database
as superuser and can drop any tenant's data).

### M1 is fixed catalogue SQL, and that is what makes it safe

M1 sends **no tenant-authored SQL at any point**. Every statement is a constant
in our source with bound parameters. That single property is what removes the
entire class of problems the panel raised against M2: no statement stacking, no
`SET`, no `SECURITY DEFINER` reachability, no temp tables. M1 therefore needs no
new database role, no `REVOKE` campaign, and no cursor machinery.

Connections still get a defensive envelope: timeouts set **via the pg Client
config** (not `SET LOCAL`, see below), `BEGIN READ ONLY`, `ROLLBACK`, and
`client.end()` in a `finally`.

### Why M2 is deferred

M2 was "add a read-only SQL box". The panel established that a read-only *role*
is necessary but nowhere near sufficient, and that the supporting work is a
project rather than a milestone:

- `EXECUTE` on functions is granted to `PUBLIC` by default and the provisioner's
  `REVOKE ALL ON SCHEMA public FROM PUBLIC` (`database-provisioner.ts:195`) does
  not touch function ACLs — so a `SECURITY DEFINER` function the app created
  executes **as the app owner**, a full write primitive no `SELECT`-only grant
  can stop. Only `BEGIN READ ONLY` stops it.
- `CREATE DATABASE` grants `TEMPORARY` to `PUBLIC` by default and the provisioner
  revokes only `CONNECT` (`:194`), so temp tables — real relations on disk, not
  bounded by `temp_file_limit` — are reachable.
- `temp_file_limit` defaults to unlimited and `work_mem` is `USERSET`. Disk is
  global on this box: filling it takes down PostgreSQL, Caddy and every app.
- A true server-side row cap needs `DECLARE … CURSOR` / `FETCH`; `rows: n` caps
  the batch, not the total, because node-postgres re-`Execute`s on
  `portalSuspended`.
- `pg_catalog` and the shared catalogs are world-readable and **no privilege
  configuration can close them**: any principal running arbitrary `SELECT` can
  enumerate every database and role on the cluster, i.e. the box's full app
  inventory. This is an accepted, un-fixable limit that the operator must
  consciously accept before a SQL console ships on a multi-tenant box.

None of this makes M2 impossible. It makes it a separate decision with a separate
threat model, and M1 delivers most of the operator value without any of it.

## File-level changes — M1 only

### Data access

- [x] `src/managers/database/connection-string.ts` — **new**. Extract one pure
      `buildConnectionString(creds, target)` where `target` is
      `{kind:'tcp', host}` or `{kind:'socket', dir}`. `getEnvVars`
      (`database-provisioner.ts:448`) is refactored to call it, so there is one
      percent-encoding implementation rather than a second that drifts (DROP-066
      lives in this code path).
- [x] `src/managers/database/app-db-inspector.ts` — **new**
  - `openClient(creds)` — takes **credentials, never an app name**, so there is
    no default that could silently fall back to a read-write role later.
    **Loopback TCP unconditionally**: the API process runs on the host and always
    can reach PostgreSQL that way; the socket form exists for *containers*, and
    `getSocketDir()` returns `null` on win32.
  - Timeouts on the **Client config** — `connectionTimeoutMillis`,
    `query_timeout`, `statement_timeout`, `idle_in_transaction_session_timeout`.
    Not `SET LOCAL`: outside a transaction block that is a no-op with only a
    WARNING, and the M1 ordering (`connect → SET → BEGIN`) would hit exactly
    that. `idle_in_transaction_session_timeout` is required because a stalled
    JS path between `BEGIN` and `ROLLBACK` pins the cluster-wide xmin horizon and
    blocks `VACUUM` in **every** database on the instance.
  - `withReadOnlySession(creds, fn)` — `BEGIN READ ONLY` → run → `ROLLBACK` →
    `client.end()` in `finally`.
  - `getOverview(appName)` / `listTables(appName)` — fixed parameterized SQL.
  - Bounded gate: **N in flight, zero queue depth, immediate 503** with
    `Retry-After`. A queue would accumulate requests whose clients have gone.
    Global cap **plus** a per-app sub-cap so one app cannot starve the rest.
- [~] Row counts: report `n_live_tup` **explicitly labelled an estimate**, shown
      whenever it is positive — `n_live_tup` is maintained live by the stats
      collector on every DML at commit, so it does *not* wait for ANALYZE; a
      freshly migrated, never-analysed table already reports a correct count
      (the column that genuinely stays unreliable until ANALYZE is
      `pg_class.reltuples`, which this panel never reads). Render "not yet
      analysed" only when the reported count is `0` **and** the relation is
      non-empty by size: a real, non-empty table whose cumulative stats were
      reset (e.g. `pg_stat_reset()`) can report `n_live_tup = 0` too, and a
      confident wrong `0` there is the very confusion this feature exists to
      remove. Exact `COUNT(*)` for small relations was CUT — see the diff-stage critiques.

### API

- [x] `src/api/routes/db.ts` — **new**, mounted at `/api/v1/db`
  - `GET /:name` → `{ provisioned: boolean, … }`. **200, not an error**, when the
    app simply has no database — that is the normal case.
  - `GET /:name/tables`
  - ~~`POST /:name/connection-string`~~ — **cut from M1** (see approved decisions
    above). When it returns, it must serve the **app-visible** string
    (`getEnvVars(...).DATABASE_URL`, socket form under docker isolation) labelled
    "as injected into your app", plus the host/TCP form separately — returning
    only the TCP form would hand operators a string their own container cannot
    use.
  - **`interactiveSessionOnly` on both routes.** On an
    auth-disabled box `authMiddleware` calls `next()` unconditionally and
    `canAccess(undefined, app)` returns `true`, so unguarded GETs would be
    anonymous, network-reachable disclosure of every app's schema. It also closes
    the open DROP-075 gap (an API key's role is never clamped to its owner's, so
    a stale `admin` key reads every tenant) for the read paths, which
    session-only-on-the-reveal alone did not.
  - Ownership resolved from `getStateManager().getApp(name)` and 404 **before**
    any credentials lookup — never from `db-credentials.json`, which can retain
    an orphan entry after a failed drop.
  - Explicit states: provisioner `null` → 503 "database service unavailable";
    no database → 200 `{provisioned:false}`; credentials quarantined but
    `databaseExists()` true → 503 naming the quarantine file (otherwise the panel
    answers "no database" for an app that has one — a wrong answer, in the one
    situation an operator most needs the truth); `ECONNREFUSED` → 503;
    SQLSTATE `53300` → 503 "connection limit reached"; `28P01` → 503 "stored
    credentials rejected". All via `HttpError` so the message survives
    `onError`'s deliberate 500-collapse (`server.ts:604-619`).
- [x] `src/api/access.ts` — move `interactiveSessionOnly` here from
      `routes/auth.ts` (**not** a new `auth-guards.ts`; `access.ts` is already the
      home for shared non-middleware authz helpers). No re-export — the existing
      guard test is HTTP-level and stays green untouched as proof.
- [x] `src/api/middleware/rate-limit.ts` — `dbRateLimitMiddleware()` (~20/min).
      **In M1.** An ADDITIONAL, tighter cap on `/db/*` — not an exemption from
      the general 100/min-per-IP-shared-across-all-endpoints bucket, which
      still applies to `/db/*` too (it is mounted on `/api/*`); a db request
      is throttled by both. 20/min is simply the saner ceiling for an
      endpoint backed by a single shared PostgreSQL instance.
- [x] `src/api/server.ts` — limiter registered **unconditionally** with the other
      route-specific limiters; auth guard **inside** the `enableAuth` block and
      **above** the mount; both `'/db/:name'` and `'/db/:name/*'` patterns.
- [x] `src/managers/activity/activity-log.ts` — **no new action, and no logging
      of reads.** With the reveal cut from M1 there is no low-frequency,
      security-relevant event left to record, so this file is untouched.
      **Do not log the reads.** `ActivityLog` is a 500-entry ring
      rewritten in full on every append (`:35`, `:57-71`); logging reads would
      evict every deploy, login and delete record within minutes of a tab being
      left open — an audit-integrity regression dressed as diligence.

### Dashboard

- [x] `src/dashboard/src/components/DatabaseTab.tsx` — **new**. Overview, table
      list. No connection string (cut from M1).
- [x] `src/dashboard/src/pages/AppDetailPage.tsx` — add `database` to the static
      `DETAIL_TABS`. **Always visible**; the "no database provisioned" state is
      first-class content. Hiding the tab would leave the motivating question
      unanswerable and make `DETAIL_TABS` dynamic, which is a structural change
      to a 679-line component, not a one-liner.
- [x] **On-demand refresh only — no polling.** The house rate is 3 s; two polled
      endpoints would add 40 req/min against the shared bucket and hammer a
      shared PostgreSQL with SCRAM handshakes (4096 PBKDF2 iterations per
      connect). A visible Refresh button is correct for a panel backed by a
      shared database.
- [x] `src/dashboard/src/components/landing/ReferenceContent.tsx` — document the
      new group. Needs `npm run build:site`, not `build:dashboard`.

### Tests

- [x] Client always closed, including on throw; bounded gate rejects rather than
      queues; the three explicit states; ownership 404 for a foreign app;
      session-only 403 for an API key on **both** routes; `readonly` token 403
      (proves the middleware is actually bound); **no activity-log row written by
      either route**; `getEnvVars` byte-identical output after the
      `connection-string.ts` refactor.

## Risks & open questions

1. **`max_connections` on the live box is probably 100, not 200.** The raise
   landed 2026-07-05; dropkit.sh was stood up 2026-06-19; it applies only at
   initdb and nothing in the tree runs `ALTER SYSTEM`. **Action before this
   ships:** run `SHOW max_connections;` on the box and record it. If 100, ship
   `ALTER SYSTEM SET max_connections = 200` + restart as a *separate, prior*
   change. Merging to `develop` restarts prod and re-deploys the whole fleet —
   the single highest connection-count moment on the box — so deploying a
   connection-safety feature into a 100-slot ceiling is itself the likeliest
   trigger of the exhaustion it guards against.
2. **No connection-pressure observability exists** anywhere (`/health`'s DB probe
   reads an in-memory field, not a live query). Proposed: one greppable
   `[db-panel]` warn line per connect failure and cap rejection, and extend the
   health probe with a `pg_stat_activity` count reported `degraded` above ~80%.
   **Open:** in scope for M1, or a follow-up?
3. **The reveal is a genuinely new disclosure primitive.** `DATABASE_URL` is
   explicitly *reserved out* of the secrets API (`secrets.ts:18`), so no route
   exposes this password today. It has no rotation path anywhere in DROP, and
   `canAccess` grants it to any admin for any tenant. **Open:** ship the reveal at
   all in M1, or defer it until a rotation path exists? A defensible M1 ships
   overview + tables only.
4. **Timeout values.** Proposed 2 s statement timeout for M1's catalogue queries.
5. **Gate 4 cannot be done on this box.** The bundled PostgreSQL does not run
   reliably on Windows, and every claim here is about what the *server* does. A
   `postgres:16` container is required, or verification on dropkit.sh.
6. **Deferred to the M2 plan:** the read-only role, its collision guard and
   teardown, the `REVOKE EXECUTE`/`REVOKE TEMPORARY` set, cursor-based capping,
   `ALTER ROLE … SET temp_file_limit/work_mem/CONNECTION LIMIT`, RLS asymmetry
   (M1 connects as the owner and **bypasses** RLS; a `_ro` role would be subject
   to it, so row counts and query results would legitimately disagree), and the
   `pg_catalog` enumeration acceptance decision.

## Agent critiques considered

Four critics: `security-critic`, `architecture-critic`, and two `general-purpose`
task-fit critics (PostgreSQL-semantics auditor, operational-risk reviewer). All
read the repo, not just the plan. **1 critical + 15 high** findings; every one is
dispositioned below. **~46 medium/low findings**, of which the substantive ones
are folded into the file-level changes above and **4 are consciously rejected**
(listed at the end).

### Critical

- **`values: []` does NOT select the extended protocol** (PG-semantics `C3`,
  *critical/high*; security-critic `1`, *high/high*). Both verified from the
  pinned driver source: `requiresPreparation()` ends `return this.values.length > 0`,
  so an empty array takes the **simple** protocol and `;`-stacking survives —
  collapsing two of v1's three defence layers and re-enabling
  `SET statement_timeout = 0; SELECT pg_sleep(3600)`.
  **Actioned.** v1's central mechanism was wrong. M2 (where it applies) is
  deferred; the correct mechanism is recorded for it: `queryMode: 'extended'`,
  and a cursor for the row cap. M1 sends no tenant SQL, so it is unaffected.

### High

- **`BEGIN READ ONLY` *is* load-bearing** (`C4` *high/high*; security-critic `3`
  *high/high*). `SECURITY DEFINER` functions and `CREATE TEMP TABLE` are
  reachable with only CONNECT/USAGE/SELECT and are stopped by the read-only
  transaction alone. **Actioned** — v1 said the extra layers were "none of them
  load-bearing"; that sentence is deleted and the two controls are documented as
  complementary and both required.
- **`ensureReadOnlyRole` would GRANT in the wrong database** (`C5` *high/high*).
  The admin pool hardcodes `database: 'postgres'`, and 3 of the 5 statements are
  database-local — silently applied to the wrong database, surfacing later as
  "permission denied". **Actioned** into the deferred M2 plan (must use
  `getSuperuserPoolConfig(dbName)`).
- **Resource exhaustion beyond connections** (`C7` *high/high*): `temp_file_limit`
  unlimited, `work_mem` USERSET, temp tables unbounded. **Actioned** into M2.
- **`rows: n` is not a total row cap** (`MR1` *high/high*) — node-postgres
  re-`Execute`s on `portalSuspended`; only a cursor is server-side. **Actioned**
  into M2.
- **`_ro` role-name collision** (`MR5` *high/high*; security-critic `2`
  *high/medium*; architecture-critic *high/high*). `sanitizeName` truncates to 32
  chars, so two apps can share one role; teardown drops only the DB and
  `_user`, so orphan roles outlive apps and a later collision would *adopt* or
  rotate another tenant's role. **Actioned** into M2 (derive from the
  already-unique `credentials.database`, add the collision guard, add
  `DROP ROLE` to teardown).
- **Socket-dir form is wrong for the API process** (architecture-critic
  *high/high*). **Actioned** — loopback TCP unconditionally; one shared
  `buildConnectionString`.
- **Logging reads to `ActivityLog` destroys the audit trail** (ops `OPS2`
  *high/high*; architecture-critic *high/high*). **Actioned** — reads are not
  logged; only the reveal, and it also goes to the append-only audit file.
- **`_ro` credentials would be silently erased** (ops `OPS3` *high/high*;
  security-critic `10` *medium/high*) — `saveCredentials` rebuilds the whole
  object, so sibling keys vanish on any other app's provision. **Actioned** into
  M2 (separate file).
- **Rate limit belongs in M1, and the cap needs defined saturation behaviour**
  (architecture-critic *high/medium*; ops `OPS4` *medium/high*). **Actioned** —
  bucket moved to M1; gate rejects with 503 + `Retry-After`, zero queue, plus a
  per-app sub-cap.
- **`max_connections` is probably 100 on the live box** (ops `OPS1`
  *high/medium*). **Actioned** as a blocking pre-step (Risk 1).
- **Polling behaviour was unspecified** and the rest of the operational profile
  hangs on it (ops, *high/high*). **Actioned** — on-demand refresh, no polling.

### Consciously rejected

- **security-critic `8` — `dblink`/`postgres_fdw` write escape** (*medium/medium*).
  **Rejected on the evidence**, and this is a direct disagreement between two
  critics: `8` asserts the app's role can install these because it holds `ALL ON
  SCHEMA public`; `C8` (*low/high*) establishes both are **untrusted**
  extensions, so `CREATE EXTENSION` requires superuser regardless of `CREATE`
  privilege. **Deciding factor:** trusted-extension status is a documented
  property of the extension, not of the caller's grants, so `C8` is right on the
  mechanism. Residual risk retained in the M2 plan: if an *operator* installed
  dblink as superuser, the escape is real, which the `REVOKE EXECUTE … FROM
  PUBLIC` from `C4` also mitigates.
- **security-critic `9` / `C8` — `pg_catalog` cross-tenant enumeration.** Not
  fixable; **accepted in writing** rather than actioned, and promoted to a
  precondition the operator must accept before M2 ships. `C8` usefully bounds it:
  names and metadata only, since `pg_database_size` on another database needs
  `CONNECT`, which the provisioner revokes.
- **security-critic `7` — reveal endpoint should require re-auth + rotation.**
  Not rejected on merit; **converted to an open question** (Risk 3) because it
  changes M1's scope and is the user's call.
- **`C8` — `drop_internal`/`postgres`/`template1` are PUBLIC-connectable.** Real,
  but **out of scope**: a pre-existing one-line hardening unrelated to this
  feature. Recorded here so it is not lost.

## Agent critiques considered — diff stage

Gate 2 re-ran `security-critic` and `architecture-critic` against the real diff
(both read the working tree, including the uncommitted files). **Zero critical,
zero high.** Security returned 8 findings, all `low`, plus an explicit
clean-check on the load-bearing invariants — the `interactiveSessionOnly` move
byte-identical, no path to the superuser pool for tenant data, `getEnvVars`
output unchanged, middleware binding order correct. Architecture returned 18,
six `medium`, the rest `low`.

### M1 · pass 1 — actioned

Nine fixes applied in one batch:

1. **`listTables` reported the quarantine diagnostic for ordinary DB-less apps**
   (architecture, *medium/high*) — it threw `credentials-missing` unconditionally
   while `getOverview` only did so after confirming a live database. Added a
   `not-provisioned` reason mapped to **404**; 503 implies retry-will-help, which
   is wrong for a permanent state.
2. **SQLSTATE `3D000` was unmapped** (architecture, *medium/high*) — stored
   credentials pointing at a deleted database surfaced as "PostgreSQL is not
   reachable", sending an operator to check a healthy cluster. Now
   `database-missing`.
3. **The headline invariant had no executable guard** (architecture,
   *medium/high*) — `getAppCredentials('_internal')` can return superuser
   credentials and nothing in the module refused them. Now throws, and the test
   points at the guard rather than at a connection string, so it fails for ANY
   future path that tries one.
4. **Connection-string round-trip** (security, *low/low*) — the inspector fed a
   URL back into `pg`, which re-parses it; a password containing `@` would
   re-split the authority. Unreachable today, closed anyway: discrete fields now.
5. **Log hygiene** (architecture, *low/high*) — `connect failed` was logged where
   nothing had connected, over-counting the feature's only observability signal.
   The raw driver message is no longer logged at all.
6. **`DatabaseTab` latched its error state** (architecture, *medium/high*) — one
   transient failure stuck the panel on the red card, and it fired on *every* dev
   mount via StrictMode's double-invoke hitting the per-app cap of 1. Cleared on
   success; cap raised to 2.
7. **Empty vs. unanalysed rendering** (architecture, *medium/high*) — see the
   correction below.
8. **The rate-limit comment was false** (architecture, *medium/high*) — the db
   bucket *stacks with* the general `/api/*` bucket, it does not exempt panel
   traffic from it. Comment and plan corrected; wiring unchanged, since the
   tighter cap is still worth having.
9. Path encoding in the dashboard, and the reference page's `user` floor.

### The correction Gate 4 forced

Finding 7 was originally specified — by me — on the architecture critic's premise
that `n_live_tup` reads 0 until autovacuum analyses a table. **Gate 4 measured
that against a real PostgreSQL 16 and it is false.** `n_live_tup` is maintained
live by the statistics collector on DML; `pg_class.reltuples` — which this panel
does not read — is the field gated on ANALYZE. Measured, with 7 rows inserted and
never analysed:

```
relname | n_live_tup | last_analyze | size
todos   |          7 |              | 32768
```

The rule as originally specified would have hidden a correct `7` behind "not yet
analysed", which is worse than the bug it was meant to fix. The implemented rule
flags only the genuinely untrustworthy combination — zero rows reported against
real bytes on disk, which is what a stats reset produces:

```
todos   |          0 |              | 32768   <- 7 real rows
```

Both states are now pinned by the Gate 4 harness.

### Consciously rejected

- **architecture · the provisioner singleton lives in the barrel**
  (*medium/high*), forcing `app-db-inspector` to import `./index` and leaving a
  latent `index -> app-db-inspector -> index` cycle if the barrel ever
  re-exports the inspector. **Real, and deferred.** It is a pre-existing
  inconsistency with `getPostgresServer` (which owns its own singleton); moving
  it churns every existing call site for no behaviour change, which does not
  belong in a feature branch. No cycle exists today — the barrel does not
  re-export the inspector, and the routes deep-import deliberately.
- **architecture · exact `COUNT(*)` for small relations was dropped**
  (*medium/high*). **Cut, and the checkbox un-ticked** rather than left silently
  marked done. It needs a second statement per relation against a shared server,
  and Gate 4 showed `n_live_tup` is already correct in the ordinary case — so the
  value is much lower than when the plan was written.
- **security · four apps can hold the whole global gate** (*low/low*) and **the
  `sanitizeName` collision existence-oracle** (*low/medium*). Accepted: the first
  is <=5s of degradation on a read-only view behind a rate limit; the second
  requires owning an app whose name collides in the first 32 sanitized characters
  and yields a single boolean. Both are carried into the M2 plan, which has to
  solve the collision class properly regardless.
- **security · a hung `client.end()` leaks a gate slot permanently**
  (*low/medium*). Accepted for M1 with the reasoning recorded: it needs a
  blackholed TCP peer, and the fix — racing teardown against a timer — adds its
  own failure mode. The `[db-panel]` lines exist to make it visible if it ever
  happens.

Medium/low findings dropped without individual reasons: **11**.

## Run stats

```yaml
date: 2026-07-28
slug: database-panel
gear: full
effort_plan: high
effort_diff: high
findings_plan_actioned: 16
findings_plan_rejected: 4
findings_plan_dropped: 42
findings_diff_actioned: 10
findings_diff_rejected: 5
findings_diff_dropped: 11
escaped: 2
agents_spawned: 16
gates_failed_first_pass: 3
escalated_from: none
```

**On `escaped: 2`** — both are worth naming, because the point of the number is
to be honest about what the critics did not catch.

1. **The `n_live_tup` inversion.** The architecture critic asserted at plan stage
   that row estimates read 0 until autovacuum analyses a table. I believed it,
   wrote it into the plan, and specified a UI rule on top of it. The Gate 2
   critics repeated it rather than challenging it. **Gate 4 measured it against a
   real PostgreSQL 16 and it is false** — `n_live_tup` is stats-collector
   maintained on DML. The rule as specified would have hidden correct row counts
   behind "not yet analysed" — a defect introduced *by* the review process and
   caught only by running the thing.
2. **The row-estimate heuristic had zero test coverage.** Flagged at Gate 3.
   Closed by extracting it to a plain `.ts` sibling the root jest can reach, with
   fixtures taken from the Gate 4 readings.

**On `gates_failed_first_pass: 3`** — Gate 1 caught a plan item (the quarantined
-credentials state) that no implementer had built; Gate 2 returned a
nine-item fix batch; Gate 3 returned the coverage gap above. Gate 4 passed first
time, which is the one I would have bet against.

**On the ratio** — 17 critical/high findings at plan stage against 26 findings at
diff stage, of which **zero** were critical or high. Read together, the plan
review is where the design was wrong and the diff review is where the polish was
missing, which is the shape you want. The single most valuable finding in the run
(`values: []` does not select the extended protocol) was empirically verified by
two independent critics from the pinned driver source, and it is what moved M2
out of this plan.

