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

> **Superseded 2026-08-20** by "Phase 3 — detach: final plan" at the end of this
> file, after its own adversarial panel. Two lines below are explicitly amended
> there: "persist `'detached'` only after the deprovision reports success"
> (replaced by persist-intent-first with converging retries) and "surface the
> provider's own result verbatim, including `dumpPath`" (basename to the client,
> full path server-side only). The rest carries forward.

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

---

# Phase 3 — detach: final plan (2026-08-20)

**Status:** awaiting approval. Folds in carried debts **#11** (AppConfig setter
split) and **#19** (secrets gate + detach-must-restart), per explicit user
scope. Reviewed by a fresh three-critic panel (security, architecture,
correctness/edge-case — 44 findings, 8 scenarios verified clean); reconciliation
below.

## Goal

`DELETE /api/v1/apps/:name/services/:id` — detach postgres or redis: record the
owner's intent durably, deprovision (postgres: verified dump then drop; redis:
flush then free the logical DB number), and restart the app so the injected env
var actually drops. Postgres detach is the platform's only user-facing
irreversible action; the design's first duty is that no failure arm strands a
state that cannot be retried, displayed, or reasoned about.

## The invariant that reorganised the draft

**Persist intent first; let retries converge; render divergence honestly.**

`AppConfig.services[id] = 'detached'` is written *after every refusal gate and
before any destruction*. Intent records the owner's decision; the provisioner
registries record physical state; a retry converges the two; the UI shows the
gap as its own card state ("detach incomplete — retry"). This **replaces the
original plan's "persist `'detached'` only after the deprovision reports
success"**, which three critics independently broke:

- the partial state (db dropped, role-drop failed) became a **permanent wedge**
  — every retry re-entered `pg_dump` against a nonexistent database and died
  before the drops, with the quota slot burned forever (correctness C1,
  *high/high*);
- a crash between the drops and the intent write **silently re-provisions an
  empty database on boot** via manifest/inference (correctness C5, *low/high*);
- an owner whose provisioning was skipped (quota, provisioner down) could
  **never record a detach at all** against a third-party manifest — the exact
  override the intent field exists for (architecture A12, *medium/medium*).

Persist-first is safe because `'detached'` intent with a live database is
already a fully-handled state: all four injection/provisioning read sites
honour it (`appNeedsDatabase` platform.ts:2546, `appNeedsRedis` :2764,
`buildFreshStartSpec` :5210, `provisionRedisEnvVars` :2855) — which is also the
**restated justification for #19b**: boot reconciliation needs no `services`
input because intent is enforced at every read site, not because "boot rebuilds
on failure" (architecture A16 corrected the draft's weaker argument; a future
deletion of any of those four guards must argue with this list).

## `detachService(appName, serviceId)` — platform.ts, mirroring attach

**No owner lock.** Detach only *frees* quota, so every interleaving with
attach's check-then-provision errs toward over-refusal, never over-admission
(architecture A4, *high/medium-high*); `appsInProgress` already serialises the
app itself. This also moots the panel's lock-poisoning attack (security S1
half), and attach's lock keeps its name — no churn through the 28-test suite.

Guards, in order (structured refusals, attach's result-union style):

1. **busy** — `appsInProgress` add / finally-delete; concurrent → thrown
   `AppInProgressError` → 409.
2. **not-found** — no config AND no state.
3. **group-app** — refuse on group containers/children with a structured
   reason: children never consult the container's config, so a container
   detach would report destruction that did not happen (security S11,
   *low/medium*). Attach has the same gap; recorded under debt #17.
4. **service-unavailable** — the *named* service's provisioner is null
   (postgres → dbProvisioner, redis → redisProvisioner — per-service, never
   generic; security S12) → 503.
5. **not provisioned** — two sub-cases:
   - postgres with `orphanDatabaseExists(name)` (quarantined
     `db-credentials.json`) → refusal **`credentials-missing`** — "nothing to
     detach" would be a lie about an app with a live database (security S12,
     *low/high*);
   - otherwise: **not a refusal.** Persist `'detached'` and return
     `{detached: true, deprovisioned: false}` — records intent against a
     manifest the owner does not control, and makes double-click idempotent
     (architecture A12). `setServiceIntent` returning null (no config) is the
     `no-app-config` refusal, enforced at the write site (A13).
6. **detach-limit** → **429 + retryAfter** (not 409 — the client's one useful
   fact is *when to retry*; architecture A21, *low/medium*):
   - **per-app cooldown**: `lastDetachAt` stored in `AppConfig` beside
     `services` (no new store, survives restarts, test-resettable for free —
     architecture A11 over the draft's in-memory map), env
     `DROP_DETACH_COOLDOWN_MINUTES` default 10;
   - **per-owner dump-byte budget** — NOT the draft's global ceiling, which was
     a cross-tenant DoS in the exact shape CLAUDE.md forbids (security S2 +
     architecture A3, both *high*): sum the sizes of `pre-delete/*.dump` files
     mapping to the owner's apps (flat `readdir` — no `measureTree`, no
     truncation fail-open; A15), refuse at `DROP_PREDELETE_MAX_MB` (default
     2048). Ownerless apps share one bucket — admin-only surface, recorded.
   - **retry exemption**: intent already `'detached'` && still provisioned
     skips the *cooldown* (repair is not abuse — architecture A10), never the
     byte budget.
   - Both new envs parse via one shared helper, invalid → default (fail
     closed); the same helper retrofits `DROP_PREDELETE_RETENTION_DAYS`, which
     today fails **open** to keep-forever (security S10, *medium/high*).
7. **manifest conflict** — not a refusal; `manifestConflict: true` in the
   result (owner-wins, sec #8, unchanged from the original plan).

Execution:

8. **Persist `'detached'` + `lastDetachAt`** via `setServiceIntent` (the
   converging-retry pivot).
9. **Stop, properly.** Liveness from the **runtime**
   (`runtime.getStatus`), not state status — `'errored'` and
   `'crash-looping'` apps hold live processes whose stale env and open
   connections are exactly what must die before a Redis number frees or a
   `DROP ... FORCE` fires (correctness C2, *high/high*). If live:
   `stopHealthProber` + `stopCrashLoopWatch`, `setAppStatus('stopped')`
   (honest state + tears down watches via the :2435 subscriber), then
   `runtime.stop` — the prober otherwise *restarts the app ~90s into a long
   dump* (architecture A2, *high/high*; correctness C4). `wasRunning` (by
   state, read before the stop) decides step 11 only.
10. **Deprovision.**
    - **postgres** — `backupAndDeleteAppDatabase`, extended not replaced
      (architecture A8: it has **two** production callers — apps.ts:757 AND
      `teardownApp` platform.ts:5664 — the draft's "sole caller" was wrong):
      *keep* `dropped` (= both succeeded) and *add* `databaseDropped`,
      `roleDropped`. New behaviour, all inside the provisioner:
      - `skipBackup` when `config.ephemeral` — mirrors `teardownApp`'s own
        choice; without it, N cheap ephemerals = N dumps of throwaway data
        (architecture A5, *medium-high/high*);
      - **cleanup arm**: registry entry exists but `databaseExists()` is false
        → skip the dump, drop the role, remove the entry — the arm that makes
        partial-detach retries converge (C1);
      - registry entry removed iff `databaseDropped` (regardless of
        `roleDropped`) — a credentials record pointing at a dropped database
        protects nothing and permanently burns a `checkDbQuota` slot
        (architecture A10; the surviving *role* is the tracked orphan);
      - `*.restore-role.sql` **unlinked when `roleDropped === false`** — with
        the role alive it is a live plaintext credential, not a restore
        artifact (security S3, *high/medium*);
      - `runPgDump` gains a timeout + `SIGKILL` + partial-file cleanup
        (`DROP_PG_DUMP_TIMEOUT_MS`, default 10min) — today it can await
        forever on a tenant-held `ACCESS EXCLUSIVE` lock, wedging
        `appsInProgress` for the app until a platform restart (security S1,
        *high/high*).
      - dump failure → nothing dropped, return `backup-failed`; intent stays
        `'detached'` (retry state), app restarted per step 11.
    - **redis** — `deprovisionAppRedis` modified: **keep the allocation when
      `FLUSHDB` fails** (return `{removed:false, flushed:false}`) — today it
      frees the number anyway, and two tolerated Redis blips hand one tenant's
      session keys to the next allocation (security S9, *medium/medium*).
      Retry converges when Redis is back. App already stopped → the freed
      number cannot be written by the old process (C3 from the original plan,
      now actually closed given step 9's runtime-liveness fix).
11. **Start iff `wasRunning`, via `doRestart` — never a hand-rolled
    `runtime.start(spec)`**: PM2 merges env on a bare start over an existing
    process entry, so the removed `DATABASE_URL` would *keep being injected*
    under `isolation: none` while docker behaves — an isolation-parity bug
    invisible in prod (architecture A1, *high/medium-high*). `doRestart`
    already does delete-then-start plus the state write and watch re-arming.
    `AppNeedsConfigError` → `restart: 'needs-config'` + `missingSecrets`,
    mapped like attach's :1129-1138 arm — never an opaque 500 after an
    irreversible drop (architecture A6, *medium-high/high*). Other failure →
    `restart: 'failed'`.
12. **Result**: `{detached, deprovisioned, databaseDropped?, roleDropped?,
    flushed?, backup?: {written, file}, manifestConflict?, restart}` where
    `backup.file` is the **basename only** — the draft's "dumpPath verbatim"
    reversed the delete route's own hardening (apps.ts:765-769 refuses to
    return `reason` precisely because it leaks host paths; security S4,
    *medium/high*). Full path and provider `reason` go to the server log and
    the ActivityLog detail. **This amends the original plan's "surface the
    provider's own result verbatim, including dumpPath" item** — the
    discriminated shape survives; the host path does not.
13. **Audit**: ActivityLog on success and both failure arms. **Refusals go to
    the platform logger, never the ActivityLog ring** — the ring holds 500
    entries and cheap repeatable refusals at 20/min would let one tenant evict
    every security-relevant entry in ~25 minutes (security S5, *medium/high*).
    Applied to attach refusals too (same change, ~3 lines), which closes the
    asymmetry architecture A22 objected to and **resolves debt #15 by
    decision**: refusals are observable in logs, deliberately not in the ring.

## Folded debt #11 — AppConfig setter split (own plan item, own commit)

- `setServiceIntent(appName, serviceId, intent, extras?)` — reads the current
  config **inside the write chain** (`enqueueWrite` semantics verified:
  app-config.ts:369-382 invokes the op at execution time), merges one key,
  **`updateConfig` semantics**: returns null when no config exists, so the
  skeleton-config/boot-corruption hazard is enforced where the write happens,
  not re-derived per caller (architecture A13, *medium/medium*). Also carries
  `lastDetachAt`. `attachService` :5556-5558 switches to it — its snapshot
  spread is unreachable today (single writer + sync busy-guard; correctness
  verified-clean #5) but becomes a real lost-update the moment detach lands.
- `upsertConfig`/`updateConfig` parameter types narrow to
  `Partial<Omit<AppConfig, SystemConfigField>>` **and the system keys are
  stripped at runtime** — the type narrowing alone is defeated by any cast or
  non-literal object (excess-property checks fire only on fresh literals;
  architecture A7 *medium/high* + security S13 *low/high*). The runtime strip
  is the guarantee; the types are documentation.
- `upsertSystemConfig` — the unstripped writer; migrated callers:
  upload-deploy.ts:176, git-deploy.ts:~223-234, capabilities route
  apps.ts:1184, plus test fixtures.
- `SYSTEM_CONFIG_FIELDS`: `services`, `grantedApiScopes`, `agentCreated`,
  `ephemeral`, `ephemeralPrincipalId`, `expiresAt`, `lastDetachAt` (verify the
  member list against the type at implementation).

## Folded debt #19a — intent-aware secrets gate

secrets.ts:114 refuses `DATABASE_URL` iff `isProvisioned(name) && intent !==
'detached'`. Intent is read via a new **`PlatformOps.getServiceIntent`** — not
a fresh `getAppConfigService()` read in the route — so the precedence rule has
one authority; this also gives debt #10's prescribed seam its second caller
(architecture A20, *low/medium*). The gate's comment block is rewritten: its
current "safe by construction — both read the same map" argument is dissolved
by partial detach, and the new invariant (every DSN-injecting site checks
intent) is pinned by tests on all injection sites in the state
`intent === 'detached' && isProvisioned() === true` (security S6,
*medium/high*).

## Debt #13 — closed here, no longer optional

`GET /db/:name` computes `redis`/`services`/`quota` inside the Postgres `try`,
and `app-db-inspector` maps a dropped database to `DbUnavailableError`
(3D000 → `database-missing`) → the route 503s → `DatabaseTab` replaces the
whole tab with a dead error card. **The partial-detach state this plan designs
for is therefore a state the UI cannot render** — no Detach button, no retry,
the honest message unreachable (correctness C3, *medium/high*). Fix: move the
Phase-2 fields out of the `try`; map `database-missing` to a renderable
payload (`provisioned: false` + a `broken` marker) instead of a 503.

## API, dashboard, limits

- **Route**: `DELETE /apps/:name/services/:id` in apps.ts after attach — same
  allowlist + `canAccess`; status map: thrown busy → 409, refusals → 409,
  `detach-limit` → 429 + `Retry-After`, `service-unavailable` → 503,
  `needs-config` restart arm → 409 with attach's message shape.
- **server.ts**: `/apps/*/services/*` gets its **own** rate bucket — sharing
  the 20/min `/db/*` bucket means detach traffic 429s the database panel for
  the same client mid-incident, the exact failure that bucket's comment says
  it exists to prevent (security S15, *low/high*). Existing method-scoped auth
  covers DELETE at `user` (server.ts:349-356); no new auth line. Both pinned
  by a behavioural test (retires debt #18's ask for this route pair).
- **apps.delete route**: gains `pruneOwnerDumpsToFit` (oldest-own-dumps) before
  its dump rather than a refusal — deletes must never be blocked by the
  budget, but unmetered they reproduce the full amplification through
  create→attach→delete loops (security S2c + correctness C7, confirmed against
  apps.ts:757).
- **Dashboard**: `attach-state.ts` gains a third state —
  `provisioned && intent === 'detached'` → `detachIncomplete`, label "Retry
  detach" — the current derivation from `provisioned` alone would show
  **"Attached"** after a partial detach, hiding the only repair affordance and
  contradicting the plan's own open question 2 (architecture A9,
  *medium/high*); pinned in `attach-state.test.ts`. DatabaseTab: Detach button
  (role ≠ readonly), per-service danger confirm — postgres names the backup
  directory ("a compressed dump is written under the platform backup directory
  first"; the basename appears in the result), **ephemeral postgres says "no
  backup is written"**, redis says "data is flushed immediately; there is NO
  backup". In-flight guard generalised to one `pendingAction` slot. `api.ts`
  client function.

## File-level changes

- [x] Shared env-int parse helper (invalid → default, fail closed); retrofit
      `DROP_PREDELETE_RETENTION_DAYS`.
- [x] `src/managers/database/pg-dump.ts` — timeout + SIGKILL + partial cleanup.
- [x] `src/managers/database/database-provisioner.ts` + tests — extended return
      (add `databaseDropped`/`roleDropped`, keep `dropped`), ephemeral
      `skipBackup`, cleanup arm, entry-removal-iff-databaseDropped,
      restore-role.sql unlink on failed role drop.
- [x] `src/managers/redis/redis-provisioner.ts` + tests — retain allocation on
      flush failure.
- [x] `src/managers/guardrail/detach-limits.ts` + tests — pure cooldown check,
      per-owner dump-byte budget (flat readdir), `pruneOwnerDumpsToFit`.
- [x] `src/managers/app/app-config.ts` + tests — **#11 item, own commit**:
      `setServiceIntent`, narrowed+stripped `upsertConfig`/`updateConfig`,
      `upsertSystemConfig`.
- [x] `src/core/upload-deploy.ts`, `src/core/git-deploy/`, apps.ts capabilities
      route — migrate to `upsertSystemConfig` (mechanical, same commit as #11).
- [x] `src/core/platform.ts` + tests — `detachService` (guards 1-7, execution
      8-13), attach switched to `setServiceIntent`, attach refusal audit moved
      to logger; guard-ordering test suite mirroring attach's; isolation-parity
      test asserting the restarted spec carries no `DATABASE_URL`/`REDIS_URL`
      under **both** runtimes.
- [x] `src/api/platform-ops.ts` — `detachService`, `getServiceIntent`,
      `DetachServiceResult`.
- [x] `src/api/routes/apps.ts` + route tests — DELETE route, status map, audit;
      delete route's `pruneOwnerDumpsToFit`.
- [x] `src/api/routes/secrets.ts` + tests — #19a gate + comment rewrite +
      injection-site pin tests.
- [x] `src/api/routes/db.ts` + tests — #13: fields out of the try,
      `database-missing` renderable.
- [x] `src/api/server.ts` + behavioural 429 test — dedicated services bucket.
- [x] `src/dashboard/src/lib/attach-state.ts` + test — third card state.
- [x] `src/dashboard/src/components/DatabaseTab.tsx`, `src/dashboard/src/lib/api.ts`
      — detach UI (no component test possible — logic stays in the pure `.ts`
      sibling; Gate 4 covers behaviour).

## Risks & open questions — Phase 3

20. **Two original plan lines amended** (persist-after-success → persist-first;
    verbatim dumpPath → basename): both amendments were demanded by this
    panel's high findings and are recorded above with their reasons.
21. **Ownerless apps and group children share one budget/lock-free bucket** —
    admin-only surface today; acceptable, recorded (security S11/S1 context).
22. **`doRestart`'s capacity guard** can refuse the post-detach start on a
    `DROP_MAX_CONCURRENT_APPS`-capped box (default 0 = disabled), stranding the
    app stopped after a successful detach (architecture A18, *low/medium*).
    Accepted: the `restart:'failed'` arm reports it; a hint-flag is not worth
    the plumbing for a non-default config.
23. **NEW DEBT — hot-reload env staleness**: platform.ts:5075-5101
    (`stop`+`start`, no delete) and :5303-5312 (`delete` because "start is a
    merge") assert contradictory things about PM2; whichever is wrong means a
    revoked secret survives a hot-reload today, independent of detach
    (architecture A19, *low/medium*). The parity test added here covers the
    detach path only; the hot-reload path needs its own fix.
24. **The secrets gate now reads a file tenant code can write under
    `isolation: 'none'`** — `data/appconf/` is owned by the `drop` user, so an
    app writing `services: {postgres: 'detached'}` into its own config unlocks
    the DATABASE_URL secret path. Blast radius under `none` isolation is
    already unbounded (drop ≈ root-equivalent there); recorded, not mitigated
    (security S14, *low/medium*).
25. **Cooldown records at intent-persist time; the `backup-failed` arm retries
    cooldown-exempt** (intent already `'detached'`). A repeatedly-failing dump
    therefore costs pg_dump streams bounded only by the route rate limit and
    the byte budget (failed dumps commit no bytes) — accepted; the timeout
    (S1) bounds each attempt (correctness C6 residue).

**Debt ledger after Phase 3**: #11 closed, #13 closed, #15 resolved by
decision, #19 closed; #10 **half-closed** (`getServiceIntent` gives PlatformOps
the seam; the quota-accessor half — `serviceQuotaState` + `runtime-config`
plumbing deletion — still open); #12, #14 (attach side), #16 (pre-existing
envs), #17 (now covering both attach and detach on group apps), #18
(half-retired: the services-bucket test lands here; other buckets still
untested) remain. Plus new #23/#24 above.

## Agent critiques considered — Phase 3 plan stage

Separate corpus from the Phase 1/2 sections. Panel: `security-critic` (15
findings), `architecture-critic` (22), plus a correctness/edge-case auditor
(`general-purpose`, read-only, 7 findings + 8 mandatory scenarios verified
clean with file:line evidence). **44 findings: 0 critical, 9 high, 20
medium(-high), 15 low. Every finding actioned or recorded; 0 dropped.**
Severities quoted verbatim; none re-graded.

**Actioned — high** (all nine): S1 pg_dump timeout/lock-poisoning
(*high/high*); S2 guardrail keyed backwards — per-owner budget + AppConfig
cooldown + delete-route metering (*high/high*); S3 restore-role.sql live
credential (*high/medium*); C1 partial-detach permanent wedge → cleanup arm
(*high/high*); C2 runtime-liveness stop (*high/high*); A1 doRestart-not-start,
PM2 env merge (*high/medium-high*); A2 prober resurrection mid-dump
(*high/high*); A3 global ceiling is cross-tenant DoS (*high/medium*); A4 owner
lock unnecessary for detach (*high/medium-high*).

**Actioned — medium/low**, compressed: S4 basename-not-path; S5 refusals off
the ring; S6 gate-invariant tests; S8+A8 extend-don't-replace return shape
(the draft's "sole caller" fact was **wrong** — `teardownApp` is the second);
S9 Redis tombstone-on-flush-failure; S10 retention fail-open; S11 group
refusal; S12 per-service provisioner + `credentials-missing`; S13+A7 runtime
strip; S15 dedicated bucket; C3 #13 load-bearing; C4 stop recipe; C5+A12
persist-first; C6 cooldown timing; C7+S2c delete-route metering; A5 ephemeral
skipBackup; A6 needs-config arm; A9 third card state; A10 entry
removal + retry exemption; A11 cooldown in AppConfig; A13 setServiceIntent
null-refusal; A15 shared env parse; A16 #19b restated; A17 state write before
stop; A20 getServiceIntent on PlatformOps; A21 429+Retry-After.

**Partly rejected — recorded**

- **S7 (*medium/high*): "re-attach after partial detach hands the app a DSN
  for a dropped database with no path back".** The scenario half is
  **rejected on traced evidence**: `provisionAppDatabase` short-circuits to
  existing credentials only when `existing && dbAlreadyExists`
  (database-provisioner.ts:134-139); with the database dropped it takes the
  fresh-provision path and `ALTER USER`s the surviving role — re-attach
  self-heals (correctness verified-clean 1b, two critics disagreeing and the
  one who traced the code winning). The quota half is actioned (entry removal
  on `databaseDropped`).
- **S2a's fix as specified** ("persist the cooldown per principal in a
  principal-quota-shaped store"): the *finding* (per-app in-memory keying is
  bypassable) is actioned, but via A11's shape — per-app `lastDetachAt` in
  `AppConfig` + the per-owner **byte budget** as the loop bound. A
  per-principal detach *count* adds a store without adding a bound the byte
  budget doesn't already impose.
- **A14 (*medium/medium*): "carry the setter split as its own change"** —
  partly rejected: the user explicitly scoped #11 into Phase 3. Its substance
  is honoured — the split is its own plan item and own commit, and the
  runtime-strip shape cuts the caller migration to three sites.

**Disagreements resolved**

- **S5 vs A22** (audit refusals: never-in-ring vs symmetric-in-ring): sided
  with security — the ring is evictable by design; symmetry restored by
  logging both operations' refusals to the platform logger. Debt #15 closes by
  decision rather than by ring-writes.
- **A4 vs S1** (fix the lock vs drop the lock): dropping the lock for detach
  satisfies both — S1's timeout is actioned independently because
  `appsInProgress` alone can still wedge one app on a hung dump.
- **A11 vs S2** (where cooldown state lives): AppConfig, because it survives
  restarts *and* deletes no abuse margin the byte budget doesn't hold.

**Dropped without individual reasons:** none — `findings_plan_dropped: 0` for
this stage. Two draft "verified facts" corrected by the panel: the sole-caller
claim (A8) and `wasRunning`-by-state (C2).

## Agent critiques considered — Phase 3 diff stage

Separate corpus from the plan-stage panel. Panel: `security-critic` (13
findings) and `architecture-critic` (17) on the real diff. The `/code-review`
correctness pass died on a session limit mid-fan-out and was re-run against the
fixed tree instead — recorded here rather than quietly omitted.

### Phase 3 · pass 1 (whole diff)

**Actioned — blocking**

- **The destructive span has no `try`/`finally`** (architecture, *critical/high*;
  security #1, *high/high* — both found it independently). Steps 9-11 stop the
  app, then deprovision, and `restartAfterDetach` is reached only through the
  `return` arms. This diff *added* the first throw path into that span: the
  cleanup arm's `databaseExists` probe is the one call in
  `backupAndDeleteAppDatabase` not wrapped, so a Postgres blip mid-detach leaves
  a previously-running app stopped indefinitely, 500 to the caller, no audit
  entry, intent already flipped. Pre-diff every failure was a returned result,
  which is exactly why no test caught it: 33 detach tests, none makes the
  deprovisioner throw. **Actioned**: single restart site covering return *and*
  throw; probe wrapped so a failed probe is never read as "the database is
  gone".
- **The Redis tombstone burns a logical DB number permanently**
  (architecture, *high/high*; security #7, *medium/medium*). My own follow-up
  commission caused this: retaining the *allocation* on a failed FLUSHDB is
  right for detach, which retries, and wrong for delete, where the app is gone
  a moment later. All three candidate reclaim paths were checked and none
  applies to a deleted app; `nextFreeDb` then treats the number as in use
  forever, and 15 tolerated blips disable managed Redis platform-wide for every
  tenant. The cure/disease ratio decided it: the key-leak it closed needed
  *two* independent flush failures (assignment already re-flushes), the
  permanent burn needs one. **Actioned**: tombstone moved from the allocation to
  the DB *number* — the allocation frees as before, the number stays flagged,
  and the existing flush-before-handout turns fail-hard for flagged numbers
  only. Same safety property, no leak.

**Actioned — one root cause behind three findings**

Dump ownership was re-derived from the live app list via
`dbNameForApp(app.name)` prefixes. That single choice produced:
*evadable metering* (security #3, *medium/high*; architecture, *medium/high*) —
a `create → attach → fill → delete` loop with a fresh name each iteration
writes dumps attributable to nobody, so the byte budget that plan risk 25
explicitly leans on does not bound the loop it was accepted against;
*cross-app eviction* (security #5, *medium/high*) — the delete-path prune sorts
**all** of an owner's dumps oldest-first, so deleting app A destroys app B's
only surviving pre-drop dump, breaking the invariant
`prunePreDeleteBackups`'s own doc states; and *collision* (security #8,
*medium/medium*) — `sanitizeName` is lossy and prefixes are built from app
names with no requirement the app ever had a database, so a tenant can register
a name that sanitizes onto a victim's database name and have their own delete
prune the victim's dumps. **Actioned** with one structural change rather than
three patches: dumps move into per-owner subdirectories, so attribution is a
property of where the file *is* rather than a guess re-derived from mutable
state — and it survives the app's deletion, which is the case all three
findings turn on.

**Actioned — the rest**

- **Raw `err.message` to a `user`-role tenant** on the detach 500 (security #2,
  *medium/high*) — pg errors embed the socket path under `dropRoot`, fs errors
  the pre-delete path. Reverses this same change's own basename hardening, and
  the delete route two hundred lines away already refuses to return
  `outcome.reason` for that reason.
- **Ephemeral deletes write a full dump with metering disabled** (security #4,
  *medium/high*) — the new comment says the prune is skipped because the dump is
  skipped too, and the call passes no `skipBackup`. The comment was true of the
  intent and false of the code, on the highest-volume app class.
- **Restart decision disagreed with the stop decision, then misreported it**
  (architecture, *medium-high/high*). Stop keys on runtime liveness, restart on
  state status, so an `errored`-but-live app is stopped and never restarted —
  and the result says `not-restarted`, which the dashboard renders as "the app
  was not running", about an app DROP had just killed. "My database is broken,
  let me detach it" is the archetypal call. **Actioned**: one liveness
  authority.
- **Confirm dialog promises a backup ephemeral apps never get** (security #9,
  *low/high*; architecture, *medium/high*) — consent to the platform's only
  irreversible action, on a false premise, and the UI had no `ephemeral` field
  to tell the truth with. The plan had specified this copy; it was not built.
- Route discarded `restart`/`missingSecrets` on the failure arms — the arms
  where durable state changed (architecture, *medium/high*). `lstat` over
  `stat` in the budget walk (security #12, *low/low*). Redis "no allocation"
  vs "flush failed" collapsed into one retriable-looking refusal (security #13,
  *low/medium*). Budget charged before a dump that will be skipped
  (architecture, *low/high*). `db.ts` phase-2 fields could now 500 on an
  uninitialised config service (architecture, *low/medium*). `manifestConflict`
  and `broken` plumbed across four layers with no reader (architecture, two
  *low/high*). Client/server wire-type drift — `backup.file` optional one side,
  required the other, the second such drift after the restart union
  (architecture, *low/high*). `SERVICES_CONFIG` duplicated literals
  (architecture, *low/medium*). No authz regression pin on the new irreversible
  route (security #10, *low/high*).

**Recorded, not actioned**

- **No free-space check before an unbounded dump** (security #6,
  *medium/medium*). The byte budget gates accumulated bytes, never the incoming
  dump, and the pre-delete tree shares a filesystem with the Postgres data
  directory and platform state. Real, and now self-service rather than
  operator-initiated. Deferred as new debt #26 rather than fixed here: a
  correct fix needs a free-space/`pg_database_size` probe and a refusal policy
  of its own, and bolting it onto this diff would ship an untested guess at the
  threshold.
- **Delete-path role orphans are invisible** (architecture, *low-medium/high*).
  Entry removal now keys on `databaseDropped`, so a delete whose role drop
  fails leaves a live role with a live password and no registry record, and —
  unlike detach — no retry path, because the app is gone. The compensating
  `restore-role.sql` unlink is in and does reduce exposure. New debt #27: the
  fix is an `orphanedRoles` list swept at boot, which is its own change.
- **Four config writers plus `setServiceIntent`** (architecture, *medium/high*).
  The (upsert|update) × (stripped|unstripped) matrix is orthogonal in two axes
  and will be re-reasoned by every future caller. Correct, and it is a Gate 5
  concern rather than a defect — deferred to the simplify gate in this same
  change, not to a later one.
- **`stripSystemFields` warns rather than throws** (architecture,
  *medium/medium-high*). Verified clean today — all eleven call sites pass fresh
  literals, so the excess-property check does fire — but a `console.warn` in a
  long-lived server is not a signal anyone reads. New debt #28; the argument for
  throwing (a system field at a general-purpose writer is a programming error,
  never a runtime condition) is recorded with it.
- **Cooldown-exempt retries fan out concurrently across an owner's apps**
  (architecture, *low/medium*) — `appsInProgress` serialises per app, not per
  owner, so N failing dumps run at once against the shared bundled Postgres.
  Plan risk 25 accepted the retry rate but not this dimension; amended there.
- **Detach is anonymous on an auth-disabled box** (security #11, *low/high*) —
  identical posture to `DELETE /apps/:name`, so consistent rather than novel,
  but worth stating: `db.ts` deliberately gates *reads* in that mode while data
  destruction stays open. Recorded, unchanged.

**Dropped without individual reasons:** none.

### Phase 3 · pass 2 (correctness, against the fixed tree)

The `/code-review` correctness pass died on a session limit mid-fan-out, so it
was replaced by a dedicated correctness/edge-case reviewer run against the
*fixed* tree — better ordering as it turned out, because **the two highest
findings were defects introduced by the fix round itself**, which a review of
the original diff could not have seen.

- **The byte budget bounded nothing** (*high/high*). `detachService` measured
  `pre-delete/<owner>/` but called `backupAndDeleteAppDatabase` without
  `ownerUserId`, so every detach dump landed in `_ownerless` while the gate read
  a perpetually empty directory — the amplification loop wide open again, owned
  dumps polluting the admin bucket, and the delete-route prune unable to reach
  them. Two tests **pinned the bug** by asserting the argument's absence. Root
  cause worth naming: the parameter was made *optional* so two parallel agents
  would keep compiling, and that optionality is exactly what hid the defect.
  Fixed, and `ownerUserId` is now required so a future caller cannot repeat it.
- **The try/catch opened one step too late** (*high/high*). The critical Gate-2
  fix wrapped the deprovision but not step 9's stop, and `ContainerManager.stop`
  rethrows any non-not-found error — so on docker isolation (production) a
  daemon hiccup still stranded an app with intent flipped, database intact,
  watches disarmed and no restart. The same end state, relocated one step.
- **A failed Redis flush was reported as a refusal** (*medium/high*) although the
  allocation was freed, the number tombstoned and the app restarted without
  `REDIS_URL` — a success. The 409 told the owner "nothing was removed, retry",
  and the retry then said "nothing was provisioned to remove". The `flush-failed`
  refusal arm was deleted; `deprovision-failed` now covers genuine throws only.
- Also actioned: the not-provisioned early return hard-coded `not-restarted` and
  the UI rendered "the app was not running" about a running app (new
  `not-needed` arm); the `database-missing` card named two affordances it then
  hid, because `canDetach` keyed on `provisioned` (*medium/high* — debt #13's
  dead end in a new shape); `nextFreeDb` preferred the tombstoned number, so a
  Redis outage failed provisions on db 1 while 14 clean numbers sat unused; the
  **attach** route still leaked raw `err.message` one function above the detach
  catch that had just been hardened, and the tombstone added a new throw path
  into it; `attachService` ignored `setServiceIntent`'s null return on the
  strength of a comment describing a race as an invariant; one per-app
  `lastDetachAt` let a Postgres detach 429 a Redis detach with a message naming
  neither service (now per-service).

**Verified clean** (traced with evidence, not assumed): `appsInProgress` releases
on every path and the single restart site cannot double-restart; tombstone
persistence and reload reconciliation; the prune's one-level walk cannot follow a
symlinked subdirectory or delete a directory, and its prefix match cannot
under/over-match (`foo` vs `foo_bar`); every union arm is mapped end to end; no
request-derived data reaches a system config field; and the secrets gate cannot
disagree with the injection path, because all four intent read sites were
checked individually.

### Gate 5 — simplify

Four cleanup reviewers (reuse, simplification, efficiency, altitude). The
readability finding that mattered most: **48 references to unresolvable review
IDs** — `FIX X5`, `Gate-2 finding #2`, `debt #13`, `security S15`, `A21` — had
accumulated across ten production files and even into test titles, pointing at
planning documents that are gitignored and absent from the repo. Every one of
those comments already stated the fact its label stood for, so the labels were
stripped and the prose kept. That is Gate 5's bar exactly: a reader who does not
have this plan file must still be able to follow the code.

Structural cleanups applied: the pre-delete dump layout was being constructed
**four** ways (provisioner from `this.dropRoot`, platform from `config.dropRoot`,
the delete route by string-surgery on `path.dirname(getTempDirectory())`, and
`detach-limits` re-listing the artifact suffixes) — three reviewers converged on
it independently, and it is the same multi-writer shape whose divergence caused
the `_ownerless` bug above; now one owner (`preDeleteRootDir`/`ownerDumpDir`).
The budget also **undercounted**, charging only `.dump` while the retention sweep
knew about `.restore-role.sql` and `.dump.partial` — a fail-closed gate must not
undercount, so both scanners now share one artifact predicate. The third
hand-copy of the detach wire contract inside `platform.ts` (kept compiling by an
`as` cast that would have absorbed any drift) was replaced by a zero-import leaf
types module the dashboard imports directly, retiring a mirror that had already
drifted twice. Sixteen refusal sites now route through a helper that returns what
it logs, so a refusal cannot be returned unlogged. The four-writer
`(upsert|update) × (stripped|unstripped)` matrix collapsed to one private
`write()`. One genuine defect surfaced and was fixed: attach and detach refusals
lived in separate maps rendered with `??`, so a detach refusal following an
attach refusal on the same service was masked by the stale attach banner.

**Recorded, not applied** (new debt): **#26** no free-space check before an
unbounded dump; **#27** delete-path role orphans are invisible with no retry path
once the app is gone; **#28** `stripSystemFields` warns rather than throws;
**#29** `getOverview` still throws `database-missing` and the route rewrites it
into a success payload — it should return that state (touches
`app-db-inspector.ts`, outside this diff); **#30** the four intent read sites
should collapse into one filter in `buildStartSpec`, which would make the
invariant structural rather than a conjunction of four deletable guards (behaviour
change on monorepo/hot-reload paths — needs its own parity tests); **#31** four
pre-existing guardrail env parses still bypass `parsePositiveIntEnv` (migrating
them changes behaviour on malformed input); **#32** the retention sweep now walks
every tenant's dump directory serially on a user-facing request — it wants a
boot/idle sweep instead. Also noted honestly: one of the three assertions in the
wire-contract pin became tautological once the dashboard imported the shared
union, and `DetachServiceSuccess` is still hand-mirrored deliberately.

## Run stats — Phase 3 (detach)

Separate run from the Phase 1 block above, on the same plan file. The number
worth reading is `escaped: 2`, and the more useful fact behind it: **the two
highest-severity findings of the whole run were introduced by the fix round for
the previous review**, not by the original implementation. Reviewing the *fixed*
tree rather than the original diff is what caught them, and that only happened
because the correctness pass died on a session limit and had to be re-run later.

```yaml
date: 2026-08-21
slug: extension-catalog
gear: full
effort_plan: high
effort_diff: high
findings_plan_actioned: 41
findings_plan_rejected: 3
findings_plan_dropped: 0
findings_diff_actioned: 59
findings_diff_rejected: 13
findings_diff_dropped: 0
escaped: 2
agents_spawned: 37
gates_failed_first_pass: 3
escalated_from: none
```

Counting notes, so the numbers are reproducible rather than tidy:

- **Plan stage** = the three critics on the draft plan (security 15,
  architecture 22, correctness 7 + 8 scenarios verified clean). The 3 rejections
  are the ones recorded with written reasons above.
- **Diff stage** folds together Gate 2 (security 13 + architecture 17, then a
  second correctness pass of 10 against the fixed tree) and Gate 5's four
  cleanup reviewers. Rejections are the "recorded, not actioned" items — new
  debt #26-#32 — each with its reason.
- **`escaped: 2`.** (1) A cross-slice contract drift: the dashboard's restart
  union said `'ok'` where the server said `'restarted'`. Both plan critics saw
  only a plan, and the code was split across five agents, so nothing but the
  conformance walk could have caught it — I did, at Gate 1. (2) The attach and
  detach refusal maps rendered with `??` while detach cleared only its own, so a
  detach refusal following an attach refusal on the same service was masked by
  the stale attach banner. That survived all three Gate 2 reviewers and was
  found by a Gate 5 cleanup reviewer looking at duplicated state, not at
  correctness.
- **`gates_failed_first_pass: 3`** — Gate 1 (the union drift), Gate 2 (two full
  fix rounds), Gate 5 (cleanups applied, including the escape above). Gates 3
  and 4 passed first time: the dedicated test pass found no product bug, and
  runtime verification passed 5/5 against a real PostgreSQL 16 with no defects.
- **`agents_spawned: 37`** includes 6 finder agents from a `/code-review`
  invocation that died on a session limit and produced nothing usable, plus
  three resumed agents (resumes are not counted as new spawns).

### What this run should change about the next one

- **An optional parameter added to keep parallel agents compiling is a defect
  waiting to happen.** `ownerUserId` was made optional so two agents editing
  different files would both typecheck; the default silently mis-attributed
  every detach dump and defeated the byte budget, and two tests pinned the bug
  by asserting the argument's absence. Prefer a required parameter and a brief
  moment of red.
- **Verify the fixed tree, not just the original diff.** Both high findings in
  the second pass were introduced by the first pass's fixes.
- **Runtime verification earned its place on the irreversible path.** The unit
  suite proved a dump file appeared; only `pg_restore` proved the dump contained
  the tenant's rows as they were *before* the drop.
