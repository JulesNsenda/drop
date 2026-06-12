# AI Support for DROP

**Date:** 2026-06-12
**Status:** Draft — awaiting approval
**Target releases:** v2.0 GA (Track 0 + security fixes), v2.1 (MCP), v2.2 (diagnosis, demand-gated)

---

## Goal

Make DROP usable *by* AI agents (Claude Code, Cursor, etc.) and add AI assistance *inside* DROP where it genuinely beats what users already have. The user base is developers self-hosting a PaaS — they almost all already pay for an AI coding tool. The plan exploits that instead of competing with it.

## What was considered and cut

The original draft had three tracks: (1) MCP server, (2) AI build-failure
diagnosis with an AIService manager + encrypted key storage + Settings UI,
(3) a dashboard chat assistant with server-side tool-use. After adversarial
review (three agents: security, simplicity, integration — see bottom),
the plan was restructured:

- **Track 3 (dashboard chat assistant) is cut entirely.** All three reviewers
  converged on this independently. It is: a prompt-injection confused-deputy
  risk (tenant-controlled build logs/app names flow into a privileged
  tool-use loop), a privilege-escalation hazard (in-process tool execution
  bypasses route auth middleware), the largest maintenance surface (SSE +
  tool loop + conversation persistence + authz matrix), and a strictly worse
  client than Claude Code pointed at the MCP server — which can also edit the
  user's actual app code. Revisit only on concrete user demand, as its own
  threat-modeled release.
- **Settings UI for AI key management is cut.** `ANTHROPIC_API_KEY` env var
  on the platform process. A self-hoster who can set `DROP_ROOT` can set an
  env var. This also dissolves a hidden critical-path dependency: there is
  **no platform-config read/write API today** (SettingsPage.tsx hardcodes its
  config table client-side), so the Settings-UI path would have required a
  whole new admin config API first.
- **AIService manager singleton is cut.** The diagnosis feature is one
  stateless HTTP call; it gets a plain module, not `get*/reset*` lifecycle
  ceremony wired into `platform.stop()`.
- **Diagnosis result caching is cut (initially).** Stateless endpoint;
  re-running costs cents. Avoids coupling a new sidecar artifact to
  BuildLogService's 10-build retention (orphan risk identified in review).
- **MCP secrets tools are cut.** Both the security and simplicity reviewers
  flagged `set_secret` as a silent destructive overwrite an agent will
  eventually misfire. Secrets stay a human/dashboard action.

---

## Track 0 — Agent-facing docs + copy button (v2.0 GA)

Zero/near-zero code. Ships the cheapest 80% of the value immediately.

1. **`docs/AI.md`** — a guide for AI coding agents (and their users) driving
   DROP: CLI recipes (`drop list/status/logs/deploy/...`), REST API recipes
   with API-key auth (`curl` against `/api/v1`), how to get build logs, the
   runtime directory layout. Written so a user can paste it into their
   project's CLAUDE.md / agent rules.
2. **"Copy build log" button** in the dashboard build-log panel (~10 lines).
   Works with whatever AI the user already has, needs no key, no endpoint.
   This is the experiment that decides whether Track 2 ships at all.

## Track 1 — MCP server (v2.1)

A thin stdio MCP server that proxies to DROP's REST API, so Claude Code /
Cursor / any MCP client can manage deployments conversationally.

**Packaging decision (load-bearing):** ships as a **separate slim npm
package** in-repo at `packages/mcp/` (same separate-package pattern as
`src/dashboard/`), published as e.g. `drop-mcp`, runnable via `npx drop-mcp`.

- *Why not `drop mcp` in the main CLI:* the main package deps include `pm2`,
  `dockerode`, `pg`, `bcrypt` (native build) — hundreds of MB on every client
  laptop for what is a thin HTTP proxy. Worse, `src/cli/utils/output.ts`
  writes spinners/tables/info lines to **stdout**, which corrupts the stdio
  JSON-RPC stream; a separate package never imports any of it.
- Deps: `@modelcontextprotocol/sdk` only (+ native `fetch`). Nothing added to
  the main `package.json`.

**Tool set (7, read-heavy):** `list_apps`, `get_app`, `get_logs`,
`get_build_log`, `list_builds`, `get_health`, `restart_app`. No deploy, no
remove, no secrets — mutating actions an agent shouldn't own stay with the
human. `restart_app` is included because "restart the failing service" is the
single most common agent ask and is low-blast-radius.

**Auth:** `DROP_API_URL` + `DROP_API_KEY` env vars, both **hard-required** —
no fallback to the local `local.key` (the existing CLI fallback would
silently send a stale local key to a remote box and produce baffling 401s).
The API key's existing server-side role enforcement is the authz model; the
MCP server adds none of its own.

**Transport:** stdio only. The MCP server is a local process proxying to a
(possibly remote) REST API — this deliberately dodges the OAuth/session
machinery of remote MCP transports. Explicit non-goal, now and later:
serving MCP from the DROP platform process itself (new authenticated network
surface inside a multi-tenant server).

**Files:**
- `packages/mcp/package.json`, `tsconfig.json`, `src/index.ts` (server +
  transport), `src/tools.ts` (schemas + handlers), `src/api-client.ts`
  (thin fetch wrapper)
- `docs/AI.md` gains an MCP setup section
- Test asserting stdout silence during startup (regression guard for the
  JSON-RPC corruption class)
- New PRD: `docs/specs/prd/PRD-039-mcp-server.md`

## Track 2 — AI build-failure diagnosis (v2.2, demand-gated)

Ships **only if** Track 0's copy button proves insufficient (users ask for
in-product diagnosis). Scope if it ships:

- `POST /api/v1/ai/diagnose/:app` — sends the last ~200 lines of the latest
  failed build log + app type/metadata to the Anthropic API, returns
  explanation + suggested fix. Stateless, no cache.
- Key: `ANTHROPIC_API_KEY` env var; clear 503-with-message if unset. Model:
  one constant, `DROP_AI_MODEL` env override, no UI dropdown (model-name rot
  becomes a support ticket otherwise).
- Dashboard: "Diagnose" button in the build-log panel, shown only when the
  platform reports AI is configured (flag on the health/config response).
- Implementation: `src/api/routes/ai.ts` + `src/managers/ai/diagnose.ts`
  (plain functions, no singleton). New PRD: `PRD-040-ai-build-diagnosis`.

**Hard security prerequisites (block Track 2; see next section):** P1, P2, P3.

## Security work harvested from review

The security audit found real issues in **current** code, independent of AI.
The first one is the reason Track 2 cannot ship today.

**Blocking for Track 2:**
- **P1 (HIGH, exists today):** `executeEnvironment` in `builder.ts` merges
  `process.env` into `context.env`, which is then passed as overrides to
  `sanitizeBuildEnv` — defeating the sanitizer for install/build commands.
  Host secrets (`DATABASE_URL`, `PGPASSWORD`, npm tokens…) can end up in
  build logs. Fix: stop merging `process.env` in the environment stage;
  expand the secret-env list (or move to allowlist). **This should land in
  v2.0 GA regardless of any AI work.**
- **P2 (HIGH):** redact build log content (token/connection-string patterns,
  `https://user:pass@`, `postgresql://…`) before any external API dispatch.
- **P3 (HIGH):** `/api/v1/ai/*` gets its own tight rate limit keyed by
  **user ID** (not IP), role minimum `user` (not `readonly`), and a
  per-user daily quota — otherwise any authenticated user burns the admin's
  Anthropic credits at 100 req/min.

**v2.0 GA hardening (not AI-specific, found in passing — fix cheap, fix now):**
- `app.onError` in `server.ts` leaks raw `err.message` (paths, PG connection
  strings) to clients; return generic message, log server-side.
- Suspended users keep valid JWTs up to 24h; add live `enabled` check in
  `authMiddleware` after JWT verification.
- Audit middleware trusts `X-Forwarded-For` unconditionally (rate limiter
  already does loopback-only); apply the same guard.
- `getBuildLog` containment check resolves the path but reads the unresolved
  one; read from `fileResolved`.
- `ALTER USER … WITH PASSWORD '${password}'` in database-provisioner: switch
  to parameterized form (currently safe by accident of the password alphabet).

## Sequencing & dependency graph

```
v2.0 GA   ← P1 + the five hardening fixes + Track 0 (docs, copy button)
   │         (nothing AI-flavored lands before GA; the RC test baseline
   │          and Hetzner pipeline coverage stay valid)
v2.1      ← Track 1: packages/mcp (no new server surface, no new main deps)
v2.2      ← Track 2: diagnose endpoint (gated on demand signal from the
             copy button; requires P2 + P3)
never*    ← Track 3 dashboard chat (*absent concrete demand + own threat model)
```

## Risks & open questions

- **Does anyone use the MCP server?** Mitigated by ordering: docs ship first
  and are nearly free; MCP is ~300 lines and one dep. If docs alone satisfy
  users, v2.1 can slip with no loss.
- **MCP spec churn** — the SDK is still evolving; pin the SDK version, keep
  the tool surface small (7 tools = small re-validation surface).
- **Anthropic-only diagnosis** — Track 2 hardcodes one provider. Acceptable
  for a first cut; a provider abstraction is exactly the premature
  generality the review cut. Revisit if users ask for local models.
- **Repo URL inconsistency** — README/install scripts reference
  `JulesNsenda/drop`; confirm package name `drop-mcp` is available on npm
  before committing to it in docs.
- **Open:** should `deploy_app` join the MCP tool set later? Leaning no
  (agents triggering deploys of arbitrary paths is the riskiest tool); a
  human `drop deploy` is one command. Revisit with usage data.

## Agent critiques considered

- **Security auditor** (11 findings): found P1 (live build-env leak defeating
  `sanitizeBuildEnv`), the exfiltration path via diagnose (→ P2), cost abuse
  (→ P3), prompt injection in Track 3's tool loop (→ contributed to cutting
  Track 3), `set_secret` destructiveness (→ tool cut), plus five
  pre-existing non-AI fixes adopted into v2.0 GA scope above. One finding
  (AI key co-located with app secrets in SecretManager) was mooted by
  cutting key storage entirely in favor of the env var.
- **Simplicity critic** (10 cuts): "docs + copy button first" reframing
  adopted as Track 0; tool set 13→6-7 adopted; AIService manager, Settings
  UI, diagnosis cache, conversation persistence all cut as proposed; "drop
  Track 3 entirely" adopted. Its strongest claim — *maybe MCP isn't needed
  at all since agents drive CLIs natively* — was **partially rejected**: docs
  ship first, but the MCP server stays planned for v2.1 because structured
  tools with typed schemas are meaningfully more reliable for agents than
  freeform shell against a remote API, and the cost (one slim package) is
  low. This is the one place the plan consciously overrides a reviewer.
- **Integration reviewer** (8 risks): separate-package extraction for MCP
  (adopted — the decisive argument: main-package deps + stdout pollution),
  local.key fallback hazard (adopted as hard-require), diagnosis-cache
  orphaning under retention (mooted by going stateless), tool-reuse between
  MCP and Track 3 being a false economy (mooted by cutting Track 3),
  SettingsPage having no config API to piggyback on (mooted by env var),
  SSE/rate-limit interactions (mooted by cutting Track 3), "nothing before
  v2.0 GA" sequencing (adopted), stale VERSION-ROADMAP.md (to be updated
  alongside the new PRDs).

**Reviewer disagreement surfaced:** simplicity said "MCP only if demand
materializes"; integration said "MCP is the only track that can start today."
Resolution: MCP is committed for v2.1 (not demand-gated) because it's the
product answer to "AI support" with the best risk/effort profile; Track 2 is
the demand-gated one.
