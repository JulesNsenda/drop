# PRD-039: Source Upload Deploy (Agent Deploy Target — Server)

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-039 |
| Feature | Source Upload Deploy (remote tarball deploys) |
| Status | Completed |
| Priority | P1 |
| Target | v2.1 |
| Depends On | PRD-016 (git deploy — landing pattern), PRD-029 (docker isolation); companion: PRD-040 (MCP client) |
| Created | 2026-07-09 |

---

## Overview

Make DROP a deploy target for AI coding agents (Claude Code, Cursor). Agents generate
many small apps that die on localhost because deployment is the friction point. Today
there is no way to get code onto a DROP box remotely without a GitHub repo
(`POST /apps` registers a server-local path). A tarball upload endpoint closes the
loop: an agent uploads source, gets a URL, observes structured build feedback via the
existing deploy-episodes and build-logs APIs, fixes, and redeploys — over one
`user`-role API key, which the existing `canAccess` model automatically scopes to the
apps that key created.

DROP already has the rest of the loop: deploy episodes with per-stage failure
categories (`GET /api/v1/deploys`), build logs (`GET /api/v1/logs/:name/build`),
per-app secrets, auto-provisioned `DATABASE_URL`, HTTPS hostnames.

## Changes

1. **Upload endpoint** — `POST /api/v1/apps/:name/source` (auth `user`+, never
   anonymous): gzipped tarball, streamed to disk with an incremental byte cap (never
   buffered via `formData()`, never trusting `Content-Length`), staged under
   `data/temp/` (outside the watched dir), extracted with hardening (change 2), then
   landed the way git-deploy lands clones: an `activeUploads` guard consulted by the
   platform's `app:detected`/`app:update` subscribers (generalize git-deploy's
   `isCloning` seam), followed by a deterministic direct publish of `app:detected`
   (new app) or `app:update{bypassCooldown: true}` (redeploy). **Not**
   watcher-mediated — the adaptive cooldown (up to 120 s) would swallow the agent's
   rapid fix→redeploy loop, and rename onto an existing app dir is not atomic anyway.
2. **Extraction hardening (merge gate)** — `node-tar` (never system tar) with an
   entry filter: reject symlink/hardlink/FIFO/device/socket entries outright (only
   regular files and directories are written); per-entry resolved-path containment
   (`isPathWithin` pattern — do not trust the library's internal guard); reject
   case-insensitive or Unicode-normalization collisions within one tarball;
   incremental caps on decompressed bytes and entry count (abort mid-stream, not
   post-hoc); wall-clock timeout on extraction; gzip magic-bytes check. A test suite
   covering tar-slip / bomb / symlink escape / collision is a merge gate.
3. **Guards** — same as `POST /apps` plus: explicit `canAccess` on redeploys, with
   foreign-or-unknown app → `404` (mirrors deploys.ts's no-existence-oracle
   discipline); per-user app limit enforced on first-time create; register app +
   `userId` atomically **before** files land (git-deploy pattern, not the
   `POST /apps` register-then-update pattern); synchronous `409` when the app is
   already building (extend the platform-ops seam) so a `202` always yields an
   observable episode; disk watermark re-checked during extraction, not only before;
   per-user upload concurrency of 1 and a stricter route-specific rate limit.
4. **Body-limit carve-out** — the global 1 MB `validateBodySize` middleware runs
   before all routes and would 413 the upload first; it must exempt/branch on the
   upload path. Real enforcement is the endpoint's own streamed byte cap (default
   100 MB compressed, configurable).
5. **Correlation contract** — `202` body returns `{ app, acceptedAt }`; clients poll
   `GET /api/v1/deploys?app=<name>&limit=1` until an episode with
   `startedAt >= acceptedAt` reaches a terminal status. Per-app builds are
   serialized, so no deployId plumbing through `EventPayloadMap`; if real ambiguity
   ever appears, escalate to a `DeployTracker.reserveDeployId(appName)` method.
6. **Trigger taxonomy** — extend `DeployTrigger` with `'upload'` (`deriveTrigger`,
   DTO, dashboard timeline) so upload redeploys don't render as "hot-reload".
7. **Docs** — API doc page with the curl recipe (tar → upload → poll → build-log
   tail on failure), directly usable by shell-capable agents via a CLAUDE.md
   snippet; document that hot re-upload over a running app on Windows is best-effort
   (files held open by the running process; stop-first fallback), matching the
   existing git-pull-over-running-app caveat.

## Non-Goals

- **No expiry/reaper for idle apps** — cut after review: per-user limits + disk
  watermark already bound growth, and a reaper that sets `stopped` collides with the
  user-stopped guard (expired apps would become un-redeployable); needs a
  `stoppedReason: 'user' | 'expired'` design first. Separate PRD if a real box ever
  fills up.
- No per-key app scoping beyond the existing per-user `canAccess` model.
- No new isolation machinery: inherits the v2 posture (multi-user requires
  `isolation: docker`). Recommend docker isolation even for single-user agent
  targets — agent-authored *and* agent-triggered deploys remove the implicit
  human-review gate that folder-drop has.

## Preconditions

Already landed (verified against the code): watcher exclusion locks (M1.5), deploy
transaction + build logs (M5.1/M5.2), log rotation (P0-3), resource caps (P0-4).

Still open — must land before or with this PRD:

- **P0-6** — `drop.yaml` `domains:` claim validation: this endpoint makes the
  cross-tenant hostname hijack remotely reachable via an uploaded `drop.yaml`.
- **git-redeploy ownership gap** — `POST /git/redeploy/:name` has no `canAccess`
  check today (any `user`-role account can redeploy any tenant's git app by name).
  Pre-existing IDOR; this endpoint must not replicate it, and it should be fixed
  alongside.

## Design decisions from adversarial review

Three reviewers (security, simplicity, integration/blast-radius) critiqued the
draft. Adopted: land files the way git-deploy does instead of "atomic move +
unchanged watcher pipeline" (the original design was wrong for redeploys);
timestamp correlation instead of a first-class deployId (integration proposed a
`reserveDeployId` tracker method, simplicity showed per-app serialization makes it
unnecessary for v1 — kept as the escalation path); expiry reaper cut; MCP client
split into PRD-040 so its release isn't gated on server preconditions. Rejected:
making the endpoint synchronous (builds take minutes; `202` + poll matches the
event-driven pipeline).
