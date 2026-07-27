/// <reference types="vite/client" />

/**
 * Platform version, injected at build time by BOTH Vite configs from the root
 * package.json (`define`). Not fetched at runtime: the public site bundle is
 * forbidden from importing `api/client` (CI enforces this with a grep over
 * dist/site), so a build-time constant is the only mechanism available to
 * both bundles. Hardcoding it in components drifted twice — it read
 * v2.0.0-rc.1 through the rc.2 and rc.3 cuts.
 */
declare const __DROP_VERSION__: string;
