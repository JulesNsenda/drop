# Landing page redesign — import `Landing.dc.html` from Claude Design

**Date:** 2026-07-10
**Slug:** landing-redesign
**Driver:** `/goal` — import the Claude Design project and implement `Landing.dc.html`, adapting the current landing to the sample's look, preserving existing functionality, and writing PRDs for functionality the sample implies that we don't yet have.

## Goal

Replace the current minimal one-screen landing (`src/dashboard/src/pages/LandingPage.tsx`) with the full marketing landing from the Claude Design project
`DROP Platform Design` (`b2fbbdb6-c229-4d84-8ed2-e05b9b6460f3`, file `Landing.dc.html`), translated faithfully to React while:

1. **Adopting the sample's look** — CSS-variable theme, JetBrains Mono + Hanken Grotesk fonts, accent `#2E9BFE`, bento/terminal/floating-card layout, dark + light.
2. **Preserving all existing landing functionality** — auth-status probe, redirect-if-authenticated, loading state, `handleEnter` (login vs. direct enter), and the signup link — restyled to match.
3. **Creating PRDs** for the two pages the sample links to that don't exist yet: a public **Docs** site and a public **API/CLI reference** page.

## Key facts established during orientation

- **Current dashboard**: React 18 + Vite + Tailwind (`darkMode: 'class'`, `.dark` on `<html>`), `drop-*` sky-blue palette (`drop-500 #0ea5e9`), **system fonts**, existing `useTheme()` hook (`{theme,setTheme}`, key `drop-theme`, default `system`). Routes under basename `/dashboard`. Landing at `/` is **standalone** (not wrapped in `Layout`).
- **Design**: CSS custom properties + `data-theme` (same `drop-theme` key), accent `#2E9BFE`, JetBrains Mono (mono, used for headings) + Hanken Grotesk (sans). Shares `SiteNav` + `SiteFooter`. Links to `Docs.dc.html`, `API.dc.html`, `Dashboard.dc.html`, `Login.dc.html`.
- **CSP is strict and global** (`server.ts`: `app.use('*', securityHeadersMiddleware())`; `style-src 'self' 'unsafe-inline'`, `font-src 'self' data:`). External Google Fonts are **blocked**; inline `style=` is allowed. → **self-host fonts**.
- **Real MCP tools**: `deploy_files`, `deploy_from_git`, `list_apps`, `app_status`, `app_logs`, `restart_app` (design's `drop_*` names are decorative — use the real ones).
- **Repo URL** for external links: `https://github.com/JulesNsenda/drop` (the git remote embeds a PAT — never write the tokenized form anywhere).

## Approach

### Theming (the one genuinely uncertain decision — resolved)
Scope the design's CSS-variable system to a `.drop-landing` wrapper and **drive it off the existing `html.dark` class** (no parallel `data-theme` signal that could desync):

```css
.drop-landing { /* light values (base) — matches repo's light-is-base convention */ }
html.dark .drop-landing { /* dark values */ }
```

`LandingPage` calls `useTheme()` (so the class is actually applied on this route, which has no `Layout`). The `SiteNav` toggle maps the design's binary switch onto `setTheme(isDark ? 'light' : 'dark')`. Default stays `system` (consistent with the dashboard; the page looks right in both).

### Fonts (CSP-safe, offline-safe)
Add `@fontsource/jetbrains-mono` + `@fontsource/hanken-grotesk` to the dashboard package; import weights 400/500/600/700 for each. These bundle woff2 as `'self'` assets under `/dashboard/assets/` — pass CSP and work air-gapped. Font stacks keep `ui-monospace,monospace` / `system-ui,sans-serif` fallbacks if install fails.

### Structure & translation
- Everything scoped under `.drop-landing`; **do not** port the design's global `*{}` / `html,body{}` rules (Tailwind Preflight already resets; adding them would clobber the rest of the dashboard).
- Translate inline `style=""` → React `style={{}}` (allowed by `'unsafe-inline'`). `sc-for` → `.map()`. `dc-import` → real components. Drop DC-only attributes (`style-hover`, `ref="{{}}"`, `sc-if`) — replace hovers with scoped CSS helper classes.
- Hardcode the DC "props" to their defaults (JetBrains+Hanken pairing, accent `#2E9BFE`, terminal cursor `blink` keyframe on).
- Add `id="runtimes"` to the runtimes strip (footer anchors to it); `#features/#mcp/#dashboard/#config/#cli` already present.

### Link mapping (no dead links / no `href="#"` / no SPA 404s)
- Logo → `/`; "Features" → `#features`; other in-page anchors as-is.
- Auth CTAs — "Sign in", "Get started", "Start deploying", terminal URL, "Open the dashboard", final "Get started", footer "Sign in" → **`handleEnter`** (`/login` if auth enabled else `/apps`).
- "Create an account" (preserved) → `/signup`, shown under the hero CTA when auth is enabled.
- "Documentation" / "Docs" / "API" / "CLI" / footer "GitHub" → external `https://github.com/JulesNsenda/drop` (`target="_blank" rel="noopener noreferrer"`) until the real pages ship (PRD-043/044); PRDs note re-pointing to `/docs` and `/api` later.
- MCP config uses the real tool names; "copy" buttons wired to `navigator.clipboard` (progressive enhancement, cheap).

### Preserved functionality (must not regress)
`authEnabled` via `/api/v1/auth/status`; redirect to `/apps` when authenticated; branded loading state (restyled); `handleEnter`; signup link.

## File-level changes

**Edit**
- `src/dashboard/package.json` — add `@fontsource/jetbrains-mono`, `@fontsource/hanken-grotesk`. *(done)*
- `src/dashboard/src/pages/LandingPage.tsx` — rewrite: font imports, `.drop-landing` wrapper, single `useTheme()` (passes `isDark`/`onToggleTheme` down), preserved `authEnabled` fetch + `handleEnter` + signup link + restyled loading, renders `SiteNav` + sections + `SiteFooter`.
- `src/dashboard/src/App.tsx` — `React.lazy` + `Suspense` on the `index` route; gate authenticated→`/apps` (and mustChangePassword→`/change-password`) at route level, mirroring the login route.
- `src/dashboard/index.html` — `theme-color` `#6366f1` → `#2E9BFE`.

**Add**
- `src/dashboard/src/styles/landing.css` — scoped `.drop-landing` variables (light + `html.dark` dark), scoped `a`/`code`/`pre`/`::selection`, hover helper classes, `@keyframes blink`.
- `src/dashboard/src/components/landing/SiteNav.tsx` — sticky public nav + theme toggle.
- `src/dashboard/src/components/landing/SiteFooter.tsx` — footer columns + status line.
- `src/dashboard/src/components/landing/LandingSections.tsx` — the 9 marketing sections as named exports: `Hero`, `McpSection`, `RuntimesStrip`, `HowItWorks`, `FeaturesBento`, `DashboardPreview`, `ConfigSection`, `CliApiSection`, `FinalCta`. Takes an `onEnter` callback + `authEnabled`.
- `docs/specs/prd/PRD-043-public-docs-site.md` — public documentation site (mirrors `Docs.dc.html`).
- `docs/specs/prd/PRD-044-api-cli-reference.md` — public REST API + CLI reference page (mirrors `API.dc.html`).

## Risks & open questions

- **Font install/network**: `npm install @fontsource/*` needs network at build time. Mitigation: fallbacks in the font stack; verify install succeeds.
- **FOUC of theme**: no pre-paint theme script exists today (dashboard-wide), so a brief light flash for dark users is possible — **same as current behavior**, not a regression; out of scope to add a global pre-paint script.
- **Fidelity**: an inline-style translation of a 350-line bento/terminal/floating-card layout can drift. **Primary gate = browser render in dark AND light**, not a passing build.
- **`pre` whitespace** in JSX must be preserved exactly for the terminal/yaml/json blocks.
- **Marketing truthfulness**: content claims (Caddy/Let's Encrypt, Postgres auto-provision, PM2, hot reload, MCP) are all real DROP features; MCP tool names corrected to real ones.

## Agent critiques considered (3 adversarial reviewers, reconciled)

**Correctness / CSP & fidelity**
- **`<pre>` whitespace (HIGH)** — JSX collapses multi-line text children even inside `<pre>`. Every code block MUST be a template-literal expression `<pre>{`…\n…`}</pre>` (or span/`<br/>` array). Adopted.
- **`script-src 'self'` (no inline)** — audit the DC source for `<script>`; convert to `useEffect`. Verified: the Landing source has no reveal/typewriter/analytics scripts (only the DC-runtime `<script type="text/x-dc">`, which becomes React data, and a pre-paint theme script we replace with `useTheme()`). The only animation is the CSS `blink` keyframe. Nothing inline survives.
- **Resolved theme (MED-HIGH)** — `useTheme()` exposes only raw `theme` (`light|dark|system`), not the resolved boolean, and has no Context. `LandingPage` makes the single `useTheme()` call and passes `{ isDark, onToggleTheme }` to `SiteNav` (tracking resolved state via the `.dark` class). Adopted.
- **Authed page-weight flash (MED-HIGH)** — redesign turns the splash into a heavy page. Gate the authenticated→`/apps` redirect at the **route level** in `App.tsx` (mirror the login route) so authenticated users never mount the landing. Adopted (combines with lazy-load below).
- **Internal links (MED)** — basename is `/dashboard`; raw `<a href="/login">` 404s. Use `navigate()`/`<Link>` for internal, plain `<a>` for `#anchors`, `target="_blank" rel="noopener noreferrer"` for external. Adopted.
- `@fontsource` CSP-compliance **confirmed** (bundled same-origin woff2 + external stylesheet, no `unsafe-inline` needed); also eyeball built `dist/dashboard/index.html` for any stray external font link.

**Simplicity / over-engineering**
- **Cut the clipboard copy** — scope creep + fails outside secure contexts (default deploy is HTTP). Render "copy" as a static label (matches the sample). Adopted.
- **Use `lucide-react` for glyph icons** — the sample's Unicode symbols (`⚿ ⛁ ⟲ ▤ ◈ ⚙`) likely aren't in JetBrains Mono/Hanken Grotesk → tofu. Map to lucide; keep CSS shapes for the brand diamond + traffic-light dots. Adopted (also a robustness win).
- **Trim font weights** to those actually used (finalize after JSX). Adopted.
- **Rejected**: rewrite the scoped CSS-variable layer as Tailwind `dark:` utilities. The source is entirely inline-style + CSS-variable driven; a scoped variable layer is the faithful, *lower-risk, less-code* translation. Converting hundreds of token refs to `dark:` pairs (or arbitrary values, which can't theme-switch) would be more code and more fidelity risk. The advisor endorsed the scoped-variable approach; only the second theme *switch* was worth avoiding, and we already reuse `useTheme()`/`.dark`.

**Integration / blast-radius**
- **Lazy-load `LandingPage` (HIGH)** — the SPA ships a single JS/CSS chunk (no code-splitting today); importing fonts + the marketing page there bloats what every authenticated dashboard route downloads. `React.lazy` + `Suspense` on the `index` route; combined with the route-level authed gate, the landing chunk never loads for logged-in users. Adopted.
- **`index.html` `theme-color`** `#6366f1` → `#2E9BFE`. Adopted.
- Verified non-issues: `.drop-landing` scoping is airtight (no leak into Layout/AppsPage); `/dashboard/assets/*` route already serves woff2 with containment; external links have no CSP impact; no dashboard tests exist to break; fonts already installed.

## Verification

1. `cd src/dashboard && npm install` (fonts), then `npm run build` (or `tsc -p .` + `vite build`) — types + bundle clean.
2. Render the landing (vite dev) in **dark and light**; eyeball hero, bento spans, floating cards, terminal mock, gradient/grid overlays, nav, footer.
3. Confirm preserved behavior: loading state, redirect-if-authed, `handleEnter`, signup link.
4. Grep the landing sources for `googleapis|gstatic|http://|https://fonts` — no external style/font URLs remain.

## Status — 2026-07-10 (implemented)

Done and verified as far as automation allows:
- ✅ All files created/edited: `styles/landing.css`, `components/landing/{SiteNav,SiteFooter,LandingSections}.tsx`, `pages/LandingPage.tsx` (rewrite), `App.tsx` (lazy + route-level authed gate), `index.html` (accent), `package.json` (fonts).
- ✅ `tsc && vite build` green; **LandingPage code-split** into its own chunk (fonts + marketing markup kept out of the 659 KB main bundle).
- ✅ Fonts self-hosted (`@fontsource`), bundled as same-origin `/dashboard/assets/*.woff2`; **no external font/style URLs** in sources or `dist/` (CSP-clean).
- ✅ Preserved: `authEnabled` probe, `handleEnter` (login vs enter), signup link (gated on `authEnabled`), branded loading; authed users redirect at the route level; public landing still paints when the API is unreachable (`useAuthProvider` resolves `loading:false` on network failure).
- ✅ Reviewer bugs fixed: `dl-hover-*` needed `!important` (inline styles win otherwise); lucide icons switched from `color="var(--x)"` (invalid var() in an SVG presentation attribute) to `style={{ color: 'var(--x)' }}`.
- ⏳ **In-browser visual pass (dark + light) handed to the user** — the Claude-in-Chrome extension was not connected, so the render gate couldn't be driven autonomously. Dev server: `http://localhost:5173/dashboard/`.
- 📋 PRD-043 (public docs site) + PRD-044 (API/CLI reference) written for the deferred pages the design links to.
