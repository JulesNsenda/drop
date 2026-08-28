import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import { tokenColors } from './tailwind-preset.js';

/*
 * Dashboard ESLint config (DROP-156).
 *
 * The dashboard is a separate npm package and the ROOT eslint.config.js
 * explicitly ignores `src/dashboard/**`, so before this file there was no lint
 * pass over the dashboard at all — which is why the two guard rules below
 * needed a home, a `lint` script AND a `_verify.yml` step to exist. A rule
 * without a runner is a file nobody executes.
 *
 * This config is deliberately NARROW. Its job is the two token guards plus
 * basic TS hygiene — not a full React/a11y ruleset. Turning on the usual
 * react-hooks/jsx-a11y stack would surface hundreds of pre-existing findings
 * and make this step unshippable; that is its own task.
 */

// Utility names the preset generates, e.g. `panel`, `muted`, `accent-soft`.
const TOKEN_UTILITIES = Object.keys(tokenColors)
  .map((n) => n.replace(/-/g, '\\-'))
  .join('|');

// Utility PREFIXES that consume a color scale and therefore accept `/<alpha>`.
const COLOR_PREFIXES = 'bg|text|border|ring|divide|shadow|outline|decoration|from|via|to|caret|accent|fill|stroke';

/*
 * GUARD 1 (error) — `bg-panel/50` and friends.
 *
 * The tokens are hex literals, so Tailwind's `<alpha-value>` substitution
 * cannot apply and the utility is dropped from the stylesheet ENTIRELY, with
 * no warning. Measured: `.bg-panel` emits, `.bg-panel/50` emits nothing. The
 * failure mode is an invisible element, not a build error — the same silent
 * class as an out-of-scope token (see the `.drop-ui` note in app-ui.css).
 *
 * Zero violations exist today (the utilities are new), so this is an error
 * from day one. If you need a translucent token surface, add a `color-mix()`
 * rule to styles/app-ui.css instead.
 */
const NO_TOKEN_ALPHA = {
  selector: `Literal[value=/(?:^|[\\s"'\`])(?:${COLOR_PREFIXES})-(?:${TOKEN_UTILITIES})\\/[0-9]/]`,
  message:
    'Opacity modifiers on token colors compile to NOTHING (silently). The tokens are hex, so Tailwind cannot substitute <alpha-value>. Use a color-mix() rule in styles/app-ui.css instead. See tailwind-preset.js.',
};

/*
 * GUARD 2 (warn, ratcheting to error) — `style={{ color: 'var(--text-2)' }}`.
 *
 * This is the hand-rolled utility layer the preset replaces: 483 blocks at the
 * start of DROP-156, ~450 of them a plain token color assignment. It is a WARN
 * and not an ERROR because PR 1 does not migrate call sites — the migration is
 * folded into PRs 2 and 3 on a per-page basis, so the count falls as pages are
 * touched rather than in one unreviewable 483-site diff.
 *
 * `--max-warnings` in the `lint` script is the ratchet: lower it as the count
 * drops, and flip this to 'error' with a ceiling of 0 once the last call site
 * is gone (end of PR 3).
 *
 * Anchored on `^var(--` so genuine computed values — notably the existing
 * `color-mix(in srgb, var(--err) 10%, transparent)` fills — are not flagged.
 *
 * LIMITATION, stated honestly: this matches AST literals. It catches
 * `style={{ color: 'var(--text-2)' }}` and `className="bg-panel/50"`, but NOT
 * template literals, `clsx()` arguments, or values reached through a variable.
 * It is a partial guard.
 */
const NO_INLINE_TOKEN_STYLE = {
  selector: 'JSXAttribute[name.name="style"] Property > Literal[value=/^var\\(--/]',
  message:
    'Reach design tokens through Tailwind utilities, not inline styles: className="text-muted" rather than style={{ color: var(--text-2) }}. See tailwind-preset.js for the token to utility mapping.',
};

export default [
  eslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    /*
     * `exhaustive-deps` is off (see rules below) but the source keeps its
     * hand-written disable comments for it, so they read as "unused". They are
     * not dead — they are the record of a deliberate opt-out, and they become
     * live again the moment that rule is switched on. Reporting them would add
     * noise to the --max-warnings ratchet, which exists to track exactly one
     * thing.
     */
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        navigator: 'readonly',
        location: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tseslint, 'react-hooks': reactHooks },
    rules: {
      // Covered by TypeScript itself.
      'no-unused-vars': 'off',
      'no-undef': 'off',

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'prefer-const': 'error',
      'no-var': 'error',

      // Four pre-existing deliberate swallows (DeployPage ×2, UsersPage,
      // GitWebhooksTab). Changing their behaviour is out of scope for a
      // tooling PR, and an intentionally-empty catch is a legitimate idiom.
      'no-empty': ['error', { allowEmptyCatch: true }],

      /*
       * react-hooks is registered mainly so the `react-hooks/exhaustive-deps`
       * disable comments already in the source resolve to a DEFINED rule —
       * without the plugin those comments are themselves an ESLint error
       * ("Definition for rule not found").
       *
       * `rules-of-hooks` catches real bugs and passes clean today, so it is on.
       * `exhaustive-deps` stays off: the codebase already opts out of it by
       * hand in several places, and auditing those is its own task, not this
       * one.
       */
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'off',

      /*
       * The DROP-156 token guards.
       *
       * Both ride ONE rule id, because `no-restricted-syntax` takes a single
       * severity for all of its options and flat config merges by rule id —
       * there is no way to give two selectors two severities. Guard 2 has 483
       * pre-existing violations, so 'error' would fail the build on day one.
       *
       * The severity is therefore 'warn', and `--max-warnings` in the `lint`
       * script is what makes these build-breaking: it is pinned to the EXACT
       * current count, so any new violation of either guard pushes the total
       * over the ceiling and fails CI. Lower the ceiling as pages migrate; it
       * doubles as a visible progress metric.
       */
      'no-restricted-syntax': ['warn', NO_TOKEN_ALPHA, NO_INLINE_TOKEN_STYLE],
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', '**/*.test.ts', '*.js'],
  },
];
