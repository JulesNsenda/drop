# Plan: stop monorepo expansion from deleting a child it is still serving

**Date:** 2026-07-30 · **Branch:** `fix/DROP-122-safe-materialization` (from `develop`)
**Status:** DRAFT v2 — rewritten after a 3-critic panel. **Awaiting approval.**

> **v2 changed the design, not just the details.** v1 proposed stop → replace →
> build → start, plus preserving `node_modules`/build output. The panel returned
> **3 critical and 11 high** findings against it, including two that would have
> been worse than the bug. The platform already owns a deploy transaction that
> does what v1 was trying to hand-build. v2 uses it. See _What v1 got wrong_.

## Goal

A monorepo group redeploy must never leave a child serving a directory that has
been emptied — and must leave the child no worse off than any other app on the
platform when a build fails.

## The bug

`expandMonorepo` materializes each child as (`platform.ts:2939-2944`):

```ts
await fs.rm(childPath, { recursive: true, force: true });
await fs.cp(srcDir, childPath, { filter: excludes node_modules/.git/dist/build });
```

The child is never stopped. A running static child's server keeps serving a
document root that has just been deleted and refilled with source-only content.
Under docker isolation nginx re-enters `try_files … /index.html` and returns
**500** — what `ezsign-frontend` did. (On host isolation the built-in static
server returns 404 instead; the incident shape is docker-specific.)

The window is not brief: the `fs.rm` destroys the child's `node_modules` and
build output, while the copy filter only excludes those from the *source*. So
every expansion forces a full install + build with the docroot empty throughout.
It becomes **permanent** on any of four early returns in `handleBuildApp` —
guardrail refusal (`:3196`), `appsInProgress` collision (`:3178`), build-queue
full (`:3215`), or a throw in the per-service loop.

## Approach — reuse the transaction the platform already has

`handleAppUpdate` (`platform.ts:4336-4500`) already implements the contract:
build in place while the old process keeps serving, stop only **after** a
successful build, restart on the same port, re-arm the health prober and
crash-loop watch, park in `needs-config` on a missing secret, and **restore
`running` on build failure**. Every other app on this platform gets that. A
monorepo child should not be the exception.

So, in `expandMonorepo`, per service:

1. **Delete the `fs.rm`** (`platform.ts:2939`). Let `fs.cp` land the source over
   the child in place. `node_modules` and the previous build output survive
   because nothing removes them — v1's "preserve the build cache" milestone
   evaporates rather than being deferred.
2. **Route an EXISTING child through `handleAppUpdate`** with
   `bypassCooldown: true`, instead of `handleBuildApp`. A **first-ever** child
   (no state entry) still goes through `handleBuildApp` — there is nothing to
   keep serving. DROP-121's grouped-child refusal at `:4227` only fires when
   `!bypassCooldown`, so an explicit re-expansion already passes.
3. **Skip a user-stopped child.** `handleAppUpdate` does not honour
   `status === 'stopped'` the way `buildSub` does (`:2335`), so without this a
   deliberately stopped child is resurrected by a group redeploy.

That is the whole correctness fix: one deleted line, one swapped call, one guard.

### What this does and does not buy

It **eliminates** the install-duration outage and restores rollback-on-failure.
It **shortens but does not eliminate** the static window: the build writes output
in place and Vite's `emptyOutDir` empties `dist/` at build start
(`container-build-runner.ts:12,121-122` bind-mounts the app dir read-write), so a
static child is still briefly unserved during its own build.

That residual window is **platform-wide** — every static app already has it on
every redeploy. This change makes a monorepo child exactly as safe as every other
app, no safer. Closing it belongs to the platform (staging, or an output-dir
swap), not to monorepo, and is named as a follow-up below rather than smuggled in.

## What v1 got wrong

Recorded because the reasoning is the valuable part:

- **Preserving the build output would have been worse than the bug.**
  `static.ts:59-72` returns early from `preBuild` when it finds an existing
  `index.html`, so a preserved `dist/` marks the child "already built" and it
  never rebuilds again. Since the copy filter already excludes `dist` from the
  source, the `fs.rm` is currently the *only* thing forcing a static rebuild.
  v1 would have turned "500s loudly" into "quietly serves last week's bundle".
- **Holding the child in `appsInProgress` across replace+build** would have made
  `handleBuildApp` return immediately (`:3178`) — child source-only and
  permanently down, on 100% of expansions. All three critics found this
  independently.
- **`runtime.stop` was the wrong verb**: PM2 merges env on restart, so revoked
  secrets and rotated `DROP_API_KEY`s would have survived — `platform.ts:4643`
  documents exactly this and uses `delete`.
- **Marking the child `stopped`** poisons three guards that read it as "the user
  stopped this deliberately" (`:2320`, `:3144`, `:4263`); it would never restart.
- **Changing `handleBuildApp`'s refusal path** would have regressed every
  standalone app — it is the single choke point for watcher, webhook, git, upload
  and MCP deploys, and `errored` additionally trips boot's force-redeploy.
- **"A rename needs a stop/start anyway" was factually wrong** for the
  host-isolation static case: `static-server.ts:44,93` re-resolves the root per
  request, so a swapped directory is picked up live.
- **The real blocker for staging** is neither venvs nor disk: `build:completed`
  dispatches synchronously and `buildSub` starts the app from `AppConfig.path`,
  so a staged build would start on the *old* tree before the rename. That needs
  the `selfManagedUpdates` marker and hand-owned stop/swap/start.

## File-level changes

- [ ] `src/core/platform.ts` — `expandMonorepo` per-service loop:
  - remove `fs.rm(childPath, …)` at `:2939`
  - after the copy + config/state writes, branch: existing child →
    `handleAppUpdate(childName, childPath, 'monorepo re-expansion', true, actor)`;
    first-ever child → `handleBuildApp` as today
  - skip a child whose status is `stopped`, logging why
  - keep `appsInProgress` holding the **container only** — explicitly do NOT add
    the child (see _What v1 got wrong_); add a comment so it is not "fixed" later
- [ ] `src/core/platform.ts:2936-2938` — correct the copy-filter comment, which
      claims the exclusions keep redeploys cheap while the line above defeated it.
- [ ] Tests — `platform.monorepo-materialization.test.ts`:
  - an existing child goes through the update transaction, not `handleBuildApp`
  - a **first-ever** child still goes through `handleBuildApp`
  - `node_modules` and the previous output survive a re-expansion
  - a re-expansion whose source changed produces changed build output (proves the
    build actually re-ran — the inverse of v1's mistaken assertion)
  - a failed build leaves the child `running` on its old version, not `errored`
  - a user-`stopped` child is not resurrected
  - a standalone app's path is unchanged

## Risks & open questions

1. **Re-entrancy.** `handleAppUpdate` is called from inside `expandMonorepo`
   while the container holds its own `appsInProgress` key. The guards at
   `:4135-4151` and `:4227` read as clear for a child with `bypassCooldown: true`,
   but this is ordering, and ordering should be proven at Gate 4 on the real
   `ezsign` group rather than by reading.
2. **Deleted source files now linger.** Removing the `fs.rm` means a file deleted
   from the source subtree survives in the child forever. That is the one thing
   the `fs.rm` did right. Fix is a prune — deliberately a **separate** change,
   see below, because it must be shared and is the riskiest part.
3. **Orphaned services.** `expandMonorepo` never reconciles removals: a service
   deleted from `services:` leaves a child running forever. Pre-existing;
   out of scope; named so it is not mistaken for covered.

## Follow-ups this plan deliberately does NOT do

Each is independently shippable and none blocks the fix above:

1. **The same defect exists on the upload-deploy path, which is more common.**
   `UploadDeployService.pruneStale` (`upload-deploy.ts:269-315`) runs over a
   **live** app dir on every tarball redeploy and deletes everything absent from
   the tarball — including `dist/` and `node_modules/` — while the app is
   running. `platform.ts:4363` calls that "the dominant path for an agent
   redeploying". Fixing only `expandMonorepo` leaves the busier path broken. The
   prune from risk 2 should land here as one shared helper both callers use.
2. **Two pre-existing security holes the panel found, which are arguably more
   urgent than this fix:**
   - `validateContainedPath` is structural only (no `realpath`), so a symlink in
     a cloned repo makes `services.<x>.path` resolve outside the container while
     passing validation — `fs.cp` then copies **another tenant's tree, `.env` and
     all**, into the attacker's servable child. `git clone` materializes symlinks;
     the upload path already refuses them (`tar-extract.ts:58`).
   - the child-name collision guard (`:2901-2909`) skips only when
     `existing && existing.group !== group`, so `existing === undefined` falls
     through to the delete — `group: victim` + service `frontend` targets
     `victim-frontend`, raceable before the victim's config is written.
3. **Skip unchanged services** — hash the source subtree with the existing
   `computeSourceMtimeMs` and skip copy+build entirely when nothing changed
   (plus the secret fingerprint and runtime-spec revision, per DROP-068's rule
   that rebuild is the only apply path for secret revocation). In the ezsign
   shape this removes half the blast radius outright.
4. **The platform-wide static build window** (`emptyOutDir` empties the docroot
   mid-build). Staging or an output-dir swap; belongs to the static path.
5. `MONOREPO_COPY_EXCLUDE_RE` tests the **absolute** source path, so a service at
   `packages/build` makes the filter reject the copy root and copy nothing.

## Agent critiques considered

Three critics: `architecture-critic`, `security-critic`, and a task-fit design
critic briefed to argue **for** the option v1 rejected. **3 critical, 11 high.**

### Critical — all actioned

- **`appsInProgress` held across the child's build silently skips it**
  (architecture *critical/high*, security *high/high*, design `D1`
  *critical/high*). Found independently by all three. **Actioned**: the child is
  never added; v2 keeps the container-only hold and comments why.
- **Preserving build output makes static children serve a stale bundle forever**
  (architecture *critical/high*). **Actioned**: the whole preserve-the-cache
  change is gone — under v2 nothing deletes the cache, so nothing needs
  preserving.

### High — actioned

- `runtime.stop` → PM2 env merge keeps revoked secrets (architecture
  *high/high*); marking the child `stopped` poisons three guards (*high/high*);
  the `handleBuildApp` refusal change regresses every standalone app
  (architecture *high/high*, security *medium/high*); stop-first couples recovery
  to `autoBuild`/`autoStart` and to `promotion: manual` (*high/medium*).
  **All actioned by deleting the stop-first design** — v2 stops nothing.
- **v2's central design came from `D7`/`A5`** (*high/high*): v1 would have made a
  monorepo child the only app on the platform without a transactional redeploy.
  **Actioned** — that is now the approach.
- `D2` (*high/high*): v1's "a rename needs a stop/start anyway" was wrong for
  host-isolation static. **Actioned** — claim removed, and the real blocker
  (`buildSub` starting from `AppConfig.path`) recorded instead.
- `D9` (*high/high*): the prune was misscoped — `upload-deploy` has the identical
  defect on a busier path, and prior art (`copyTree`/`pruneStale`) already
  exists. **Actioned** — prune removed from this plan and named as a shared
  follow-up.
- Security `S2` symlink escape and `S3` collision guard fail-open (*high/medium*
  each). **Actioned as follow-up 2** — both are **pre-existing**, not introduced
  here, and both deserve their own PR ahead of this one.

### Consciously rejected

- **architecture · remove and re-add the child's route** (*medium/medium*) —
  moot: v2 does not stop the child, so there is no route to remove.
- **`A3` Capistrano `current` symlink** (*low/medium*) — rejected on the critic's
  own reasoning: it breaks `AppConfig.path` identity, group teardown's
  `fs.rm(appsDirectory/groupName)`, and the grouped-child guard, for a benefit a
  plain rename already gives.
- **`A4` blue/green on a second port** (*low/high*) — the only genuinely
  zero-downtime option and the right eventual shape, but it fights
  AppConfig-as-port-source-of-truth and the readiness gate. Named so "zero
  downtime" is not equated with "rename".
- **architecture · orphaned-service reconciliation** (*low/medium*) and
  **`node_modules` preservation delivers less than claimed for Node** because the
  skip-install path is dead (*low/medium*) — both recorded, neither actioned.

Medium/low findings dropped without individual reasons: **9**.

## Run stats

_To be filled at the end of Phase 2._

---

# Gate 2 outcome: v2 REJECTED, branch not merged

The v2 implementation passed Gate 1 (conformance) and the full suite, and was
then **rejected at Gate 2**. Two critics returned 3 critical/high findings that
each independently defeat it. The branch `fix/DROP-122-safe-materialization` is
abandoned; nothing was committed beyond this plan.

Recorded because the reasoning is the deliverable.

## Why v2 does not work

1. **The transaction never happens.** `expandMonorepo` calls
   `stateManager.registerApp(childName, …)` *before* `handleAppUpdate`, and
   `registerApp` forces `status` back to `pending` (`state-manager.ts:265`). So
   `handleAppUpdate`'s `wasRunning` is always false for a running child. On
   success the old process is never stopped and `ProcessManager.start`
   early-returns on `online` — new build on disk, old code still serving, deploy
   reported green. On failure the child is marked `errored` while its old process
   is still alive. Both halves of the contract v2 was buying are inverted.

2. **v2 reproduced the exact failure it rejected v1 for.**
   `StaticBuildStrategy.preBuild` returns early when it finds an existing
   `index.html`, leaving `buildCommand` unset. With the `fs.rm` gone the child's
   previous `dist/` survives, so a static child with no explicit `build:` **never
   rebuilds again** and `validate()` passes against the stale bundle. The plan
   argued this exact mechanism on page 1 to reject v1 and then recreated it on
   page 2. The claimed mitigation (Vite's `emptyOutDir`) only applies when a
   build command is configured, which is what `preBuild` declines to do.

3. **Tenant build commands escape the build container.** `handleBuildApp` sets
   `execCommand = createContainerExecCommand(...)` under docker isolation so
   tenant-authored `install`/`build`/`preBuild` run in a locked-down container.
   `handleAppUpdate` never sets it, so the builder falls back to host
   `child_process` as the platform user — who is in the `docker` group and
   therefore root-equivalent. v2 newly routed every existing monorepo child
   through that path.

## The load-bearing lesson

**The prune is not optional.** v2 deferred it as "the riskiest part, a separate
follow-up". It is in fact what makes removing the `fs.rm` safe at all. Without
it, removing the wipe turns an availability bug into confidentiality
regressions:

- a file deleted from the source stays deployed and, for a static child, stays
  publicly served — "delete the secret and redeploy" silently no-ops
- changing `services.<svc>.path` leaves the child holding the union of both
  trees, publishing the old subtree, and lets a leftover manifest steer detection
  and the start command
- a symlink planted in the child tree by a `postinstall` outside the source's
  path set now survives forever, and under `isolation: 'none'` the static server
  follows it; removing the malicious source no longer remediates
- `fs.cp` throws `ERR_FS_CP_DIR_TO_NON_DIR` on a file→directory flip and abandons
  the copy mid-tree, leaving a half-old/half-new tree serving, permanently

## What a v3 must contain

Not a patch on v2 — these are its preconditions:

1. `execCommand` parity between `handleBuildApp` and `handleAppUpdate`, lifted
   into one shared helper. **Security-critical and pre-existing**: every upload
   and git redeploy of a *standalone* app already builds on the host today.
2. The prune, as a first-class part, shared with `UploadDeployService.pruneStale`
   (which has the same defect on a busier path).
3. `updateApp` instead of `registerApp` for an existing child, so status survives.
4. A decision on stale `dist` vs. `StaticBuildStrategy.preBuild` ordering.
5. The stopped-child check moved *above* the `fs.cp` — v2 refreshed a stopped
   child's source while skipping its build, so a later `drop start` serves new,
   unbuilt source.

## Recommended sequencing

The two pre-existing security holes now outrank the original 500:

1. `execCommand` parity (tenant builds on the host).
2. `validateContainedPath` realpath + the collision guard's fail-open.
3. The shared prune helper.
4. Only then, the materialization change that depends on all three.

---

# Progress against that sequencing

**Step 1 — DONE, on develop.** `execCommand` parity shipped as DROP-123
(PR #155, `fbf8564`): `buildExecCommandFor` (`platform.ts:4136`) is now the
single helper both `handleBuildApp` (`:3309`) and `handleAppUpdate` (`:4440`)
call, so tenant build commands run in the container on both paths. DROP-124
(PR #156) followed up by keeping platform secrets out of those commands.

**Step 2 — DONE, this branch (`1ca2fa7`).** Both holes closed in
`expandMonorepo`, with `platform.monorepo-source-safety.test.ts` covering them.

The symlink mechanism was **verified rather than assumed, and the plan above had
it wrong**. It claimed `fs.cp` "copies another tenant's tree, `.env` and all".
It does not — `fs.cp` does not dereference, it **recreates** the symlink at the
destination (probed directly on Node 22 Linux via Docker). The consequences are
worse than a copy:

- a symlinked `services.<x>.path` makes the **child app directory itself a
  symlink** aliasing the target — a live alias, not a snapshot
- a nested symlink is reproduced verbatim inside the child

Both are served by a static child. The fix therefore has two halves — realpath
containment of the service root (`isPathWithin`, which the codebase already
had) *and* a walk refusing symlinks anywhere in the copied set. Realpathing the
root alone would have missed the nested case entirely.

Placement note: the realpath check went next to the `fs.stat` in
`expandMonorepo`, **not** into `validateContainedPath` as the plan proposed.
The parser's helper is sync inside an async `parseDropYaml`, so making it
realpath ripples through its callers, and parse time is the wrong moment
anyway — the check now runs immediately before the copy that consumes it.

Exclusions are honoured (`MONOREPO_COPY_EXCLUDE_RE`), so a pnpm workspace's
`node_modules` link farm is not refused for no security gain.

**A test that proved nothing, caught by mutation.** The first version of the
symlinked-root test asserted only "no child directory was created". That passes
with the guard disabled: on Windows `fs.cp` throws `EPERM` trying to recreate
the link, so the directory is absent either way. The assertion now keys on
`watcher.markAppKnown`, which the guard returns *before* and the EPERM path has
already called — a discriminator that holds on both platforms. Both guards were
then mutation-verified: each test fails when and only when its own guard is
neutered.

**Still open — steps 3 and 4**, unchanged, plus everything under _Follow-ups_.
Note that the `UploadDeployService.pruneStale` defect (follow-up 1) and the
`MONOREPO_COPY_EXCLUDE_RE` absolute-path quirk (follow-up 5) are both still
live.

**Not runtime-verified.** These guards are refusal paths in `expandMonorepo`;
exercising them end to end needs a real monorepo deploy on a Linux host. The
underlying `fs.cp` behaviour was confirmed on Linux, and the suite is green
(153 suites / 2503 tests), but nothing has run on dropkit.sh.
