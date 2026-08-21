# CI/CD pipeline redesign

**Date:** 2026-08-21
**Status:** DRAFT — awaiting approval. No production code written.

---

## The decision this plan makes, up front

**The release-directory + symlink layout is cut.** It was the centrepiece of the
draft and every critic attacked it independently: it produced 4 of the panel's 6
critical findings, 5 of the draft's own 8 risks, and the failure-mode audit
found that its headline claim — "rollback is one symlink repoint plus a
restart" — is false in three separate ways.

The deciding argument is that **keeping today's stop-the-service deploy deletes
those criticals outright rather than mitigating them**:

| Critical | Why it existed | Why stop-first kills it |
|---|---|---|
| F1 health gate proves liveness, not identity | zero-downtime swap leaves the old process serving, so `/health/live` 200s and the job goes green having shipped nothing | with the service stopped, a 200 can only be the new process |
| F2 `npm ci` after the swap | arms a delayed crash-loop that fires at the *next* unrelated restart, hours later | install happens while stopped, as today, before anything starts |
| F3 same-SHA redeploy | `releases/<sha>` is the live directory, so a re-run mutates it under the running process and the rollback pointer becomes self-referential | no per-SHA directories exist |
| F6 first-deploy conversion | `rename(2)` cannot replace a directory with a symlink, so deploy #1 cannot be atomic, and the live process starts reading the new bundle mid-install | no conversion ever happens |

The deploy job has **not failed once in the last 100 runs** (2026-07-27 →
2026-08-21; the one Deploy failure in that window was the `Test` step, with the
deploy job correctly skipped). Rewriting the only path to production to add a
recovery property, at the cost of six new critical failure modes, is a bad trade
at this scale.

What is kept is the *property* the layout was for: **a bad deploy must be
recoverable without a human rebuilding the box.** That is delivered by a
snapshot instead of a layout.

---

## Goal

Close the largest real exposure (a public repo whose workflows hold a production
SSH key, with every action on a mutable tag), make a failed deploy recoverable,
delete the bug class the apostrophe guard exists to catch, and know when a deploy
did not happen. Change as little of the working production path as possible while
doing it.

---

## Approach

### A. Supply chain — ships first, touches nothing that runs

`.github/dependabot.yml` for three ecosystems (npm root, npm `src/dashboard`,
`github-actions`), and **all 11 action references pinned to a commit SHA** with a
version comment. These pair deliberately: SHA pins without dependabot rot into a
2026 checkout forever, and dependabot without SHA pins leaves the mutable-tag
exposure open.

`permissions: contents: read` at the top of every workflow, with narrower grants
only on the job that needs them. `release.yml` already models this
(top-level `contents: read`; job-scoped write grants on `publish`); the other two declare nothing and run at the repository
default, while executing `npm ci` — the full transitive postinstall surface — in
a job whose token may be write-scoped.

This is the item with the best value-to-risk ratio in the plan and it was **not
in the draft at all**; the scope critic supplied it.

### B. One verified definition of "good" — `ci.yml` + `deploy.yml` only

`.github/workflows/_verify.yml`, `on: workflow_call`, running the four steps
those two workflows already duplicate, and uploading the **tarball** (not raw
`dist/`, which loses the executable bit `bin: ./dist/cli/index.js` depends on).
It declares `permissions: contents: read` and **no `secrets:` block**; callers
pass nothing and must never use `secrets: inherit`.

**`release.yml` is deliberately excluded.** It has three properties a shared call
would damage: its tarball assertion proves things about the tree *it just built*
rather than a transported blob; its build job must not hold release-write scope
while running `npm ci`; and its cheap tag/version/CHANGELOG gates run *before*
`npm ci` so a bad tag fails in seconds. Two callers is a thin de-duplication
case, and it is worth it only because one of them is the production path.

**No composite action, no 5-way job split, no test sharding.** Measured: CI is
155s end to end with the test step at 104s. The split saves ~65-70s and costs 9
runners per workflow (18 on every `develop` push, since CI and Deploy both fire),
reshuffles a suite with a known contention-flake fingerprint, and — decisively —
**forecloses coverage enforcement**, because `--shard` and `coverageThreshold`
are mutually exclusive without a per-shard coverage merge subsystem. Sharding
starts to pay at roughly a 5-minute suite. Revisit then.

Add **shellcheck** over `install.sh` (1018 lines, never linted, a deferred item
from the original bootstrap plan) and over the new deploy scripts.

### C. The remote script becomes a file — behaviourally identical, plus recovery

`scripts/deploy/remote-deploy.sh`, **packaged into the verified artifact** (not
fetched by adding `actions/checkout` to the key-holding deploy job, which would
both widen that job and run a branch's copy of the script on production rather
than the copy shellcheck verified).

It must reproduce today's sequence exactly — stop → refresh
`/opt/drop/{install.sh,package.json,package-lock.json}` and `dist` → lockfile-
witness-conditional `npm ci --omit=dev` → three-arm `--provision` → staleness
warn → health gate — with these changes and no others:

1. **First statement is `[[ "$1" =~ ^[0-9a-f]{40}$ ]] || exit 1`.** `ssh host cmd
   arg` is re-parsed by the remote login shell, so local quoting does not protect
   the value; `deploy.yml:8` deploys `feature/DROP-v2*`, and a branch name is
   attacker-influenced. `github.ref_name` must never reach the ssh command line.
2. **`SHIPPED_HASH` stays runner-side.** Computing both halves on the box turns
   the staleness check into a self-comparison that always passes — the existing
   comment says why, and a script that already has the tarball is exactly where
   that mistake gets made.
3. **Staging in a `drop`-owned `0700` directory**, not `/tmp`. `/tmp` is
   world-writable and its sticky bit prevents replacement, not pre-creation —
   and this plan makes the staged file *executable*, which is a change of kind.
   `install.sh:695-698` already rejects `/tmp` for this reason.
4. **`set -euo pipefail`, `${VAR:?}` on every destructive path**, and the
   `sudo -n /usr/bin/bash /usr/local/sbin/drop-provision --provision` invocation
   copied **verbatim** — sudoers matches it byte-for-byte, and any reformatting
   silently falls through to the legacy arm.
5. **Snapshot before destroying anything**: `dist` and `package-lock.json` are
   archived to `/opt/drop/rollback.tar.gz` before the untar.

### D. Rollback by snapshot, with the honesty the layout could not provide

On health-gate failure: restore the snapshot, reinstall dependencies **from the
restored lockfile** if the lock hash changed, restart, and **always exit
non-zero** — exit `10` for "rolled back, previous release healthy" and `1` for
"failed, box state unknown", so the notification can tell an operator which of
those two very different things happened.

Constraints the panel established, all load-bearing:

- **Exactly one rollback attempt**, with an explicit terminal state. A slow boot
  can fail the gate for a *good* build, and the rollback's own gate would then
  fail identically — the draft did not define that branch at all.
- **Never re-run `--provision` during rollback.** It restarts the service and
  rewrites the unit, Caddy and the apex route from `$PROVISION_BIN`; that is
  infra, not code, and rolling code back through it is the wrong order.
- **`set -e` does not apply inside a function called from an `if`/`||`/`&&`
  context** — the natural way to write "gate failed → roll back". Every rollback
  path must set its own status and exit explicitly rather than relying on `set -e`.
- **Dependencies roll back too.** Restoring code without dependencies is what
  makes a rollback as likely to fail as the deploy it is undoing.

**Stated plainly, because the layout's marketing hid it:** rollback restores code
and dependencies. It does **not** undo what a crash-looping release already did
to tenant apps. Under `Restart=on-failure`/`RestartSec=5`, a release that boots
far enough to start the watcher and then dies re-runs boot reconciliation each
cycle — Caddyfile regeneration, per-app config writes, container recreation —
and those survive the rollback. A rollback needs a fleet sanity check, not just a
green gate. (Blast radius here depends on `DROP_BOOT_RECONCILE` being `on` in
`/etc/drop/drop.env`; the code default is `off`. **Verify it on the box** rather
than assuming — it was measured on 2026-07-26 and the deploy has restarted the
platform many times since.)

### E. A health gate that can fail

Today's gate is 30×2s against `/api/v1/health/live`, a window the comment says
matches the platform's internal 60s readiness gate — i.e. **zero headroom**, on a
box where `--provision` restarts twice under docker isolation and boot cost
scales with fleet size. Changes:

- widen the window and stop treating it as equal to the internal gate;
- assert **`GET /dashboard` returns 200 with a non-empty body** and log the
  version `/api/v1/health` reports — a release whose paths resolve wrong serves a
  404 dashboard while `/health/live` happily 200s, which is precisely the class a
  deploy-time gate should catch;
- assert the freshly-unpacked `dist/index.js` exists **before** the swap, as
  `install.sh:714` already does for the release path;
- do not read `systemctl restart`'s exit code as evidence: `Type=simple` returns
  success the instant `execve` does;
- read the port from the env file rather than hardcoding 3000, since `apiPort` is
  configurable and a non-default value makes the gate probe a dead port forever.

### F. Knowing a deploy did not happen

**The hourly SHA-drift check is cut.** It is broken by design: `deploy.yml` fires
on `main` and `feature/DROP-v2*` as well as `develop`, so "most recent successful
Deploy run's SHA == develop head" is permanently false after any `main` deploy.
Worse, the `hetzner` environment approval gate makes "develop head ≠ deployed
SHA" a *normal steady state* — measured waits on the last 12 develop deploys
range from 17s to 12m12s, and an overnight merge would alarm every hour until
morning. An alarm that cries wolf gets muted, which reinstates the blind spot it
was built to close.

Replaced by a **daily** `GET /api/v1/health` probe that records the version
production reports. No false-alarm surface, no cross-referencing of run SHAs.

Honest about its limit: it cannot distinguish "deployed" from "deployed then
rolled back", and it starts life on a signal that was wrong for a week (prod
reported 1.2.2 against a tagged 1.3.0). A real answer needs the box to report the
SHA it is running — recorded as follow-up, not built here.

**Failure notification**: one mechanism, not two. The draft's "webhook if the
secret exists, else a GitHub issue" ships a branch conditioned on a secret that
does not exist, so exactly one path is live and the dead one is untested until
the day it matters. A `notify` job files/updates a **GitHub issue** with
`GITHUB_TOKEN`, `if: ${{ !success() }}` (which `failure()` does not cover for a
*cancelled* run — a shape that can leave the box stopped). Body carries run URL,
workflow, branch, SHA and job name only: **no secrets, no hostnames, no raw
response bodies**, because the repo is public and masking applies to logs, not to
an issue body. No `${{ }}` interpolation inside any `run:` block — values arrive
via `env:` — since a crafted commit message would otherwise execute on a runner
in the same workflow as the deploy key.

Check whether GitHub's default failure email to the repo owner is already on
before building this; for a solo maintainer it may make the issue path worth
little.

### G. Deliberately not in this change

- **Prettier / `format:check`** — 383 files fail `--check`, and normalizing them
  would bury every subsequent diff. Its own change.
- **Coverage enforcement** — thresholds (35/45/50) are declared in
  `jest.config.js` and enforced nowhere. The right shape is measure → set to
  observed reality minus a margin → ratchet, and `--coverage` on ts-jest adds
  40-100% to a 104s step, so it wants its own job. Follow-up, and now *possible*
  precisely because sharding was cut.
- **`runs-on: ubuntu-latest`** — itself a mutable tag, and the one that bites in
  practice (glibc/node/docker CLI rollovers under every job, including the
  production deploy, with no PR signal). Pinning it is a real tradeoff: a pinned
  image eventually goes unsupported and hard-fails. Recorded so the supply-chain
  work is not read as complete when it covers only half the mutable surface.
- **Host-key pinning** — `StrictHostKeyChecking=no` is carried forward
  unchanged. Worth a `DEPLOY_HOST_KEY` secret, but it is a pre-existing posture,
  not something this change introduces.

---

## Sequencing — three landings, not one

The draft bundled ~9 independent changes into a single landing, of which exactly
one can take production down. That is unbisectable while prod is down.

1. **Landing A — supply chain (A).** Zero interaction with the deploy path.
2. **Landing B — verify consolidation, notify, daily probe (B, F).** Pure CI;
   fully exercisable on a branch.
3. **Landing C — the production path (C, D, E), alone and watched.** Gated on a
   container smoke test (below) and diffed line-by-line against the current
   inline blob before it ever runs.

---

## File-level changes

- [ ] `.github/dependabot.yml` — npm (root), npm (`src/dashboard`), github-actions.
- [ ] All workflows — pin 11 action refs to SHAs; add `permissions:` blocks.
- [ ] `.github/workflows/_verify.yml` — reusable; lint, shellcheck, typecheck,
      test, build; uploads the **tarball**; `contents: read`; no secrets.
- [ ] `.github/workflows/ci.yml` — thin caller + notify.
- [ ] `.github/workflows/deploy.yml` — caller + deploy job; inline remote script
      replaced by the packaged file; apostrophe guard replaced by a structural
      assertion (below); notify job.
- [ ] `.github/workflows/health-probe.yml` — daily version probe.
- [ ] `scripts/deploy/remote-deploy.sh` — the sequence in C, snapshot + rollback
      in D, gate in E. Shellcheck-clean, `flock`'d against `rollback.sh`.
- [ ] `scripts/deploy/rollback.sh` — manual restore from the snapshot; same lock;
      no privileged verb beyond the closed sudoers list (stop/start/restart/
      status/`--provision`; **no** `daemon-reload`, `reset-failed`, `journalctl`).
- [ ] `scripts/deploy/smoke-test.sh` + a `_verify.yml` job — run
      `remote-deploy.sh` in a Debian container against a fake `/opt/drop` with
      stubbed `systemctl`/`curl`/`sudo`, asserting end state and **idempotency on
      a second run**. This is the only way the script is exercised before it runs
      against production for real.
- [ ] Structural guard replacing the apostrophe check — assert no workflow passes
      a multi-line script as an `ssh` argument. Deleting the guard's *instance*
      without guarding its *class* leaves the DROP-074 outage available again;
      shellcheck cannot see it, which is what the original comment says.
- [ ] `docs/` — the rollback runbook, including what rollback does **not** undo.

---

## Risks & open questions

1. **The gate window is being widened, which lengthens the time a genuinely
   broken deploy holds the pipeline** before rolling back. Accepted: a spurious
   rollback of a good build is worse.
2. **`DROP_BOOT_RECONCILE` must be verified `on` on the box.** The code default
   is `off`, and the crash-loop blast radius in D depends on it.
3. **The smoke test stubs `systemctl`/`sudo`**, so it proves sequencing and
   idempotency, not real systemd behaviour. It cannot catch a sudoers byte
   mismatch — that is what the verbatim-copy constraint is for.
4. **`_verify.yml` is PR-authored on `pull_request` runs** (a fork supplies its
   own copy via the merge ref). It must never handle a secret or token. Not worse
   than a fork editing a test file, but it is not trusted infrastructure.
5. **Two `package.json` copies never exist** under this plan, because the layout
   was cut — but the remote script must still refresh `/opt/drop/package.json`
   and `package-lock.json` **in lockstep with `dist`**, or `npm ci` hard-errors on
   a lock/manifest mismatch after the service is already stopped.
6. **`npm audit` is not added.** Dependabot's security PRs supersede a
   non-blocking report nobody reads; a blocking `--audit-level=high` on
   main/develop is a follow-up.
7. **The `drop` user is root-equivalent on this docker-isolation box** (docker
   group). None of this is a security boundary; it is operational safety. Under
   `isolation: none`, which `install.sh` supports, some of it would be.

---

## Agent critiques considered

Panel: `security-critic` (18 findings), `architecture-critic` (20), plus two
`general-purpose` critics with distinct schemas — a deploy failure-mode auditor
tracing power-loss and rollback timelines (12), and a scope/simplicity critic
briefed to argue against scope (10). **60 findings: 6 critical, 17 high, 24
medium, 13 low.** Severities quoted verbatim; none re-graded. Every
critical/high is actioned or recorded below.

### Actioned — critical (all six killed the same design)

- **F1 health gate proves liveness, not identity** (*critical/high*) — a
  zero-downtime swap lets the OLD process answer `/health/live` 200, so a deploy
  where all three provisioning arms fail reports success having shipped nothing.
- **F2 `npm ci` after the swap** (*critical/high*) — leaves new code against old
  dependencies; the box looks healthy for hours and crash-loops at the next
  unrelated restart. Interrupting the install is worse: `npm ci` deletes
  `node_modules` out from under the live process, and a lazy `require` (TOTP,
  the DB manager) crashes it mid-window.
- **F3 same-SHA redeploy** (*critical/high*) — a job re-run, or a fast-forwarded
  `main` and `develop` sharing a SHA, makes `releases/<sha>` both the unpack
  target and the live directory, and makes the rollback pointer self-referential.
- **F4 dependency rollback impossible; the plan contradicted itself on
  `/opt/drop/package.json`** (*critical/high*) — no release carried its own
  lockfile, so rollback had nothing to reinstall from, and "package.json
  unchanged" makes `npm ci` hard-error after the stop.
- **Architecture: "rollback is one symlink repoint" is false** (*critical/high*)
  — boot-reconciliation side effects from a crash-looping release survive the
  rollback.
- **Architecture: `package.json`/`package-lock.json` staleness breaks the
  install** (*critical/high*) — same defect as F4, found independently.

**Actioned by cutting the layout**, which removes all six rather than mitigating
them, and by the rollback constraints in D plus the identity/dashboard assertions
in E.

### Actioned — high

Security: `secrets: inherit` would expose the production SSH key to a
transitive postinstall (*high/medium*); missing `permissions:` blocks give
`npm ci` a possibly write-scoped token (*high/high*); `SHIPPED_HASH` must stay
runner-side or the staleness check becomes a self-comparison (*high/medium*);
the layout breaks `npm ci` **and** the legacy sudoers arm (*high/high*); `ssh`
re-parses its argument on the remote shell (*high/high*).

Architecture: the symlink buys atomicity the design cannot use, since a restart
is mandatory (*high/high*); the health gate cannot detect the failure class the
layout introduces (*high/high*); ~9 changes in one landing are unbisectable
(*high/high*); nothing tests `remote-deploy.sh`, and shellcheck-clean is not
tested (*high/medium*).

Failure-mode: slow boot triggers a spurious rollback whose own gate also fails,
and `set -e` is suppressed in the `if`/`||` context rollback is naturally called
from (*high/high*); the first conversion cannot be atomic and re-points the live
process at the new bundle (*high/high*); the retention prune can delete the live
release, and SHA names have no chronological order (*high/high*).

Scope: sharding forecloses the coverage gate (*high/high*); the 5-way split buys
~70s for 18 runners and reshuffles known flakes (*high/high*); the drift check is
broken by `deploy.yml`'s `main` trigger (*high/high*); a shared `release.yml`
call destroys two stated security properties (*high/medium-high*); **dependabot +
SHA-pinned actions were omitted and outrank everything in the draft**
(*high/high*).

### Rejected / partly rejected — recorded

- **Architecture's copy-based swap** (`cp -a` into `dist.new`, then `mv -T`)
  (*high/high*) — **partly rejected**. Its analysis is right and its five-risks-
  gone claim holds, but once the layout is cut entirely the copy dance has
  nothing left to swap: the snapshot achieves the same recovery property with
  strictly less machinery. Adopted in substance, not in form.
- **Failure-mode F4's per-lockfile dependency trees**
  (`/opt/drop/deps/<lockhash>/node_modules`) (*critical/high*) — **rejected for
  now.** It is the correct end state and it makes rollback complete, but it is a
  second on-disk layout change, which is exactly what this plan just spent six
  criticals learning not to bundle. The snapshot restores the previous lockfile
  and reinstalls from it, which covers the same failure at the cost of one
  install. Recorded as the follow-up if a rollback ever proves too slow.
- **Architecture: "D1's premise is overstated — a one-time root `--bootstrap` is
  available"** (*medium/high*) — **accepted as a correction, not as a change of
  direction.** The draft said a `current/` layout "cannot be delivered by CI",
  which was too strong: `deploy.yml:226` already documents the root remediation.
  The honest statement is that it is available and we are choosing not to pay it.
  Moot now that the layout is cut, but recorded so nobody re-derives a false
  impossibility later.
- **Scope's "cut D2 entirely; two callers is under the de-duplication
  threshold"** (*high/medium-high*) — **partly rejected.** Its `release.yml`
  half is adopted in full. Its `ci.yml`/`deploy.yml` half is not: those two
  genuinely run identical steps, they have already drifted, and one of them is
  the production path, so a single definition of "verified" is worth one
  indirection. The composite action *is* cut, as recommended.

### Dropped without individual reasons

`medium`/`low` triaged out after the above: **security** 4 medium, 4 low;
**architecture** 5 medium, 4 low; **failure-mode** 3 medium; **scope** 1 medium,
1 low. Total dropped: **13 medium, 9 low**. Every `critical`/`high` is actioned
or recorded.

---

## Agent critiques considered — diff stage

### Landing A · pass 1

**Actioned — blocking**

- **Landing A was not inert** (architecture, *critical/high*). The implementer
  silently upgraded four actions a full major (`@v4` → `v5.x`), two of them on
  the production deploy path — falsifying §A's "touches nothing that runs" and
  destroying the bisect property the three-landing split exists to buy. **And the
  pins were 2-3 majors stale anyway** (*high/high*): checkout is at v7.0.1,
  setup-node v7.0.0, upload-artifact v7.0.1, download-artifact v8.0.1, so the
  diff neither preserved what runs nor adopted what is current — it was a
  mid-2025 snapshot, the fingerprint of versions recalled rather than queried.
  **Actioned**: repinned to the v4 tips, and verified the floating `@v4` ref
  resolves to exactly those SHAs for all four actions, so the pins are a provable
  no-op — the same bytes that ran on the last green deploy.
  My own Gate 1 check missed this: I verified SHA↔tag correspondence and never
  asked whether the tag was current.
- **`persist-credentials: false` was missing** on the `ci.yml`/`deploy.yml`
  checkouts (security #8, *low/high*) while `release.yml` sets it with a comment
  explaining exactly why. Checkout writes `GITHUB_TOKEN` into `.git/config`,
  where two `npm ci` runs of arbitrary postinstall scripts can read it. Graded
  low by the critic because `contents: read` caps the damage; actioned anyway
  because it is behaviour-neutral and squarely this landing's remit.

**Actioned — the file's own claims**

- `open-pull-requests-limit` is **per entry**, so the real ceiling is 9 open PRs,
  not 3, each a production deploy on merge (security #7, *low/high*). The comment
  asserted a safety property the config did not have; corrected.
- Cadence moved weekly → monthly, because the scarce resource is service
  interruptions rather than review minutes (architecture, *high/high*).
- `jose` and `tar` majors are now ignored, with the reason named in the file
  (architecture, *high/high*): `jose` is mocked file-wide via
  `jest.config.js`'s `moduleNameMapper`, so a green suite is not evidence for a
  JWT bump; `tar-extract.ts`'s path-traversal hardening depends on node-tar's
  PAX-override semantics. This is the same vacuous-green class as the
  `fs/promises`-mocked-in-`platform.test.ts` trap.
- `commit-message` prefix (repo uses conventional commits) and
  `versioning-strategy: increase-if-necessary` so declared ranges are not
  widened silently — `zod` is exact-pinned deliberately while everything else is
  caret.

**Two findings that change what this landing MEANS — surfaced, not silently absorbed**

Both API-verified by me independently, not taken on the critic's word:

1. **Dependabot alerts and security updates are DISABLED on the repository**
   (security #1, *high/high*). `vulnerability-alerts` returns 404;
   `dependabot_security_updates` is `disabled`. A config file cannot enable
   them. So plan §G item 6 — which declined `npm audit` because "Dependabot's
   security PRs supersede a non-blocking report nobody reads" — rests on a
   mechanism that does not exist. **Until the setting is enabled there is no
   vulnerability signal at all** on a tarball `install.sh` ships to every
   self-hosted user.
2. **Dependabot reads this config only from the DEFAULT branch, which is `main`**
   (security #2, *medium/high*). The branching model lands everything on
   `develop`, so the file is inert on arrival and stays inert until the next
   `develop` → `main` release merge — a window this repo's own history says is
   long (the 1.3.0 bump sat on `main` unmerged for a week). `target-branch`
   governs where PRs open, not where config is read.

Both are recorded in the file's header comment so the next reader cannot mistake
the file's presence for dependency safety. Neither is fixed here: enabling repo
settings is the maintainer's call, and landing the config on `main` would deploy
production from a divergent tree.

**Disagreement resolved — the two critics wanted opposite pins**

Security #4 (*medium/high*) argued for pinning the **current** majors now, so
dependabot has no major to propose in week one, noting that `download-artifact`
v8 makes artifact digest mismatch a hard error — a real security gain on the path
that ships to production. Architecture (*critical/high*) argued for the **v4
tips**, to keep the landing inert.

**Sided with architecture.** The deciding factor is the plan's own sequencing
rationale: Landing A exists to be eliminable as a cause when Landing C touches
production. Jumping four actions across 2-3 majors inside the landing that claims
to touch nothing that runs reintroduces precisely the defect being fixed, and the
majors are exactly what dependabot is for — a separate, reviewable PR. The
underlying digest concern is better answered by security #5's cheaper fix
(hash the tarball in the build job and re-verify in deploy), which needs no major
bump; recorded for Landing B.

**Recorded, not actioned**

- **Artifact digest is never verified between the build and deploy jobs**
  (security #5, *medium/high*) — a compromised postinstall writes straight to
  production, and §B's "verified artifact" language reads as if this were
  covered. Deferred because it changes a `run:` step, which Landing A must not.
  **Landing B.**
- **Secret scanning and push protection are disabled** on a public repo whose
  workflows hold a production SSH key, and which has a prior credential-in-repo
  incident (security #6, *medium/high*). Repo setting; maintainer's call.
- **The `hetzner` environment has no deployment-branch policy**, so a
  `feature/DROP-v2*` scratch branch can draw the production SSH key
  (security #9, *low/medium*). Repo setting; pre-existing.
- **Deploy-path actions get zero PR validation** — `upload-artifact`/
  `download-artifact` and the DROP-074 guard's `yaml` dependency appear only in
  workflows that never run on `pull_request` (architecture, *medium/high*).
  Landing B mostly dissolves this by moving the upload into `_verify.yml`.
- **`runs-on: ubuntu-latest` is itself a mutable tag** (architecture,
  *low/high*) — the supply-chain section covers only half the mutable surface.
  Added to §G.
- **`${{ env.SHIPPED_HASH }}` is interpolated into the ssh `run:` block**
  (security #10, *low/low*) — shape, not exploit, since the value is hex. The
  comment justifying it points at an `env:` block that does not exist. Landing C
  rewrites that step entirely.
- **Duplicating pins across workflow files is deliberate and self-liquidating**
  (architecture, *low/high*): same-repo reusable workflows are referenced by
  path and take no SHA, so `_verify.yml` adds zero pins and Landing B reduces the
  net count. No composite action needed. Recorded so the question is not
  reopened.
- **Plan line citations had drifted** (architecture, *low/high*) — §A cited
  `release.yml:24-29` for the permissions model; it is `:20-21` and `:32-33`.
  Corrected below. Landing C requires copying a `sudo` invocation verbatim, so
  stale citations in this document are a live hazard: prefer anchor text to line
  numbers there.

**Dropped without individual reasons:** architecture 2 medium, 1 low; security
1 medium, 1 low.

## Run stats

_Filled in at the end of Phase 2._
