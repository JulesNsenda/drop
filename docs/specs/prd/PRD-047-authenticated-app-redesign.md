# PRD-047: Authenticated App Redesign (Shell, Apps, App Detail, & Pages)

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-047 |
| Feature | Redesign the authenticated dashboard to `Dashboard.dc.html` |
| Status | Not Started |
| Phase | Design / Frontend |
| Priority | P2 |
| Target | v2.1+ |
| Depends On | PRD-045 (design system + `AppShell`) |
| Related | PRD-048 (per-app metrics), PRD-022 (custom domains), PRD-020 (per-user limits), PRD-027 (limit indicator), PRD-034 (build logs), PRD-016 (git deploy), PRD-039 (source upload), DROP-042 (API keys) |
| Created | 2026-07-10 |

---

## 1. Overview

### 1.1 Summary

Restyle the authenticated dashboard to the **`Dashboard.dc.html`** mockup: a 236px sidebar +
sticky header shell, an applications overview with stat cards, an applications list, and a
selected-app detail panel organized into **Logs / Metrics / Environment / Domains** tabs. The
same visual system is then applied to the remaining authenticated pages (Deploy, Settings, Users,
404) so the whole app is consistent.

The mockup is a representative desktop view. It **omits** a large amount of real behavior
(search/filter, deploy timeline, build logs, git info, app limits, role gating, the Users page,
the deploy flow, MFA/API-key management in Settings). All of that is **preserved and restyled**.
Two things need care: (1) the mockup's **top-level nav** (Databases/Domains/Logs) is aspirational
and is reconciled to real routes/tabs; (2) the detail panel's **Metrics tab** is only partly
backed by real data and is specced in **PRD-048**.

### 1.2 Goals

- [ ] `Layout` renders via `AppShell` (PRD-045): sidebar (logo, nav, `daemon online` footer) +
      sticky header (breadcrumb, search, theme toggle, "+ New deploy", user avatar).
- [ ] **Nav reconciliation** (see §2.1): Applications → `/apps`, Deploy → `/deploy`, Settings →
      `/settings`, Users → `/users` (admin-only, **kept** though the mockup omits it). Do **not**
      add dead top-level Databases/Domains/Logs items.
- [ ] `AppsPage`: an **overview stat strip** (`StatCard`s) + the applications list, preserving
      search, status filters, empty/no-results states, status badges, the app-limit indicator,
      and per-app external links.
- [ ] `AppDetailPage`: reorganize its current linear sections into the mockup's **tabbed** detail
      panel — **Logs** (existing `LogViewer`), **Environment** (existing env-vars section),
      **Domains** (existing custom-domain section, aligned with PRD-022), plus a **Metrics** tab
      (PRD-048). Preserve Restart/Stop/Start/Redeploy/Delete, git info, deploy timeline, info
      cards, and all role gating.
- [ ] Restyle `DeployPage`, `SettingsPage`, `UsersPage`, `NotFoundPage` to the design system
      (PRD-045 primitives + `Card`/`Tabs`), preserving all their current functionality.
- [ ] All existing shared components (`StatusBadge`, `LimitBadge`, `DeployTimeline`, `LogViewer`,
      `Toast`, `ConfirmDialog`) restyled, not rewritten.

### 1.3 Non-Goals

- New backend features. The Environment and Domains tabs surface **existing** data (secrets;
  PRD-022 custom domains). Real request/latency metrics are **PRD-048**, not here.
- Standalone Databases / Domains / Logs pages (see §2.1 — deferred; separate PRDs if ever wanted).
- Changing any API, auth, or deploy behavior.
- The auth/login screens (PRD-046).

---

## 2. Technical Design

### 2.1 Navigation reconciliation (do not adopt the mockup's nav blindly)

The mockup sidebar shows Applications / Deployments / Databases / Domains / Logs / Settings. Real
nav today is **Applications (`/apps`) / Deploy (`/deploy`) / Users (`/users`, admin-only)**.
Resolution:

| Mockup nav item | Resolution |
|---|---|
| Applications | → `/apps` (direct) |
| Deployments | → `/deploy` (our deploy page; adopting the label "Deployments" is a copy choice, not new functionality) |
| Settings | → `/settings` |
| Databases | **not** a top-level page; databases are per-app. Omit as top-level for this pass. |
| Domains | **not** a top-level page; surfaced as the app-detail **Domains** tab. Omit as top-level. |
| Logs | **not** a top-level page; surfaced as the app-detail **Logs** tab. Omit as top-level. |
| *(missing)* Users | **Keep** `/users` (admin-only) — the mockup omits it; we do not drop it. |

Every visible sidebar item must route somewhere real. Standalone Databases/Domains/Logs pages, if
desired later, are separate PRDs — not silent empty routes here.

### 2.2 AppShell wiring (Layout)

`Layout.tsx` fills `AppShell` slots:
- **Sidebar:** logo; nav items per §2.1 with the design's glyph treatment; `daemon online` footer
  reflecting real platform-health status (from `/health`), not a static dot.
- **Header:** breadcrumb (`apps / {name}` on detail); the header search box (wired to `AppsPage`
  search, or omitted on pages without search); theme toggle; "+ New deploy" → `/deploy`; user
  avatar → account menu (must preserve **logout**, PRD-026).
- **Preserve:** the mobile-drawer behavior, the **admin** badge, the **`LimitBadge`** (PRD-027)
  for non-admins, and the role-gated Users link.

### 2.3 AppsPage — overview + list

- **Overview strip:** `StatCard`s mirroring the mockup (Apps online, Databases, Avg CPU, …).
  Source only from **real** data: apps-online and per-app CPU/memory come from PM2
  (`ProcessManager` / `pm2-client`), database count from the provisioner. **Requests/min** has no
  data source yet → either omit that card or gate it on PRD-048. Never render fabricated numbers.
- **List:** restyle the app cards/rows to the mockup (status dot, name, domain, runtime·port,
  uptime). **Preserve:** search (name/type/framework), status-filter pills with counts, refresh,
  empty-state onboarding card (with "Deploy from GitHub" → `/deploy`), no-results state, owner
  column for admins, and per-app error snippet.

### 2.4 AppDetailPage — introduce tabs over existing sections

Today the detail page is **linear sections** (info cards, deploy timeline, custom-domain input,
git source, env vars, `LogViewer`) — it has **no tabs**. The mockup organizes the detail panel
into tabs. Map existing content onto tabs (using the restyled `Tabs` primitive):

| Tab | Backed by (existing unless noted) |
|---|---|
| **Logs** | existing `LogViewer` (Runtime/Build sub-tabs, filters, search, pause, copy/download) |
| **Metrics** | **PRD-048** — CPU/memory/uptime from PM2 now; req/latency later |
| **Environment** | existing env-vars section (masked values, add/remove, role-gated, "takes effect on next restart") |
| **Domains** | existing custom-domain input + PRD-022 custom domains; show cert status if available |

**Preserve (outside the tabs or as a header):** the status badge + type; Restart / Stop / Start /
Restart(yellow) / **Redeploy** (only when `gitSource`) / **Delete** (with the existing
`ConfirmDialog` copy); the info cards (URL, path/type, last-deployed + build duration); the
**deploy timeline** (PRD-034/PRD-035 context); git source table (repo link, branch, commit
SHA-7, auto-redeploy); the app-error banner; and all role gating (readonly can view env but not
mutate).

Where to place the deploy timeline and info cards (inside a tab vs. above the tabs) is a layout
choice for implementation; default recommendation: keep info cards + actions + deploy timeline in
a header/summary region above the tabs, so the tabs hold the deep views.

### 2.5 Remaining pages (restyle, preserve behavior)

- **DeployPage:** restyle the **GitHub / Upload** tabs, repo/branch/name inputs, the **token
  manager** panel, auto-redeploy checkbox, drag-and-drop zone, the deploy-progress step messages,
  and success/error result cards. Preserve the polling behavior and all `/git` + upload API calls.
- **SettingsPage:** restyle the tab set — **System** (admin), **Account**, **API Keys** (admin),
  **Activity** (admin), **About**. Preserve: system-health cards + component table + app
  health-check polling; the Account tab's **change-password**, **MFA enable/disable (TOTP + QR +
  recovery hint)**, and **delete-account** (non-admin); the `ApiKeysTab` CRUD (DROP-042); the
  activity log polling. Role-gating of tabs is preserved exactly.
- **UsersPage:** restyle the list table + detail view. Preserve: enable/disable, **editable app
  limit** (PRD-020), reset-password, the user's apps list, and recent-activity — all admin-only.
- **NotFoundPage:** restyle the 404 (PRD-025); keep the "Back to dashboard" → `/apps` link.

### 2.6 Preserved-functionality matrix (master checklist)

| Page | Must preserve |
|---|---|
| Shell | sidebar nav; mobile drawer; theme toggle; `LimitBadge`; admin badge; logout; role-gated Users |
| Apps | search; status filters + counts; refresh; empty/no-results; status badges; external links; owner col (admin); error snippet |
| App detail | logs (+build logs); deploy timeline; Start/Stop/Restart/Redeploy/Delete; git info; env add/remove (role-gated); custom domain; info cards; error banner |
| Deploy | GitHub + Upload tabs; token manager; auto-redeploy; drag-drop; progress steps; polling; success/error cards |
| Settings | System/Account/API Keys/Activity/About tabs; MFA setup/disable; change password; delete account; health polling; activity polling; role gating |
| Users | list + detail; enable/disable; app-limit edit; reset password; user apps; activity — admin-only |
| 404 | not-found + back-to-apps link |

---

## 3. Implementation Plan

### 3.1 Files to Create/Modify

- `src/dashboard/src/components/Layout.tsx` — fill `AppShell` slots; nav per §2.1.
- `src/dashboard/src/pages/AppsPage.tsx` — overview strip + restyled list.
- `src/dashboard/src/pages/AppDetailPage.tsx` — tabbed detail panel over existing sections.
- `src/dashboard/src/pages/DeployPage.tsx` — restyle (behavior preserved).
- `src/dashboard/src/pages/SettingsPage.tsx` — restyle (tabs + behavior preserved).
- `src/dashboard/src/pages/UsersPage.tsx` — restyle (behavior preserved).
- `src/dashboard/src/pages/NotFoundPage.tsx` — restyle.
- `src/dashboard/src/components/{StatusBadge,LimitBadge,DeployTimeline,LogViewer,ApiKeysTab}.tsx`
  — restyle to the design tokens; **no behavior change**.
- (Reuse) PRD-045 primitives + `Tabs` + `StatCard`.

*Implementation note:* this PRD is large. It may be split per-page into parallel work units during
implementation; it is kept as one PRD because the pages share the shell and primitives.

### 3.2 Design source of truth

- Claude Design project `DROP Platform Design` (`b2fbbdb6-c229-4d84-8ed2-e05b9b6460f3`), file
  `Dashboard.dc.html` (shell, stat cards, list, detail tabs). Deploy/Settings/Users/404 have no
  dedicated mockup — apply the same system by analogy.

### 3.3 Verification

- Headless-Chrome harness with **authenticated** stubs: `/api/v1/auth/status` → enabled and the
  `/me`/apps endpoints returning a signed-in user + sample apps so the shell renders. Check
  dark/light/mobile; verify search/filter, tab switching, and role-gated elements (admin vs
  user vs readonly) via different stubbed roles.

---

## 4. Risks & Open Questions

- **Silent behavior loss.** The mockup omits most real behavior; the §2.6 matrix is the guard.
  Highest-risk drops: search/filter on Apps, MFA management in Settings, app-limit edit in Users,
  build logs + deploy timeline on detail.
- **Dead nav.** Adopting Databases/Domains/Logs as top-level would create empty routes. Resolved
  in §2.1 (omit as top-level; surface as app-detail tabs).
- **Fabricated stats.** The overview + Metrics tab must only show real data. Requests/min has no
  source until PRD-048 — omit or gate it; do not invent it.
- **Tabs vs. linear content on detail.** Moving sections into tabs changes information scent;
  ensure destructive actions (Delete) and status stay visible regardless of active tab (§2.4
  recommends a summary/header region above the tabs).
- **`Tabs` API stability.** `DeployPage` and `SettingsPage` already use `Tabs`; the PRD-045
  restyle must not break its API.
- **PR size.** Consider landing PRD-045 + shell first, then per-page PRs, to keep reviews tractable.
