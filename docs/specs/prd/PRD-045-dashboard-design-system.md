# PRD-045: Dashboard Design System & App Shell

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-045 |
| Feature | App-wide design system + shared shell adopted from the Claude Design project |
| Status | Not Started |
| Phase | Design / Frontend |
| Priority | P2 |
| Target | v2.1+ |
| Depends On | Landing redesign (`docs/plans/2026-07-10-landing-redesign.md` — proven token set + self-hosted fonts + `html.dark` theming) |
| Blocks | PRD-046 (auth screens), PRD-047 (authenticated app) |
| Created | 2026-07-10 |

---

## 1. Overview

### 1.1 Summary

The landing page was reimplemented from the **"DROP Platform Design"** Claude Design project
(`b2fbbdb6-c229-4d84-8ed2-e05b9b6460f3`). The same project ships mockups for the **login page**
(`Login.dc.html`) and the **dashboard** (`Dashboard.dc.html`). Before those pages can be
restyled, the app needs a **shared design layer** they can both consume.

Today the authenticated dashboard styles everything with **inline Tailwind** using the existing
`drop-*` sky-blue palette (`bg-drop-600`, `focus:ring-drop-500`, `dark:` variants everywhere).
There is **no** shared `Button` / `Card` / `Input` / `Badge` primitive to restyle centrally —
so a redesign done naively would mean editing hundreds of inline class strings across every
page. This PRD establishes the foundation instead:

1. An **app-wide design-token layer** (colors, fonts, elevation) driven off the same
   `html.dark` signal the landing already uses.
2. A small set of **shared UI primitives** the redesigned pages compose from.
3. Two **layout shells** — `AppShell` (sidebar + header, from `Dashboard.dc.html`) and
   `AuthLayout` (split-screen branding, from `Login.dc.html`) — as visual containers only.

This is a **foundation PRD**: it ships primitives + shells but does not, by itself, change any
page's behavior. PRD-046 and PRD-047 consume it.

### 1.2 Goals

- [ ] App-scoped design tokens (CSS custom properties) matching the design system's palette,
      driven off the existing `html.dark` class (same mechanism as `landing.css`).
- [ ] Reuse the self-hosted `@fontsource` fonts (JetBrains Mono + Hanken Grotesk) — required by
      the app's strict CSP (`font-src 'self' data:`; Google Fonts are blocked).
- [ ] Shared primitives: `Button` (variants: primary/secondary/danger/ghost), `Card`, `Input`,
      `Badge`, `StatCard`, and a restyled `Tabs` (a `Tabs.tsx` already exists).
- [ ] `AppShell` component: 236px sidebar (logo, nav slot, daemon-status footer) + sticky header
      (breadcrumb slot, search slot, theme toggle, action slot, user-avatar slot), responsive to
      the existing mobile-drawer behavior.
- [ ] `AuthLayout` component: two-column branding + form container (animated diamond, tagline,
      host-status footer on the left; form on the right).
- [ ] No behavioral change and no regression to the existing Tailwind `drop-*` usage during the
      foundation step (primitives are additive; pages migrate in PRD-046/047).

### 1.3 Non-Goals

- Migrating page behavior or content — that's PRD-046 / PRD-047.
- Ripping out Tailwind. The design layer coexists with Tailwind; primitives may be implemented
  with Tailwind classes internally or with the token variables, whichever is cleaner.
- A full component library / Storybook. Scope is the handful of primitives the two mockups need.
- Changing `useTheme()` semantics (light/dark/system, key `drop-theme`, `.dark` on `<html>`).

---

## 2. Technical Design

### 2.1 Token layer — scoped, not global (decision)

The landing tokens live in a scoped `.drop-landing` block specifically so they don't leak. For
the authenticated app we want a shared layer, but **not** a full-page global that fights the
existing Tailwind `drop-*` palette and `darkMode:'class'` config.

**Decision:** introduce a CSS-variable layer — a `.drop-ui` wrapper — driven off the same
`html.dark` class, mirroring exactly what already works for `.drop-landing`. This avoids a
Tailwind-config rewrite and keeps light-is-base. The token names should match the landing's
(`--bg`, `--bg-2`, `--panel`, `--border`, `--text`, `--text-2`, `--accent`, `--ok`, `--warn`,
`--err`, `--elev`, `--mono`, `--sans`) so there is one vocabulary across landing + app.

**Scope — both shells, not just the authenticated tree.** The `.drop-ui` wrapper must cover
**both** `AppShell` (the authenticated app) **and** `AuthLayout` (the login/signup/change-password
screens). This is essential: the auth screens are **public routes rendered outside `Layout`**
(see PRD-046), yet they consume the shared primitives (`Button`/`Input`/`Card`) that reference
`var(--accent)`, `var(--panel)`, etc. If `.drop-ui` only wrapped the authenticated tree, those
variables would be undefined on the login page and the primitives would render broken — the exact
trap the landing avoided by scoping `.drop-landing` on the unauthenticated page itself. Put
`.drop-ui` on **both shells** (or at a common ancestor above the auth/app route split). Any
surface that uses a PRD-045 primitive must sit inside a `.drop-ui` scope.

`Dashboard.dc.html` adds `--err` (and reuses `--warn`) beyond the landing set; include the full
status triplet `--ok` / `--warn` / `--err` in both light and dark.

*Alternative considered:* map the design tokens onto the existing Tailwind `drop-*` palette and
restyle via Tailwind only. Rejected as the primary path because the design's neutral ramp
(`--bg`/`--bg-2`/`--bg-3`/`--panel`/`--border`/`--border-2`) is finer-grained than the current
`gray-*`/`drop-*` usage and would require a palette redefinition touching every existing `dark:`
class. The scoped-variable layer is the lower-blast-radius choice and consistent with the
landing. Individual primitives MAY still use Tailwind internally.

### 2.2 Shared primitives

New directory `src/dashboard/src/components/ui/`:

| Primitive | Replaces (inline patterns today) | Notes |
|---|---|---|
| `Button` | `bg-drop-600 … hover:bg-drop-700 disabled:opacity-50` | variants: primary, secondary, danger, ghost; loading state |
| `Card` | `bg-white dark:bg-gray-800 rounded-lg border …` | uses `--panel`/`--border`/`--elev` |
| `Input` | `w-full px-3 py-2 border … focus:ring-2 focus:ring-drop-500` | label, error, focus = `--accent` |
| `Badge` | per-status/role color classes | wraps existing `StatusBadge` semantics; not a rewrite of it |
| `StatCard` | (new) | for the dashboard overview strip (label, value, delta) |
| `Tabs` | existing `components/Tabs.tsx` | restyle to the design's tab underline/pills; keep API |

Primitives are additive. `StatusBadge`, `LimitBadge`, `DeployTimeline`, `LogViewer`, `Toast`,
`ConfirmDialog` keep their behavior and are restyled (not replaced) in PRD-047.

### 2.3 Shells

- **`AppShell`** (from `Dashboard.dc.html`): props are content slots — `sidebarNav`,
  `breadcrumb`, `headerSearch`, `headerActions`, `user`, `children`. It renders the 236px
  sidebar (logo + nav slot + `daemon online` footer) and the sticky header. It must preserve the
  existing responsive mobile-drawer behavior in `Layout.tsx` (hamburger, slide-in drawer,
  overlay). `Layout.tsx` becomes a thin wrapper that fills `AppShell`'s slots with the real nav
  items, `LimitBadge`, theme toggle, and logout.
- **`AuthLayout`** (from `Login.dc.html`): carries the `.drop-ui` token scope (it renders on public
  routes outside `Layout` — see §2.1). Two-column container. Left = branding panel (animated
  diamond via a scoped keyframe, "Drop a folder. / Get a URL." headline, description, host-status
  footer line). Right = a centered form container with a theme toggle in the corner. Used by all
  three auth pages in PRD-046. Collapses to single-column (form only, or form over a condensed
  banner) on narrow viewports.

### 2.4 Fonts & CSP

Reuse the already-installed `@fontsource/jetbrains-mono` and `@fontsource/hanken-grotesk`
imports. Because the whole app (not just landing) will use them, import them once at the app
entry rather than per-page. Confirm this does not bloat the main bundle unacceptably; if it does,
keep the imports on the shells that use them. External stylesheets/fonts remain blocked by CSP —
no Google Fonts, no external CSS.

### 2.5 Preserved functionality

This PRD adds primitives and shells; it must not regress:

- `useTheme()` behavior (light/dark/system; `drop-theme` key; `.dark` on `<html>`).
- The existing mobile-drawer nav behavior in `Layout.tsx`.
- The `drop-*` Tailwind palette (kept; the token layer coexists).

---

## 3. Implementation Plan

### 3.1 Files to Create/Modify

- `src/dashboard/src/styles/app-ui.css` — new `.drop-ui` scoped token layer (light base +
  `html.dark .drop-ui` dark palette), modeled on `landing.css`.
- `src/dashboard/src/components/ui/Button.tsx`, `Card.tsx`, `Input.tsx`, `Badge.tsx`,
  `StatCard.tsx` — new primitives.
- `src/dashboard/src/components/Tabs.tsx` — restyle to the design; keep the public API.
- `src/dashboard/src/components/AppShell.tsx` — new shell (sidebar + header slots).
- `src/dashboard/src/components/AuthLayout.tsx` — new auth shell (split-screen).
- `src/dashboard/src/components/Layout.tsx` — refactor to consume `AppShell` (behavior preserved).
- `src/dashboard/src/main.tsx` (or app entry) — import fonts + `app-ui.css` once; apply the
  `.drop-ui` scope so it covers **both** `AppShell` and `AuthLayout` (a common ancestor above the
  auth/app route split, or the wrapper baked into each shell — see §2.1).

### 3.2 Design source of truth

- Claude Design project `DROP Platform Design` (`b2fbbdb6-c229-4d84-8ed2-e05b9b6460f3`), files
  `Dashboard.dc.html` (shell, cards, tabs) and `Login.dc.html` (auth shell).
- Existing `src/dashboard/src/styles/landing.css` — the proven token vocabulary to mirror.

---

## 4. Risks & Open Questions

- **Token collision with Tailwind `drop-*`.** Mitigated by scoping to `.drop-ui` and driving off
  the same `html.dark`. Open question: do we eventually converge the Tailwind palette onto these
  tokens, or keep two systems? Recommendation: keep both now; converge later only if it pays off.
- **Bundle size** from importing fonts app-wide (they were landing-only + lazy before). Measure;
  fall back to per-shell imports if the main bundle grows materially.
- **Primitive API churn.** If `Tabs` restyle changes its API, `DeployPage`/`SettingsPage` (both
  use it) break. Keep the `Tabs` public API stable; restyle internals only.
- **Scope creep into a component library.** Hold the line at the primitives the two mockups need;
  resist building unused variants.
