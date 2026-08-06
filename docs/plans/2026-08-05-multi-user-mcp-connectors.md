# Multi-user MCP connectors

Date: 2026-08-05 (revised 2026-08-06 after the adversarial panel)
Branch (planned): `feature/DROP-131-multi-user-connectors`
Status: **awaiting approval**

## Goal

Let non-admin (`user`-role) accounts set up a claude.ai MCP connector against
this DROP installation — both against DROP's own control plane (scoped to the
apps they own) and against their own MCP-declaring apps — with a new platform
setting an admin can flip to gate the capability for everyone but admins.

## The finding that shapes this plan

Multi-user connectors **already work, ungated**. All four critics independently
verified every citation below against the current tree:

- `GET /oauth/authorize` has no auth middleware; it self-gates by redirecting
  to the consent SPA, which is not admin-gated (`App.tsx:78`).
- `POST /oauth/approve` sits at `authMiddleware('user')` (`server.ts:307`).
- `mayHoldTokenFor()` returns `true` unconditionally for `kind: 'drop'`
  (`routes/oauth.ts:116-117`).
- `canAccess()` limits a non-admin to apps they own (`access.ts:16-20`).
- Per-app tenant MCP resources work end-to-end (`oauth/app-resources.ts`,
  `drop-yaml-parser.ts:497-531`), with `canAccess` required for `kind: 'app'`.

The only thing stopping a non-admin is that they cannot **discover** the static
`client_id`: `/oauth/client` is admin-gated (`server.ts:309`) and the "Claude
(MCP)" tab is admin-only (`SettingsPage.tsx:321`). That is discoverability, not
authorization — the `client_id` is a public PKCE identifier with
`client_secret: null` and `token_endpoint_auth_methods_supported: ['none']`.

Two consequences:

1. The gate must live where grants are **minted and verified**, not in the UI.
2. A connector grants a non-admin **no capability they lack in the dashboard**
   (`/apps/*/source` and `/git/deploy` are both `user`-tier). The security
   critic walked every MCP tool and found no escalation path for a `user`-role
   OAuth principal. So this setting is operator policy, not a privilege fix.

**What the toggle does NOT cover** (security critic, medium/high — must appear
in the UI copy and docs, or the control becomes false assurance):
`mcpAuthMiddleware` also admits session JWTs, API keys, and agent tokens, and
`POST /auth/agent-tokens` is deliberately `user`-tier. Any user can still point
Claude Code at `POST /api/v1/mcp` with an agent token while the toggle is OFF.
The toggle disables **claude.ai connector setup**, not "MCP for users".

## Approach

`mayUseConnectors(role)` — one exported helper, `admin` always true, otherwise
the setting — consulted at **five** server-side sites. Two "don't mint", one
"don't extend", two "don't use":

| # | Site | File | Why here |
|---|---|---|---|
| 1 | `POST /oauth/approve` | `routes/oauth.ts:~296` | blocks the authorization code |
| 2 | `/token` `authorization_code` | `routes/oauth.ts:~370` | code may straddle a flip (60s TTL) |
| 3 | `rotateRefreshToken` **internals** | `middleware/auth.ts:~1437` | see below |
| 4 | `verifyOAuthAccessToken` | `middleware/auth.ts:~1272` | immediate kill |
| 5 | `verifyAppMcpAccessToken` | `middleware/auth.ts:~1205` | immediate kill, app-scoped |

Sites 4 and 5 sit beside the existing `record.enabled === false` check, which
is already a per-request `getUserById` re-read. Cross-reference all five in
comments and enumerate them in one test — five hand-placed sites is the
structure DROP-130 warns about, so the invariant must be pinned, not trusted.

### Two corrections the panel forced

**Site 3 was wrong in the draft.** The draft put the refresh check in
`routes/oauth.ts:~443`, *after* `rotateRefreshToken` at line 418 has already
spliced the presented record and persisted a replacement. Three critics caught
it (critical/high, high/high, medium/high). A refusal there returns
`invalid_grant` **after destroying the grant**, and the replacement is never
handed back — so flipping the toggle back ON restores nothing, every connected
user must re-consent, and one orphaned record accretes per failed attempt in
`api-credentials.json` (parsed linearly on every authenticated request). The
function's own comment at `auth.ts:1430-1436` states this reasoning for the
existing `enabled`/stamp checks: *"a caller-only check means containment rests
on every caller staying careful, which is not a boundary."* The check goes
**inside** `rotateRefreshToken`, pre-splice. This also answers draft risk #3:
match the `enabled` branch exactly — leave the record intact, so toggle-OFF is
reversible.

**Draft risk #1 was factually wrong.** It claimed a ≤15-minute lag was
unavoidable without new durable state. Verified false: `verifyOAuthAccessToken`
(`auth.ts:1272`) and `verifyAppMcpAccessToken` (`auth.ts:1205`) both re-read
the user record on **every** request and are the only gates those tokens pass.
Adding sites 4 and 5 collapses the window to zero with no new store. The
≤15-min caveat is removed from the UI copy.

### Scope of the toggle

**One toggle covers both DROP-scoped and app-scoped grants** — the plain
reading of the request. Consequence the security critic flagged (low/high) and
which therefore **must** be in the help text: flipping OFF also stops non-admin
users' own `mcp: auth: drop` tenant apps from refreshing, symptom a 401 from
the gateway. Splitting later is a one-line change (gate only
`target.kind === 'drop'`).

## Items — in dependency order

The architecture critic (medium/high) showed the draft's six items were not
independently revertable, and on this repo every `develop` commit is a
production deploy. Reordered so **the switch exists and is settable before
anything is enforced, and enforcement exists before the capability is
discoverable**. Each item is a self-consistent commit.

### Item 1 — The setting (inert; no behaviour change)

`src/managers/settings/settings-manager.ts`:

- Add `userConnectorsEnabled?: boolean` to `PlatformSettings`.
- **Extract it in `parseSettings()`** as a *spread-preserving* edit, not a
  rewritten return literal. `parseSettings` rebuilds from a whitelist and
  `doSave` persists `{...this.settings}`, so a key it fails to extract is
  **erased from disk on the next admin write** — dropping `publicUrl` would
  503 every OAuth route, 404 discovery, and kill the *existing admin*
  connector (arch high/medium; live-regression high/medium).
- **Fail closed on corruption.** `load()` currently swallows corrupt JSON into
  `{}` with a `console.error` that reaches no file. `?? true` would make this
  the store's only fail-open member: an admin's OFF silently reverts to ON
  after any parse failure (arch high/high, security medium/high, correctness
  medium/high). Add a `corrupt` flag set on the parse-failure branch; the
  getter returns `false` when the file existed but failed to parse, and `true`
  only when genuinely unset.
- Getter must use `?? true`, **never `|| true`** — `||` discards `false`, the
  security-relevant value.
- Setter follows `setPublicUrl`: persist to disk, *then* commit in memory.

### Item 2 — Admin route to set it

`src/api/routes/admin.ts`:

- Separate `buildUserConnectorsPayload()`, spread into the `GET /settings`
  handler **only** — not into `buildSettingsPayload()`, which is shared with
  the cleared-branch response of `PUT /settings/public-url` and would silently
  change a second endpoint's shape (arch medium/high).
- `PUT /admin/settings/user-connectors` — `{ enabled: boolean }`, strict
  boolean (reject, never coerce).
- Add the new action literal to the closed union at
  `src/managers/activity/activity-log.ts:14` — otherwise `tsc` fails
  (correctness low/high).
- Update the three exhaustive `toEqual` assertions in `admin.settings.test.ts`
  (lines ~126, ~138, ~157) in this same commit.

### Item 3 — Enforcement at the five sites

Export `mayUseConnectors` so it is testable without an HTTP round-trip (arch
low/high).

**DEVIATION FROM PLAN (implementation, 2026-08-06): the helper lives in a new
`src/api/connector-policy.ts`, not in `routes/oauth.ts`.** The plan sited it
beside `mayHoldTokenFor` on the architecture critic's reasoning (co-location
with its sibling predicate; `access.ts` rejected because it carries no runtime
manager dependency). That reasoning assumed only `routes/oauth.ts` would call
it. Sites 3-5 are in `middleware/auth.ts`, which `routes/oauth.ts` already
imports heavily from — so the planned home made the pair **cyclic**. The
implementer built it that way, verified it worked (the binding is only read at
request time, never at module-evaluation time), and correctly flagged it rather
than treating the plan's narrower cycle-check as cover.

Accepted the flag and broke the dependency instead: a cycle that works only
because no call site has been hoisted to module scope is a trap for the next
editor. `connector-policy.ts` imports only the settings manager, so nothing can
import its way back into it. `access.ts` remains the wrong home for the stated
reason.

- Read the setting **per request**. Never snapshot it into `ApiRuntimeConfig`
  or module scope — either would silently require a restart, contradicting the
  UI (live-regression low/high).
- At `/approve`, evaluate the admin bypass against **`auth.role`** (the clamped
  context role), not `approver.role`. Since DROP-130 an API key resolves to its
  owner with `minRole(key.role, owner.role)`; reading the account role would
  let a deliberately-downscoped `user` key owned by an admin bypass the toggle
  (correctness low/medium). At the `/token` sites there is no AuthContext
  (PKCE only), so the `User` record is the only option — note the asymmetry in
  a comment.
- **Distinct refusal for the policy gate.** Do not reuse `mayHoldTokenFor`'s
  indistinguishable "resource does not match" message (arch medium/medium,
  correctness medium/high, live-regression medium/high): the toggle is global
  and carries no existence oracle, so that refusal buys no secrecy and sends
  the operator debugging `DROP_PUBLIC_URL` and app MCP declarations — the most
  expensive wrong path. Return `access_denied` / "Connectors are disabled by
  your administrator" at `/approve`; keep `invalid_grant` at `/token` (claude.ai
  only understands RFC 6749 codes there). Add a
  `console.log('[oauth] connectors disabled', { userId, role })` matching the
  existing `[oauth]` style — `getLogger()` writes to no file, so `journalctl`
  is the only trail.

### Item 4 — Read-only connector info endpoint

**Do not touch `server.ts:309`.** The draft proposed method-scoping it; all
four critics attacked this (high/high, critical/medium, medium/high, high/high).
The `/apps/*` pattern it cited is a floor-raiser backed by a following
catch-all; `/oauth/client` has no such floor, so a faithful copy leaves either
`POST` (minting) or `GET` unauthenticated, and a mis-registration on `/oauth/*`
instead of `/oauth/client` would session-gate `/authorize` and `/token` and
break the live connector on the next refresh.

Instead: **new explicit path `GET /api/v1/oauth/connector-info`** with its own
`v1.use('/oauth/connector-info', authMiddleware('user'))`. Matches CLAUDE.md's
"register specific paths first, prefer explicit routes", never mutates the line
guarding live minting, is independently revertable, and rides the existing
`v1.use('/oauth/*', ...)` rate bucket (`server.ts:266`) — which resolves draft
open question 5: **no new bucket**.

- Uses the **read-only** `getOAuthClientId()` (`auth.ts:1517`) — never
  `getOrCreateOAuthClientId()`.
- Returns `client_id`, `client_secret: null`, `redirect_uri`, `mcp_url`,
  mirroring the POST response shape. *(Draft text said "GET already returns
  `mcp_url`" — no GET exists; that was an error, corrected here.)*
- Three distinct states the panel must tell apart: **503** (no public URL, from
  `requireOAuthPreconditions`), **404** (client never minted), **403** (toggle
  off).
- `getOrCreateOAuthClientId()` has exactly one caller — `POST /oauth/client`.
  On an install where the admin set the public URL by env and never opened the
  tab, a non-admin 404s forever with no remedy (arch medium/medium,
  correctness medium/high). Chosen fix: explicit copy — "an administrator must
  finish connector setup" — rather than minting at boot, which would change
  when `api-credentials.json` is first written.

### Item 5 — Dashboard

- Extract `ConnectorDetailsPanel` covering `McpConnectorTab.tsx:281-326` (the
  setup instructions + client-secret note + copy fields), keeping `CopyField`
  private to it. Extracting only the copy fields leaves the claude.ai setup
  steps duplicated, and the non-admin copy is the one that will rot (arch
  medium/medium).
- **Parameterise the fetcher.** The admin panel must keep calling
  `POST /oauth/client` (`McpConnectorTab.tsx:154`) — it is the only minting
  path in the product. A shared component that switches admin to the new GET
  means no `client_id` can ever be minted from the UI again (live-regression
  medium/medium). Note the tab distinguishes "not configured" by regexing
  `/not configured/i`; new error states need matching copy.
- **`SettingsPage.tsx` gates the tab in two places** — `:321` (push) and
  `:844` (render). The draft named only the first; changing one alone ships a
  tab that renders an empty pane (live-regression medium/high).
- Gate the tab on `role === 'admin' || role === 'user'`, **not**
  unconditionally — `readonly` can never complete `/approve` and would only
  ever see a 403 (correctness low/high). Tolerate `role` being briefly
  undefined while `useAuth` loads.
- `OAuthConsent.tsx` must render the disabled state (arch low/high) — it is the
  page a gated user actually lands on, and the draft omitted it entirely.
- Admin tab keeps `PublicUrlSection` + the new toggle. Disable one control
  while the other saves: `SettingsManager` setters are read-modify-write, and
  this is the first tab with two writers, so concurrent saves can silently drop
  one field with a 200 on both (correctness low/medium).
- Keep the shared component under `src/dashboard/src/components/` so it cannot
  reach the site bundle (DROP-070 invariant).

### Item 6 — Refresh-grant hygiene

Broadening from a handful of admins to every account is what makes these bite
(security medium/high):

- Publish `revocation_endpoint` in `buildAuthServerMetadata`
  (`oauth/metadata.ts:61-73`). Without it claude.ai cannot discover
  `/oauth/revoke`, so disconnecting a connector in its UI leaves a permanently
  valid grant server-side.
- Per-user cap on `RefreshTokenRecord`, evicting oldest-first. Records have no
  TTL and are pruned only by rotation, explicit revoke, or user deletion — and
  `api-credentials.json` is parsed on every authenticated request.
  **Constraint:** the cap runs in `issueRefreshToken`, which `rotateRefreshToken`
  calls *after* its splice. Eviction must never be able to drop the record being
  rotated, or a user sitting at the cap loses their grant on every refresh.

**Deferred with reason:** a full TTL redesign of `RefreshTokenRecord`, and a
dashboard grant list/revoke UI. Both are real, neither is caused by this change,
and the cap plus the discoverable revocation endpoint bound the growth this
change actually introduces.

**Also actioned here** (correctness low/medium): the `/oauth/*` bucket is
30 req/min **per IP**, and claude.ai's `/token` refreshes arrive from a handful
of Anthropic egress IPs sharing one counter. At ~30 connected users that starts
429ing refreshes, which claude.ai reads as a dead connector. **Fix = raise
`OAUTH_CONFIG.maxRequests`; leave the IP keying alone.**

**Plan defect, corrected before implementation (2026-08-06):** this line
originally said "key the `/token` limiter on `client_id`+`grant_type`". That is
wrong and no critic caught it. There is exactly **one** static `client_id` on
this platform, so that keying collapses the entire installation into two
buckets of 30/min — one user hammering reconnects would starve every other
user's refreshes. It is precisely the global-cap anti-pattern CLAUDE.md calls
out for `principal-quota` ("never global — a global cap is a DoS any tenant can
trigger"), and it would sit on the endpoint claude.ai polls. Per-user fairness
on refreshes, if ever wanted, is a `principal-quota`-shaped change and is not
in scope.

### Item 7 — Docs

- `docs/AGENT-DEPLOY.md`: connector setup for every user; **explicitly** that
  the toggle does not disable agent tokens or `POST /api/v1/mcp`.
- Public site Integrations section (`DocsContent.tsx`).
- `ReferenceContent.tsx:321` lists `POST /api/v1/oauth/client` as `role: admin`
  — add the new GET.
- **Correction to the draft:** `documented-samples.test.ts` does *not* read the
  `.tsx` files; it holds a hand-maintained copy (correctness low/high). A new
  `mcp:` sample must be added to `PUBLISHED_SAMPLES` by hand or it ships
  unvalidated. Also: `mcp` is in `ALLOWED_TOP_KEYS` but **not**
  `ALLOWED_SERVICE_KEYS` — do not document `mcp:` under a `services.<name>`
  entry; the parser rejects it.

## Tests

The draft had no test plan (arch medium/high) in a repo whose convention is a
colocated `*.authz.test.ts` per authorization boundary.

- `settings-manager.test.ts` — reload round-trip on the new key; **three-way**
  independence (set each of the three fields, assert the other two survive);
  stored `false` survives a reload; corrupt file → getter returns `false`;
  non-boolean stored value is discarded and logged.
- `oauth.flow.test.ts` — **add `resetSettingsManager()` to `beforeEach`/
  `afterEach` first**: the file has no settings reset, so the first toggle test
  would leak the singleton into every later test in the file. Then: key absent
  + admin → full happy path **including the refresh leg** (this single test
  kills both inverted-default and inverted-carve-out variants); toggle OFF +
  admin → still passes; toggle OFF + non-admin → refused at `/approve`, at
  `authorization_code`, and at `refresh_token`; **after a toggle-OFF refusal on
  refresh, the presented token still works once the toggle is flipped back on**
  (pins the pre-splice placement); toggle OFF → a live access token is rejected
  at `POST /api/v1/mcp` immediately, not after 15 minutes.
- New `oauth.connector-info.authz.test.ts` — no credential → 401; `readonly` →
  403; `user` → 200; toggle off + `user` → 403; unminted → 404.
- Regression tripwire: `GET /oauth/authorize` and `POST /oauth/token` with **no**
  Authorization header still reach their handlers (302 / OAuth-shaped 400,
  never 401).
- `admin.settings.test.ts` — new PUT, plus the three updated `toEqual` bodies.

## Gate 4 — runtime verification

Local, before any push (isolation `none`, Windows dev box):
`DROP_PUBLIC_URL=http://localhost:3000` (loopback http is permitted), auth
enabled.

**Admin baseline** — drive the real flow by hand: `POST /oauth/client` →
`/authorize` with an S256 challenge → `/approve` → form-encoded `/token` →
`POST /api/v1/mcp` `tools/list` → `grant_type=refresh_token`. Then flip the
toggle OFF and repeat **the refresh leg as admin** — it must still succeed.

**Non-admin path — this is the actual feature, and the admin baseline above
proves nothing about it.** Item 5 has *zero* automated coverage (the only
dashboard test in the tree is `db-format.test.ts`), so runtime observation is
the only net it will ever have. Create a second account via `POST /auth/users`,
then verify:

1. `user`, toggle unset → the full flow succeeds end-to-end, including refresh
   and a real `tools/list`.
2. Toggle OFF → that user is refused at `/approve` with the **distinct 403**
   (not the resource-mismatch message), and their still-unexpired access token
   stops working at `/mcp` on the **next call**, not in 15 minutes.
3. Toggle back ON → **the same refresh token they still hold works again**, no
   re-consent. This is the runtime proof of site 3's pre-splice placement, and
   the only check that catches the one-way-disable failure three critics
   flagged.
4. That user opens Settings → the Claude (MCP) tab renders with real values;
   a `readonly` account does not get the tab at all.

Diff guard before push: `git diff develop -- src/api/server.ts` must show only
an added `/oauth/connector-info` line — `server.ts:309` unchanged.

Post-deploy: `journalctl -u drop-platform -f | grep '\[oauth\]'` and wait for a
real `grant_type: 'refresh_token'` from claude.ai (up to ~15 min) plus one live
tool call. `deploy.yml`'s `/health/live` probe proves nothing about this path.

Before deploying, back up on the box: `settings.json` and
`api-credentials.json` (the latter holds `oauthClientId` and every live refresh
record). **And confirm `settings.json` actually PARSES** (`jq . settings.json`)
— if it is currently unparseable, site 5 will begin 401ing every non-admin
tenant-app MCP endpoint through the Caddy `forward_auth` gateway the moment
this deploys. One cheap check that de-risks the whole Item-3 surface.

### Gate 4 result — PASSED 2026-08-06, 32/32

Run against a **real `ApiServer` on a real TCP port over real HTTP**, out of
band from jest (harness kept at `scratchpad/gate4-drop131.ts`; the full
platform can't boot on this Windows box — no way to skip bundled Postgres —
so this is the same standalone-server method Gate 4 used for DROP-130).
Three accounts: admin, `user`, `readonly`.

Observed, in order:

1. **Non-admin, toggle at default (key ABSENT — the live box's actual state):**
   `connector-info` 200 with the admin-minted `client_id` and
   `client_secret: null`; `/approve` 200 → code; `/token` → access + refresh;
   `POST /api/v1/mcp` `tools/list` 200 returning the real tool set; refresh 200.
   The whole non-admin feature, end to end.
2. **Toggle OFF:** the *already-issued, still-unexpired* access token is
   rejected at `/mcp` **immediately** — this is the observation that proves
   sites 4/5 work and that the 15-minute-TTL caveat is genuinely gone.
   `/approve` 403 with the **policy** message (asserted NOT to be the
   resource-mismatch string), `connector-info` 403, refresh 400.
3. **Admin carve-out while OFF:** admin `connector-info`, `/approve`,
   exchange, refresh and `/mcp` all still 200 — an admin cannot lock
   themselves out of the switch they need to flip back.
4. **Toggle back ON:** the **same refresh token the user still held** works
   again, yields a usable access token, and that token is accepted at `/mcp`.
   This is the runtime proof of site 3's pre-splice placement — the thing three
   critics said the draft would have made permanent.
5. `readonly` → 403.
6. Tripwire: unauthenticated `GET /oauth/authorize` → **302** and
   `POST /oauth/token` → **400** (never 401), proving the new middleware did
   not land on `/oauth/*`.
7. Discovery advertises `revocation_endpoint`.

Sites 3, 4 and 5 were additionally **mutation-tested**: moving site 3
post-splice fails the reflip test; deleting site 4 turns the immediate-`/mcp`
rejection into a pass-through; deleting site 5 turns the gateway's expected
401 into a 204. Every gate is pinned by a test that fails without it.

**Still unverified (needs the live box):** behaviour against dropkit.sh's real
`settings.json` and `api-credentials.json`, and a real claude.ai connector
refresh. See the pre-deploy checks above.

**Gate sequencing deviation (recorded, not silent):** the skill's rule is that
each plan-item clears all four gates before its own commit. Gates 1 and 3
(conformance, tests) do run per item. Gates 2 and 4 do **not**: Gate 4 on Item 1
alone is meaningless (an inert store field has no observable runtime), and Gate
2 is materially stronger over the whole branch diff than over per-item slices —
`connector-policy.ts` and the two import rewires are exactly the kind of
cross-item seam a per-slice review cannot see. So Items 1-3 are committed on
Gates 1+3, and Gates 2+4 run once over `git diff develop...HEAD` before the
branch is pushed. Nothing ships to production between those points, because a
push is the deploy.

## Risks & open questions

1. ~~**`DROP_ALLOW_SIGNUP` on the live box — blocking for the default.**~~
   **RESOLVED 2026-08-06: signup is closed on dropkit.sh.**
   `grep DROP_ALLOW_SIGNUP /etc/drop/drop.env` returns nothing, and the systemd
   unit sets only `NODE_ENV`/`DROP_ROOT` inline plus
   `EnvironmentFile=-$ENV_FILE` (`install.sh:586-591`), so `allowSignup` falls
   back to `false` (`platform.ts:323`). The security critic's concern
   (medium/medium) was that open signup would let a stranger self-register and
   obtain a connector — it does not apply: every account is admin-created.
   **Default ON confirmed; the "no startup constraint" call stands**, since the
   toggle genuinely only affects accounts that already exist and can already
   deploy. Re-check this if signup is ever enabled.
2. Whether the live `publicUrl` is `stored` or `env`
   (`GET /admin/settings` → `source`) sets the severity of an Item-1 mistake.
   Mitigation is identical either way; worth knowing before the deploy.
3. One toggle covers app-scoped grants (above). Accepted; must be in the copy.
4. The toggle does not gate agent tokens (above). Accepted; must be in the copy.
5. Rollback limit: once the pre-splice placement is correct, a refusal leaves
   the grant intact, so revert-and-redeploy restores service. If Item 3 is
   implemented wrong, it does not — which is why the refusal-then-reflip test
   is mandatory.
6. **Corrupt-settings blast radius is wider than Item 1 alone implies**
   (surfaced by the Item 3 implementer, accepted). Wiring sites 4 and 5 means a
   settings file that exists but fails to parse now 401s every non-admin
   connector *and* every non-admin `mcp: auth: drop` tenant app, platform-wide,
   until an operator notices. That is the intended direction — a security
   policy store that cannot be read must not read as "permitted" — and it is
   largely moot in practice, since the same corrupt file also loses `publicUrl`
   and `requireOAuthPreconditions` then 503s the OAuth routes anyway. Admin
   connectors keep working throughout via the carve-out. Recorded because it is
   a consequence of Item 3, not of Item 1 where the fail-closed choice was made.

## Agent critiques considered

Panel: `security-critic`, `architecture-critic`, plus two `general-purpose`
critics with distinct schemas (correctness/claim-verification;
live-regression). All read-only, all with repo access. **49 findings: 3
critical, 6 high, 19 medium, 21 low.**

**All 9 critical/high findings actioned** — none rejected:

| Finding | Severity/confidence | Disposition |
|---|---|---|
| Refresh check post-consume burns the grant | critical/high (LR), high/high (corr), medium/high (sec) | Actioned — check moved inside `rotateRefreshToken`, pre-splice (Item 3) |
| Method-branch on `/oauth/*` would session-gate `/authorize`+`/token` | critical/medium | Eliminated — separate path, `server.ts:309` untouched (Item 4) |
| Inverted default or carve-out disconnects admin ~15 min post-deploy | critical/high | Actioned — the key-absent + admin refresh test (Tests) |
| `parseSettings` regression erases `publicUrl` from disk | high/medium (arch + LR) | Actioned — spread-preserving edit + three-way round-trip test |
| `/oauth/client` method split is a deny-list with no floor | high/high | Eliminated — separate path (Item 4) |
| `?? true` fails open on a corrupt settings file | high/high | Actioned — `corrupt` flag, getter fails closed (Item 1) |
| Literal `/apps/*` copy leaves `GET` unauthenticated | high/high | Eliminated — separate path with explicit `authMiddleware('user')` |

Medium/low findings adopted (not exhaustive): immediate-kill at the two verify
sites, which corrected a wrong claim in the draft; distinct policy refusal +
`[oauth]` log line; `auth.role` vs `approver.role` at `/approve`; separate
`buildUserConnectorsPayload`; both `SettingsPage` gate sites; `readonly`
excluded from the tab; `OAuthConsent` disabled state; parameterised fetcher
keeping admin on POST; activity-log union literal; `resetSettingsManager` in
`oauth.flow.test.ts` hooks; item reordering; `revocation_endpoint` + per-user
cap; `/token` rate-limit keying; `documented-samples` is hand-maintained and
`mcp` is not a valid `services.<name>` key; two factual errors in the draft
text corrected.

**Dropped:** 4 medium, 14 low — duplicates across critics, findings already
covered by an adopted fix, and items explicitly out of scope (agent-token UI,
full refresh-token TTL redesign, dashboard grant-revoke UI). Two findings were
"no issue found, recorded so it is not re-litigated": exposing `client_id`
creates no open-redirect or impersonation primitive (the pinned
`CLAUDE_REDIRECT_URI` defeats the consent-phishing variant), and no MCP tool
lets a `user`-role OAuth principal reach another tenant's app.

## Agent critiques considered — diff stage

### Items 5-7 (dashboard, hygiene, docs) · pass 2

Run because pass 1 covered only items 1-4 — items 5-7 had shipped with **no**
adversarial diff review at all, which is a gap worth naming rather than
quietly closing. `security-critic` + `architecture-critic` against
`git diff 17bb544..HEAD`. **24 findings: 0 critical, 1 high, 9 medium, 14 low.**

**The high finding was a defect I introduced in Item 6, and both critics led
with it:**

| Finding | Severity/confidence | Disposition |
|---|---|---|
| `revocation_endpoint` advertises a capability that does not exist | high/high (arch), medium/high (sec) | Actioned — endpoint rewritten to RFC 7009 |

Item 6's headline fix was inert. `POST /oauth/revoke` sits behind
`authMiddleware('user')`, which **explicitly 401s OAuth access tokens** — the
only credential claude.ai holds — and it reads a JSON `refresh_token` body
where RFC 7009 clients send form-encoded `token`. So every discovery-driven
revoke would 401 and the grant would survive, which is the precise gap the
item claimed to close. `revocation_endpoint_auth_methods_supported: ['none']`
was a false statement on top. **Advertising a compliance capability the server
does not honour is worse than shipping neither**, since every future MCP client
believes the metadata. Fixed properly rather than by withdrawing the claim.

**Two overstatement fixes on security-relevant copy** (medium/high and
medium/medium, security critic): my own Item 7 change labelled every
`mcp: auth: drop` app "Protected — DROP verifies an audience-bound token", and
`AGENT-DEPLOY.md` said the same. Both are false under `isolation: none` — the
guard lives only in Caddy, and `platform.ts` logs *"the app port is reachable
directly, bypassing the guard"* itself. This is the dangerous direction: an
operator reads "Protected" and skips app-side auth. Reworded to "guarded at the
proxy", with the bypass named in both places. **The two critics disagreed here**
— the architecture critic checked that the DTO reports `auth` faithfully (it
does) and called the label safe; the security critic checked whether the
*enforcement* the label promises actually exists (it does not, on non-docker).
Sided with security: the label makes a claim about protection, not about
declaration.

Other mediums actioned: `evictOldestRefreshTokens`' caller-must-be-careful
contract restructured so one function owns push+trim (CLAUDE.md's "prefer a
type-level invariant" rule — the docstring rule would have silently started
evicting the grant being rotated after any future reorder); a record missing
`createdAt` threw inside the comparator and 500'd `/token` **platform-wide**,
now fail-safe; eviction skipped `denyGrant(sid)`, so an evicted grant kept
working for its remaining 15 minutes, contradicting `revokeRefreshToken`'s own
documented rule; eviction was entirely silent, now logged; the `403 +
UNAUTHORIZED` pair the dashboard keyed on is also what `authMiddleware` returns
for insufficient role, so `readonly` users were told to ask an admin to flip a
switch that would not help them — the policy refusal now carries a
`connectors_disabled` reason marker, pinned server-side because the dashboard
has no test infrastructure; and the `apiFetch` switch dropped `apiJson`'s
network-error normalization, leaving the consent page's Approve button spinning
forever on an offline request.

Lows actioned: the admin toggle rendered ticked when `GET /admin/settings`
failed (failing open in the UI for a control that fails closed on the server);
public docs claimed "any signed-in user" sees the tab (false for `readonly`);
the docs dropped the admin's one-time minting curl, leaving a fresh headless
install in a documented 404 dead end; `ConnectorDetailsPanel`'s "purely
presentational" docstring invited reuse from the site bundle despite importing
`Toast`.

**A prescribed mutation test turned out vacuous, and was replaced rather than
declared green.** The brief for the eviction restructure said: remove the
`keepHash` exclusion, confirm the "user at the cap can refresh repeatedly" test
fails. It did **not** fail — and the implementer traced why instead of moving
on. During steady-state rotation at the cap a rotation removes one record and
adds one, so `excess` computes to 0 and the candidate/sort logic is never
reached at all; and because the new record is appended last with a monotonic
`Date.now()`, oldest-first eviction already spares it in every scenario the
other tests reach. The `keepHash` exclusion is only load-bearing when a stored
record carries a timestamp NEWER than the record being pushed — reachable
because `api-credentials.json` has no schema validation, the same gap as the
missing-`createdAt` case. A test seeding `2099-` dated records was added, and
that one does fail under the mutation. **A mutation test that passes proves
nothing until you know which branch it reached.**

**Deferred, with reasons:** the remaining shell duplication between
`McpConnectorTab` and `UserConnectorTab` (`ConnectorCard`/`ConnectorNotice`
extraction — cosmetic, and the panel that actually drifts is already shared);
making `documented-samples.test.ts` read `.md` fences instead of hand-copies
(a good idea, but a change to a shared test mechanism mid-branch);
`DROP_MAX_REFRESH_TOKENS` as an env override; and capping per
`(userId, resource)` rather than per user — the eviction log line makes the
ceiling diagnosable, which was the practical objection.

**Recorded as "no issue":** the DROP-070 import graph was traced by hand — this
diff adds no import to either site-bundle file; both `SettingsPage` gate sites
were confirmed changed with `readonly` reaching neither; the admin panel still
POSTs `/oauth/client`; and eviction cannot be weaponised across users
(`issueRefreshToken` is reachable only via the victim's own consent).

### Items 1-4 (server-side core) · pass 1

`security-critic` + `architecture-critic` against `git diff develop...HEAD`.
**20 findings: 0 critical, 2 high, 10 medium, 8 low.** Both critics also
independently confirmed the deploy is safe for the *existing admin* connector:
default ON plus the admin carve-out means nothing observable changes, settings
load before `ApiServer` is constructed, and the shipped tripwire tests prove
the new middleware did not land on `/oauth/*`.

**Both high findings actioned** — none rejected:

| Finding | Severity/confidence | Disposition |
|---|---|---|
| `corrupt` never cleared by a write, so the remedy path is broken — admin's PUT returns 200 with `{enabled:false}` and connectors stay dead until restart | high/high (arch), medium/high (sec) | Actioned — `doSave()` clears it on the success path |
| Site 5 (`verifyAppMcpAccessToken`) has zero coverage; deleting the gate is silently green and fails open | high/high (arch), low/high (sec) | Actioned — gateway test + `connector-policy.test.ts`, mutation-verified (401 → 204 without the gate) |

Medium/low actioned: `corrupt` covered only a `JSON.parse` throw, leaving
non-ENOENT read errors and non-object JSON failing open; `resetSettingsManager()`
ran ~90 lines before the API server stopped, failing the gate OPEN for a
multi-second window **on every deploy**; the five cross-reference comments still
pointed at `routes/oauth.ts` after the helper moved, and the header said five
sites when there are six callers; `mayUseConnectors` took a bare `string`, so
`mayUseConnectors(auth.userId)` would type-check and hit the permissive branch;
the policy gate ran after the public-URL precondition so a 503 masked the 403;
the duplicated connector response literal; the admin PUT 500ing on a non-object
body; the `FORBIDDEN` whole-codebase claim moved to `types.ts`;
`mcp-gateway.test.ts` self-instantiating a `SettingsManager` at the real
`C:\drop` path; the OAuth rate bucket raised 30 → 120 (Item 6 pulled forward,
since this change adds dashboard traffic to a bucket already known to be
undersized). The commit message for items 3+4 was amended: it claimed the two
items' hunks were interleaved and needed hunk-level staging, which is false
(@@283/@@405 vs @@536) — the honest reason is that they were written together.

**Deferred, with reasons:**
- **`resolveLiveTokenOwner` extraction** (arch medium/medium) — sites 4 and 5
  duplicate a four-check owner-liveness sequence, and extracting it would make a
  future sixth verifier inherit the gate automatically. Real, but it refactors
  two hot, already-verified security functions beyond this change's scope; the
  duplication predates this branch. Worth doing separately.
- **Shared `startTestApiServer` helper in `src/api/__testutils__/`** (arch
  medium/medium) — three copies of the real-ApiServer harness now exist. Test-only
  churn; deferred rather than reshaping three suites mid-branch.
- **Full `RefreshTokenRecord` TTL redesign and a grant list/revoke UI** — already
  recorded as out of scope in Item 6.

**Recorded as "no issue, do not re-litigate":** the five-site set is complete
(both critics traced every mint/extend/verify path including `mcp-gateway.ts`);
site 3's pre-splice placement cannot burn the presented token; `server.ts:309`
is unchanged; HEAD/OPTIONS reach nothing unexpected; the new 403 and `[oauth]`
log lines leak nothing the previous refusal protected.

**Superseded:** the blocking condition below was closed by Items 5 and 7 —
the caveat now lives in the admin toggle's own help text and in the tracked
`docs/AGENT-DEPLOY.md`, not only in this gitignored file.

**Was open, blocking the push:** the toggle does not gate agent tokens or
`POST /api/v1/mcp` (any user can still mint an agent token and use Claude Code).
The plan accepted that scope **on condition the caveat appears in UI copy and
docs** — Items 5 and 7. Until those land, the control ships with its caveat
living only in a gitignored plan file, so **items 1-4 must not reach `develop`
ahead of Item 7** (a push is a production deploy).

## Run stats

```yaml
date: 2026-08-05
slug: multi-user-mcp-connectors
gear: full
effort_plan: high
effort_diff: high
findings_plan_actioned: 31
findings_plan_rejected: 0
findings_plan_dropped: 18
findings_diff_actioned: 40
findings_diff_rejected: 6
findings_diff_dropped: 0
escaped: 3
agents_spawned: 22
gates_failed_first_pass: 1
escalated_from: none
```

Notes on the honest numbers, since several look flattering and one does not:

- **`findings_plan_rejected: 0`** is not a claim the plan panel was flawless —
  it is that nothing it raised was worth arguing with. 18 were dropped as
  duplicates across four critics, findings already covered by an adopted fix,
  or explicitly out of scope.
- **`findings_diff_*`** sums both diff passes: pass 1 (items 1-4) 21 findings,
  2 rejected; pass 2 (items 5-7) 24 findings, 4 rejected. Pass 2 existed only
  because pass 1 had covered items 1-4 and items 5-7 shipped without any
  adversarial review — a real gap, caught by re-reading my own gate record.
- **`escaped: 3`** — defects both critic passes missed:
  1. The plan's Item 6 instruction to key the `/token` rate limiter on
     `client_id`+`grant_type`. There is exactly one static `client_id`, so
     that would have collapsed the whole installation into two buckets and let
     any one user starve every other user's refreshes — a DoS lever on the
     endpoint claude.ai polls. Four plan critics read that line and none caught
     it; the advisor did, before implementation.
  2. The plan's premise that `rotateRefreshToken` delegates to
     `issueRefreshToken`. It does not — it pushes a record directly. Caught by
     the implementer, who applied the cap at both push sites rather than
     silently following a false premise.
  3. `userConnectors` being blanked from dashboard state after every Public URL
     save (the PUT deliberately returns the narrower payload), which would have
     thrown on the next render. Caught during Item 5's implementation. No
     critic pass had seen that code yet, which is the same gap pass 2 closed.
- **`gates_failed_first_pass: 1`** — Gate 2 only. Gates 1 and 3 passed per item;
  Gate 4 passed 32/32 first time and again unchanged after the pass-2 fixes.
- **`agents_spawned: 22`** — 2 orientation, 4 plan critics (+4 relaunched after
  a session-limit kill, counted), 8 implementers, 4 diff critics (+2 relaunched
  after watchdog stalls, counted). Relaunches are counted because they cost
  tokens; the plan-critic relaunch produced the only findings, the first four
  died before reporting.

The most useful row here is `escaped: 3`. Two of the three were defects in the
**plan text itself** that survived a four-critic adversarial panel, and both
were caught by someone reading the plan again later with implementation in
hand. A panel that reviews a plan is not a substitute for re-reading it when
the code disagrees with it.
