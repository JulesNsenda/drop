import dropPreset from './tailwind-preset.js';

/** @type {import('tailwindcss').Config} */
export default {
  // DROP-156: the token bridge. Every `.drop-ui` design token is exposed as a
  // Tailwind utility here (see tailwind-preset.js for the mapping and for the
  // one rule: map token names, never rename them — tokens.css is duplicated in
  // the drop-site repo with no CI link between them).
  presets: [dropPreset],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // LEGACY, being retired (DROP-156). Kept only until the last caller is
        // migrated to the token utilities above; deleted at the end of PR 3.
        // Do not use in new code — `accent` is the token-backed equivalent.
        drop: {
          50: '#f0f9ff',
          100: '#e0f2fe',
          200: '#bae6fd',
          300: '#7dd3fc',
          400: '#38bdf8',
          500: '#0ea5e9',
          600: '#0284c7',
          700: '#0369a1',
          800: '#075985',
          900: '#0c4a6e',
        },
      },
    },
  },
  plugins: [],
};
