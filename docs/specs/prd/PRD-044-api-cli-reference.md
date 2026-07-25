# PRD-044: Public REST API & CLI Reference

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-044 |
| Feature | Public in-app REST API + CLI reference page (`/reference`) |
| Status | Not Started |
| Phase | Marketing / Developer Experience |
| Priority | P2 |
| Target | v2.1+ |
| Depends On | Landing redesign (2026-07-10 plan — shared public shell); PRD-043 (docs site, sibling page); PRD-009 (REST API), PRD-010 (CLI) as the source of truth for endpoints/commands |
| Created | 2026-07-10 |

---

## 1. Overview

### 1.1 Summary

The redesigned landing page links to an **API** reference in its nav and footer (as does
the docs site, PRD-043). The design's `API.dc.html` is a public reference page documenting
the REST API and the `drop` CLI. This PRD covers building it as a real dashboard route.

Like the docs site, it is a **public** page served from the dashboard bundle, reusing the
public `SiteNav`/`SiteFooter` shell and the scoped landing theme.

### 1.2 Goals

- [ ] Public `/reference` route (dashboard SPA, no auth) using the shared public shell. (Route name avoids collision with the backend `/api/*` namespace — the dashboard is under the `/dashboard` basename, but `/reference` is unambiguous.)
- [ ] Left nav grouped into "Overview" (Authentication, CLI commands) and "Endpoints" (per-endpoint anchors with HTTP-method chips), matching `API.dc.html`.
- [ ] Authentication section: JWT (login) + API keys (Bearer header), with `drop keys create` example — reflecting the **real** auth model (`src/api/middleware/auth.ts`, `api-credentials.json`).
- [ ] Endpoints section: method + path + description cards, generated from / verified against the **real** routes under `src/api/routes/` (mounted at `/api/v1/*`) — not the design's illustrative `/api/apps` paths.
- [ ] CLI section: command + description rows, verified against the **real** CLI (`src/cli/`), e.g. `drop deploy`, `drop list`, `drop logs`, `drop status`, `drop restart`, `drop domain`, `drop keys`.
- [ ] Cross-links to the docs site (PRD-043) and dashboard.
- [ ] Re-point the landing's nav/footer "API" / "API Reference" / "CLI" links from the GitHub placeholder to `/reference`.

### 1.3 Non-Goals

- Interactive "try it" request console.
- Auto-generated OpenAPI/Swagger spec (a possible future enhancement — this page is hand-curated first).
- SDK/client-library documentation.

---

## 2. Technical Design

### 2.1 Route & shell

- Add a public route `/reference` in `src/dashboard/src/App.tsx` (not wrapped in `Layout`), wrapped in `.drop-landing`, using `SiteNav current="api"` + `SiteFooter`.

### 2.2 Accuracy requirement

The single most important constraint: **the documented endpoints, methods, paths, and CLI
commands must match the real implementation.** The design's `API.dc.html` uses illustrative
paths (`/api/apps`, base `http://localhost:4300/api`) and CLI names (`drop ps`, `drop db`)
that differ from this codebase (routes under `/api/v1/*`; CLI uses `drop list`, etc.).
Enumerate from source:

- Endpoints: `src/api/routes/*` mounted in `src/api/server.ts` under `/api/v1`.
- Auth: `src/api/middleware/auth.ts` (JWT + API keys, role tiers readonly/user/admin).
- CLI: `src/cli/commands/*`.

Consider a lightweight build-time or test-time check that the documented endpoint list
does not drift from the mounted routes.

### 2.3 Method-chip color tokens

`API.dc.html` adds `--get/--post/--put/--del` tokens to the scoped theme for HTTP-method
chips; fold these into the landing theme tokens (or a `reference`-scoped block).

---

## 3. Implementation Plan

### 3.1 Files to Create/Modify

- `src/dashboard/src/pages/ReferencePage.tsx` — new public reference page.
- `src/dashboard/src/App.tsx` — add the `/reference` route.
- `src/dashboard/src/components/landing/SiteNav.tsx` — honor `current="api"`; repoint "API" link to `/reference`.
- `src/dashboard/src/components/landing/SiteFooter.tsx` — repoint "API Reference" / "CLI" links to `/reference` (`#cli`).
- `src/dashboard/src/styles/landing.css` — add HTTP-method chip tokens if not present.

### 3.2 Design source of truth

- Claude Design project `DROP Platform Design` (`b2fbbdb6-c229-4d84-8ed2-e05b9b6460f3`), file `API.dc.html` (visual/structure), reconciled against the real API/CLI source for content.

---

## 4. Risks & Open Questions

- **Drift** between documented and actual endpoints/commands is the main risk — mitigate by generating from or testing against source.
- Route naming: `/reference` vs `/api` vs `/docs/api`. `/api` is avoided to prevent confusion with the backend API namespace even though the basename makes them technically distinct. Final name TBD with the docs IA (PRD-043).
- Whether to eventually derive this page from an OpenAPI document (would remove drift entirely) — deferred as a non-goal for the first version.
