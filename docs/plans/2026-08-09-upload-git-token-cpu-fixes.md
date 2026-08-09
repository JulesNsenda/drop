# 2026-08-09 — Dashboard upload, git-token recovery, container CPU accuracy

Origin: three user-reported defects. Tracing them surfaced a fourth issue — an
authenticated remote-code-execution chain — which is promoted to **Item 0** and
ships first.

Prod context: dropkit.sh, **docker isolation**, dashboard + API + OAuth issuer
on `dashboard.dropkit.sh`. The `drop` user is in the `docker` group, i.e.
**root-equivalent** (`install.sh:153`).

---

## Goal

1. **Item 0 (DROP-144, security)** — refuse `.git` metadata in uploaded
   archives, closing an authenticated RCE against a root-equivalent account.
2. **Item 1 (DROP-141)** — make dashboard upload-deploy work at all.
3. **Item 2 (DROP-142)** — let an operator attach a credential to a
   git-deployed app whose repo went public → private, and stop the PAT being
   written into the tenant's own document root.
4. **Item 3 (DROP-143)** — stop under-reporting container CPU by the host core
   count.

Ends at **PRs opened**, not merged. See *Deploy consent* below.

---

## Item 0 — DROP-144: uploaded `.git` metadata is a host RCE

### The chain (every link verified in code)

| # | Step | Evidence |
|---|---|---|
| 1 | A `user`-role caller deploys any public repo → an app they own with a `gitSource` | `server.ts:344` (`/git/deploy` = `user`) |
| 2 | They `POST /apps/<app>/source` a tarball containing a crafted `.git/` | `apps.ts:479`, `server.ts:288` (`user`) |
| 3 | `extractTarball` has **no path-name filter** — only a type filter | `tar-extract.ts:61, 204-214` |
| 4 | `landFiles` → `syncTree(..., {preserve: DEFAULT_PRESERVE})`; `DEFAULT_PRESERVE` is **`['node_modules']`** only, so the real `.git` is overwritten and pruned to match the tarball | `upload-deploy.ts:257-277`, `tree-sync.ts:70` |
| 5 | `POST /git/redeploy/<app>` (also `user`) runs `gitPull` → `git remote get-url origin` + `git pull origin <branch>` **in that directory, on the host, as `drop`** — never containerized, in either isolation mode | `git-client.ts:105-124` |
| 6 | The tenant now controls `.git/config`; an `ext::sh -c …` remote URL (or `core.fsmonitor`) is executed by git during fetch | — |
| 7 | `drop` ∈ `docker` group → root | `install.sh:153` |

**A second, independent entrance — found and closed during implementation.**
node-tar consumes a **PAX extended header** (typeflag `x`) *internally* and
applies its `path=` record to the following entry, so a header whose name field
says `innocuous.txt` can carry `.git/config`. Measured: with the guard removed,
such an archive **extracts successfully**. The guard is only safe because it
reads `entry.path` — the post-override value — rather than the raw header name
field. A guard written against the header name would have looked correct and
closed nothing. Pinned by a test and by a comment at the guard.

Confirmed non-issues: `.git/hooks/*` is not exploitable (`fs.createWriteStream`
gives 0644, no exec bit); a `config`-only tarball fails because the prune wipes
the rest of `.git` and `git remote get-url` then errors. The working payload is
a complete minimal `.git` (HEAD, refs, objects, config), which is trivial to
produce.

**Pre-existing and reachable today by `curl`** — Item 1 does not create it, but
it does put a `.git`-carrying upload one drag-and-drop away, so it ships first
and separately.

### File-level changes

- [ ] **`src/core/upload-deploy/tar-extract.ts`** — new `ArchiveRejectReason`
      `'vcs_metadata'`. In `parser.on('entry')`, immediately after the existing
      entry-type check (`:204-214`, same `entry.resume()` + `settle(...)`
      shape), reject any entry with a `.git` path component.
      - **Any depth**, not just the first segment — `vendor/foo/.git/config`
        must be refused too.
      - **Case-insensitive** strict equality per component: `.GIT` and `.Git`
        are the same directory on Windows and macOS (the CVE-2014-9390 /
        CVE-2019-1353 class). Extraction runs on Windows dev boxes here.
      - Reject the whole archive; do **not** skip the entry and do **not** add
        `.git` to `DEFAULT_PRESERVE` — that list is shared with monorepo
        materialization, and preserving is the weaker guarantee.
- [ ] **`src/core/upload-deploy/tar-extract.test.ts`** — assert rejection for
      `.git/config`, `a/.git/config` and `.GIT/config`; assert a file merely
      *named* `.gitignore` or `gitconfig` still extracts.

No legitimate producer is affected: git-deployed apps get their `.git` from
`gitClone`, never from an archive, and no existing test uploads one
(`grep '\.git' src/core/upload-deploy/*.test.ts` → empty).

### Post-deploy check (read-only, for the user to run)

SSH is blocked for me this session. Closing the hole is not the same as knowing
it was never used:

```bash
sudo grep -rlE 'ext::|core\.fsmonitor|core\.sshCommand' /var/drop/data/webapps/*/.git/config 2>/dev/null
sudo grep -hE '^\s*url\s*=' /var/drop/data/webapps/*/.git/config 2>/dev/null | grep -v 'https://github.com/'
```

---

## Item 1 — DROP-141: dashboard upload-deploy has never worked

### Evidence

- `DeployPage.tsx:213-222` POSTs `FormData` to `/api/v1/apps/deploy`.
- No such route: `apps.ts` registers `/`, `/:name`, `/:name/source`,
  `/:name/{start,stop,promote,restart,migrate-runtime,capabilities,domain}`.
  `git log -S"'/deploy'" -- src/api/routes/apps.ts` → empty. Broken since
  `a2529bb`, the commit that introduced the deploy UI.
- The real endpoint takes the **raw body as a gzipped tarball**
  (`apps.ts:494-515`), gzip magic asserted at `tar-extract.ts:88-102`, app name
  from the URL path, **no strip-components** — entry paths must already be
  relative to the app root.
- Limits: 100 MB compressed (`runtime-config.ts:64-70`), 20 000 entries and 60 s
  extract (`platform.ts:1484-1485`), 10 req/min (`rate-limit.ts:32-35`), role
  `user` (`server.ts:288`).

### Approach

Build the tar+gzip **in the browser** and POST the bytes to the existing
hardened `/:name/source`. Rejected: a new multipart backend endpoint — it would
duplicate every guard `tar-extract.ts` already implements onto a second,
unhardened surface.

Gzip uses the native **`CompressionStream('gzip')`** — no dependency, no Web
Worker, no wasm, so no CSP change (`security-headers.ts:31-44` is
`script-src 'self'` / `connect-src 'self'`; same-origin `fetch` is already
allowed).

**Pure logic lives in `src/utils/`, not the dashboard package.** `src/dashboard/**`
is excluded from root `tsconfig.json` *and* from `eslint.config.js:46-52`, so
hand-rolled binary code placed there would sit outside both gates. `src/utils/`
is reached by root tsc, eslint and jest. Only DOM glue stays in the dashboard.

### File-level changes

- [ ] **`src/utils/tar-writer.ts`** (new) — `buildTar(entries)`, pure USTAR,
      **`Uint8Array` only, zero DOM types** (root tsconfig is `lib: ["ES2022"]`,
      no DOM, and ts-jest compiles per-file against it). Mirrors the existing
      `tar-extract.ts` on the read side. **The byte-level spec below is not
      optional** — every item was measured against this repo's node-tar 7.5.19,
      and each one fails *silently*.
      - **Checksum: six octal digits + `NUL` + space**, not eight zero-padded
        digits. node-tar scans forward from offset 148 to a NUL-or-space, so a
        full-width field swallows the typeflag at 156 as a ninth digit —
        measured 4221 read as 33768 (8×), `cksumValid=false`, **every entry
        dropped**. This is the single most natural way to write the field and it
        is wrong.
      - **Magic must be the exact bytes `75 73 74 61 72 00 30 30`** at 257..264
        (`ustar\0` + `00`). GNU's `ustar  \0` makes node-tar accept the entry but
        **silently discard the prefix field** — measured: prefix `deep/dir` +
        name `c.txt` emitted as `"c.txt"`. Long paths flatten and overwrite each
        other with no warning and a valid checksum.
      - **Every length decision on `TextEncoder` bytes, never `String.length`.**
        A 40-character CJK path is 120+ bytes; the overflow corrupts `mode`/`uid`
        and the checksum — computed *after* the write — makes it self-consistent.
        Split only at a `/` byte (0x2F), which cannot occur mid-sequence.
      - **Body padding `(512 - (len % 512)) % 512`.** Without the outer `% 512`
        every exact-multiple body (including every zero-byte file) emits a stray
        block; GNU tar stops at two consecutive zero blocks, so `tar -tzf` would
        show a truncated listing. Omitting padding is worse — measured
        `TAR_ENTRY_INVALID` and the **following entry lost entirely**.
      - **Fresh 512-byte header per entry**, not one reused scratch buffer. Four
        junk bytes left at offset 157 (`linkname`) on a typeflag-`0` entry gave
        `TAR_ENTRY_INVALID: linkpath forbidden`, then desync into
        `TAR_BAD_ARCHIVE` — **the whole upload lost**.
      - **Size derived from `data.byteLength` in the same expression that writes
        the body.** A mismatch is not an error: over-declaring made node-tar eat
        the end-of-archive zero blocks as content; under-declaring truncated.
        Both produce a corrupt file and a confusing downstream build failure.
      - **`name` (100) and `prefix` (155) take raw bytes with no NUL
        terminator** — a 100-byte path fills the field exactly and a generic
        "write string + terminator" helper silently drops its last byte.
        `uname`/`gname` are the opposite: POSIX requires termination, cap at 31.
      - **Prefix split is a windowed search, not "the last `/`".** The constraint
        is a `/` at byte `i` with `i ≤ 155` *and* `len - i - 1 ≤ 100`. Scan for
        the first `/` at index ≥ `len - 101`. A single path *component* over 100
        bytes is unrepresentable at any total length — reject it client-side,
        naming the file.
      - Refuse `data.byteLength > 0o77777777777` explicitly. Base-256 is
        unreachable behind the 100 MB cap and is untested surface.
- [ ] **`src/core/upload-deploy/tar-extract.ts`** — attach
      `parser.on('warn', …)` in `runExtraction` and surface the first warning's
      code in the thrown error. `new TarParser()` is **non-strict** (`:139`) and
      no `warn` listener exists, so `TAR_ENTRY_INVALID` / `TAR_BAD_ARCHIVE` are
      discarded and *every* writer defect above surfaces as the same
      `empty_archive` — "Archive contains no regular files". Measured across the
      checksum, magic and linkname cases. Near-zero risk (the existing MCP
      producer emits clean archives) and the difference between a one-hour and a
      one-day debugging session.
- [ ] **`src/utils/upload-paths.ts`** (new) — the pure helpers the dashboard
      needs and jest can reach: `stripCommonRoot`, the exclusion predicate,
      `deriveAppName`, a single exported `APP_NAME_RE`, and **path
      normalization**, which is load-bearing rather than cosmetic:
      - strip a leading `/` (measured: node-tar does **no** normalization, so
        `/etc/passwd` passes through verbatim and `path.resolve` sends it outside
        `destDir` → `path_escape` **kills the entire archive**);
      - strip `./` prefixes and collapse `//` (`./index.html` and `index.html`
        resolve identically → `path_collision`, whole upload lost);
      - reject any `..` segment; strip trailing `/` (node-tar retypes a
        `0`-typeflag entry ending in `/` as a **Directory** and discards its
        body, so such an archive fails as `empty_archive` despite holding data);
      - reject `\` in paths — on Windows `path.resolve` treats `a\b.txt` as a
        subdirectory while on the Linux production box it is a legal single
        filename, so the same archive builds different trees in dev and prod;
      - dedupe on the parser's own key shape, `normalize('NFC').toLowerCase()`
        (`tar-extract.ts:226`), and report the colliding **pair by name** up
        front. Safari's `webkitRelativePath` yields NFD on macOS, and a
        Linux-authored repo may legitimately contain `README.md` and
        `readme.md` — either aborts the whole upload server-side.
      - **Exclusions are now correctness, not just hygiene**: a typical
        `node_modules` alone exceeds the 20 000-entry cap, and `.git` pack files
        are near-incompressible against the 100 MB cap. Fail fast in the client
        above 20 000 entries, naming the cap.
      - **`.git` is load-bearing after Item 0.** The server now *rejects* an
        archive containing it (`reason: vcs_metadata`) — this is the deliberate
        client-strips / server-refuses split recorded under Item 0's diff-stage
        critiques. So the client MUST strip `.git` and show it in the skipped
        list, or every folder drop from a checked-out repo 400s. Share the rule
        rather than re-deriving it, so the two layers cannot drift — but **move
        `isVcsMetadataComponent` into `src/utils/upload-paths.ts` and re-point
        `tar-extract.ts` at it**. Item 0 exports it from `tar-extract.ts`, which
        is correct there (nothing in a browser touches it yet) but must NOT be
        the browser's import source: that module pulls in `node:fs`,
        `node:zlib`, `node:path` and node-tar, so importing it from the
        dashboard would drag all of that into the Vite bundle — either failing
        to resolve the `node:` specifiers or polyfilling them in. `upload-paths.ts`
        is already specced as the DOM-free, node-free home for exactly this.
- [ ] **`src/utils/tar-writer.test.ts`**, **`src/utils/upload-paths.test.ts`**
      (new) — round-trip generated archives through **node-tar** (the backend's
      own parser, already a root dep) and `zlib.gunzipSync`, not through
      self-authored fixtures. Cover: paths and bytes survive; a 150-char path
      survives the prefix split; a zero-byte entry; non-ASCII names; the entry
      type node-tar reports is in `REGULAR_FILE_TYPES`; mixed
      `webkitRelativePath`/bare-name selections; single-file selection; no
      common root.
- [ ] **`src/dashboard/src/lib/upload-archive.ts`** (new) — DOM glue only:
      `FileList` → entries, `CompressionStream`, size budget. Typed error when
      `CompressionStream` is absent. **No test may import this file** — it
      references `File`/`Blob`/`CompressionStream`, which do not exist under the
      root tsconfig's libs.
- [ ] **`src/dashboard/src/pages/DeployPage.tsx`** — rewrite `uploadFiles`:
      resolve the app name (explicit field → stripped common root → error;
      `/:name/source` has no auto-generate), validate against `APP_NAME_RE`,
      build the archive, POST to `/api/v1/apps/${name}/source` with
      `Content-Type: application/gzip`, read **`json.data.app`** (the 202 body is
      `{app, acceptedAt, isNew}` — `apps.ts:539-542`), then poll
      `/api/v1/apps/:name` the way the git tab already does at `:120-150`.
      Add a `webkitdirectory` folder picker; drop the `accept=".js,.ts,…"`
      whitelist (it silently blocks images, fonts and binaries — every real app
      has them); distinct messages for 400/413/429; show file count, compressed
      size and the skipped-paths list before sending; fix the copy, which
      currently names no accepted format.

### Decisions, and the critic findings behind them

- **App-name regex.** Validate against `isValidAppName`
  (`validate.ts:11`, `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`) — **not** the
  `/^[\w.-]+$/` in `git-deploy.ts:90` that the draft named. A dotted folder
  (`my.app`) is a likely derived default and would otherwise also miss the
  body-size carve-out `UPLOAD_SOURCE_PATH_RE` (`server.ts:55`) and fail with a
  misleading "Request body too large".
- **The git-backed 409 is a first-class UI case, pre-empted AND handled.**
  DROP-146 makes an upload onto a git-deployed app return 409 with a message
  naming `git/redeploy`. Dragging the folder of an app originally deployed from
  GitHub is the single most likely accidental rejection, so: (1) the existing
  `GET /api/v1/apps/:name` pre-check below does double duty — `toAppDto`
  returns `gitSource`, so the client can refuse **before** spending a tar+gzip
  of up to 100 MB and an upload; and (2) the 409 is still rendered with the
  server's own message as a backstop, never as a generic "Deployment failed".
  Same for a `vcs_metadata` 400, which the client-side `.git` strip should make
  unreachable but which must read correctly if it ever surfaces.
- **Overwrite confirmation.** `/:name/source` is deploy-*or-redeploy*, and
  `landFiles` prunes the target (`upload-deploy.ts:257-277`). With an
  auto-derived name, dropping a folder that shares a name with a live app
  silently replaces its source. `GET /api/v1/apps/:name` first; if it resolves,
  require an explicit "replace `<name>`" confirmation via the page's existing
  `useConfirm` (`DeployPage.tsx:173`).
- **Client size budget.** `buildTar` materialises files + tar + gzip in memory;
  the only existing cap is server-side and compressed-only, so a large folder
  is a tab OOM with no error. Sum `file.size` during collection and throw the
  typed "use the CLI" error above a client budget before reading any bytes.
- **Exclusions** `.git` and `node_modules`, with the skipped list shown. This is
  **UX only** — the endpoint takes a raw body and any `curl` bypasses it. The
  real control is Item 0.
- **Recursive directory drag-and-drop** (`webkitGetAsEntry`) is **out of scope**.
  `webkitdirectory` on the picker covers folder selection; this is the one piece
  not needed for the fix to work.

---

## Item 2 — DROP-142: a git app whose repo went private is unrecoverable

### Evidence

The token is stored by reference and re-read at redeploy (`git-deploy.ts:298-304`),
so rotation was anticipated — but nothing can write that reference after
creation: `deploy()` rejects an existing app (`:96-98`) and an existing directory
(`:133-140`); `POST /git/redeploy/:name` parses **no body** (`routes/git-deploy.ts:108`);
there is no `PATCH`/`PUT` on `/git`; `AppDetailPage.tsx:472-507` is read-only.
Failure is a warn-and-continue: `"trying without auth"` (`git-deploy.ts:301`),
then a doomed pull.

### Approach

**2a — attach a token at redeploy.** `POST /git/redeploy/:name` accepts an
optional `{ tokenId?: string | null }`. Applied to the **resolved** target (the
monorepo-container resolution at `routes/git-deploy.ts:123-142` runs first, and
re-checks `canAccess` on the container), `null` clears it.

**2b — token ownership: DEFERRED.** See *Agent critiques considered*.

**2c — stop writing the PAT into the tenant's document root.** In scope because
Item 2 exists precisely to make more private-repo pulls happen, and each one
currently writes the credential to a tenant-servable path.

### The defect both critics found in the draft — and it was real

`redeploy()` captures `app` at `:269`; `updateApp` **replaces** the map entry
with a fresh object (`state-manager.ts:288-298`) rather than mutating it. So a
pre-pull `updateApp` write is invisible to the captured `app`, and the post-pull
write at `:328-332` spreads the **stale** `...app.gitSource` — reverting the
attach on the **success** path. The draft's own proposed test ("persists before
the pull and survives a pull failure") exercises only the failure path, the one
path where the revert does not manifest. The feature would have shipped inert,
with a green suite. Same fixture-trap class as DROP-128 and Item 3.

Correct shape: resolve once at the top —
`const effectiveTokenId = opts?.tokenId !== undefined ? opts.tokenId : app.gitSource.tokenId`
— use it for `getTokenValue`/`gitPull` **and** build the final `gitSource` from
it rather than from `app.gitSource`.

### Carried in from the Item 1 security review — fix here, not there

`toAppDto` (`apps.ts:190`) returns the **whole `gitSource`** at the non-admin
tier: `repoUrl`, which echoes back userinfo credentials if a user pasted
`https://user:pat@github.com/...`, and `tokenId`, a correlation handle. Rated
`low`/`high`, pre-existing, and **not** widened by Item 1 (which only reads the
field the DTO already exposed) — but this item owns token handling, so it is
fixed here rather than deferred again. Strip userinfo from `repoUrl` via a
`new URL()` round-trip clearing `username`/`password`, and gate `tokenId` on
`isAdmin` the way `pid` and `path` already are.

### File-level changes

- [ ] **`src/api/routes/apps.ts`** — `toAppDto`: strip `repoUrl` userinfo; gate
      `tokenId` on `isAdmin`. Note the dashboard's own upload pre-flight reads
      `gitSource` to refuse a git-backed target, so keep the FIELD present for
      non-admins — narrow its contents, don't remove it, or DROP-141's
      client-side refusal silently stops working.
- [ ] **`src/core/git-deploy/git-deploy.types.ts`** — add `tokenId?: string | null`
      to the existing **`DeployActor`**, *not* a third `redeploy()` parameter.
      Five assertions in `git-deploy.authz.test.ts` (`:97, :106, :133, :165,
      :174`) are arity-exact `toHaveBeenCalledWith('<app>', expect.anything())`,
      and `toHaveBeenCalledWith` fails on a third argument. Riding the existing
      second argument keeps `expect.anything()` matching and touches no test.
- [ ] **`src/core/git-deploy/git-deploy.ts`** — `effectiveTokenId` resolved once
      and used for both the pull and the final `gitSource`. The webhook caller
      (`routes/git-deploy.ts:243`) passes `{automation:'webhook'}` with no
      `tokenId` and is unaffected.
      - **Invariant: persist to `target.name`, never to `c.req.param('name')`.**
        `registerApp` spreads `...existing` (`state-manager.ts:239-271`), so a
        `gitSource` written to a monorepo *child* is **permanent** — re-expansion
        cannot clear it. Four consequences, all traced in code: the child stops
        resolving to its container (`git-deploy.ts:132`); `findAppsForWebhook`
        starts matching it so one push redeploys the group twice (`:415-423`);
        `gitPull` runs against a materialized copy that is not a git repo
        (`:314`); and `apps.ts:196-199` stops emitting `groupGitBacked`, flipping
        the dashboard button from "Redeploy group" to "Redeploy".
      - **Persisted, not one-shot** — deliberate. Recovering the app is the point
        of DROP-142. Consequence to accept and document: the container's
        `tokenId` is also what unattended **webhook** redeploys use
        (`:243, :295-304`), so attaching a token re-credentials every future
        automatic redeploy of that group.
- [ ] **`src/core/git-deploy/git-client.ts`** — `gitPull` must **stop** doing
      `git remote set-url origin https://TOKEN@…` (`:111-121`), which writes the
      PAT in cleartext into `<app>/.git/config` — inside the tenant's document
      root (a static app can serve it), bind-mounted into their container under
      docker isolation, and left there permanently if the process dies before
      the `finally`. Replace with a credential helper that reads the token from
      the child **`env`** (not argv — argv is world-readable via `ps`). Also fix
      the file header at `:5`, which asserts PATs are "never written to disk",
      and note that `sanitizeOutput`'s `https://[^@]+@` regex becomes **inert**
      rather than wrong — it must not be read as proof of stripping afterwards.
      - **Portability of the helper — measured, not assumed.** A `!f(){…};f`
        helper makes git spawn a shell, which raised whether `sh` exists on a
        Windows host (DROP supports `C:\drop`). Tested on this box against
        **Git for Windows 2.50.0**: `git -c credential.helper=!f(){…};f
        credential fill` returned the username and the password read from the
        child `env`. Git for Windows bundles its own `sh`, so this is portable
        to both platforms. Alternatives rejected knowingly: `http.extraHeader`
        is shell-free but puts the credential in **argv**, world-readable via
        `ps`; `GIT_ASKPASS` needs a script file on disk.
      - The token goes in `execFileAsync`'s `env` option (spread over
        `process.env`), **never assigned into `process.env` itself** — that
        would expose it to every later child the platform spawns.
      - Three distinct states at the route/service boundary, easy to collapse:
        `tokenId` **absent** leaves the stored value unchanged, **`null`**
        clears it, a **string** replaces it. If the route passes `null` where
        the body simply omitted the key, "omitted" silently becomes "clear".
- [ ] **`src/api/routes/git-deploy.ts`** — tolerant body parse on
      `/redeploy/:name` (the body is absent today and must stay optional), with
      a **strict** shape check: accept only `null` or
      `/^git_[A-Za-z0-9]+$/`, ignore all other keys, 400 otherwise. Unvalidated
      input here would land arbitrary JSON in `gitSource.tokenId` in `apps.json`
      and flow into `keys.find(k => k.startsWith(...))`.
- [ ] **`src/dashboard/src/pages/AppDetailPage.tsx`** — a token `<select>` (from
      `GET /git/tokens`) feeding the **existing** Redeploy button at `:283-298`
      (gated on `canRedeploy`, `:105`) — do not add a second one. The page does
      not currently fetch tokens (`:23` imports only `useApp, appAction,
      deleteApp, gitRedeploy`). **Gate the picker on role**: AppDetailPage is
      reachable at `readonly`, but `/git/tokens` requires `user`
      (`server.ts:346`), so an ungated picker 403s for readonly viewers.
- [ ] **Tests** — extend `git-deploy.authz.test.ts` and `git-deploy.test.ts`
      following `src/api/routes/secrets.authz.test.ts` and the shared helpers in
      `src/api/__testutils__/` rather than a fresh harness. Must cover:
      the tokenId survives a **successful** pull (the inverted case above);
      survives a failed pull; **survives a platform restart** — attach, run the
      boot reconciliation path, assert `gitSource.tokenId` is still there
      (`gitSource` lives in `apps.json`, and boot reconciles config > runtime >
      `apps.json`); a malformed `tokenId` 400s; the webhook path still works
      with no `opts`.

      **Prove the pull AUTHENTICATES, not just that nothing leaked.** Asserting
      "no token text in `.git/config`" passes equally well if the helper never
      fires and the pull succeeded because the repo was public — which is
      exactly what a fixture is. Fix 4 replaces the mechanism by which the
      credential reaches git, so the test has to exercise that mechanism.
      `git credential fill` does it with no network: feed
      `protocol=https\nhost=github.com\n` to
      `git -c credential.helper= -c credential.helper=<the helper string the
      code builds> credential fill` with the token in the child env, and assert
      the token comes back as `password=`. That is the difference between "we
      stopped writing the PAT to disk" and "we stopped writing the PAT to disk
      **and the pull still works**". Verified as a working shape on Git for
      Windows 2.50.0 while scoping this.

---

## Item 3 — DROP-143: container CPU under-reported by the host core count

`container-manager.ts:706-707` derives `numCpus` from `percpu_usage`, a
**cgroup v1-only** field. Under cgroup v2 — default on current Debian/Ubuntu —
Docker omits it and sends `cpu_stats.online_cpus`, so `numCpus` falls back to
`1` and every reading is divided by the host core count.
`container-manager.test.ts:79` seeds `percpu_usage: [1,1]`, i.e. the test passes
against a field production never sends.

Already recorded as knowingly deferred in the DROP-133 memory ("Unverified
against the live box, so it was kept out").

- [ ] **`src/managers/runtime/container-manager.ts`** — prefer `online_cpus`,
      fall back to `percpu_usage.length`, then `1`.
- [ ] **`src/managers/runtime/container-manager.test.ts`** — add the cgroup-v2
      case (`online_cpus: 4`, no `percpu_usage`) as a **new fixture, not by
      editing the shared `makeStats()`** at `:75-87`. Three assertions depend on
      that fixture yielding `cpu === 2` (`:668`, `:670`, `:705`); editing it
      changes all three. Also add the both-absent → ×1 case.

**The fallback is load-bearing.** `online_cpus ?? percpu_usage?.length ?? 1`
keeps the existing v1 assertions green; a bare `online_cpus ?? 1` fails `:668`
and `:705`. Note `:670` is a list/detail *parity* check — both halves drop
together, so it cannot catch this on its own.

Confirmed no blast radius: `cpu` is display-only (`apps.ts:297/317/359`,
`cli/list.ts:60`, `cli/status.ts:50-51`); no guardrail, quota or reaper reads it
— `idle-reaper` uses the cumulative `cpuTotalNs`.

---

## Item 4 — DROP-145: "Back to home" on login/signup is a no-op loop

Reported by the user mid-plan; implemented immediately as a light-gear change,
independent of Items 0–3.

`LoginPage.tsx` and `SignupPage.tsx` linked to `href="/"`. Since the site split
(DROP-139) the dashboard is on its **own host**, so `/` resolves to
`dashboard.dropkit.sh/`, which the platform 301s to `/dashboard`
(`server.ts:556`), whose anonymous index route sends a logged-out visitor
straight back to `/login` (`App.tsx:54-62`). The button visibly did nothing.
The code comment above it described the *pre-split* architecture (DROP-070,
"the marketing home lives in a separate bundle at `/`") — the link was correct
when written and rotted when the host changed.

- [x] **`src/dashboard/src/lib/site-url.ts`** (new) — `deriveSiteOrigin(protocol,
      hostname)`: strips a leading `dashboard.` label, returns `null` when there
      is no separate site. Deliberately DOM-free so root jest can reach it.
- [x] **`src/dashboard/src/lib/site-url.test.ts`** (new) — 6 cases, incl. the
      `dashboard.localhost` trap (strips to `localhost`, i.e. the same platform)
      and `dashboards.dropkit.sh` (a prefix match that must not be a label match).
- [x] **`LoginPage.tsx`, `SignupPage.tsx`** — absolute cross-origin `href`;
      render nothing when `null`, rather than a link that loops. A single-host
      install has no landing page at all, so hiding is the honest outcome.

Verified: 6/6 unit tests pass, `cd src/dashboard && npx tsc --noEmit` clean,
`npm run build:dashboard` succeeds and the derivation is present in the emitted
bundle. **Not observed in a browser** — the Chrome extension was not connected
this session.

---

## Risks & open questions

1. **Hand-rolled tar.** Retired by round-tripping through node-tar — the
   backend's own parser — not self-authored fixtures. The DROP-133 lesson:
   only the reference implementation catches this class.
2. **`CompressionStream`**: Chrome 80+, Firefox 113+, Safari 16.4+. Older
   browsers get a typed error pointing at the CLI, never a silent failure.
3. **Item 3 stays runtime-unverified.** Read-only SSH was blocked twice by the
   permission classifier this session. The fix is correct on **both** cgroup
   versions (`online_cpus` is reported on v1 too, since Docker API v1.27), so it
   does not depend on knowing which the box runs — only the *magnitude* of the
   live error is unconfirmed. Ships on the unit test, labelled unverified.
4. **Caddy body limit.** `caddy-generator.ts:113-114` applies `request_body
   max_size` to **tenant app** routes; confirm the `dashboard.dropkit.sh` host
   does not cap below 100 MB. Gate 4 item.
5. **cgroup v2 memory over-reports** — `memory_stats.usage` includes
   `inactive_file`, which the `docker stats` CLI subtracts. Same function, same
   bug class, **out of scope**: the user asked about CPU. Follow-up, not
   silently bundled.
6. **`gitSource` has no second store.** Unlike `port`, which is mirrored into
   `data/appconf/webapps/` and restored by boot reconciliation, `gitSource`
   lives only in `apps.json` (`state-manager.ts:181-183`;
   `syncStateWithConfigs` writes back only `port`, `lastDeployedAt`,
   `buildDuration` — `platform.ts:1747-1753`). A corrupt `apps.json` is renamed
   to `.corrupt-<ts>` and the map cleared, taking every attached tokenId with
   it and leaving no recovery path. Accepted and documented, not fixed here.
7. **Reproducing the Item 1 bug live depends on role and payload size.** With a
   `readonly` token the method guard (`server.ts:320-326`) returns 403 before
   the 404, and the global 1 MB `Content-Length` check (`server.ts:185-199`,
   carved out only for `UPLOAD_SOURCE_PATH_RE`) returns 413 for any multipart
   body over 1 MB. The plain 404 only shows for a small upload by `user`/`admin`.

---

## Gates

**Gate 3 additions.** No existing gate typechecks the dashboard — root tsconfig
excludes `src/dashboard/**`, and jest only compiles test files plus what they
import, so a type error in `DeployPage.tsx` would first appear in **CI**, after
the gates were called green. For Items 1 and 2 add
`cd src/dashboard && npx tsc --noEmit`. Note `noUnusedLocals` /
`noUnusedParameters` are on — a leftover import from the `uploadFiles` rewrite
is a hard failure.

**Gate 4, per item:**

- **Item 0** — **SATISFIED.** Method changed from the originally-planned `curl`
  against a local `npm run dev`: the change is confined entirely to
  `extractTarball`, and `tar-extract.test.ts` already calls that production
  function directly against real gzip archives written to disk and parsed by
  real node-tar. The HTTP hop is the only thing `curl` adds and this diff does
  not touch it. Verified additionally by **mutation**: breaking the guard
  predicate fails exactly the 7 guard tests and no others, so they are not
  vacuous.
- **Item 1** — local `npm run dev` (`none` isolation) driven through
  claude-in-chrome. The upload path (`/:name/source` → `tar-extract`) is
  isolation-independent, so a pm2 run genuinely exercises it. **`ApiServer`
  prefers built `dist/dashboard` over source**, so either run
  `npm run build:dashboard` first or use `cd src/dashboard && npm run dev` with
  its `/api` proxy — and do not mix the two. Same class as the
  `__DROP_VERSION__` trap: verify in the built output.
  Because this branch is **stacked on Item 0**, the local run exercises the new
  UI against the `.git` rejection and the git-app 409 together — which is the
  ideal integration test, not a complication. Two named steps, not a generic
  "drive the UI":
  1. Drag a folder that **contains `.git`** and confirm the client strips it
     silently (listing it as skipped) rather than the server returning a
     `vcs_metadata` 400.
  2. Drag onto an app that is **git-deployed** and confirm the 409 renders with
     the server's own `git/redeploy` message, not "Deployment failed".
  **PARTIALLY SATISFIED without a browser.** The Chrome extension was not
  connected this session, but the two observations that mattered did not need
  it: Node 22 implements `File`, `Blob` and `CompressionStream` natively — the
  blocker was only the *type* layer (`lib: ["ES2022"]`), not the runtime. So
  `upload-archive.ts` was bundled unmodified with esbuild and executed against
  a realistic checked-out-repo selection, then its output handed to the
  **production `extractTarball`**:

  ```
  skipped    : [".git/config",".git/HEAD","node_modules/left-pad/index.js"]
  tar entries: ["package.json","src/index.js",".gitignore"]
  magic      : 1f 8b        IS_GZIP: true
  extract    : {"fileCount":3,"dirCount":0,"bytesWritten":44}
  landed     : [".gitignore","package.json","src","src/index.js"]
  ```

  That is the real glue, the real `buildTar`, the real `CompressionStream`, and
  the real hardened extractor. It proves: `.git` is stripped client-side (so a
  repo folder does not 400), `.gitignore` is NOT over-matched, the `my-app/`
  common root is removed (the server has no strip-components), the body is a
  genuine gzip stream, and the endpoint's own extractor accepts it.

  **Still unverified — the React layer only**: folder picker, replace
  confirmation, the git-backed pre-flight refusal, error-message rendering, and
  the poll loop. Those need a browser. Do not report Item 1 as fully runtime
  verified until they are driven.

  3. **Inspect the request body's first two bytes — they must be `1f 8b`** —
     and confirm a 202 rather than a `not_gzip` 400. This is the one step the
     unit tests structurally cannot reach: every `buildTar` test round-trips
     through `zlib`/node-tar or `extractTarball`, so `new Blob(chunks)` →
     `CompressionStream('gzip')` has never actually executed. It can't be
     tested under jest either (`testEnvironment: 'node'`, no `CompressionStream`
     without jsdom). "The upload worked" would also be satisfied by luck, so
     read the payload, not just the status. Watch specifically for `entry.data`
     being a *view* onto a larger `ArrayBuffer` — `new Blob([view])` is a
     classic place to silently ship the wrong bytes.
- **Item 2** — needs a real private GitHub repo and a PAT. Token injection is
  HTTPS-only (`git-client.ts:21-22`), so a `file://` bare repo would make the
  test **vacuous**. Plus a platform restart to prove `gitSource.tokenId`
  survives boot.
- **Item 3** — not verifiable from this box (no Docker on Windows;
  `container-manager.smoke.test.ts` self-skips). Unit test only; magnitude
  confirmed later by the user on the box.

---

## Deploy consent

A push to `develop` **is** a production deploy — `deploy.yml` is not
branch-gated and stops/restarts the service. This plan ends at **PRs opened**.

**Two windows, not four:**
1. **Item 0 alone, first** — a critical RCE fix should not wait behind a feature
   review.
2. **Items 1–3 batched** into a single second window. Item 3 is a two-line
   change that does not deserve its own outage.

Consent is required for each window, on the *deploy*, not merely the push.

### Branches and their ordering

| Branch | Contains | Constraint |
|---|---|---|
| `bugfix/DROP-145-login-back-home` | Item 4 | Independent — may merge at any time, in either window |
| `feature/DROP-144-reject-vcs-metadata` | Item 0 (3 commits, incl. DROP-146) | **Window 1**, merges first |
| `feature/DROP-141-dashboard-upload` | Item 1 | **Stacked on DROP-144** — must merge after it, or be rebased onto `develop` once DROP-144 lands |

DROP-145 and DROP-141 both add files under `src/dashboard/src/lib/`, but
different ones (`site-url.ts` vs `upload-archive.ts`), so they do not conflict.
Consequence while working: **`site-url.ts` is absent on the DROP-141 branch**, so
a Gate 4 run there still shows the old, broken "Back to home" link. That is the
branch layout, not a regression — verify Item 4 from its own branch.

---

## Agent critiques considered — plan stage

**Panel integrity: 4 critics launched, 4 returned** (two after a relaunch). `security-critic` and
`architecture-critic` (both `model: opus`) completed on the first pass. Both
task-fit critics died with `You've hit your session limit` before producing
findings; both completed on relaunch (`model: claude-opus-5[1m]`) and between
them returned the highest-value findings of the run.

**The tar-spec critic was the most valuable agent in this run, and the reason is
worth keeping.** It did not reason about the USTAR spec — it *built headers
byte-by-byte and fed them through this repo's actual node-tar 7.5.19 parser*,
then reported measurements. Four separate **critical** defects, each of which
would have shipped silently and none of which a spec-reading review would
reliably catch, because in every case node-tar accepts the archive and produces
a wrong result rather than an error. Same lesson as the DROP-133 moby frame
spec: **only the reference implementation catches this class.** Its own caveat:
probes ran on win32, production is Linux — the two findings whose direction
changes with platform are marked in the plan text.

Caveat carried from the integration critic's own report: `node_modules` was
absent at the repo root when it ran, so its "breaks no existing assertion"
verdicts are by inspection of assertion text, not a green run. Gate 3 must
actually execute them.

### Actioned

| Severity / confidence | Finding | Disposition |
|---|---|---|
| critical / high (both critics, independently) | 2a's pre-pull `tokenId` write is read back from a stale `app`, so a **successful** pull reverts the attach; the proposed test only covered the failure path | Actioned — `effectiveTokenId` resolved once; explicit success-path test. **Verified myself** at `git-deploy.ts:269/295/328-332` vs `state-manager.ts:288-298` |
| critical / high (security) | Uploaded `.git` → poisoned `.git/config` → `gitPull` on the host as root-equivalent `drop` | Actioned — promoted to Item 0. **Verified myself**: no `.git` filter in the upload path; `DEFAULT_PRESERVE` is `node_modules` only |
| high / high (security) | `gitPull` writes the PAT into `<app>/.git/config`, inside the tenant's document root; file header claims the opposite | Actioned as 2c. **Verified myself** at `git-client.ts:5, 111-121` |
| medium / high (both) | Plan validated the app name against the wrong regex (`git-deploy.ts:90`, not `validate.ts:11`), and a dotted name also misses the body-size carve-out | Actioned |
| medium / high (architecture) | Pure logic in `src/dashboard/src/lib/` sits outside eslint *and* root tsc; only DOM-free modules are jest-reachable | Actioned — `src/utils/tar-writer.ts` + `upload-paths.ts` |
| medium / high (architecture) | Upload to an existing name is destructive (`syncTree` prunes); auto-derived names make silent overwrite easy | Actioned — existence check + explicit confirmation |
| medium / medium (architecture) | No client-side bound on uncompressed input → tab OOM | Actioned — pre-read size budget |
| medium / high (security) | "Tolerant" body parse without a type check writes arbitrary JSON into `apps.json` | Actioned — strict shape check |
| low / high (architecture) | Upload reports success for apps that then fail to build | Actioned — reuse the git tab's poll loop |
| low / medium (architecture) | New authz test harness where a maintained one exists | Actioned — follow `secrets.authz.test.ts` + `__testutils__` |
| **critical / high (integration F3)** | Writing `gitSource` to the clicked child instead of the resolved container is **permanent** — `registerApp` merges, so re-expansion cannot clear it; four downstream breakages traced | Actioned — explicit `target.name` invariant + test |
| **high / high (integration F1)** | A third `redeploy()` **argument** breaks five arity-exact `toHaveBeenCalledWith(x, expect.anything())` assertions | Actioned — carry `tokenId` on the existing `DeployActor` instead |
| **high / high (integration F2)** | Every current caller and all nine existing test requests send **no body**, so an unguarded `c.req.json()` 500s them all | Actioned — `.catch(() => ({}))` + a no-body regression test |
| high / high (integration F7) | AppDetailPage already has a Redeploy button and does not fetch tokens; `/git/tokens` needs `user` while the page is `readonly`-reachable | Actioned — reuse the button, gate the picker on role |
| medium / high (integration F6) | The v2 case must be a **new** fixture; editing shared `makeStats()` moves three assertions | Actioned |
| medium / high (integration F4) | `gitSource` has no second store, unlike `port` | Recorded as risk 6; accepted, not fixed |
| low / high (integration F8, F9) | `json.data?.message` is also absent from the 202 shape; the 404 repro depends on role and payload size | Actioned / recorded as risk 7 |
| **critical / high (tar TAR-01)** | Full-width 8-digit checksum read 8× too large — **every entry dropped** | Actioned — 6 digits + `NUL` + space |
| **critical / high (tar TAR-02)** | GNU magic `ustar  \0` silently discards the prefix field, flattening long paths | Actioned — exact byte assertion |
| **critical / high (tar TAR-03)** | `String.length` on byte-counted fields overflows into `mode`/`uid`; checksum hides it | Actioned — `TextEncoder` bytes throughout |
| **critical / high (tar TAR-04)** | Padding off-by-one: no padding **loses the next entry**; `512 - (n%512)` emits stray blocks | Actioned — `(512 - (n%512)) % 512` |
| high / high (tar TAR-05, 06, 07, 08, 09) | Size drift silently corrupts; NUL-terminated 100-byte name truncates; a reused header buffer leaks `linkname` and kills the archive; "last `/`" split is wrong; over-100-byte components are unrepresentable | Actioned — all in the writer spec |
| **high / high (tar TAR-10)** | Parser is non-strict with no `warn` listener, so **every** writer defect surfaces as the same misleading `empty_archive` | Actioned — added to Item 1 |
| high / high (tar TAR-11) | `node_modules` alone exceeds the 20 000-entry cap | Actioned — exclusions are correctness; fail fast client-side |
| medium / high (tar TAR-12, 13, 14) | Trailing `/` retypes a file as a Directory and drops its body; no path normalization in node-tar (leading `/` → `path_escape`, `./` → `path_collision`); NFC+lowercase collision key breaks on macOS NFD and case-differing siblings | Actioned — normalization in `upload-paths.ts` |
| medium / high (tar TAR-15, TAR-16) | `'deflate'` fails the gzip magic gate; an explicit Content-Type is inert but harmless; **`FormData` would break it** | Actioned — hard-code `'gzip'`, send the Blob directly |
| medium / medium (tar TAR-17) | One contiguous `Uint8Array` for the whole archive risks a tab OOM | Actioned — `Uint8Array[]` into `new Blob(parts)` |
| low / high (tar TAR-19) | Modes and mtimes are discarded by this extraction path — a committed `+x` bit cannot survive | Recorded; write `0o644` anyway, build no feature on it |

Refinements added beyond what the critics specified: the `.git` guard must match
**any** path component (not just the first — `vendor/foo/.git/config`) and
compare **case-insensitively** (`.GIT` on Windows/macOS — the CVE-2014-9390 /
CVE-2019-1353 class).

### Rejected or deferred, with reasons

- **`high` / `high` (security #3) + `medium`–`low` cluster (security #5, #6, #7,
  #9, #14; architecture #2, #7, #8) — git PAT store is unowned: any `user` can
  list, delete, or borrow any tenant's token.** **DEFERRED, reported to the user
  as a separate finding.** Severity retained as the critics graded it; not
  re-graded to justify deferral. Reason: **pre-existing and independently
  reachable today** via `POST /git/deploy`, which already accepts an arbitrary
  caller-supplied `tokenId` with no ownership check (`git-deploy.ts:152-157`,
  `server.ts:344`). Adding the same parameter to redeploy reaches **no new
  state** — it is parity, not widening. Fixing it means inventing an
  authorization data model inside a bug fix, tripling the PR the user asked for,
  and shipping a live behaviour change ("legacy unowned tokens → admin-only")
  that would strand existing non-admin tokens. Severity governs whether a
  finding may be *ignored*, not which PR fixes it. When it is scheduled, the
  critics' design guidance stands: a single `writeJsonAtomic` metadata store
  (`data/drop-svc/git-tokens.json`, `{id, name, ownerUserId, createdAt}`), **not**
  a companion secret namespace with two non-atomic writes; `randomUUID()` for
  the id (`Date.now().toString(36)` collides within a millisecond and
  `startsWith` then resolves the wrong record — which would let an attacker
  overwrite a victim's owner row); an explicit `if (!auth) return true`
  carve-out mirroring `access.ts:17`, or auth-disabled boxes lose token
  management entirely; the gate in the **service**, not the route, since the CLI
  (`cli/commands/deploy.ts:41-50`) and MCP construct the service directly; a
  strict rate-limit bucket on `POST /git/tokens`; and an identical error for
  "unknown" and "not yours" so the gate is not an existence oracle.
- **`low` / `medium` (security #11) — `deploy()`'s `/^[\w.-]+$/` admits `.` and
  `..`.** Deferred. Containment today is the accidental side effect of the
  "Directory already exists" check at `:133-140`, which is real but fragile.
  Swapping to `isValidAppName` would narrow the charset and reject repos named
  `my.app` that work today; the zero-behaviour-change fix is an explicit
  `.`/`..` rejection. Out of scope for these four items, worth its own change.
- **`low` / `low` (security #13) — CORS defaults to `*`.** Deferred: not
  exploitable without cookie auth, and unrelated to these items.
- **`low` / `low` (architecture) — `test:coverage` may break on a DOM-dependent
  dashboard module.** Moot: the DOM module now has no test importing it and the
  pure logic moved to `src/utils/`.
- **`medium` / `medium` (architecture #9) — land 2b before 2a for revert
  granularity.** Rejected as a consequence of deferring 2b.
- Architecture's "share one archive-building seam across three clients" angle
  was withdrawn by the critic itself: `drop deploy` POSTs a *path*
  (`cli/commands/deploy.ts:67-75`), so there are two builders in two runtimes,
  and MCP's `tar.create` cannot run in a browser.

**`medium`/`low` findings dropped without individual reasons: 0.** Every
finding returned by the two completed critics is recorded above.

---

## Agent critiques considered — diff stage

### Item 0 · pass 1

Panel: `security-critic` (`model: opus`), `architecture-critic` (`model: opus`),
`code-reviewer` (`model: Sonnet 5`) — all three on the real diff. The
code-reviewer returned **APPROVED**.

**The disagreement, and how it was broken.** The two senior critics reached
opposite conclusions on the central design choice:

- `security-critic` (finding 8, low/high): *"reject-whole-archive is the **right**
  call here — I'd keep it; skipping the entry would mean a silently modified
  extraction."*
- `architecture-critic` (high/high): *"Strip rather than reject… The security
  delta is zero… Reject-vs-strip is purely a UX call."*

Both are right on their own terms — the architecture critic is correct that
stripping is *equally safe for this vector*, since `syncTree`'s prune removes any
pre-existing `.git` and an uploaded one can only land because the archive
carried it. It is a UX call, not a security one.

**Resolved as a layering decision, not a single answer — the client strips, the
server refuses.** An earlier draft of this section justified reject on the
grounds that stripping would be a "silent modification" inconsistent with making
dropped corrupt entries fatal. That argument does not survive scrutiny and is
withdrawn: a corrupt entry is an archive the caller *believes* is intact, while
`.git` is a known, named, documented exclusion — the same class as
`node_modules`, which Item 1 strips client-side without anyone calling it
silent. Keeping it would also have put Items 0 and 1 in direct contradiction,
with the UI stripping `.git` and the server rejecting it.

The honest split:

- **Item 1's browser client strips `.git` before building the archive and shows
  the user exactly what it skipped**, so the dashboard path never trips the
  server guard. Convenience layer, informed user.
- **`extractTarball` refuses**, because its callers are hand-rolled clients and
  agents where a hard, named error (`reason: vcs_metadata`) is a better signal
  than a tree that quietly differs from the archive they believe they sent.
  Boundary layer, no guessing about intent.

Cost accepted, and recorded rather than discounted: `admitDeploy` runs *before*
extraction, so a rejected retry burns principal quota, and `tar -czf app.tgz .`
from a working tree is a breaking change for existing hand-rolled callers. Both
are mitigated by the doc and changelog entries below, and by rejecting in the
MCP tool before staging. The architecture critic's operational consequences were
all actioned.

| Severity / confidence | Finding | Disposition |
|---|---|---|
| **high/high (arch) + medium/high (security), independently** | `firstWarning` is read only when `fileCount === 0`, so a non-empty archive with a corrupt entry extracts a **partial tree**, reports success, and `syncTree` then prunes the destination to match — deleting files. The diff *observed* the condition and discarded it. Measured by both. | **Actioned** — any parser warning is now fatal (`invalid_archive`) in the listener; deletes `ExtractionOutcome`, the widened return type and the runtime type-leak with it |
| high/high (arch) | If reject is kept, the diff is incomplete: `AGENT-DEPLOY.md` presents `--exclude .git` as *advice*, and `CHANGELOG.md` `[Unreleased]` is empty while release notes are machine-extracted from it | **Actioned** — both updated; the doc now states rejection is mandatory and why |
| high/high (arch) | MCP `deploy_files` accepts a `.git/config` entry, stages it, tars it, **burns quota via `admitDeploy`**, and only then fails in the extractor | **Actioned** — rejected in `validateStagedRelativePath`, before staging |
| low/medium (security) + low/medium (arch) | Windows aliases reach a real `.git` past the guard: NTFS 8.3 short names (`GIT~1`) resolve via lstat in `syncTree`'s `copyInto`; alternate data streams (`.git::$INDEX_ALLOCATION`) likewise | **Actioned** — both normalized in the predicate |
| low/medium (arch) | The comment mislabels trailing-dot/space as "the CVE-2019-1353 class" — 1353 is the 8.3 short-name issue, 1352 is ADS | **Actioned** — CVE numbers dropped entirely rather than risk another mislabel; mechanisms described plainly. A wrong CVE reference is worse than none |
| low/high (security) | `entry.path` (≈256 bytes of arbitrary attacker UTF-8) reaches an **unfenced** MCP tool result, in a file that wraps third-party text in `wrapUntrusted` three lines away | **Actioned** |
| low/high (security) + low/high (arch) + low/high (code-review) | Test gaps: GNU `L` long-name smuggling unpinned (only PAX covered); bare `.git/` directory entry (typeflag 5) untested; legitimately-empty archives don't assert the *absence* of a suffix; the warning test couples to node-tar's warn-code vocabulary | **All actioned** |
| low/high (security) | The `.git` invariant is enforced in one place and documented in none of the callers — `tree-sync.ts`'s header states only the symlink obligation. CLAUDE.md: *"a boundary that holds only when callers are careful is not a boundary."* | **Actioned** — predicate exported as a named policy; obligation recorded in `tree-sync.ts` and `upload-deploy.ts` headers |
| low/medium (security) | After the prune deletes a git app's real `.git`, `gitPull` walks **up** the ancestor chain looking for a repository (no `--git-dir`, no `GIT_CEILING_DIRECTORIES`) | **Deferred to Item 2**, which owns `git-client.ts`. Not exploitable today (no ancestor is a repo) but it converts a clear failure into "git operates on whatever repo it finds above the app." Strengthens the case for refusing uploads onto git-backed apps |
| low/medium (arch) | `vcs_metadata` is category-shaped where its neighbours are mechanism-shaped, and promises `.hg`/`.svn` coverage it doesn't implement | **Rejected.** `.hg`/`.svn` lack the execution property that makes `.git` dangerous — nothing runs `hg pull` on the host — so covering them is surface for no gain. Renaming to `disallowed_path` churns a shipped reason string for a naming preference; no consumer switches on it |
| low/high (code-review) | The "kept off the public `TarExtractResult`" comment overstates what is hidden — the field is present at runtime | **Moot** — the interface is deleted by the first row |
| low/high (security) | Whole-archive rejection is a hard break for `tar -czf .` from a working tree | **Accepted, no code change** — see the tie-break above; mitigated by the doc and changelog entries |

**One decision made in passing, recorded so it is not rediscovered:**
`invalid_archive` now labels two distinct failure modes — a corrupt gzip stream
(`gunzip.on('error')`, the pre-existing use) and a tar entry node-tar dropped
(the new fatal-warning path). Those are different problems for a caller: the
first means the upload itself is damaged, the second means the archive was
built wrong. **Left shared deliberately**, on the same grounds that
`disallowed_path` was rejected above — no consumer switches on `reason`; both
surfaces (`apps.ts:544-552` → 400, `tools.ts:470-472` → `toolError`)
interpolate it into a message, and the message carries the discriminating
detail verbatim (`TAR_ENTRY_INVALID: checksum failure` vs zlib's `incorrect
header check`). A new reason would be enum churn for a distinction the message
already makes.

**`medium`/`low` findings dropped without individual reasons: 0.**

One critic reported the plan file's path as `docs/specs/plans/…` and inferred a
gitignore-convention problem. Verified false: it is `docs/plans/…`, force-added
deliberately past `.gitignore:117`.

### Item 1 · pass 1

Panel: `security-critic` (`model: opus`) — reported; `code-reviewer` —
outstanding at time of writing, to be read against the CURRENT tree, since the
all-excluded refusal below is a new early-return path it did not see.

The security critic closed five of its six asked angles with evidence and no
finding: the `isVcsMetadataComponent` move is a byte-identical symbol move with
the call site unchanged; no client-crafted path escapes `resolveContained`,
because node-tar's post-PAX `entry.path` is both what the guard checks and what
gets written, so client and server cannot diverge on the resolved path; the
client caps sit under the server's and the 100 MB compressed cap plus the
10/min bucket still apply (the new URL matches `UPLOAD_SOURCE_PATH_RE` because
`APP_NAME_RE` is a subset of `[A-Za-z0-9_-]+`); `Content-Type` is never read by
the route; and `gitSource` was already in `toAppDto` before this branch, so the
pre-flight reads it without widening exposure.

| Severity / confidence | Finding | Disposition |
|---|---|---|
| **low / high** | **Exclusion ran AFTER `stripCommonRoot`, exempting the selected root from its own rules** — picking the `node_modules` or `.git` folder itself makes it the common root, strips it, and every file inside sails through. `node_modules` as a root also passes `APP_NAME_RE`, so nothing downstream catches it | **Actioned** — tests the pre-strip path. Rated `low` by the critic only because the `.git` case additionally needs a typed app name; the `node_modules` case has no such brake, so this was treated as the real bug it is. Re-verified on the bundled glue: both rooted selections now keep zero files |
| low / medium | Folder picker archives the whole tree with no `.gitignore` awareness — a `.env` is fetchable at `/.env` for a static app, whose doc root IS the uploaded tree | **Actioned** — `.env*` excluded except templates, listed in the skipped panel, changelogged |
| low / high | `normalizeEntryPath` rejects `..` and `\` but not NUL — which truncates the USTAR name field, so the path the UI validated is not the path the server writes | **Actioned** — all control characters rejected |
| low / high | `writeOctal`'s `padStart` pads but never truncates: an oversized value overflows into the next header field and the checksum, computed last, makes it verify | **Actioned** — unreachable today, but this is a shared util now imported by two bundles and the failure is silent |
| low / medium | `splitPath` could split at the final byte, leaving an empty `name`; node-tar retypes the entry as a directory and discards its body | **Actioned** |
| low / high | `MAX_ENTRIES` checked against the KEPT count only, so a 200 000-file selection builds three arrays that size and the excluded entries escape the cap | **Actioned** — bounded before normalizing |
| low / low | The `.git` guard now lives in a module whose stated contract is "DOM-free so the dashboard can bundle it", inviting a browser-motivated edit to a security control | **Actioned** — SECURITY CONTROL banner at the top of the file |
| low / high, pre-existing | `toAppDto` returns the whole `gitSource` — `repoUrl` (possibly with userinfo credentials) and `tokenId` — at the non-admin tier | **Moved to Item 2**, which owns token handling, and written into that item's file list rather than left as a note |

Also fixed while in the file, not from a critic: an all-excluded selection used
to build an empty archive and defer to the server's `empty_archive` 400, which
says nothing about why; it now refuses locally and names the reason.

**A process note worth keeping.** Writing the control-character class with
literal bytes made git and grep treat the source as **binary**, and made the
character class invisible in review — three separate edit attempts then failed
to match it. The regex is now written with explicit escapes and the tests build
control characters via `String.fromCharCode`. Never type a control character
into source.

**`medium`/`low` findings dropped without individual reasons: 0.**

### Item 1 · pass 2 (`code-reviewer`, verdict NEEDS CHANGES)

Reported after the pass-1 fixes had already landed; it re-verified against the
current tree and independently found the all-excluded-archive gap that had been
closed in-session.

| Severity / confidence | Finding | Disposition |
|---|---|---|
| **medium-high / high** | **No re-entrancy guard.** `onClick` was gated on `status !== 'deploying'`, `onDrop` was not, and both tabs share the status state. The sharp edge is not the racing poll loops: `ConfirmProvider` holds exactly ONE pending resolve, so a second `confirmDialog()` overwrites the first, whose `await` **never settles** — a silent permanent hang | **Actioned** — guarded in `uploadFiles`, covering both entry points |
| **medium / high** | "Try again" reset only `status`, so a failure AFTER the archive was built (409/413/429) left the previous attempt's file count and skip list rendered on the idle form as though they described the next upload | **Actioned** |
| medium / high | `tar-writer.test.ts` never hit `name` at exactly 100 bytes or `prefix` at exactly 155 — the boundaries that discriminate `writeBytes` from `writeTerminatedString`, which the file's own doc comment distinguishes. Swapping the two helpers would have passed the whole suite. Also: `buildTar([])` untested, and the two hardening branches added in pass 1 untested | **Actioned** — all covered |
| low / low-medium | `dataTransfer.files` read after two awaits; `File` objects should outlive `DataTransfer` protected mode but this was unverified cross-engine | **Actioned** — `Array.from` snapshot, `buildArchiveFromFiles` widened to `ArrayLike<File>`. Zero-downside, removes the question |
| low-medium / high | A comment in `upload-paths.test.ts` claims the NFC/NFD literals are built from escapes; they are raw characters | **Not actioned** — the adjacent `expect(nfc).not.toBe(nfd)` is a live assertion that fails loudly if a tool ever normalizes the file, so the property is enforced even though the comment describes the wrong mechanism. Recorded rather than churned |
| low-medium / high | Poll loop has no unmount cleanup | **Not actioned, deliberately** — identical to the git tab's pre-existing loop and self-terminating in 30 s; fixing only the new copy is the inconsistent choice. A shared `usePollAppStatus` hook is the right fix and belongs to whoever touches both |
| low / — | An app name owned by ANOTHER tenant 404s indistinguishably from a free name, so the pre-flight cannot warn and the user pays a full archive build before a confusing "not found" | **Not actionable** — the server's deliberate no-existence-oracle posture. Recorded because it is the one behaviour the client genuinely cannot improve |
| low / — | `uploadErrorMessage`'s 413/429 fallback strings are unreachable (both server paths always populate `error.message`) | **Kept** — harmless defensive code |

**`medium`/`low` findings dropped without individual reasons: 0.**

## Run stats

_To be filled in after the last plan-item commit._

---

## Found during Item 0 implementation — decide before Item 1 lands

**Upload-deploy over a git-deployed app silently severs its git link.**
`upload-preflight.ts` has **no `gitSource` check** (verified: the file's only
"git" match is a comment at `:55`), so an upload onto a git-backed app is
allowed. `landFiles` → `syncTree` then prunes everything not in the tarball, and
`DEFAULT_PRESERVE` is `['node_modules']` only — so the app's real `.git` is
deleted. The next `POST /git/redeploy/<app>` fails at `git remote get-url
origin`.

Pre-existing, but Item 0 makes it **less** recoverable: re-uploading a tarball
that carries `.git` used to restore it by accident, and is now rejected
outright. Item 1 matters here because it makes upload-deploy reachable from the
UI for the first time, turning a curl-only edge case into a one-drag mistake.

Three options, needs a decision:
(a) refuse an upload onto an app that has a `gitSource` — cleanest, since
    mixing deploy sources on one app is incoherent, but it is a behaviour change;
(b) preserve `.git` on the upload path only — narrow, but `DEFAULT_PRESERVE` is
    shared with monorepo materialization so it must not be edited globally;
(c) document it and let the link break.

Leaning (a). Severity medium — data-loss-adjacent, not a security issue.
