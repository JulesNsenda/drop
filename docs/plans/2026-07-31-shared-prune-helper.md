# Plan: one shared tree-sync helper (DROP-122 step 3)

**Date:** 2026-07-31 · **Branch:** `fix/DROP-126-shared-prune` (from `develop`)
**Status:** DRAFT — **awaiting approval.**
**Context:** step 3 of the sequencing in `2026-07-30-monorepo-safe-materialization.md`.
Steps 1 (`execCommand` parity, DROP-123) and 2 (symlink escape + collision
fail-open, PR #158) are merged.

## Goal

One helper that lands a source tree over a destination directory: copy what's
there, delete what isn't, keep a named set regardless. Used by
`UploadDeployService.landFiles` now, and by `expandMonorepo` in step 4 when the
`fs.rm` comes out.

## The load-bearing decision: preserve `node_modules`, never `dist`/`build`

The source plan contradicts itself here, so this is stated with evidence rather
than inherited.

Its _follow-ups_ section says `pruneStale` wrongly "deletes everything absent
from the tarball — including `dist/` and `node_modules/`". Its own _Gate 2
rejection_ says preserving `dist` is what killed v2. Both cannot hold. Measured:

- `StaticBuildStrategy.preBuild` (`static.ts:68`) calls `findOutputDirWithIndex`
  **before** `isSourceSpa`. A surviving `dist/index.html` therefore sets
  `outputDirectory` and returns early, leaving `buildCommand` unset
  (`getBuildCommand` is `config.buildCommand ?? null`). No build runs, and
  `validate()` (`:101-105`) then checks `appPath/dist/index.html` and **passes
  against the stale bundle**. The deploy reports success serving old code.
- So `pruneStale` deleting `dist` is **not purely a defect** — it is currently
  the only thing forcing a static rebuild on the upload path, exactly as the
  `fs.rm` was for monorepo children.

**Therefore `dist`/`build` are excluded from the preserve list as a
requirement, not an oversight** — and the code comment must say so, or someone
will "complete" the list later and reintroduce v2's failure. Revisiting it
belongs to step 4's open question about `preBuild` ordering.

`node_modules` is preserved. What that buys is narrower than the source plan
implies, and worth stating so nobody claims a speedup that isn't there:

- it does **not** enable a skip-install for Node apps. That path is dead in the
  default case — `nodejs.ts:86-91` documents that the detector always supplies
  `installCommand`, so the lockfile-hash skip never runs. (See also the
  DROP-062 trap: a detector's `suggestedConfig.installCommand` shadows the
  strategy's own logic.)
- what it does buy is not deleting a running process's dependencies out from
  under it mid-redeploy, and letting `npm install` be incremental.

## Scope — three items, deliberately narrow

1. **`src/utils/tree-sync.ts`** — `syncTree(srcDir, destDir, { preserve })`:
   copy every entry from src over dest, then delete dest entries absent from
   src except those named in `preserve` (matched on the top-level entry name,
   at any depth, mirroring `MONOREPO_COPY_EXCLUDE_RE`'s segment semantics).
   Extracted from `copyTree`/`pruneStale`, which already have the shape.
2. **`lstat`-based deletion** — the prune must never follow a link out of the
   app directory. Same class as the two holes fixed in PR #158; `pruneStale`
   currently uses `readdir(withFileTypes)`, which is already lstat-semantics,
   so this is mostly pinning it with a test rather than changing behaviour.
3. **The file↔directory flip.** `fs.cp` throws `ERR_FS_CP_DIR_TO_NON_DIR` when
   an entry changes kind between deploys and abandons the copy mid-tree,
   leaving a permanent half-old/half-new tree (named in the v2 rejection).
   `copyTree` already handles this (`upload-deploy.ts:280-289`);
   `expandMonorepo`'s raw `fs.cp` does **not**. Building it into the helper now
   means step 4 inherits the fix when it drops `fs.cp`.

## Behaviour change on a live production path

`UploadDeployService` switches from "delete everything absent from the tarball"
to "…except `node_modules`". This changes what happens to **already-deployed**
apps on their next tarball redeploy: `node_modules` now survives where it was
previously deleted. That is the intended fix, but it is a live-path change and
is called out here rather than discovered later. `dist`/`build` keep being
deleted exactly as today, so static rebuild behaviour is **unchanged**.

`expandMonorepo` is **not** switched over in this step — it keeps its
`fs.rm` + `fs.cp`. Nothing about monorepo materialization changes here.

## Tests

- an entry absent from src is deleted; one present is overwritten
- `node_modules` survives a sync that doesn't mention it; `dist` does **not**
  (pin the decision above, with the reason in the test name)
- a symlink in dest is removed as a link, and the prune does not follow it out
  of the destination
- file→directory and directory→file flips both land, no partial tree
- nested prune: a stale file deep in a surviving directory is removed
- upload redeploy end-to-end through `landFiles`: stale file gone,
  `node_modules` intact, `dist` gone

Each guard mutation-verified — a test that passes with the guard neutered gets
rewritten, per the two vacuous tests PR #158 caught.

## What this does NOT do

- **Does not fix the ezsign 500.** That is step 4.
- Does not touch `expandMonorepo` or the `fs.rm`.
- Does not resolve the `preBuild`-ordering question (step 4, open).
- Does not address the `MONOREPO_COPY_EXCLUDE_RE` absolute-path quirk
  (follow-up 5) or orphaned-service reconciliation.
