import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Public marketing site (landing / docs / reference) — DROP-070. A separate
// Vite root (./site, with its own entry HTML) keeps this a distinct Rollup
// graph from the admin dashboard (vite.config.ts) without a second npm
// package: no second lockfile, no third CI `npm ci`, one shared `src/` tree.
// `root` must point at the entry HTML's own directory, or the build emits
// `dist/site/site/index.html` (or `dist/site/site.html`) instead of
// `dist/site/index.html`, which both `ApiServer`'s `siteExists` guard and
// the CI packaging assertion depend on.
export default defineConfig({
  plugins: [react()],
  base: '/',
  root: path.resolve(__dirname, 'site'),
  // publicDir defaults to `<root>/public`, which would resolve to
  // `./site/public` once `root` is overridden — point it back at the shared
  // `public/` dir (favicon) used by the dashboard build too.
  publicDir: path.resolve(__dirname, 'public'),
  build: {
    outDir: path.resolve(__dirname, '../../dist/site'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
