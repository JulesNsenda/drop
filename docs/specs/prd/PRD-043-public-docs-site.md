# PRD-043: Public Documentation Site

## Document Info

| Field | Value |
|-------|-------|
| PRD ID | PRD-043 |
| Feature | Public in-app documentation site (`/docs`) |
| Status | Not Started |
| Phase | Marketing / Developer Experience |
| Priority | P2 |
| Target | v2.1+ |
| Depends On | Landing redesign (2026-07-10 plan — introduces the shared public `SiteNav`/`SiteFooter` shell + scoped landing theme) |
| Created | 2026-07-10 |

---

## 1. Overview

### 1.1 Summary

The redesigned landing page (imported from the "DROP Platform Design" Claude Design
project, `Landing.dc.html`) links to a **Docs** page in its nav and footer. That page
does not exist yet — the links currently point at the GitHub repo as a placeholder.
This PRD covers building the public documentation site as a real route in the dashboard
SPA, matching the design's `Docs.dc.html`.

It is a **public** (no-auth) marketing/developer surface served from the same
Vite dashboard bundle as the landing page, reusing the public `SiteNav` + `SiteFooter`
shell and the scoped `.drop-landing` theme tokens introduced by the landing redesign.

### 1.2 Goals

- [ ] Public `/docs` route (dashboard SPA, no auth) using the shared public site shell.
- [ ] Three-column docs layout: left section TOC, center content, right "on this page" rail (as in `Docs.dc.html`).
- [ ] Getting-started content: Introduction, Installation, Your first deploy.
- [ ] Configuration content: `drop.yaml`, environment variables, persistent data (`DROP_DATA_DIR`).
- [ ] Platform content: runtimes & framework detection, routing & HTTPS (Caddy / Let's Encrypt), databases, logs.
- [ ] Cross-links to the API/CLI reference (PRD-044) and the dashboard.
- [ ] Smooth-scroll in-page anchors with sticky-nav offset; `current="docs"` state in `SiteNav`.
- [ ] Re-point the landing's nav/footer "Docs" links from the GitHub placeholder to `/docs`.

### 1.3 Non-Goals

- Full-text search across docs.
- Versioned documentation / multiple release channels.
- Internationalization.
- Authoring pipeline for third-party contributors (content ships as MDX/TSX in-repo initially).

---

## 2. Technical Design

### 2.1 Route & shell

- Add a public route `/docs` in `src/dashboard/src/App.tsx` (sibling of the landing `index` route, **not** wrapped in the protected `Layout`).
- Reuse `components/landing/SiteNav.tsx` (with a `current="docs"` prop to highlight the active link) and `components/landing/SiteFooter.tsx`.
- Wrap the page in the `.drop-landing` container so it inherits the scoped theme tokens and self-hosted fonts.

### 2.2 Content model

- Content authored as structured data (section objects) + a small renderer, or as MDX if an MDX Vite plugin is added. Initial pass: hardcoded TSX sections mirroring `Docs.dc.html`, since the copy is stable and short.
- Reuse existing repo documentation (`docs/`, `README`, `docs/AGENT-DEPLOY.md`, install script) as the source of truth for the prose so the site does not drift from reality.

### 2.3 Layout

Mirror `Docs.dc.html`: `grid-template-columns: 220px 1fr 200px`, sticky left TOC and right "on this page" rail (collapse to single column on narrow viewports), code blocks styled with the scoped `--panel`/`--border`/`--mono` tokens.

---

## 3. Implementation Plan

### 3.1 Files to Create/Modify

- `src/dashboard/src/pages/DocsPage.tsx` — new public docs page.
- `src/dashboard/src/components/landing/DocsContent.tsx` (optional) — section data + renderer.
- `src/dashboard/src/App.tsx` — add the `/docs` route.
- `src/dashboard/src/components/landing/SiteNav.tsx` — honor `current="docs"`; repoint the "Docs" link to `/docs`.
- `src/dashboard/src/components/landing/SiteFooter.tsx` — repoint the "Documentation" / "Self-hosting" / "Changelog" links to `/docs`.

### 3.2 Design source of truth

- Claude Design project `DROP Platform Design` (`b2fbbdb6-c229-4d84-8ed2-e05b9b6460f3`), file `Docs.dc.html`.

---

## 4. Risks & Open Questions

- MDX vs. hardcoded TSX: MDX is nicer for long-form authoring but adds a Vite plugin + build surface. Start hardcoded; revisit if docs grow.
- Keeping docs content in sync with real behavior — prefer generating install snippets/commands from the actual CLI where practical.
- Public route caching / SEO is minimal concern for a self-hosted product, but ensure the SPA fallback in `server.ts` serves `/docs` correctly (it already serves `/dashboard/*` to `index.html`).
