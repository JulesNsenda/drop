/**
 * DROP dashboard Tailwind preset (DROP-156).
 *
 * THE BRIDGE. Before this file existed there was no path from the `.drop-ui`
 * design tokens into Tailwind's theme, so the only way to reach a token from a
 * component was to hand-pipe it: `style={{ color: 'var(--text-2)' }}`. That is
 * why the dashboard carried 483 inline style blocks and why SettingsPage.tsx
 * grew to 929 lines. This preset makes every token a first-class utility.
 *
 * ── The one rule ────────────────────────────────────────────────────────────
 * This file MAPS existing token names. It never RENAMES them, and it never
 * defines a color. The values all live in `styles/tokens.css`, which is
 * DELIBERATELY DUPLICATED in the drop-site repo (see that file's header — a
 * shared package was considered and rejected). There is no CI link between the
 * two repos, so renaming a `--token` here breaks the marketing site silently.
 * Add a mapping; never edit the right-hand side.
 *
 * ── Naming ──────────────────────────────────────────────────────────────────
 * Utility names are chosen so the generated class reads well, which sometimes
 * means the utility name differs from the token name. The full mapping:
 *
 *   --bg          → surface       bg-surface
 *   --bg-2        → surface-2     bg-surface-2      (hover/inset fills)
 *   --bg-3        → surface-3     bg-surface-3      (inputs, code)
 *   --panel       → panel         bg-panel          (cards)
 *   --border      → line          border-line
 *   --border-2    → line-2        border-line-2     (hover borders)
 *   --text        → fg            text-fg
 *   --text-2      → muted         text-muted        (secondary copy)
 *   --text-3      → faint         text-faint        (tertiary//icons)
 *   --accent      → accent        text-accent bg-accent
 *   --accent-2    → accent-2      hover:bg-accent-2
 *   --accent-ink  → accent-ink    text-accent-ink   (copy ON accent)
 *   --accent-soft → accent-soft   bg-accent-soft
 *   --ok/--warn   → ok/warn       text-ok text-warn
 *   --err         → err           text-err          (app-ui.css only)
 *   --grid        → grid          bg-grid
 *
 * `bg-surface-2` rather than `bg-bg-2`, and `border-line` rather than
 * `border-border`, purely because the alternatives read badly at the call site.
 *
 * ── Known limitation: opacity modifiers silently produce NOTHING ────────────
 * The tokens are hex literals, so Tailwind's `<alpha-value>` substitution
 * cannot apply. Measured against the installed Tailwind 3.4:
 *
 *     .bg-panel     { background-color: var(--panel) }   ✅
 *     .bg-panel/50  → NO OUTPUT AT ALL                   ❌ silent, no error
 *
 * The failure mode is an invisible element, not a build failure. Supporting
 * alpha would need `rgb(var(--panel-rgb) / <alpha-value>)` channel triplets,
 * which forks drop-site's copy of tokens.css — not worth it, since nothing in
 * the dashboard needs it and the few translucent surfaces already use
 * `color-mix(in srgb, var(--err) 10%, transparent)` in app-ui.css, which works.
 *
 * `eslint.config.js` bans the `/<alpha>` suffix on these names so the silent
 * no-op cannot reach production. If you ever genuinely need a translucent
 * token surface, add a `color-mix()` rule to app-ui.css instead.
 */

/** Token-backed color utilities. Keys are utility names, values are tokens. */
export const tokenColors = {
  surface: 'var(--bg)',
  'surface-2': 'var(--bg-2)',
  'surface-3': 'var(--bg-3)',
  panel: 'var(--panel)',
  line: 'var(--border)',
  'line-2': 'var(--border-2)',
  fg: 'var(--text)',
  muted: 'var(--text-2)',
  faint: 'var(--text-3)',
  accent: 'var(--accent)',
  'accent-2': 'var(--accent-2)',
  'accent-ink': 'var(--accent-ink)',
  'accent-soft': 'var(--accent-soft)',
  ok: 'var(--ok)',
  warn: 'var(--warn)',
  err: 'var(--err)',
  grid: 'var(--grid)',
};

export default {
  theme: {
    extend: {
      colors: tokenColors,
      fontFamily: {
        sans: 'var(--sans)',
        mono: 'var(--mono)',
      },
      boxShadow: {
        elev: 'var(--elev)',
        btn: 'var(--btn)',
      },
    },
  },
};
