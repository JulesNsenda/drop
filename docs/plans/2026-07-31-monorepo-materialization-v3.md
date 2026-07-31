# Plan: monorepo materialization, v3 (DROP-122 step 4)

**Date:** 2026-07-31 · **Branch:** `fix/DROP-127-materialization-v3` (from `develop`)
**Status:** DRAFT — **awaiting approval.**
**History:** v1 rejected by a 3-critic panel; **v2 built, then rejected at Gate 2**.
Both write-ups are in `2026-07-30-monorepo-safe-materialization.md`. This is not
a patch on v2 — it is v2's five preconditions, four of which are now met.

## Precondition status

| # | Precondition (from the Gate 2 rejection) | Status |
|---|---|---|
| 1 | `execCommand` parity between the two build paths | **DONE** — DROP-123, `buildExecCommandFor` |
| 2 | The prune, shared with `UploadDeployService` | **DONE** — `syncTree`, PR #159 |
| 3 | `updateApp` not `registerApp` for an existing child | **this plan** |
| 4 | A decision on stale `dist` vs `preBuild` ordering | **this plan — decided below** |
| 5 | Stopped-child check above the `fs.cp` | **this plan** |

## The bug, unchanged

`expandMonorepo` materializes each child with `fs.rm(childPath)` +
`fs.cp(srcDir, childPath)` while the child is **still running**. It destroys
`node_modules` and the build output, so the docroot sits empty for the whole
install + build. A docker static child's nginx returns **500** throughout —
what `ezsign-frontend` did. It becomes permanent on any of four early returns
in `handleBuildApp`.

## The change — five edits, all inside `expandMonorepo`'s per-service loop

1. **Skip a `stopped` child before anything is written.** `handleAppUpdate`
   already refuses a user-stopped app (`platform.ts:4439`) — but it does so
   *after* the copy, so v2 refreshed a stopped child's source and skipped its
   build, leaving a later `drop start` serving new, unbuilt source. The check
   belongs above the copy.
2. **Replace `fs.rm` + `fs.cp` with `syncTree`** (see the `exclude` option
   below): the source lands in place, stale files are pruned, and nothing
   deletes the tree wholesale.
3. **`preserve: ['node_modules']`** — the child keeps its installed deps, so a
   re-expansion no longer forces a from-scratch install with the docroot empty.
   This is where the outage actually goes away.
4. **Route an EXISTING child through `handleAppUpdate`** with
   `bypassCooldown: true`; a **first-ever** child (no state entry) still goes
   through `handleBuildApp`, because there is nothing to keep serving.
5. **`updateApp` instead of `registerApp` for an existing child** — the v2
   killer. `registerApp` forces `status` back to `pending`
   (`state-manager.ts:265`), so `handleAppUpdate`'s `wasRunning`
   (`platform.ts:4450`) was always false and **both halves of the transaction
   inverted**: on success the stop at `:4629` was skipped and
   `ProcessManager.start` early-returned on `online` (new build on disk, old
   code serving, deploy green); on failure the child was marked `errored` at
   `:4598` while its old process was still alive.

`appsInProgress` keeps holding **the container only**. The child is never
added — that was v2's critical finding, made independently by all three
critics — and the code will carry a comment saying so.

## `syncTree` needs a source-side `exclude` (noted when #159 landed)

`preserve` is a *destination*-side exemption; `expandMonorepo` needs a
*source*-side filter, which `syncTree` does not have. Without it the
container's `node_modules` and `.git` would be copied into every child.

Add `exclude?: RegExp` (matched against the absolute source path, exactly as
today's `fs.cp` filter uses `MONOREPO_COPY_EXCLUDE_RE`), applied in the copy
half only.

## Decision on stale `dist` (precondition 4)

**Delete it, via the prune. Do not preserve it, and do not touch
`StaticBuildStrategy.preBuild` in this change.**

`dist`/`build` are in the source-side exclude, so they are absent from the
filtered source and the prune removes them from the child — reproducing
exactly what the `fs.rm` did for rebuild purposes. That matters because
`preBuild` (`static.ts:68`) resolves a surviving `dist/index.html` as "already
built" *before* checking for a source SPA and leaves `buildCommand` unset, so
a preserved `dist` means the child **never rebuilds again** and `validate()`
passes against the stale bundle. That is the trap that killed v2, and the same
one `DEFAULT_PRESERVE` documents on the upload path.

Reordering `preBuild` to check `isSourceSpa` first would allow preserving
`dist`, and is the better end state — but it changes behaviour for **every
static app on the platform** (an app with a committed `dist` *and* a build
script would start rebuilding instead of serving what it shipped). That is its
own change with its own blast radius, named as a follow-up, not smuggled in
here.

### What this does and does not buy — stated plainly

**Eliminated:** the install-duration outage (`node_modules` survives), the
wholesale tree deletion, permanent breakage on `handleBuildApp`'s early
returns, and the loss of rollback-on-failure.

**Not eliminated:** a static child is still unserved during **its own build**,
because the prune removes `dist` before the build regenerates it. That window
is **platform-wide** — every static app already has it on every redeploy — and
this change makes a monorepo child exactly as safe as any other app, no safer.
Closing it needs staging or an output-dir swap and belongs to the static path.

**So: this reduces the ezsign 500 from "the whole install + build, permanent
on four failure paths" to "the child's own build, self-healing" — it does not
take it to zero.** Anyone expecting zero downtime from this change will be
disappointed, which is why it is written here rather than discovered.

## Re-entrancy — resolved by reading, to be confirmed at runtime

The v2 plan flagged this as "prove at Gate 4 rather than by reading". Read:

- `appsInProgress` holds the **container's** name (`platform.ts:4368`), so the
  child's own check at `:4320` does not match. Child not blocked.
- The grouped-child refusal at `:4403` fires only when `!bypassCooldown`, and
  the call passes `true`. Child not refused.
- `handleAppUpdate` re-parses the child's `drop.yaml`; the generated child
  config has no `services:`, so it does not take the container branch.

Still to be **observed**, not just read, on a real group.

## Tests

- an existing, running child goes through `handleAppUpdate`, not `handleBuildApp`
- a **first-ever** child still goes through `handleBuildApp`
- an existing child's state `status: 'running'` **survives** materialization
  (the direct regression test for the v2 killer — assert `wasRunning` is
  honoured, not just that `updateApp` was called)
- a failed rebuild leaves the child `running` on its old version, not `errored`
- `node_modules` survives a re-expansion; `dist` does **not**
- a re-expansion whose source changed produces changed build output — proves
  the build actually re-ran, the inverse of v1's mistaken assertion
- a file deleted from the source subtree is removed from the child
- a user-`stopped` child is neither copied over nor built
- the container's `node_modules`/`.git` are not copied into any child
- a standalone app's path is unchanged

Every guard mutation-verified; any test that passes with its guard neutered
gets rewritten (two did in PR #158).

## Risks

1. **Runtime-unverified until a real group redeploys.** Windows cannot
   exercise this; it needs a Linux host with a monorepo. The suite covers the
   decisions, not the integration.
2. **Orphaned services** — a service deleted from `services:` still leaves a
   child running forever. Pre-existing, out of scope, named so it is not
   mistaken for covered.
3. ~~`MONOREPO_COPY_EXCLUDE_RE` matches the **absolute** source path, so a
   service at `packages/build` makes the filter reject the copy root and copy
   nothing. Pre-existing (follow-up 5 of the original plan); this change
   inherits it unchanged by passing the same regex.~~

   **Fixed instead, during implementation.** Keeping it would have meant
   writing new code that knowingly copies nothing for a service under a
   `build/` path. `syncTree`'s `exclude` matches the path **relative to the
   sync root**, so the root is never tested against the filter and only real
   nested `node_modules`/`.git`/`dist`/`build` segments are skipped. Covered
   by a test, and mutation-verified against the old absolute matching.

## Follow-ups this plan deliberately does NOT do

1. `preBuild` ordering / the platform-wide static build window.
2. The `MONOREPO_COPY_EXCLUDE_RE` absolute-path quirk (risk 3).
3. Orphaned-service reconciliation.
4. Skipping unchanged services entirely (source hash + secret fingerprint +
   runtime-spec revision, per DROP-068's rule that rebuild is the only apply
   path for secret revocation).
