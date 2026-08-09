/**
 * Where the public marketing site lives, relative to the dashboard.
 *
 * Since the site split (DROP-139) the dashboard is served from its own host —
 * `dashboard.dropkit.sh` — while the landing page, docs and API reference live
 * in the separate `drop-site` repo on the apex, `dropkit.sh`. A relative
 * `href="/"` therefore no longer reaches the marketing home: it resolves to
 * `dashboard.dropkit.sh/`, which the platform 301s to `/dashboard`
 * (`api/server.ts`), whose anonymous index route sends a logged-out visitor
 * straight back to `/login` (`App.tsx`). The "Back to home" link on the login
 * and signup pages was a visible no-op loop.
 *
 * Deliberately DOM-free so the root jest suite can reach it — the caller reads
 * `window.location` and passes the two fields in. Keep it that way: the root
 * tsconfig compiles with `lib: ["ES2022"]` and no DOM, so a `window` reference
 * here would break `site-url.test.ts` with a confusing unrelated error.
 */

/** The `dashboard.` label the platform host is conventionally deployed under. */
const DASHBOARD_LABEL = 'dashboard.';

/**
 * Derive the marketing site's origin from the dashboard's own location.
 *
 * Returns `null` when there is no separate site to go back to — a single-host
 * self-hosted install has no landing page at all (`/` redirects to
 * `/dashboard`), so the honest answer is to hide the link rather than render
 * one that loops. Callers must treat `null` as "render nothing".
 *
 * @param protocol `window.location.protocol`, e.g. `https:`
 * @param hostname `window.location.hostname` — no port, by design: the apex is
 *   conventionally on the default port even when the dashboard is not.
 */
export function deriveSiteOrigin(protocol: string, hostname: string): string | null {
  if (!hostname.startsWith(DASHBOARD_LABEL)) return null;

  const apex = hostname.slice(DASHBOARD_LABEL.length);

  // Require a real registrable domain. `dashboard.localhost` would otherwise
  // strip to `localhost`, which is this same platform — the loop again, just
  // one label shorter.
  //
  // Known limitation: this cannot tell a public domain from a split-horizon
  // internal one, so `dashboard.mybox.lan` yields a link to a host that may
  // serve nothing. There is no public suffix list in the browser, and a dead
  // link is a smaller failure than the loop this replaces. The real fix, if it
  // ever matters, is a server-provided site URL rather than derivation.
  if (!apex.includes('.')) return null;

  return `${protocol}//${apex}`;
}
