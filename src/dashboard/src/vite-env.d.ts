/// <reference types="vite/client" />

/**
 * Platform version, injected at build time by the dashboard's Vite config
 * from the root package.json (`define`). Not fetched at runtime — a
 * build-time constant means the version can't drift from what shipped.
 * Hardcoding it in components drifted twice — it read v2.0.0-rc.1 through
 * the rc.2 and rc.3 cuts. (Formerly shared with the public site bundle's own
 * Vite config, DROP-070; the site moved to its own repo in DROP-139.)
 */
declare const __DROP_VERSION__: string;
