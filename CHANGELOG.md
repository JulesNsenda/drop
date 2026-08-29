# Changelog

All notable changes to DROP will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
  Release notes are machine-extracted from this file by the release workflow,
  so the section shape below is load-bearing, not just formatting:

  - A version heading MUST look exactly like this — no extra text, no
    trailing punctuation, ISO date:
      `## [X.Y.Z] - YYYY-MM-DD`
  - The extractor opens on that exact heading for the version being released
    and reads until the next line matching `^## ` (another heading), OR
    `^\[.*\]:` (a link-reference footer line), OR `^---$` (a horizontal
    rule) — whichever comes first.

  Changing the heading text, the date format, or introducing an unindented
  line that matches one of those three terminators inside a version's body
  will silently break extraction: a release ships with an empty body, a
  truncated one, or the wrong section entirely. If you need to show an
  example heading or footer line inside this file, indent it or wrap it in
  backticks so it can't be mistaken for a real one.
-->

## [Unreleased]

## [1.5.1] - 2026-08-29

A dashboard-only patch. One malformed API response could replace an entire page
with the error boundary at mount — not the panel that made the call, the whole
page, header and tabs and every action button with it. Nothing on the server
changed, and upgrading needs no configuration.

### Fixed

- **The app page white-screened on a degraded API response.** When the secrets
  endpoint returned an array instead of `{ keys: [...] }`, `data.keys` resolved
  to `Array.prototype.keys` — a function, so the `?? []` default never fired —
  and React called it as a state updater, throwing out of `basicStateReducer`.
  (#237)
- **The same array-versus-object assumption crashed six more pages.** A `{}`
  payload passes every `?? []` and `|| []` default, and a `length === 0` guard
  does not stop it either: `{}.length` is `undefined`, so the guard falls
  through to `.map()` on an object. The apps list, the deploy timeline, the git
  token list, the API keys tab, the activity log and the users page each went
  down that way; the access tab and two filtered lists are hardened alongside
  them. Verified against the real bundle: eight pages that failed on degraded
  shapes before the fix all render after it. (#237)

## [1.5.0] - 2026-08-28

Apps can now require a sign-in before anyone reaches them, owners can share an
app with a colleague, and a person with no DROP account can be invited to one
app by email. The dashboard was rebuilt on a real design-token system and is
usable from the keyboard throughout.

**Everything in the sharing program is opt-in.** `appSharingEnabled` defaults to
false, and an app with no policy behaves exactly as it did in 1.4.0 — upgrading
changes nothing until an admin turns something on.

### Added

- **App access gate.** An app can be put behind DROP sign-in, enforced at the
  proxy rather than by the app itself. The policy is `mode: 'drop-users'` with
  an explicit allow-list; the `mode` field is the seam a future identity source
  plugs into.
- **App sharing.** An owner can grant a colleague access to one of their apps
  without an admin round-trip, gated behind an admin-level toggle that is off by
  default.
- **Outbound mail.** An SMTP relay can be configured from Settings, with the
  password encrypted at rest and write-only over the API. Share notifications
  ride on it and ship default-off.
- **Guest access.** Someone with no DROP account can be invited to exactly one
  app by email and redeem a single-use invitation. Invitations expire, are rate
  limited per principal, and the mail body only ever contains the operator's own
  domain.
- **Dashboard: Overview and Activity tabs** on the app page. The deploy history
  was previously buried mid-scroll above the tab bar; it is now a destination of
  its own, and the tab bar sits directly under the header rather than reading as
  a footer.
- **Dashboard: per-row actions** on the apps list. Restart, stop, start and
  delete without opening the app first.
- **Dashboard: command palette.** Cmd-K (Ctrl-K off macOS) jumps to any page or
  any app.
- **Dashboard: a design-token bridge.** Every `.drop-ui` token is a Tailwind
  utility, with a lint guard so the hand-piped inline styles it replaces cannot
  come back.

### Changed

- The dashboard is keyboard-usable in places it previously was not: the confirm
  dialog traps focus and restores it, the tab bar is one tab stop with arrow-key
  navigation instead of one stop per tab, table headers are associated with
  their columns, loading states announce themselves, and hints that were
  mouse-only `title` attributes now appear on focus.
- Motion respects `prefers-reduced-motion`, which the dashboard previously
  ignored entirely.

### Fixed

- Two high-severity advisories in transitive dependencies (`js-yaml` quadratic
  CPU consumption, reached via pm2 and ts-jest) and one moderate
  (`protobufjs`, via dockerode). `npm audit` reports zero.
- A credential-invalidation test that could fail on a fast CI runner when a key
  was minted in the same millisecond as the suspension that should revoke it.

## [1.4.0] - 2026-08-22

Backing services can now be attached to and detached from a running app, from
the dashboard or the API, and everything the platform can attach is listed in a
searchable catalog.

**Detach destroys data, and the two services differ.** Postgres is dumped on the
platform host before the database and its role are dropped; that dump is an
operator-side artifact with its own retention window, not a restore button in
the dashboard. Redis is flushed immediately with no backup at all. The
confirmation dialog states which of the two you are about to do.

### Added

- **Extension catalog.** `GET /api/v1/extensions` lists every backing service
  and app type this build ships, with its availability on this instance
  (installed, disabled by configuration, or unsupported under the current
  isolation mode). A Catalog page in the dashboard makes the same list
  searchable and filterable. Availability is platform-scoped: per-app facts,
  such as whether a service is already attached or the owner's quota is full,
  come from `GET /api/v1/db/<app>`.
- **Attach a backing service.** `POST /api/v1/apps/<app>/services/<id>` (`<id>`
  is `postgres` or `redis`) provisions the service, records the choice, and
  restarts the app with its URL injected. The response names the injected
  variables but never their values. Available from an app's Database tab.
- **Detach a backing service.** `DELETE /api/v1/apps/<app>/services/<id>`
  deprovisions it and restarts the app without the variable, so it is genuinely
  gone rather than merely unused.
- **Attach and detach outrank `drop.yaml`.** The choice is recorded durably, so
  a redeploy cannot quietly undo it: without that, the next deploy would re-read
  `database: postgres`, or re-detect a Postgres client in `package.json`, and
  provision a fresh database straight back. Resolution order is
  `attach/detach > drop.yaml > auto-detection`. Once a service has been attached
  or detached for an app, that manifest key stops deciding the question for it,
  and re-attaching hands authority back. On an app deployed from a repository
  you do not own, this is what stops a stale upstream manifest re-provisioning
  against your quota.
- `GET /api/v1/db/<app>` also reports whether Redis is provisioned, the recorded
  intent per service, per-service quota state, and whether the app is ephemeral.
  A database recorded but missing on the server is now reported as a renderable
  state rather than an error, so the tab still offers its repair controls.

### Fixed

- **An app with a DROP-managed database can now be repointed at an external
  one.** Setting a `DATABASE_URL` secret was refused whenever a database was
  provisioned, on the grounds that the injected URL would override the secret
  anyway. With detach available that refusal became a lock-out: the data could
  be gone and the owner still could not supply their own URL. The gate now
  consults the recorded intent, so once a database is detached the secret is
  accepted. The published documentation claimed a provisioned database "cannot
  be handed back short of deleting the app", which detach makes untrue; it has
  been corrected.
- `pg_dump` is now bounded by a timeout and killed on expiry. A tenant holding
  an `ACCESS EXCLUSIVE` lock on its own database could otherwise make a dump
  wait forever, holding the platform's per-app lock until a restart.
- `DROP_PREDELETE_RETENTION_DAYS` no longer fails open. Any unparseable value
  disabled pruning entirely and kept full database dumps, plus their plaintext
  role-recreation files, forever.
- A failed Redis `FLUSHDB` no longer releases the logical database number. Two
  tolerated Redis blips could previously hand one app's keys to the next
  allocation.
- Pre-delete database dumps are attributed to their owner by location rather
  than by matching app names, so attribution survives the app's deletion and one
  owner's cleanup can no longer evict another's only surviving dump.

### Changed

- Platform-owned fields on an app's config (its recorded service intent, granted
  API scopes, ephemeral flags) are now written through a separate path from
  caller-supplied fields, and stripped from the general one.
- CI actions are pinned to commit SHAs with Dependabot configured to propose
  updates, build and test are defined once and shared by the CI and Deploy
  workflows, and the deploy artifact's digest is verified before it is shipped.


## [1.3.0] - 2026-08-14

A security fix in how `depends_on` reaches an app's environment, and support
for external databases through the encrypted secret store.

**Prioritise this upgrade if you deploy a `drop.yaml` you did not write** — a
third-party repository via `deploy_from_git`, or an agent-authored manifest. On
those paths the manifest author and the app owner are different people, and a
`depends_on` entry could overwrite any variable in the app's start environment,
the owner's own secrets included. A box that only ever deploys its operator's
own code was never exposed to the sharp half of this.

### Security

- **`depends_on` in `drop.yaml` could overwrite anything in an app's start
  environment.** Resolved dependency URLs were applied last, so a `depends_on`
  entry could name any variable and silently win — a platform value such as
  `DROP_API_URL` (redirecting where the app sends the scoped control-plane key
  DROP mints for it), a provisioned `DATABASE_URL` or `REDIS_URL`, **or any
  secret the app's owner had set**. The last of those is the sharpest: an
  overwritten secret also satisfied the required-secret preflight, because that
  check reads the merged environment — so instead of parking in `needs-config`,
  the app started with a session or signing key the manifest author chose.
  This matters most when deploying a third-party repository, where the manifest
  author and the app owner are not the same person.

  A `depends_on` entry may now only fill a gap in the environment, never
  overwrite an entry already in it. The collision is logged and that one
  injection is skipped, so an unrelated attempt cannot fail an otherwise valid
  deploy. The check compares against the environment actually assembled rather
  than a list of protected names, so a variable added in future is covered
  without anything to keep in sync. `depends_on[].env` values that are not
  usable environment variable names are skipped the same way — skipped rather
  than rejected during parsing, because a failed `drop.yaml` validation
  discards the entire manifest, which would both break already-deployed entries
  and disable the required-secret preflight that depends on the discarded
  `secrets:` block.

### Added

- **External databases can now be configured through the encrypted secret
  store.** Storing a `DATABASE_URL` secret (Supabase, Neon, RDS, an external
  MySQL) was refused outright, which left a plaintext `env:` entry in the
  tenant's own `drop.yaml` as the only way to point an app at one. It is now
  refused only when the app already has a DROP-managed database, whose
  injected URL takes precedence over any secret and would override it anyway.
  `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` and `PGDATABASE` stay reserved,
  alongside `PORT`, `NODE_ENV` and `DROP_DATA_DIR`.

### Fixed

- **`database: true` silently discarded an app's `env:`, `secrets:` and
  `services:`.** The validator required `database` to be a string, so
  `database: true` failed validation and the whole manifest was dropped —
  while a second, unvalidated reader went on provisioning the database, making
  the loss easy to miss. `database` now accepts a boolean at the top level and
  per service, matching what the platform actually acts on.
- **A monorepo service's `database` declaration survives materialisation.** The
  generated child config was written with a truthy test, so `database: false`
  was dropped entirely rather than passed down. Note that `database: false`
  still does not decline a database — it falls through to auto-detection, as it
  always has. Making it a real opt-out needs a deprovision story first, since an
  app that already has a DROP-managed database cannot hand it back.

## [1.2.2] - 2026-08-13

One data-loss fix on the upload deploy path, and a dashboard fix.

**If you have ever deployed by upload, re-upload those apps after upgrading.**
Every release that has the upload path — 1.0.0, 1.1.0, 1.2.0 and 1.2.1 — can
write an uploaded file to disk with its opening bytes missing and still report
the deploy as successful. Upgrading stops it happening again; it does not
repair a tree that already landed short. Only a re-upload does, and a rebuild
does not: rebuilding from truncated source reproduces the truncated output.

**Checking is not a substitute for re-uploading, and a clean scan is not an
all-clear.** Which files are hit depends on chunk scheduling, so it varies per
deploy and a clean tree today says nothing about the deploy before it. The one
signal available finds only the extreme case — a small file losing its only
chunk and landing at zero bytes — and it will happily report clean on a tree
that lost 512 bytes off the front of a file, which is the ordinary outcome.
Measured that way on one fleet: the scan came back clean while an app on it had
been uploaded on the affected code. Use it to find damage, never to rule it
out:

```bash
sudo find /var/drop/data/webapps -type f -empty -not -path '*/node_modules/*'
```

**A running app is not evidence of a clean tree.** Extraction lands files over
the live app directory *before* the build is published, so when the truncation
breaks the build the corrupted tree is already on disk while the previously
built process keeps serving. A prebuilt static app is served as-is with no
install or build at all, so nothing there ever fails — a truncated asset is
simply served.

### Fixed

- **Uploaded files could land truncated, with the deploy reported as
  successful.** `extractTarball` attached a byte-counting `entry.on('data')`
  listener and then called `entry.pipe(ws)`. Attaching a `'data'` handler is
  what puts the stream into flowing mode, so the entry began emitting before
  `pipe()` had wired up the write stream, and every chunk in that window was
  counted and then dropped. The file landed missing a whole number of leading
  512-byte tar blocks. Nothing detected it: no warning, no error, and both
  `fileCount` and `bytesWritten` looked correct, because the byte count had
  counted precisely the bytes that never reached disk.

  Observed on a real 164-file upload: **12 files truncated by 512-10240 bytes,
  including a 2044-byte file written as 0 bytes.** The damage surfaces much
  later and points the wrong way — the build fails inside the uploaded
  application's own source with a parse error like `Unexpected "}"` on a file
  that now starts mid-token, naming a different file on each deploy. It reads
  as a bug in the customer's code.

  Byte accounting now sits inside the pipeline as a `Transform`
  (`entry.pipe(counter).pipe(ws)`) rather than on a side listener. Swapping the
  two statements is not sufficient and was rejected: it fixes content integrity
  but then under-counts, because the chunks `pipe()` consumes never reach a
  listener attached afterwards (measured ~7% low on the test archive), and
  `maxUncompressedBytes` is the decompression-bomb control — under-counting
  silently raises the real ceiling.

  Affects both upload entry points: `POST /api/v1/apps/:name/source` and the
  MCP `deploy_files` tool. Present since the upload deploy path first shipped
  (PRD-039), so every release before this one carries it.

  This is **not** the truncation 1.2.0 addressed, despite both being described
  as truncation. That one was about entries the tar parser *rejects*, which
  were silently dropped whole and are now fatal; its closing note about a
  stream cut off mid-way describes a case 1.2.0 explicitly left open. Here the
  entry arrives intact and the parser is perfectly happy — the bytes are lost
  between the parser and the file. Upgrading to 1.2.0 did nothing for it.

- **The dashboard's app list no longer blanks itself on every poll.** The
  polling hooks re-raised `loading` on each interval and the apps page gates
  its empty state on `!loading`, so a refresh cleared the list before repainting
  it — which read as "slow to load" at first paint and "refresh deletes
  everything" five seconds later. Both were the same bug.

## [1.2.1] - 2026-08-11

One security fix, and a correction to the note published with 1.2.0.

**Upgrading is not enough on its own — restart your static apps.** The nginx
config is regenerated from `buildStartSpec`, which runs on start *and* on
restart, so `drop restart <app>` (or the dashboard's Restart button, or the
MCP `restart_app` tool) applies the fix. A full redeploy is not required.

**Before restarting**, this tells you whether an app is exposed:

```bash
curl -o /dev/null -w '%{http_code}\n' https://<app>/.git/config   # 200 = exposed
```

**After restarting it reads 404 either way**, so it can no longer answer "was
I exposed, do I need to rotate a token?". That question is settled on the box,
and upgrading does not erase the evidence:

```bash
sudo grep -hE '^\s*url\s*=' /var/drop/data/webapps/*/.git/config | grep '@'
```

Any app listed there was cloned with a personal access token in its remote
URL. If it is also a **plain-root** static app (`outputDirectory` is the app
root, not `dist`/`build`), that token was publicly fetchable — **rotate it**.
The 404 stops the bleeding but does not un-publish what was already fetched.

### Security

- **A static app no longer serves its own dotfiles.** The generated nginx
  config now returns 404 for any path with a `.`-prefixed segment, at any
  depth, with `.well-known/` carved out. For a **plain-root** static app the
  document root *is* the app directory, so `try_files $uri` happily served
  `/.git/config` — the full repository history, and for an app cloned before
  1.2.0 the personal access token baked into it — and `/.env`. Measured
  against `nginx:alpine` before and after: `GET /.git/config` returned **200
  with the token in the body**, and now returns 404.

  This corrects the note published with 1.2.0, which named Caddy's
  `file_server` as the culprit. It is not: `staticPath` is never set, so that
  branch is dead code. Static apps are served by nginx in their own container
  and Caddy only reverse-proxies to it. The exposure was real, the component
  named was wrong.

  An **SPA is unaffected** — its root is `/app/<outputDirectory>`, so `.git`
  sits outside the document root. That asymmetry is why this went unnoticed:
  the SPA case, which is most apps, was always safe.

  Takes effect when the app's nginx config is next regenerated — a restart is
  enough, see the upgrade note above.

## [1.2.0] - 2026-08-09

Two security fixes that change behaviour, and the recovery path for a repo
that goes private after it was deployed.

**Read before upgrading — two compatibility breaks, both security-driven:**

1. **An upload carrying `.git` is now refused.** `tar -czf app.tgz .` from a
   working tree fails instead of silently deploying the repository's git
   metadata. Exclude it (`--exclude .git`), or deploy via `POST /git/deploy`.
2. **`gitSource.tokenId` is no longer returned below the admin tier**, and
   `gitSource.repoUrl` is normalized. Breaking for any script or agent that
   read `tokenId` from `GET /api/v1/apps/:name`.

### Security

- **Uploaded archives containing `.git` metadata are now rejected.** An
  archive with a `.git` path component — at any depth, case-insensitively —
  is refused with `reason: vcs_metadata` and nothing is extracted. Previously
  a tenant with the `user` role could upload a crafted `.git/` to
  `POST /apps/<app>/source`, where it overwrote the app's real one, and a
  subsequent `POST /git/redeploy/<app>` ran `git pull` in that directory **on
  the host** — never containerized in either isolation mode — so a poisoned
  `.git/config` (an `ext::sh -c …` remote URL, `core.fsmonitor`) executed
  arbitrary commands as the `drop` user, which is in the `docker` group and
  therefore root-equivalent.

  The guard reads the parser's resolved entry path rather than the raw tar
  header name, because a PAX extended header can override the path of the
  entry that follows it — a check against the header name would have closed
  nothing.

  **Behaviour change for hand-rolled clients:** `tar -czf app.tgz .` from a
  working tree now fails instead of silently deploying the repository's git
  metadata. Exclude it (`--exclude .git`), or use `POST /git/deploy` to
  deploy a repository. The MCP `deploy_files` tool rejects such paths before
  staging.

- **Dotenv files are excluded from a dashboard folder upload.** `.env`,
  `.env.local`, `.env.production` and the like are skipped (templates —
  `.env.example`, `.env.sample`, `.env.template`, `.env.dist` — still ship),
  and the upload panel lists exactly what it left out. For a static app the
  uploaded tree root is the web server's document root, so a shipped `.env`
  was fetchable at `/.env` on the public URL. Use the secrets API
  (`PUT /api/v1/secrets/<app>`) for values the app needs at runtime.

- **Personal access tokens no longer reach disk on either git path**
  (DROP-142). `git clone https://TOKEN@github.com/…` recorded the URL
  verbatim as `remote.origin.url`, so every app deployed from a private repo
  carried its PAT in cleartext inside its own directory — which is the served
  document root for a static app and is bind-mounted into the tenant's
  container under docker isolation. `gitPull` wrote the same value for the
  duration of a pull. Both now pass the token through a one-shot credential
  helper that reads it from the git child's own environment (never argv,
  which is world-readable via `ps`), scoped to `https://github.com` so a
  tampered remote URL cannot redirect the credential to another host.

- **Existing repositories are cleaned up on their next redeploy** (DROP-142).
  Closing the leak above does nothing for apps already on disk, and git
  *prefers* a credential embedded in the remote URL — so on exactly those
  apps the new helper would never fire. A redeploy now strips the userinfo
  from `remote.origin.url` before pulling. **Operator note:** an app that is
  never redeployed keeps the old value; grep for it with
  `sudo grep -hE '^\s*url\s*=' /var/drop/data/webapps/*/.git/config | grep '@'`.

  Not fully closed by this change: a plain-root static app still serves
  `/.git/config` — and its history — to the internet.

  **Correction, added in 1.2.1:** as published, this paragraph named Caddy's
  `file_server` as the component at fault. It is not — that branch is dead
  code, and static apps are served by nginx in their own container. The
  exposure was real and is fixed in 1.2.1; only the attribution was wrong.

### Added

- **A git credential can be attached to an app that already exists**
  (DROP-142). `POST /api/v1/git/redeploy/:name` takes an optional
  `{ "tokenId": … }`: absent leaves the app's stored credential unchanged,
  `null` clears it, a `git_…` id attaches or replaces one. Answers "a repo
  that was public and went private can no longer be updated" — the token was
  always stored by reference and re-read at redeploy, but nothing could write
  that reference after creation. The dashboard exposes it as a credential
  picker next to the existing Redeploy button on an app's detail page.

### Changed

- **`gitSource` is narrower for non-admin API consumers** (DROP-142).
  `GET /api/v1/apps/:name` no longer returns `gitSource.tokenId` below the
  admin tier, and `gitSource.repoUrl` has any userinfo stripped. The
  `gitSource` field itself stays present at every tier. Potentially breaking
  for a script or agent that read `tokenId` from an app record.

### Fixed

- **An archive whose entries the tar parser rejects no longer deploys as a
  partial tree.** node-tar runs non-strict here, so an entry with a bad
  checksum was silently dropped while extraction still reported success — and
  the destination was then pruned to match, deleting files that had gone
  missing. Any parser warning is now fatal (`reason: invalid_archive`), except
  the one node-tar emits for an archive with no entries at all, which still
  reports `empty_archive`.

  This closes the cases the parser *reports*. A tar stream truncated mid-way
  inside an otherwise-valid gzip wrapper is still extracted up to the
  truncation point, because node-tar signals nothing at all in that case —
  measured, and not something a warning-based check can reach.

- **Clearing a git credential actually clears it** (DROP-142). A clear is
  persisted before the pull rather than after it — otherwise the now
  unauthenticated pull fails against a private repo and the clear is
  discarded, leaving no way to detach a compromised token.

- **Git operations are pinned to the app's own repository** (DROP-142).
  They ran with only a working directory, so an app whose `.git` had been
  removed — by an upload deploy's prune, or a monorepo re-materialization —
  resolved to whatever repository existed *above* it and reported that
  repo's commit as the app's own.

- **Container CPU is no longer under-reported by the host core count**
  (DROP-143). The core count was derived from `percpu_usage`, a cgroup
  v1-only field. Under cgroup v2 — the default on current Debian and Ubuntu —
  Docker omits it and reports `online_cpus` instead, so the divisor fell back
  to 1 and every reading on the dashboard was the true figure divided by the
  number of host cores.

- **"Back to home" on the login and signup pages works again** (DROP-145).
  It linked to `/`, which since the site split resolves to the dashboard's
  own host, redirects to `/dashboard`, and sends a logged-out visitor
  straight back to `/login` — a closed loop. It now points at the marketing
  host, and renders nothing at all on a single-host install, which has no
  landing page to return to.

## [1.1.0] - 2026-08-09

The marketing site moves out of the platform, a `drop.yaml` field that was
accepted but never read starts working, and four fixes land — every one of
them found by running the site split, not by reviewing it.

### Added

- **`port:` in `drop.yaml` is now honoured.** It has always been an
  accepted, typed, validated field that nothing ever read, so an app that
  declared a port still got an arbitrary one and had no way to find out. It
  applies as a *preference*, never a claim: a port already held by another
  app, one outside the configured range, or the DROP API port itself falls
  through to normal allocation with a warning rather than failing the
  deploy. Useful wherever something outside DROP hardcodes the upstream
  port — a hand-written reverse-proxy host file, say. Check the app's
  actual port after declaring one.

### Changed

- The marketing site, docs and API reference now live in their own repo,
  deployed as a separate app at dropkit.sh — the platform no longer builds
  or serves `/`, `/docs` or `/reference`. `/` now 301-redirects to
  `/dashboard`; self-hosted installs that relied on the API-info JSON
  previously returned at `/` will see a redirect instead. Release bundles
  no longer contain a `dist/site` directory.

### Fixed

- **`/api/v1/health` no longer flaps between healthy and degraded.** Under
  Docker isolation the liveness probe was collecting live CPU and memory
  for every container — roughly a second each — against its own 2000ms
  budget. It emitted intermittent 503s on jitter while the runtime was
  perfectly healthy, and degraded monotonically with every app added. The
  probe now asks the runtime only whether it is reachable and how many apps
  it manages; per-app stats are unchanged for the dashboard's own views.
- **Single-page apps deployed from source can be built under Docker
  isolation at all.** The build and the runtime shared one image choice, so
  a static/SPA app was built in `nginx:alpine` — which has no npm, so the
  build could not succeed. Builds now select their own image and the app is
  still served from nginx.
- A tenant can no longer claim a hostname another app derives from its own
  name: the reserved-host check saw only hostnames declared under
  `domains:`, missing every implicit `<name>.<suffix>`.
- `install.sh --provision` no longer overwrites a hand-edited apex Caddy
  host file on each run. It creates the route only when absent, and refuses
  to write through a symlink.

## [1.0.0] - 2026-08-07

First public release. DROP now runs tenant apps under either PM2 or Docker
container isolation behind one runtime interface, exposes itself to coding
agents through a hosted MCP server with OAuth 2.1, and adds the guardrails,
monorepo support, and managed services needed to let an agent deploy safely
and unattended. This section also carries everything shipped but never
previously published since 0.1.0.

### Security

- **Access control:** ownership enforcement on app mutation and log
  endpoints (`PUT /apps/:name` accepts only a safe field allowlist — no more
  `userId`/`path` overwrites); every deploy path (upload, git, agent
  tooling) contains itself inside the webapps directory via a realpath
  check that defeats symlink/junction/`..` escapes.
- **Multi-tenant isolation:** a tenant-authored group or domain name can no
  longer collide with, delete, or route-hijack another owner's app; a
  colliding database name is refused instead of silently reused; deleting
  an app now purges its logs and retained deploy artifacts instead of
  leaving them readable by the next owner of that name; monorepo
  materialization no longer lets one service's build escape into a
  sibling's directory, and a dangling symlink can no longer squat a child
  app's name.
- **Auth & API keys:** authentication is on by default (`DROP_DISABLE_AUTH=true`
  to disable); JWT verification pinned to HS256; legacy password hashes are
  compared in constant time and upgraded to scrypt on login; `/auth/signup`
  is rate-limited; an API key's standing now derives from its owner instead
  of the key being its own principal (which had let a suspended owner's
  keys keep working, and orphaned apps/quotas); suspension and password
  resets are reversible and contained rather than destructive; the
  `users:create` capability can no longer be escalated into arbitrary code
  execution.
- **Agent & MCP surfaces:** the untrusted-output fence around tenant-
  controlled text — which stops a deployed app's text from acting as a
  prompt injection against a model reading it — can no longer be forged or
  bypassed; the MCP `forward_auth` guard in front of a tenant's own MCP
  endpoint now actually rejects every credential class except an
  app-audienced bearer, instead of admitting others; per-app OAuth
  audiences stop one app's token from reaching another app's MCP endpoint;
  agent tokens carry an explicit scope grammar and are admitted narrowly at
  the deploy gate.
- **Guardrails:** closed several bypasses a dedicated security review found
  in the agent-deploy guardrails — the circuit breaker and per-principal
  quotas were inert on the exact code path an autonomous deploy loop rides,
  and the idle reaper's dry-run budget was being spent by no-op sweeps
  instead of real ones.
- **Build isolation:** tenant build commands no longer inherit platform
  secrets, on both the host and containerized build paths; `install.sh` no
  longer lets root execute drop-authored code, and the bundled Postgres
  gets its own hardened, dedicated socket directory.
- **Webhooks:** GitHub webhook signature verification no longer skips when
  the header is omitted, guards `JSON.parse`, and length-checks before
  `timingSafeEqual`; outbound webhook URLs reject localhost/private/
  link-local targets (SSRF).
- **Secrets:** app secrets are encrypted with a standalone `encryption.key`
  (or `DROP_MASTER_KEY`) instead of a key derived from the store itself;
  existing stores migrate transparently.
- **Misc:** CORS defaults to same-origin (`DROP_CORS_ORIGINS` to allowlist);
  a Content-Security-Policy is set; git branch names are validated;
  `webhooks.json` is `0600`; 500 responses no longer leak internal error
  text.

### Added

- **Install from a published release.** `install.sh --from-release` downloads
  the prebuilt bundle attached to a GitHub release, verifies its SHA-256 before
  extracting anything, and installs without a `git clone` or any TypeScript or
  Vite build on the target machine. It requires an explicit `--isolation=docker`
  or `--isolation=none` on a first install, because that choice decides whether
  tenant apps run in containers or as the system user that owns the platform's
  encryption key — a one-line install command should not pick that silently.
  Node.js, PostgreSQL and Caddy are provisioned for you; no C toolchain is
  needed, since the last native dependency was removed. Every release also
  attaches `install.sh` and both checksums as individual assets, and the
  landing page, documentation and README link them directly, so the bundle can
  be fetched and inspected by hand before anything runs as root.
- **Docker isolation mode.** `AppRuntime` is a formal seam with two
  implementations — PM2 (`isolation: none`, the default) and Docker
  containers (`isolation: docker`) — chosen once at boot from
  `config.isolation`/`DROP_ISOLATION`. Container builds run in ephemeral,
  non-root containers; static/SPA apps are served by an unprivileged nginx
  with zero capabilities; Postgres has its own container-mode topology; live
  stats and log streaming work the same way under both runtimes. `drop
  migrate-runtime` moves an existing app between the two.
- **Hosted MCP server + OAuth 2.1.** `POST /api/v1/mcp` (PRD-040) exposes
  DROP's own deploy/status/logs tools to Claude and other MCP clients.
  OAuth 2.1 with PKCE (PRD-041) authorizes claude.ai's web connector,
  including per-app MCP audiences and a `revocation_endpoint`.
- **Agent-deploy guardrails.** A circuit breaker trips on a failing deploy
  loop and resets on the first success; per-principal *and* per-owning-user
  deploy quotas cap throughput regardless of outcome; ephemeral, TTL'd apps
  (default 60 minutes, promotable to permanent) give agents a safe scratch
  space; an idle reaper tears down abandoned agent-created apps; a per-app
  disk ceiling blocks a deploy before it exhausts the box. Every limit
  returns a structured refusal instead of a silent kill.
- **Monorepo / multi-service deploys.** A `services:` block in `drop.yaml`
  expands one repository into N apps sharing a hostname, with
  browser-reachable `depends_on` URLs, same-origin `/api` routing, and
  group-aware start/stop/teardown/redeploy.
- **Managed Redis (PRD-050).** A bundled Redis server provisions a per-app
  logical database and injects `REDIS_URL` for apps that opt in via
  `drop.yaml`.
- **Public site, docs, and reference — split from the dashboard (DROP-070).**
  `/`, `/docs` (PRD-043) and `/reference` (PRD-044) build as a separate
  bundle from the authenticated `/dashboard` SPA, so a marketing visitor's
  download never carries admin-only code.
- **Database panel.** The dashboard's App Details page can browse an app's
  provisioned database, reading it as the app's own database role rather
  than an admin credential.
- **Multi-user MCP connectors.** Non-admin users can set up their own
  claude.ai connector; an admin-controlled `userConnectorsEnabled` platform
  setting gates whether the capability is offered at all.
- **Agent-native deploy tooling:** tarball upload deploys
  (`POST /apps/:name/source`, PRD-039); scoped agent tokens
  (`POST /auth/agent-tokens`) with a stable principal identity per caller;
  a structured result for every deploy — a real error code, build-failure
  classification from the log tail, and `GET /deploys/:deployId` /
  `get_deploy_logs` to see why a specific deploy failed, with logs retained
  past teardown.
- **Required secrets preflight (PRD-051).** A deploy with `drop.yaml`
  `secrets:` missing is parked in a `needs-config` status instead of
  crash-looping, surfaced in both the API and dashboard.
- **Boot reconciliation.** A platform restart no longer rebuilds every app
  on the box; already-running apps are reconciled against their config
  instead of redeployed.
- **`DROP_API_URL` + scoped `DROP_API_KEY`.** Apps an admin grants
  control-plane capabilities can call DROP's own REST API from inside their
  own container/process with a least-privilege key, instead of needing the
  admin key.
- **Auth:** opt-in TOTP two-factor authentication; forced password change on
  first login; admin-manageable GitHub webhook secret with a reveal-once
  flow in the dashboard's Git settings tab.
- **CLI:** `drop restore` reverses `drop backup`; `drop backup` now also
  captures every per-app database, not just platform state.
- **Dashboard:** a log viewer (Runtime/Build tabs, stdout/stderr filter,
  search with highlighting, pause/resume, copy/download, severity
  color-coding, ANSI sanitization); settings reorganized into tabs (System /
  Account / Activity / About) with the active tab kept in the URL; a
  deploy-timeline panel and app-level Metrics tab (CPU/mem/uptime); a
  redesigned auth flow, app shell, and design system; session-expiry
  handling, a 404 page, logout redirect, an app-limit indicator
  (`GET /api/v1/usage`), and a signup-success notice.
- Continuous integration (GitHub Actions): lint, server build, tests, and
  both dashboard builds on every PR to `main`/`develop`.
- Atomic, crash-safe writes (temp + fsync + rename) for every JSON/YAML
  state store; a corrupt store is quarantined instead of silently wiped.
- `.env.example`, a LICENSE file, and a `files`/`prepublishOnly` package
  config.

### Changed

- `drop serve -d` now applies the `--root/--domain/--https/...` flags it
  forwards (previously ignored).
- Boot recovery: apps whose process died while marked `running` are set to
  `pending` (and restarted by the startup scan) instead of `stopped`.
- Version — `/health`, the CLI, `drop version`, and the dashboard — is read
  from `package.json` everywhere, replacing several hardcoded, stale
  version strings.
- Dashboard assets are served with immutable cache headers; `index.html` is
  `no-cache`.
- Git redeploy (API + webhook) always triggers a rebuild+restart after a
  successful pull, including no-change pulls, and onboards a freshly cloned
  app deterministically instead of waiting on the file watcher.
- `getAppRuntime()` returns whichever runtime is already active instead of
  defaulting to PM2, so a caller can no longer accidentally target the
  wrong adapter.

### Fixed

- Deploy pipeline: `build:completed` carries a `success` flag and the
  platform no longer starts an app after a failed build; the
  `appsInProgress` guard no longer leaks (which had permanently dead-ended
  hot reload).
- Process safety: `unhandledRejection`/`uncaughtException` handlers and a
  bounded, guarded shutdown; `waitForStatus` throws on timeout; build
  commands hard-timeout and kill the process tree; app logs are tail-read
  (no OOM on multi-GB files).
- Caddy stderr/unexpected exit is logged at warn and surfaced via
  `platform:error` instead of being swallowed at debug; a Caddy-rejected
  config is no longer misreported as "Caddy not running".
- The readiness gate no longer marks a healthy, slow-starting app as
  errored.
- Static apps now serve their built output directory instead of their
  source root.
- Resolved all ESLint errors; activity logging consolidated behind a
  best-effort `tryLogActivity` helper.

## [0.1.0] - 2026-01-18

First stable release of DROP with full deployment pipeline, hot-reload, and database auto-provisioning.

### Added

- **Hot Reload** - Automatic rebuild/restart when app files change
  - Detects changes to .ts, .js, .tsx, .jsx, .py, .go, .rs files
  - Detects changes to package.json, requirements.txt, Dockerfile, etc.
  - 2-second debounce to batch rapid changes
  - 5-second cooldown after deploys to prevent loops

- **PostgreSQL Auto-Provisioning**
  - Bundled PostgreSQL server with auto-start
  - Per-app database creation
  - Automatic `DATABASE_URL` injection
  - Secure credential generation

- **Port Persistence**
  - Per-app YAML config files in `appconf/webapps/`
  - Apps keep the same port across restarts
  - Port ownership tracking to prevent conflicts

- **REST API** (PRD-009)
  - JWT authentication
  - API key authentication
  - Endpoints: GET/POST /api/apps, GET /api/apps/:name
  - App management via API

- **Daemon Mode**
  - `drop serve -d` runs platform in background
  - Proper process detachment

- **App Config Service**
  - Per-app YAML configuration files
  - Stores: type, port, hostname, path, timestamps
  - Source of truth for port assignments

### Changed

- Router now updates existing routes instead of throwing errors (upsert behavior)
- File watcher uses polling by default on Windows for reliability
- State manager preserves port on app re-registration

### Fixed

- Port allocation now tracks ownership (Map instead of Set)
- Apps reuse their assigned port from config on restart
- No more "Route already exists" errors on hot-reload

### Technical

- 390 passing tests
- ESLint v9 flat config
- TypeScript strict mode

---

## [0.1.0-alpha.1] - 2026-01-03

### Added

#### Core Platform
- **Event Bus** (PRD-006): Typed pub/sub system for loose coupling between services
  - Event history tracking
  - Subscription management with unsubscribe support
  - Debug logging for event flow

- **Watcher Service** (PRD-001): File system monitoring for automatic app detection
  - Monitors `webapps` directory for new folders
  - Debounced change detection to prevent rapid rebuilds
  - Emits `watcher:change` events for detected apps

- **Detector Service** (PRD-002): Automatic application type detection
  - Node.js detection (package.json, npm/yarn/pnpm)
  - Python detection (requirements.txt, pyproject.toml, Pipfile)
  - Docker detection (Dockerfile, docker-compose.yml)
  - Static site detection (index.html, HTML files)
  - Framework detection (Express, NestJS, Next.js, Hono, Flask, FastAPI, Django)

- **Builder Service** (PRD-003): Application build pipeline
  - Strategy pattern for different app types
  - Node.js builder (npm/yarn/pnpm install + build)
  - Python builder (pip/poetry/pipenv install)
  - Docker builder (docker build)
  - Static site builder (copy files)
  - Build event emission for pipeline coordination

- **Process Manager** (PRD-004): PM2-based process lifecycle management
  - Start/stop/restart applications
  - Log streaming with follow mode
  - Process status monitoring
  - Automatic restart on crash

- **Router Service** (PRD-008): Caddy reverse proxy integration
  - Dynamic Caddyfile generation
  - Route management (add/remove/update)
  - TLS/SSL configuration support

#### CLI Commands
- `drop serve` - Start the DROP platform
- `drop list` - List all deployed applications
- `drop status <app>` - Show detailed app status
- `drop logs <app>` - View application logs
- `drop start <app>` - Start an application
- `drop stop <app>` - Stop an application
- `drop restart <app>` - Restart an application
- `drop deploy <path>` - Deploy app from path
- `drop remove <app>` - Remove an application

#### Infrastructure
- Cross-platform support (Windows and Linux/macOS)
- Configurable via environment variables
- Structured logging system
- Directory auto-creation on startup

---

[Unreleased]: https://github.com/JulesNsenda/drop/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/JulesNsenda/drop/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/JulesNsenda/drop/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/JulesNsenda/drop/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/JulesNsenda/drop/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/JulesNsenda/drop/releases/tag/v0.1.0
