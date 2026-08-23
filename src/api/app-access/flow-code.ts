/**
 * The single-use code that carries an authenticated identity from the platform
 * host back to a gated app (DROP-152).
 *
 * Modelled on `src/api/oauth/authorization-code.ts`, including the two things
 * that file's own comments record as deliberate: it deletes BEFORE validating,
 * so the code is single-use even under a replay race; and it prunes lazily
 * rather than on a timer, because a `setInterval` leaks a Jest open handle.
 *
 * What it adds is the **flow binding**, and that is the whole reason a code is
 * not enough on its own.
 *
 * Without it the gate is open to login-CSRF: an attacker mints a code for
 * THEIR OWN account and navigates a victim's browser to
 * `https://victim-app/.drop-session/exchange?code=<attacker's>`. The victim
 * then browses the app as the attacker — entering data into the attacker's
 * account, while the app is told by `X-Drop-Session-User-Id` that it is
 * talking to someone else entirely. Rotating the cookie value does not help;
 * that defends against a tenant pre-setting a cookie, which is a different
 * attack.
 *
 * The binding works because the verify hop's 302 is served FROM THE TENANT
 * ORIGIN, so it can set a cookie there. Measured against Caddy 2.11.4:
 * `forward_auth` copies `Set-Cookie` from a non-2xx response intact. So the
 * flow id exists in two places that an attacker cannot bridge — the victim's
 * own cookie jar for that origin, and the code record — and a code minted in
 * the attacker's flow simply does not match the victim's cookie.
 */

import * as crypto from 'crypto';

/**
 * 60 seconds, matching the OAuth authorization code.
 *
 * Short because the code transits a URL, and Caddy logs request URIs with
 * their query string. It is single-use and short-lived precisely BECAUSE it is
 * written to a log file that is kept for days — nobody may extend this without
 * first moving the code out of the URL.
 */
const CODE_TTL_MS = 60_000;

export interface AppAccessCodeRecord {
  userId: string;
  username: string;
  appName: string;
  /** Must match the `__Host-drop-flow-<app>` cookie the visitor's browser holds. */
  flowId: string;
  /**
   * Where to send the visitor afterwards, ALREADY VALIDATED.
   *
   * Held here rather than passed along the redirect chain: a `return` that
   * rides as a query parameter to the exchange is attacker-mutable between the
   * hops, and the validation would then be load-bearing twice instead of once.
   * `/oauth/token` takes the same position with `redirect_uri`.
   */
  returnPath: string;
  expiresAt: number;
}

const codes = new Map<string, AppAccessCodeRecord>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [code, record] of codes) {
    if (record.expiresAt <= now) codes.delete(code);
  }
}

/**
 * Live flows: minted by the verify hop, spent by the first code minted against
 * them.
 *
 * Without this the flow id was **caller-supplied at mint and unlimited-use** —
 * so anyone who merely OBSERVED a live flow id could mint a code bound to it
 * and hand the victim a session as themselves. And a flow id is far more
 * observable than a code: it transits two URLs on the platform host for its
 * whole 300s life, in a query string Caddy logs, and rides a cross-origin
 * navigation's `Referer`.
 *
 * That made the binding weaker than the credential it was protecting, which is
 * the opposite of what `mintAppAccessCode`'s own header claims. A flow now has
 * to have been STARTED by a verify hop, and it is consumed by the first mint.
 */
const liveFlows = new Map<string, number>();

/** 300s, matching the flow cookie's own Max-Age. */
const FLOW_TTL_MS = 300_000;

function pruneFlows(): void {
  const now = Date.now();
  for (const [id, expiry] of liveFlows) {
    if (expiry <= now) liveFlows.delete(id);
  }
}

/** A random flow id, minted by the verify hop and echoed by the browser's cookie. */
export function mintFlowId(): string {
  pruneFlows();
  const id = crypto.randomBytes(24).toString('base64url');
  liveFlows.set(id, Date.now() + FLOW_TTL_MS);
  return id;
}

/**
 * Spend a flow, or refuse.
 *
 * Delete-before-check, like the code store: a flow is single-mint, so two
 * concurrent attempts cannot both succeed. An id that was never started by a
 * verify hop — including one an attacker read out of a log — is not here.
 */
export function consumeFlowId(flowId: string): boolean {
  pruneFlows();
  const expiry = liveFlows.get(flowId);
  liveFlows.delete(flowId);
  return expiry !== undefined && expiry > Date.now();
}

/** Mint a single-use code for one authenticated user in one flow. */
export function mintAppAccessCode(params: Omit<AppAccessCodeRecord, 'expiresAt'>): string {
  pruneExpired();
  const code = crypto.randomBytes(32).toString('base64url');
  codes.set(code, { ...params, expiresAt: Date.now() + CODE_TTL_MS });
  return code;
}

/**
 * Consume a code and check it belongs to THIS browser's flow.
 *
 * The lookup-and-delete happens first, with no `await` in between, so a
 * concurrent replay finds nothing. Only then is the flow checked — which means
 * a wrong flow id BURNS the code, and that is the posture we want: a code
 * presented in the wrong flow is either an attack or a hopelessly confused
 * client, and neither should get a second attempt.
 *
 * `expectedFlowId` is what the browser presented in its cookie. An absent
 * cookie is not a pass — Caddy forwards the literal placeholder text when a
 * cookie is missing, so the caller may hand us something meaningless, and
 * anything that is not an exact match is a refusal.
 */
export function consumeAppAccessCode(
  code: string,
  expectedFlowId: string | undefined
): AppAccessCodeRecord | null {
  pruneExpired();

  const record = codes.get(code);
  codes.delete(code);

  if (!record) return null;
  if (record.expiresAt <= Date.now()) return null;
  if (!expectedFlowId) return null;
  // Constant-time compare: the flow id is a secret the attacker is trying to
  // guess, and these are equal-length base64url strings.
  if (!timingSafeEqualStrings(record.flowId, expectedFlowId)) return null;

  return record;
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, which would itself leak the
  // length — compare lengths first and return early, which leaks only that.
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Clear the stores (tests). */
export function __resetAppAccessCodes(): void {
  codes.clear();
  liveFlows.clear();
}
