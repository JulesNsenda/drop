# PRD-051: Required Secrets — Declaration, Preflight Gate & Prompt

| Field | Value |
|-------|-------|
| PRD ID | PRD-051 |
| Feature | Declared required secrets + preflight gate (auto-generate / prompt / `needs-config`) |
| Status | In Progress |
| Priority | P2 |
| Created | 2026-07-24 |
| Updated | 2026-07-24 |

> **v1 scope (approved 2026-07-24).** Thin vertical: `drop.yaml secrets:`
> parsing → auto-generate → preflight gate → `needs-config` status → MCP +
> dashboard surface of the missing keys. Non-interactive missing **parks** in
> `needs-config` (gated by `enableSecretPreflight`, default on). `required: true`
> without `generate:` does **not** auto-generate. `.env.example` hinting and
> build-time (`build_env`) secrets are deferred to a follow-up.

## 1. Overview

Let an app **declare the secrets it requires** in `drop.yaml`, and have DROP
resolve them **before it starts the process** instead of letting the app
crash-loop at runtime. For each declared-required secret DROP either (a) has it
already (a set secret or a platform-injected var), (b) **auto-generates** it
when it is just a random value, or (c) surfaces it as **missing** — collected
via an interactive prompt on the dashboard/CLI, or, on a non-interactive deploy,
parked in a new `needs-config` state with the exact keys to set.

**Why:** apps with a hard secret requirement and no safe default (JWT signing
keys, SMTP passwords, third-party API keys — e.g. `ezsign`'s `JWT_SECRET`)
currently deploy, start, then crash-loop with a cryptic app-level error
(`uncaughtException: JWT_SECRET environment variable is required`), which the
readiness gate reports as `errored`. The operator has no signal about *what* is
missing until they read the app's logs. This turns a runtime faceplant into an
actionable, guided step — and for the random-value case, into **zero** steps.

**Preserves the philosophy:** "drop a folder, get a URL" is unchanged. An app
that declares nothing gets no gate and no prompt. The gate exists only for apps
that opt in by declaring a requirement, and auto-generate keeps the common case
zero-touch.

## 2. Design

Three parts: a **declaration** (source of truth, works on every deploy path), a
**preflight gate** (resolve → generate → prompt/park), and **surfaces** (how the
prompt / `needs-config` appears per deploy path).

### 2.1 Declaration — `drop.yaml` `secrets:`

Top-level and per-service (monorepo children), mirroring `env:`/`build_env:`:

```yaml
secrets:
  JWT_SECRET:
    required: true
    generate: random          # DROP fills a strong value if unset
    description: signs auth tokens
  SMTP_PASSWORD:
    required: true            # human-supplied — prompted / parked if unset
    description: SMTP relay password
  SENTRY_DSN:
    required: false           # advisory only; never blocks
```

- Shorthand accepted: `JWT_SECRET: generate` and `SMTP_PASSWORD: required`.
- `generate: random` → 32 bytes from `crypto.randomBytes` as base64url (no
  padding). `generate` implies `required`. (v1 supports `random` only.)
- Strict Zod parser + manifest detector, exactly like `redis`/`env` in PRD-050.
- **Reserved names** (`DATABASE_URL`, `REDIS_URL`, `PORT`, `DROP_*`) are
  platform-owned: declaring one as required is auto-satisfied when DROP provides
  it, and a declared value can never override the platform-authoritative one.

### 2.2 Preflight gate (`platform.ts`, before process start)

Runs after build, before `ProcessManager.start` (before `buildStartSpec`'s start
so a parked app never occupies a PM2 slot). For an app with declared secrets:

```
provided   = setSecrets(app) ∪ platformInjected(app) ∪ dropYamlEnvKeys(app)
generatable= declaredRequired ∩ {generate:*} − provided
missing    = declaredRequired − provided − generatable
```

1. **Auto-generate** `generatable`: `SecretManager.set(app, key, gen())` (only if
   not already set — idempotent), add to `provided`.
2. If `missing` is empty → start normally.
3. If `missing` is non-empty:
   - **Interactive** (dashboard deploy / CLI TTY): collect the values, store via
     `SecretManager`, then start. *(This is the "prompt".)*
   - **Non-interactive** (folder-drop, webhook, MCP, non-TTY CLI): **do not
     start.** Set status `needs-config` with `missingSecrets: [...]`, emit an
     event + activity-log entry (key **names** only), and return a clear message.
     When the missing secrets are later set, retry the start automatically.

### 2.3 New app status: `needs-config`

Add to the status union in `AppStateManager` / status types. Distinct from
`errored` — it is *actionable, not failed*. The readiness gate (PRD/­DROP-063) is
untouched: this precedes start, that judges a started process.

### 2.4 Surfaces

| Path | Behaviour |
|------|-----------|
| Dashboard `DeployPage` / `AppDetailPage` | `needs-config` banner lists missing keys (name + description, masked input, "Generate" for `generate:random`); submit sets secrets and retries start |
| CLI `drop deploy` | Prompts for each missing required secret on a TTY; non-TTY → non-zero exit listing them + `drop secret set <app> <KEY>` hint |
| MCP `deploy_files` / `deploy_from_git` | Result reports `needs-config` + `missingSecrets` so the caller knows exactly what to set (no silent hang) |
| Folder-drop / webhook | Parked in `needs-config`; surfaced in dashboard; auto-retry on set |

### 2.5 Soft detection (follow-up, not v1 blocker)

If no `secrets:` is declared, DROP *may* read `.env.example` / `.env.sample`
from the app root and offer those keys as **optional hints** in the interactive
prompt. Inferred keys never block and their values are never imported from any
committed `.env`. Declaration is the only thing that gates. Likely deferred to a
follow-up.

## 3. Non-Goals (v1)

- Secret rotation, versioning, or expiry (reuse `SecretManager` as-is).
- Importing values from a repo `.env` (committed secrets are a footgun — keys as
  hints only, never values).
- Static code analysis to infer required vars (unreliable).
- Build-time required secrets (`build_env`) — declaration is start-time in v1;
  note as a follow-up (private registry tokens etc.).
- Structured/multi-line secret values.

## 4. Edge Cases

- Declared-required secret that DROP provides (`DATABASE_URL` with
  `database: postgres`) → auto-satisfied, never prompted.
- `generate: random` on an already-set secret → left untouched (idempotent).
- Redeploy of an app whose secrets are already set → gate passes silently.
- Monorepo: per-service `secrets:` on children; a group deploy aggregates
  missing keys across children so the operator sets them once.
- Secret set while parked → automatic start retry (event-driven), no manual
  restart needed.
- Auth-disabled dev mode: gate still runs; `needs-config` still parks (the
  requirement is the app's, not DROP's auth).

## 5. Testing Strategy

- **Parser:** `secrets:` shorthand + object forms; reserved-name handling;
  per-service under `services.<name>`; invalid shapes rejected.
- **Preflight (unit, the core):** provided/generatable/missing set arithmetic;
  auto-generate idempotence; platform-injected + `env` keys count as provided;
  reserved names auto-satisfied.
- **Generation:** value is CSPRNG, correct length/charset, never equal across
  calls, never logged.
- **Status/flow:** missing → `needs-config` (not `errored`) and process **not**
  started; set-then-retry transitions to `running`; interactive path stores +
  starts.
- **Regression:** an app with **no** `secrets:` is completely unaffected (no
  gate, no status change) — protects the zero-config promise.
- **Live:** redeploy `ezsign` with `secrets: { JWT_SECRET: {generate: random} }`
  → deploys with **no** prompt and **no** crash (the concrete win).

## 6. Security Considerations

- Generated secrets use `crypto.randomBytes` (CSPRNG); values never logged,
  never returned in API responses, never placed in activity log (key **names**
  only).
- `needs-config` payloads expose key **names** only, never values.
- Prompt inputs masked; transmitted over the existing authenticated secrets API
  (same trust path as `SecretManager.set` today) — `admin`/`user` role as per the
  current secrets routes.
- Reserved platform var names cannot be shadowed by a declared secret.
- Never auto-import a committed `.env`.

## 7. Resolved Decisions (2026-07-24)

- **Non-interactive missing → park in `needs-config`**, gated by
  `enableSecretPreflight` (default `true`) as the escape hatch. ✅
- **`required: true` without `generate:` does NOT auto-generate** — `generate`
  stays opt-in. ✅
- **`.env.example` hinting → deferred** to a follow-up. ✅
- **Build-time (`build_env`) required secrets → deferred** to a follow-up. ✅

### Still open (settle during implementation)

- [ ] Auto-retry trigger on secret-set: event-driven restart vs. an explicit
  restart for the first cut. Leaning event-driven, but an explicit restart is an
  acceptable v1 if the event wiring is fiddly.

## 8. Implementation Notes (v1 delivered)

- **Preflight lives in `buildStartSpec`** so the missing-check runs against the
  *authoritative final env* (`providedKeys` = assembled env keys with non-empty
  values) — no duplicating platform-var knowledge. It throws `AppNeedsConfigError`
  (src/api/platform-ops.ts); `handleStartApp`/`restartApp` catch it and park.
- **Generation** runs earlier in `buildStartSpec` and treats a secret as
  "already provided" only if its stored value is **non-empty**, so a `generate`
  secret sitting at `""` is regenerated rather than booting an empty key
  (security review, medium).
- **`secrets:` map capped at 50** entries to bound shared-store rewrites
  (security review, low).
- **Auto-retry (open question → resolved for v1): dashboard-driven.** The
  `needs-config` banner's "Retry deploy" calls the existing restart, which
  re-runs the preflight. CLI/MCP users set the secret then restart. Event-driven
  auto-restart-on-secret-set is deferred.
- **Deploy-tracker not touched.** A parked deploy leaves its episode
  `in-progress` (superseded by the next deploy); MCP reads the app's live
  `needs-config` status directly to avoid the 120s wait. **Follow-up:** a
  terminal `needs-config` deploy stage so deploy history reflects the park.
- **Deferred:** `.env.example` hinting; build-time (`build_env`) required
  secrets; counting `needs-config` in `StatsDto`.

## 9. Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2026-07-24 | jules | Initial draft |
| 2026-07-24 | jules | v1 implemented (commits 6f2eb06, 00bfa54, bbfe3e8); security review applied; notes added |
