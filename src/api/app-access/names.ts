/**
 * The names and paths the access gate's two halves must agree on.
 *
 * A leaf module with no imports, for the same reason `services-wire.types.ts`
 * is one: three layers need these strings and no two of them should reach
 * through a third to get them. Before this existed, `core/platform.ts` imported
 * the cookie name from an API ROUTE file — pulling that file's whole transitive
 * import graph into platform module init, and inverting the layering it would
 * take one future `api → core` import to turn circular. The generator exported
 * the exchange path while the route hardcoded the same literal, so the two
 * could drift with nothing failing.
 *
 * If a name here changes, everything that has to change is an import of this
 * file.
 */

/**
 * The session cookie for one gated app.
 *
 * `__Host-` is load-bearing: it mandates `Secure`, forbids `Domain`, and
 * requires `Path=/`, which together mean a sibling host cannot set or shadow
 * it. It does NOT stop the app's own origin from setting one — that is what
 * the flow binding and mint-on-every-exchange are for.
 */
export function sessionCookieName(appName: string): string {
  return `__Host-drop-session-${appName}`;
}

/**
 * The short-lived cookie that binds a sign-in round trip to ONE browser.
 *
 * Planted on the TENANT origin by the verify hop's 302 — which works only
 * because `forward_auth` copies `Set-Cookie` from a non-2xx response
 * (measured, Caddy 2.11.4). It is what makes an attacker-minted code useless
 * in a victim's browser.
 */
export function flowCookieName(appName: string): string {
  return `__Host-drop-flow-${appName}`;
}

/**
 * The path, on the tenant's own hostname, that DROP owns for the code
 * exchange. Emitted as a Caddy matcher and used to build the redirect the SPA
 * navigates to, which is why it cannot live in either of those places alone.
 */
export const EXCHANGE_PATH = '/.drop-session/exchange';
