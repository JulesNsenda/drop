/**
 * Entry shim for the public site bundle (DROP-070).
 *
 * `vite.site.config.ts` sets `root` to this directory, because the build must
 * emit `dist/site/index.html` and not `dist/site/site/index.html` — both
 * `ApiServer`'s `siteExists` guard and the CI packaging assertion depend on
 * that path. But that leaves the real entry module (`../src/site-main.tsx`)
 * *outside* the Vite root.
 *
 * The build tolerated a `../src/site-main.tsx` script src in index.html; the
 * dev server did not. It normalises the relative src to a root-absolute
 * `/src/site-main.tsx`, resolves that against this directory, finds nothing,
 * and serves an empty `<div id="root">` — so `npm run dev:site` rendered a
 * blank page from DROP-070 until this shim was added, while `build:site` and
 * production were always fine.
 *
 * Importing through a file that lives *inside* the root resolves identically
 * in both modes. Keep this file a single side-effecting import: the real entry
 * (React root, fonts, styles) stays in src/site-main.tsx, which is inside
 * tsconfig's `include: ["src"]` and therefore actually typechecked.
 */
import '../src/site-main';
