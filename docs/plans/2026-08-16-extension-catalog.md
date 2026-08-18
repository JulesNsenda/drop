# Extension catalog — search, and an honest Add

**Date:** 2026-08-16
**Status:** DRAFT — awaiting approval. No production code written.
**Supersedes nothing.** `docs/plans/2026-08-13-service-provider-plugins.md` stays
CLOSED, and this plan *upholds* its Stage 1 decline rather than reopening it.

---

## Goal

One searchable catalog in the dashboard listing everything DROP can attach to or
build — backing services (Postgres, Redis, external `DATABASE_URL`) and app
types (Node, Python, Go, static, Docker) — with an Add that is durable and a
Remove that tells the truth.

**Scope decision: first-party only.** Everything listed ships in-tree. There is
no download, no third-party code, no dynamic loading. Verified as sound by the
security panel (sec #13, *low/high*): `customDetectors`/`customStrategies` are
typed arrays of already-constructed objects, so nothing here introduces a
code-loading path.

---

## The decision this plan makes, up front

**No registry, no `ServiceProvider` seam, no `ExtensionDescriptor` union.**
The draft this plan replaces proposed all three. Five critics, independently,
said cut them, and one of them proved the seam could not work as designed:

> The restart path never consults need at all (`platform.ts:5012-5023`,
> unconditional `getEnvVars`), while the deploy path is gated on
> `appNeedsDatabase` (`:4009-4014`). **The two paths differ by whether inference
> runs, which `mayAllocate` cannot express.** — correctness C2, *high/high*

That is decisive. `bind(ctx, {mayAllocate})` was declined in August because its
remaining value was documentation; C2 shows it would not have delivered even
that, because the flag documents the wrong axis. The closed plan's standing
decision — extract the seam over two real implementations when MySQL is real
work — is correct and stands untouched.

What the catalog actually needs is an enumeration and two provisioner calls.

---

## Approach

### Phase 1 — the catalog (ships first, alone)

A frozen descriptor array, one read route, one page. **Zero lines of
`platform.ts`.** Search, filter, honest per-app state, and an Add that is a
copy-pasteable `drop.yaml` snippet — durable by construction, because the
manifest is what the deploy path reads.

`kind: 'service' | 'apptype'` survives **as a response field for filtering and
display**, not as a domain abstraction. The union is dead because the shape
isn't real:

> There are **6** detectors and **5** strategies; `manifestDetector` has no
> strategy at all; `BuildStrategy.supportedTypes` is many-to-one; `AppType` has
> **22** members. There is no 1:1 pair to key by a single id. — simplicity S2,
> *critical/high*

App-type cards are metadata. Nothing in `src/core/detector/` or
`src/core/builder/` is touched.

### Phase 2 — attach (gated on Phase 1 being live)

Attach = quota check → provision → persist intent → restart. The middle step is
what the draft got wrong and what three critics caught independently
(architecture *critical/high*, simplicity S1 *critical/high*, correctness C1
*critical/high*): the draft persisted **detach** intent and not **attach**
intent, so the very user who clicks Add — the one whose app didn't infer a
database — loses `DATABASE_URL` on the next deploy while the database survives
and keeps burning a `maxDbsPerUser` slot.

One symmetric field, consulted by **one shared predicate called from both
paths** (C2's requirement), not two asymmetric fields consulted by one:

```ts
// AppConfig — merged by upsertConfig, so it survives monorepo re-expansion
// (verified: app-config.ts:377-393 spreads ...existing before ...updates)
services?: Record<string, 'attached' | 'detached'>;
```

**Precedence — the one rule that makes Phase 1 and Phase 2 coexist:**

```
AppConfig.services  >  manifest declaration (`database:` / `redis:`)  >  inference
```

This is load-bearing and easy to get wrong. Phase 1's Add *is* the manifest
snippet, so after Phase 2 ships, a user can have both: a `drop.yaml` saying
`database: postgres` and a later Detach click. `appNeedsDatabase` consults the
explicit `database:` branch (`platform.ts:2504`) **before** anything else, so a
predicate inserted merely "before inference" would let the manifest re-provision
on the next deploy and silently undo the detach — the exact revert-loop this
plan exists to prevent.

The predicate therefore goes **above the manifest branch, not below it**. The
justification is temporal, and it is the same rule as sec #8's owner-wins:
the button was clicked *after* the manifest was written, so it is the newer
intent, and on the `deploy_from_git` path the manifest author may not even be
the app's owner. Consequence, stated plainly rather than discovered later: once
an app has been attached or detached through the UI, its manifest key stops
being authoritative for that service. The card must say so, and re-attaching is
what hands authority back.

### Phase 3 — detach (last; the only irreversible thing here)

Ships last because it is the one action that destroys tenant data and cannot be
undone by reverting the code.

---

## File-level changes

### Phase 1 — catalog

- [x] `src/api/routes/extensions.ts` — frozen `EXTENSIONS` descriptor array
      (postgres, redis, external-database-url, nodejs, python, go, static,
      docker); `GET /` only. `availability` as a **closed union**, never an
      exception string (sec #12, *low/medium* — spawn/`existsSync` messages
      carry absolute host paths). **No `sqlite` card** — see open question 3;
      omitting it defers that decision cleanly instead of shipping U7 in Phase 1.
      `availability` is **platform-scope only** — installed / disabled-by-config
      / unsupported-isolation. Quota-full and already-attached are *per-app* and
      cannot be computed here: this route has no `:name`, and quota is per-user.
      They arrive in Phase 2 from `GET /db/:name`, as a separate field. Keeping
      that boundary is what stops `availability-label.ts` from being retrofitted
      with app-scope cases its tests never described.
- [x] `src/api/server.ts` — mount + **`v1.use('/extensions/*', authMiddleware('readonly'))`**.
      (Shipped as the `/*` form only, not the bare path this line originally
      named — see the diff-stage note on the double-auth finding.)
      This guard is load-bearing: `setupRoutes` has no default-deny, so a new
      top-level path is anonymous on an auth-enabled box (sec #2, *high/high*;
      architecture, *medium/high*).
- [x] `src/api/routes/extensions.routes.test.ts` — 401 when unauthenticated;
      availability reflects a null provisioner.
- [x] `src/dashboard/src/lib/catalog-filter.ts` — **pure**: search over
      displayName/summary/keywords + kind filter, mirroring `AppsPage.tsx:143-155`.
- [x] `src/dashboard/src/lib/catalog-filter.test.ts` — root Jest already collects
      `src/dashboard/**/*.test.ts`.
- [x] `src/dashboard/src/lib/availability-label.ts` + `.test.ts` — **pure**: the
      availability→label→call-to-action mapping. This is the unit that carries
      the risk, not the string filter (UX U11, *medium/high*).
- [x] `src/dashboard/src/pages/CatalogPage.tsx` — reuses `AppsPage`'s search
      input and `components/ui` primitives. **No mutating buttons at platform
      scope**; each card's action is "how to add this" — the snippet plus a docs
      link (UX U2, *high/high*: there is no `:name` in the route and no
      app-picker component exists).
- [x] `src/dashboard/src/App.tsx` — one `<Route path="catalog">`.
- [~] Empty states. **Shipped**: a no-results state for search/filter (with a
      Clear filters action) and an error state that never reads as "no
      extensions exist" — the two that are reachable. **Not shipped**: the
      "zero deployed apps" onboarding card this line originally meant. It would
      require `CatalogPage` to fetch apps, which it otherwise never does, and
      the catalog-empty variant is unreachable against eight in-tree entries.
      Recorded rather than ticked (architecture, *low/medium*).

### Phase 2 — attach

- [ ] `src/core/platform.ts` — `AppConfig.services` consulted by **one shared
      predicate**, called from the deploy path *and* `buildFreshStartSpec`.
- [ ] `src/core/platform.ts` — extract the two inline quota branches
      (`:4023-4045`, `:2720-2734`) into functions returning a **structured**
      result. The quotas do not live in the provisioners, so an attach route
      that calls `provisionAppDatabase` directly is an unbounded
      database-and-role creation primitive for any `user`-role tenant (sec #1,
      *high/high*; correctness C6, *high/high*). **Preserve each service's
      current ownerless semantics exactly** and pin them — see open question 1.
- [ ] `src/managers/app/app-config.ts` — split the setter: a caller-facing
      allowlist and a system-only writer for platform-controlled fields
      (`services`, `grantedApiScopes`, `agentCreated`, `ephemeral`). Enforced in
      the type signature, not a test (sec #9, *medium/medium* — this is the
      "security helpers have callers" class CLAUDE.md names).
- [ ] `src/api/routes/apps.ts` — `POST /apps/:name/services/:id`. Returns
      `{kind, reason?, envVarNames}` — **names only, never values**; the
      Postgres binding is a DSN containing the role password (sec #11,
      *medium/medium*).
- [ ] **Read path: extend `GET /db/:name`, do not add `GET /apps/:name/services`.**
      Verified: it already returns `DbOverview {provisioned, database?,
      sizeBytes?, tableCount?}` (`app-db-inspector.ts:28-33`) and is gated by
      `interactiveSessionOnly` (`db.ts:102`) — a **stricter** gate than
      `authMiddleware('user')`, chosen deliberately because an unguarded GET
      would be "anonymous, network-reachable disclosure of every app's schema"
      on an auth-disabled box and because it closes the DROP-075 gap where an
      API key's role is never clamped to its owner's. Add `redis:
      {provisioned}`, the `services` intent, and the per-app quota state here.
      This deletes a route, its auth line, its rate-limit line and its test from
      this phase, and inherits the stronger gate rather than re-deciding it
      (simplicity S6, *medium/high*).
- [ ] `src/api/server.ts` — rate-limit bucket on **both** `/apps/*/services`
      **and** `/apps/*/services/*`; the nested path is the one that provisions
      (sec #5, *medium/high*). Add **no** new `/apps/*` auth line — the existing
      method-scoped guard at `:327-334` already covers it, and a new one would
      gate the collection GET at `user` and break readonly viewers
      (architecture, *low/high*).
- [ ] Attach refuses on `ephemeral: true` apps — the TTL sweep tears down with
      `skipDatabaseBackup: true`, so attached data dies on a timer with **no
      dump** (correctness C12, *medium/high*).
- [ ] Attach refuses when the app's `DATABASE_URL` comes from a secret or
      `drop.yaml env:`. `appDatabaseUrlSource` exists precisely to stop
      provisioning "silently repointing the app from its real database at a
      freshly-created empty one" (`platform.ts:2527-2541`); an explicit attach
      bypasses that guard by construction (UX U1, *critical/high*).
- [ ] `isAppInProgress` → 409 around the **whole** attach, and an ActivityLog
      entry — both copied from `apps.delete`, which already does exactly this
      for the same destructive primitive (sec #10, *medium/medium*; correctness
      C13, *medium/medium*).
- [ ] Per-app serialisation of provisioning (`writeChains`-style, as
      `app-config.ts:204-210`) — `provisionAppDatabase` has no in-flight lock
      (correctness C13).
- [ ] Dashboard: attach/detach live in the **existing** `DatabaseTab`, not a new
      tab. DROP-120 already made `provisioned:false` first-class content there,
      and a second panel would give two accounts of one database (UX U9,
      *medium/high*; architecture, *medium/high*; simplicity S6, *medium/high*).
      A separate "Services" tab would also collide with the monorepo meaning of
      `services:` (UX U8, *medium/high*).
- [ ] Component-owned `attachState` driving `Button loading` — `usePolledJson`
      documents that it deliberately has no in-flight flag, and the restart can
      take up to `readinessTimeoutMs` (60s default) (UX U3, *high/high*).
- [ ] Single in-flight action guard — `ConfirmProvider` holds one `resolve`
      slot, so a second `confirm()` strands the first `await` forever;
      `DeployPage.tsx:336-338` already carries this guard (UX U6, *high/high*).
- [ ] Client-side `role !== 'readonly'` gate, matching `AppDetailPage.tsx:130`
      (UX U10, *medium/high*).

### Phase 3 — detach

- [ ] Per-app cooldown **and** a total-size ceiling on `data/backup/pre-delete/`,
      refusing the detach when either is hit. Today `backupAndDeleteAppDatabase`
      runs once per app, terminally; as a button it becomes a repeatable
      amplification primitive that writes a full `-Fc` dump **plus a
      `*.restore-role.sql` containing the role's plaintext password** per cycle,
      retained by age (3 days), in a tree the disk-ceiling guardrail does not
      cover (sec #4, *high/high*).
- [ ] Surface the provider's own result verbatim, including `dumpPath`. The two
      deprovisions differ in kind and a flattened `{removed, note?}` loses it:
      Postgres dumps-then-drops and **fails closed**; Redis FLUSHDBs with **no
      dump at all** and never throws (architecture, *high/high*).
- [ ] Handle the partial state explicitly: `DROP DATABASE` can succeed while
      `DROP USER` fails, returning `dropped:false` with the data already gone
      and `getEnvVars` still yielding a DSN for a database that no longer exists
      (correctness C4, *high/high*).
- [ ] Redis detach must stop the app before releasing the logical DB number —
      `nextFreeDb()` hands the freed number to the next requester while the old
      process is still writing to it (correctness C3, *high/high*).
- [ ] Persist `'detached'` only after the deprovision reports success.
- [ ] Confirm via the existing `variant: 'danger'` dialog naming the dump path —
      **not** a typed confirmation. No typed confirm exists anywhere in the
      dashboard, and deleting an entire app uses the plain dialog; adding one
      here alone inverts the severity ordering users have already learned (UX
      U5, *medium/high*).
- [ ] **The owner's explicit detach wins over a manifest declaration.** The
      draft had this backwards: on the `deploy_from_git` path the manifest
      author is a third party, so a stale upstream pinning `database: postgres`
      would permanently deny the owner the ability to deprovision their own
      database while it keeps counting against their quota (sec #8,
      *medium/high*). Record the conflict and warn; do not refuse.

---

## Cut, with reasons

- **The registry, the `ServiceProvider` seam, `BindingContext`,
  `BindingResult`, `mayAllocate`.** C2 (*high/high*) shows the flag documents
  the wrong axis. Also: `BindingContext` cannot reproduce the deploy branch
  without four more inputs (architecture, *high/high*), and `mayAllocate` is a
  per-*provider* policy, so the restart site would need a provider-id→policy
  map — "the platform names each service by hand", in two places instead of one
  (architecture, *high/high*).
- **The `envVarNames` two-sided conflict check.** It re-imports the name-list
  pattern DROP-150 deliberately deleted, and is circular for the built-ins: the
  Postgres provider's own `envVarNames` *is* the reserved set. The positional
  filter at `platform.ts:6399-6409` is already complete by construction (sec #3,
  *high/high*; architecture, *medium/high*; simplicity S5, *medium/high*).
- **Stage C in its entirety** — `AppTypeExtension`, feeding the dead seams, and
  `PUT /apps/:name/type`. Six independent kills: `type: python` in `drop.yaml`
  already overrides detection at confidence 1.0 today (simplicity S9,
  *medium/high*); the route would write into the tenant's source tree, breaking
  `git pull` redeploys and getting wiped by monorepo child regeneration
  (architecture, *high/high*; correctness C8, *high/high*); a `drop.yaml` write
  is classified as a *config* change whose event **has no subscriber**, so the
  change is inert (correctness C9, *high/high*); a bare `type:` file makes the
  manifest detector win and short-circuit the chain, replacing a working start
  command with `node index.js` (correctness C10, *high/high*); and `canBuild` is
  pure type-membership, so a forced type runs the wrong strategy rather than
  refusing (correctness C14, *low/high*).
- **MySQL / Stage E.** Belongs to the closed plan, on its own terms.

---

## Risks & open questions

1. **The two quotas disagree about ownerless apps and must not be silently
   normalised.** `platform.ts:4023` uses a truthy test (`if (ownerUserId && …)`)
   so ownerless apps skip the DB quota entirely; `:2722` uses
   `ownerUserId !== undefined`. Unifying changes live behaviour in *both*
   directions — standardise on `!== undefined` and every ownerless app on the box
   shares one 3-database cap, so the fourth agent-deployed app silently gets no
   database (correctness C7, *medium/high*). Phase 2 preserves each service's
   current semantics and pins them with tests; changing them is a separate,
   explicit decision.
2. **Displayed attachment state must not come from `isProvisioned()`.** That map
   is independent of what `handleStartApp` actually injected, so the UI can read
   "Attached" while the app has no `DATABASE_URL`, and re-attaching appears to
   fix it while regressing on the next deploy (correctness C5, *high/high*).
   Derive from persisted intent plus the last successful start.
3. **`database: sqlite` is still a tenant-facing lie** — `appNeedsDatabase`
   returns true for it and provisions PostgreSQL, warning only to a platform log.
   The catalog makes it *more* visible, and a refusal citing it would name a key
   DROP ignores (UX U7, *medium/high*). **Phase 1 ships no `sqlite` card**, which
   defers this rather than half-answering it. It must be decided before Phase 2,
   because a detach refusal or an attach card *would* have to name the key:
   reject at parse time, or say "sqlite is served by PostgreSQL" on the card.
4. **`AppConfig.services` becomes a third system of record** alongside
   `db-credentials.json` and `redis-allocations.json`, with nothing reconciling
   them on boot (architecture, *low/medium*). One-line boot reconcile, or accept
   and document.
5. **`selectImageUser` fails open to root** for unmapped `AppType`s
   (`container-config.ts:132-147`); `container-manager.ts:258` then omits `User`
   entirely. Pre-existing and reachable today via `type: docker`, **not
   introduced here** — recorded because it should fail closed to non-root
   regardless of this plan (sec #7, *medium/high*).
6. **Phase 3 is the only un-revertable stage.** Reverting the code does not
   restore a dropped database. Phases 1 and 2 revert cleanly.
7. **Still open from the closed plan:** `secrets: { <RESERVED>: generate }`
   bypasses the denylist, and needs a production manifest grep that has never run.
8. **The Redis availability signal can read `available` after a failed
   `initialize()`.** `getRedisProvisioner(server, root)` sets the module
   singleton *before* `initialize()` is awaited, and the soft-failure catch
   nulls only the platform's instance field. Pre-existing; the one-line fix
   (`resetRedisProvisioner()` in that catch) is a `platform.ts` diff and so sits
   outside Phase 1's deliberate zero-hot-path boundary. Do it in Phase 2, which
   touches `platform.ts` anyway and keys per-app state off the same singleton.
9. **Two pre-existing hazards the catalog makes more discoverable without
   creating.** `src/core/static-server.ts` has no dotfile deny-list, so a static
   app served from its source root exposes `/.env`, `/.git/config` and
   `/drop.yaml`; and `type: docker` under `isolation: none` builds an image on
   the host but has no `buildStartSpec` branch, so the app starts under PM2 as
   `node index.js`. Neither is reachable through this diff now that the `type:`
   snippets are gone. Both deserve their own fix.

---

## Agent critiques considered

Panel: `security-critic`, `architecture-critic`, plus three `general-purpose`
critics (correctness/edge-case; simplicity/YAGNI; UX-honesty/frontend), all
read-only, all with repo access. **68 findings: 6 critical, 26 high, 27 medium,
9 low.** Severities quoted verbatim; none re-graded.

### Actioned — critical

- **Attach is not durable across a redeploy** (architecture *critical/high*;
  simplicity S1 *critical/high*; correctness C1 *critical/high*). Three critics,
  independently, on the half of the design the draft thought was safe. Actioned:
  one symmetric `AppConfig.services` field, one shared predicate on both paths.
- **The registry is not required by the feature** (architecture *critical/high*;
  simplicity S4/S8 *high/high*). Actioned: cut entirely.
- **`AppTypeExtension` is a shape the codebase does not have** (simplicity S2,
  *critical/high*). Actioned: app types are catalog metadata; the union is a
  response field.
- **Attach would silently repoint an app off its real database** (UX U1,
  *critical/high*). Actioned: attach refuses when `appDatabaseUrlSource` is
  non-null; a third card state.

### Actioned — high

Grouped where critics converged. All 26 are actioned above except the two
recorded as rejected below.

Security #1 (quota bypass), #2 (`/extensions` unauthenticated), #3
(`envVarNames` cannot protect an unbounded set), #4 (repeatable `pg_dump`
amplification + plaintext role password). Architecture: `BindingContext`
insufficiency, `mayAllocate` per-provider, detach differs in kind, `PUT type`
writes tenant tree, union-as-DTO (*high/medium*). Correctness C2 (inference, not
allocation, is the axis), C3 (Redis number reuse collision), C4 (partial detach),
C5 (`isProvisioned` is not attachment), C6 (quota attach = success + downtime +
nothing), C8/C9/C10 (the three independent kills of `PUT type`). Simplicity S3
(`detachedServices` duplicates `redis:` and re-opens `database: false`), S7
(Stage A's test bill is induced by Stage A), S8 (stage ranking), S11 (the
six-file slice — adopted as Phase 1). UX U2 (no app scope at platform level),
U3 (60s blocking mutation), U4 (two availability states collapse five
situations), U6 (confirm-dialog deadlock).

### Rejected — recorded

- **"Cut mutating attach/detach from v1 entirely; ship read-only with a
  copy-paste snippet"** (simplicity S1/S11, *critical/high*). **Partly
  rejected.** Its substance is adopted as Phase 1, which ships alone and first.
  But the user asked for "search **and add**", and a snippet is not an Add.
  Deciding factor: S1's durability objection is real and is answered by the
  `AppConfig.services` predicate rather than by abandoning the feature — and
  sec #8 (*medium/high*) shows the read-only alternative has its own cost, since
  an owner who cannot deprovision is denied control of their own quota.
- **"Refuse detach when the manifest declares the service"** (my draft's rule,
  contradicted by sec #8, *medium/high*). Rejected in favour of owner-wins.

### Disagreements resolved

- **Architecture wanted `AppConfig.services`; simplicity wanted no new field**
  (S3, *high/high*), noting `redis: false` is already a durable opt-out honoured
  on both paths. **Sided with architecture.** Deciding factor: the manifest is
  the only other durable home, and writing the tenant's `drop.yaml` is
  independently disqualified — it breaks `git pull` redeploys and is wiped
  wholesale by monorepo child regeneration (correctness C8, *high/high*). S3 is
  right that `redis: false` works today; it is not right that it covers
  Postgres, where `database: false` is deliberately not an opt-out.
- **Hono route matching.** My draft claimed `v1.use('/apps/*/services')` would
  not match the nested path and proposed a guard. Two critics, both empirical:
  trailing `/apps/*` **does** match `/apps/x/services/y` (so the existing guard
  covers auth), while `/apps/*/services` does **not** (so the rate-limit bucket
  needs `/apps/*/services/*`). The draft had it backwards in both directions.

### Corrections to the draft's "verified" facts

Two were wrong, found by the critics rather than by me — recorded because the
list's credibility is why it exists:
- **Fact 2 was false as written.** `await import()` is used in ~12 places
  (`container-manager.ts:767`, `platform.ts:1207`, `auth.ts:976`,
  `strategies/base.ts:194`, …). Every specifier is in-tree, so the conclusion —
  no precedent for loading code from *outside* the tree — survives (simplicity
  S10, *low/high*).
- **Fact 9 was misleading.** `DETAIL_TABS` already carries a `database` tab whose
  documented purpose is that "no database provisioned" is first-class content
  (architecture, *medium/high*) — which is why Phase 2 extends it instead of
  adding a tab.
- Fact 4's line range was off by two and flattened the ownerless divergence now
  recorded as open question 1. Facts 1, 3, 5, 6, 7, 8, 10 verified by two
  critics independently.

### Dropped without individual reasons

`medium`/`low` triaged out after the above: **security** 3 medium, 2 low;
**architecture** 2 medium, 2 low; **correctness** 1 medium, 0 low;
**simplicity** 2 medium, 0 low; **UX** 1 medium, 0 low.
Total dropped: 9 medium, 4 low. Every `critical`/`high` is actioned or recorded.

---

## Agent critiques considered — diff stage

Separate corpus from the plan-stage panel above. Panel: `security-critic`,
`architecture-critic` (both on the real diff), plus a `test-runner` pass.

### Phase 1 · pass 1

**Actioned — blocking**

- **The five `type:` snippets reintroduce the exact mechanism this plan cites to
  cut Stage C** (architecture, *high/high*). Verified independently before
  acting, every link: `manifestDetector` priority 100 → `confidence: 1.0` →
  `detect()` breaks at `>= 0.95` (`detector.ts:78`) → no language detector runs
  → `startOverride || procfileWeb || suggestedConfig?.startCommand ||
  'node index.js'` (`platform.ts:6212`). Pasting `type: nodejs` into a working
  zero-config app breaks it. **Actioned**: all five app-type snippets removed;
  app-type cards now carry a `detection` line sourced from what each detector
  actually keys on (`package.json`, `go.mod`, `Dockerfile`, …).
- **The snippet test measured the wrong property** (architecture, *high/high*) —
  it asserted the snippet *parses*, which is exactly true of the harmful case.
  **Actioned**: a second, explicitly behavioural gate — no snippet may set
  `type:` without `start:`. Mutation-checked: restoring `type: nodejs` fails 3
  of 12.

**Actioned — the rest**

- **Both auth guard lines registered → double auth pass** (security #5,
  *low/high*). This **overturned my own earlier empirical result**: I had tested
  on a flat Hono app, where `use('/extensions')` does not match the sub-path.
  Re-tested with the real `app.route('/api/v1', v1)` → `v1.route('/extensions')`
  nesting: `/extensions/*` alone covers **both** paths, and keeping both makes
  the collection request run `authMiddleware` twice (two JWT verifies, two user
  lookups, two `apiKey.lastUsed` writes). **Actioned**: single `/*` line, and
  the comment now records that flat-app tests give the opposite answer.
- **`docsUrl` rendered into `href` with no scheme allowlist** (security #8,
  *low/low*). Latent when filed; **my populating `docsUrl` made it live**. React
  does not block `javascript:`. **Actioned**: http(s) allowlist.
- **Snippet validity ≠ snippet semantics** (security #6, *low/medium*) —
  `validateDropYamlConfig` accepts any string for `database`, so
  `database: postgresql` (a spelling in this catalog's own keywords) would
  validate and provision nothing. **Actioned**: values pinned to what
  `appNeedsDatabase` acts on.
- **Monorepo top-level `database:`/`redis:` validates and does nothing**
  (security #7, *low/medium*) — children read `services.<name>.*`. **Actioned**:
  both service summaries say so.
- **`docsUrl` declared but never populated** (architecture, *medium/high*) —
  **Actioned**: populated on all 8, pinned by a test. It is the app-type cards'
  only action now that they ship no snippet.
- **Clipboard button always fails on plain-HTTP installs** (architecture,
  *low/high*) — `navigator.clipboard` is undefined outside a secure context.
  **Actioned**: feature-detected; the `<pre>` stays selectable.
- **`readonly` tier was pinned by no test** (test-runner) — every route test
  authenticated as `user`, which outranks it. **Actioned**: test added and
  mutation-proved (tightening the guard to `'user'` fails it alone).
- **`Object.freeze` for real immutability** (architecture, *low/high*) —
  `readonly` is compile-time only and left `keywords` shared by reference.
  **Actioned**, which required `keywords: readonly string[]` on the wire type.
- **A false comment I wrote into the route** — it claimed `platform.ts` nulls
  both the Redis server and provisioner on soft failure. It does not:
  `getRedisProvisioner(...)` sets the **module** singleton before
  `initialize()`, and the catch nulls only the platform's instance field
  (`platform.ts:1416-1426`); `resetRedisProvisioner()` runs only in `stop()`.
  **Actioned as a comment fix**, not a code fix — see open question 8.

**Recorded, not actioned**

- **`resetRedisProvisioner()` missing from the soft-failure catch**
  (security #4, *low/high*; architecture, *medium/high*). The fix is a
  `platform.ts` diff, which Phase 1's zero-hot-path-diff boundary exists to
  avoid, and the defect is pre-existing — the catalog reads the signal, it does
  not create it. Now open question 8, with the narrowing that the common
  failure (no `redis-server` binary) throws in `start()` before the singleton is
  ever set, so that case reports correctly.
- **`postgres-not-ready` is effectively unreachable in a running platform**
  (architecture, *medium/high*). `initializeServices` throws on a null
  provisioner and the API server starts after it. Kept as a real branch (tests
  and a partially-booted platform reach it) with the imprecision documented at
  the call site rather than papered over.
- **A `catalogView(...)` pure selector for the render-state matrix**
  (architecture, *medium/medium*). Sound, and the right shape if Phase 2 adds
  per-app state to those cards. Deferred: the current five gates are correct and
  reviewed, and Phase 2 is when the input count actually grows.
- **`type: docker` / `type: static` isolation and source-disclosure hazards**
  (security #1 and #2, both *medium/medium*). **Moot for this diff** — both
  depend on the `type:` snippets, which are gone. The underlying issues are real
  and pre-existing: `static-server.ts` has no dotfile deny-list, and `docker`
  under `isolation: none` has no `buildStartSpec` branch. Recorded as open
  question 9; neither is created or worsened here.
- **Content data colocated with HTTP transport** (architecture,
  *medium/medium*). Deferred to whenever a second consumer (MCP tools, CLI, a
  drop-site sync test) actually appears.
- **`ExtensionId` union instead of `id: string`** (architecture, *low/high*).
  Worth doing when Phase 2 keys per-app state by the same id.

**Dropped without individual reasons:** security 0 medium / 3 low (2 were
"verified, not a finding"); architecture 1 medium / 2 low.

### Phase 2 · pass 1 (backend)

Panel: `security-critic`, `architecture-critic`, two `test-runner` passes.
Phase 2 attracted far more review debt than Phase 1 — it touches `platform.ts`,
provisions real resources, and its guards are ordering-sensitive.

**Actioned**

- **Skeleton `AppConfig` → boot-time corruption** (architecture, *high/high*;
  security, *low/medium*). Attach on a state-only app would mint a config with
  `type: 'unknown'` and no `path`; `syncStateWithConfigs` then calls
  `registerApp(name, config.path || <appsDirectory>/name, config.type)` on the
  next boot, relocating an out-of-tree app and resetting its type. Now a
  `no-app-config` refusal.
- **Redis had no owner-supplied-URL refusal** (security, *medium/high*). The
  guard was built for Postgres only; `redisEnvVars` is spread after
  `secretEnvVars` too, so attaching over an owner's `REDIS_URL` silently
  empties a live session store. Added `appRedisUrlSource` + a
  `has-own-redis-url` refusal + the deploy-path warning. Mutation-verified.
- **Per-user quota race** (security, *medium/high*). `appsInProgress` is keyed
  per app; the quota is per user. Added an owner-keyed serialisation lock over
  the whole check-then-provision span.
- **`service-unavailable` was a throw → 500** (architecture, *medium/high*).
  Now a structured refusal → 503.
- **`AppNeedsConfigError` unhandled** (architecture, *medium/high*; security,
  *low/high*). By then the database and intent are real; the opaque 500
  stranded a quota-consuming database with no audit entry. Handled, and
  audited in that arm.
- **`resetRedisProvisioner()`** in the soft-failure catch — open question 8,
  which the plan had explicitly scheduled for this phase (architecture,
  *medium/high*; security, *low/medium*).
- **Rate-limit bucket on a nonexistent route** (architecture, *low/high*).
  Removed; it ran before auth, so it only let unauthenticated callers drain the
  shared budget through a 404.
- **`attachService` had no test at any level** (architecture, *high/high*) —
  every route test mocks it. Now 28 platform-level tests pinning guard
  *ordering*, not just outcomes; three mutations verified.
- **`serviceQuotaState`'s doc comment was wrong** about the ownerless
  divergence (test-runner). Corrected: for `undefined` BOTH report `false`; the
  divergence is the empty-string case. Both pinned by tests.

**Rejected — recorded**

- **Move intent `'attached'` below the `appDatabaseUrlSource` check**
  (architecture, *medium-high/high*; security, *medium/high*). **Partly
  rejected.** An explicit `database: postgres` already outranks the app's own
  URL by design — the code says so — so making a button click behave
  differently would be a new inconsistency, and it breaks the plan's own
  `intent > manifest > inference` rule. The hazard is real but pre-existing and
  shared with `database:`. Actioned as a loud warning on both services instead;
  the precedence question belongs in its own change. **The security critic's
  admin angle is the strongest counter-argument and is NOT dismissed**: an
  admin can now persist an intent that outranks the owner's own `DATABASE_URL`
  secret, which they previously had no API path to. Recorded as open question
  12.

**Open — deliberately not fixed, carried forward**

10. **Display and enforcement read different handles.** `db.ts` reimplements
    quota against module singletons; `checkDbQuota` uses instance fields. The
    right fix deletes code: expose `getServiceQuota` via `PlatformOps` and drop
    `serviceQuotaState` plus both `runtime-config` accessors and their
    `ApiServerConfig` plumbing (architecture, *medium-high/high* and
    *medium/high*; security, *low/medium*).
11. **The `AppConfig` setter split was specified and not built** (architecture,
    *high/high*; security, *low/high*). Containment holds today — every writer
    passes fixed literals and the one body-accepting route uses an allowlist
    over `AppState` — but nothing structural keeps it holding, and `services`
    now decides whether real Postgres roles exist. Also: `attachService`
    spreads a pre-`await` config snapshot, a lost update once Phase 3 adds a
    second writer.
12. **Attach-time-only conflict evaluation**, incl. the admin override above.
13. **`GET /db/:name` couples Redis/intent readability to Postgres health** —
    the new fields are computed inside the `try`, so a `DbUnavailableError`
    hides them. On a Postgres-less box the Redis attach state is unreadable
    (architecture, *medium/high*).
14. **Attach restarts a deliberately stopped app** (security, *low/medium*).
15. **Refusals are unaudited** — only success is logged (security, *low/high*).
16. **`NaN` quota fails open** on a malformed env value (security,
    *low/medium*). Pre-existing; load-bearing for the first time.
17. **Ephemeral check is not transitive** for monorepo children (security,
    *low/high*).
18. **Rate-limit matching is a property of the whole route set**, not the
    pattern — needs a behavioural 429 test, not a comment (security,
    *low/low*).
19. **Phase 3 must add**: `secrets.ts` gates on `isProvisioned`, which a
    partial detach makes wrong (hard lockout); and detach must restart, or
    `services` must join the boot-reconcile skip inputs.

### Test pass

`npm test`: **2955 passed, 6 failed, 8 skipped / 2969**. All 5 failing suites
(`oauth.revoke`, `auth.agent-tokens.route`, `secrets.authz`, `drop-yaml-parser`,
`tar-extract`) pass **in isolation** with the load-contention duration
fingerprint this repo's known-flaky notes describe (113s→12s, 93s→18s, 74s→12s,
39s→4s, 13s→3s). None imports any file in this diff — confirmed by grep. **All
pre-existing; none caused by this change.**

Change-surface suites: **65 passed / 65** across 6 suites. Both guards
mutation-proved (removing them turns the refusal test red; tightening to `user`
turns the readonly test red), and the snippet gate mutation-proved twice.

**Coverage gap, stated rather than papered over:** `CatalogPage.tsx` has no
behavioural test and cannot have one — root Jest is `testEnvironment: 'node'`
matching `*.test.ts` only, with no jsdom and no RTL. It *is* type-checked
(`tsc --noEmit` and `vite build` both run over it via root-hoisted deps —
`src/dashboard/node_modules` does not exist, and `npx` resolving upward is why
the build works). Gate 4 covers behaviour.

## Run stats

Phase 1 only — Phases 2 and 3 are designed but not built, and are not counted
here. `escaped: 2` is the number worth reading: both are defects the five-critic
plan panel did not catch, found later by me.

```yaml
date: 2026-08-16
slug: extension-catalog
gear: full
effort_plan: high
effort_diff: high
findings_plan_actioned: 53
findings_plan_rejected: 2
findings_plan_dropped: 13
findings_diff_actioned: 11
findings_diff_rejected: 7
findings_diff_dropped: 6
escaped: 2
agents_spawned: 14
gates_failed_first_pass: 2
escalated_from: none
```

The two escapes, recorded plainly rather than rounded away:

1. **`availability-label.ts` indexed its copy table directly**, so a reason
   string from a server newer than a cached dashboard bundle would throw on
   `.detail` and blank the card. Caught by me at Gate 1, after the plan panel
   and before the diff panel — so no critic ever saw it.
2. **The plan's own file-level checklist omitted `Layout.tsx`**, which meant
   Phase 1 as specified would have shipped a page reachable only by typing the
   URL. Two critics reviewed that checklist and neither noticed; the
   implementer building the page surfaced it instead, by refusing to silently
   widen its scope.

`gates_failed_first_pass: 2` — Gate 1 (the two items above) and Gate 2 (a
blocking architecture finding plus six security findings). Gates 3 and 4 passed
first time; the six initial failures in the Gate 4 UI run were a bug in my
verification harness, not the product, and are not counted as a gate failure.
