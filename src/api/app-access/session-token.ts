/**
 * The browser session a visitor holds for ONE gated tenant app (DROP-152).
 *
 * A third credential class, alongside `oauth_access` (DROP's own API) and
 * `app_mcp` (a tenant's MCP endpoint). It lives here rather than in
 * `auth.ts` — which is ~2k lines and imported by every route file — because it
 * is one self-contained credential class with one consumer.
 *
 * It mirrors `mintAppMcpAccessToken` deliberately, and the parts it mirrors are
 * the parts that matter:
 *
 *  - **`token_use: 'app_session'`**, and `verifyAppSessionToken` rejects on it
 *    BEFORE it looks at anything else. That ordering is what keeps the three
 *    classes from ever authenticating against each other on an audience
 *    collision.
 *  - **No `role` claim.** A control-plane role is meaningless to a tenant app
 *    and would be a live escalation primitive if any future code built an
 *    `AuthContext` out of these claims. The role the gate needs is read LIVE
 *    from the user record at verify time — which is also what makes revocation
 *    immediate.
 *  - **An `app` claim** carrying the app name, so the verifier binds the token
 *    to the app it was presented to rather than re-deriving it from a
 *    spoofable request header.
 *  - **A `sid`**, so the existing `denyGrant` primitive can reach this class.
 *    Without one, a minted session could not be revoked by any means short of
 *    suspending the account.
 *
 * What it deliberately does NOT mirror is the 15-minute TTL. That number exists
 * because a harvested MCP token has no revocation; a browser session with a
 * live per-request re-read has a different shape, and 15 minutes would convert
 * a form POST into a GET every quarter of an hour. See SESSION_TTL_SECONDS.
 */

import * as crypto from 'crypto';
import * as jose from 'jose';
import {
  getUserById,
  getOAuthTokenSecret,
  predatesInvalidationStamp,
  isGrantDenied,
} from '../middleware/auth';

/**
 * Eight hours: long enough to be a working day, short enough that a session
 * outliving its purpose is bounded.
 *
 * The length is not what bounds this credential — the live user re-read in
 * `verifyAppSessionToken` is, and it runs on every single request the gate
 * handles. That is why 8h is defensible where it would not be for a token
 * nobody re-checks. Do not raise it without keeping that re-read.
 */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

/**
 * What a verified session proves.
 *
 * NEVER an `AuthContext`, and the distinction is the same one `AppMcpIdentity`
 * makes: this must not be assignable to anything that performs control-plane
 * authorization. `role` is present because the gate's own rule needs it, and it
 * is read live from the user record — never from the token, which carries none.
 */
export interface AppSessionIdentity {
  userId: string;
  username: string;
  appName: string;
  role: 'admin' | 'user' | 'readonly';
}

/** Mint a session for one user on one app. */
export async function mintAppSessionToken(
  userId: string,
  username: string,
  appName: string,
  audience: string
): Promise<string> {
  const secret = getOAuthTokenSecret();
  if (!secret) throw new Error('Auth not initialized');
  return new jose.SignJWT({
    sub: userId,
    username,
    token_use: 'app_session',
    app: appName,
    aud: audience,
    // Per-session, so a single session can be revoked through the existing
    // grant denylist without touching the user's other sessions.
    sid: crypto.randomBytes(16).toString('base64url'),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret);
}

/**
 * Verify a session for ONE named app and ONE expected audience.
 *
 * Returns null for every failure, with no distinction between them — which of
 * the reasons applied is not the caller's business, and the caller's only
 * correct response to any of them is the same.
 *
 * The live checks after signature verification are the point of this function.
 * A signature proves the token was minted; it cannot express that the account
 * has since been disabled, that the operator stamped every credential invalid,
 * or that this grant was revoked. This class passes through exactly one gate,
 * so there is no second checkpoint to catch any of that later.
 */
export async function verifyAppSessionToken(
  token: string,
  expectedAudience: string,
  expectedApp: string
): Promise<AppSessionIdentity | null> {
  const secret = getOAuthTokenSecret();
  if (!secret) return null;

  try {
    const { payload } = await jose.jwtVerify(token, secret, { algorithms: ['HS256'] });
    const p = payload as Record<string, unknown>;

    // Class first, before audience — the same ordering verifyAppMcpAccessToken
    // uses, so an audience collision can never let one class authenticate as
    // another.
    if (p['token_use'] !== 'app_session') return null;
    if (p['aud'] !== expectedAudience) return null;
    if (p['app'] !== expectedApp) return null;

    const userId = typeof p['sub'] === 'string' ? p['sub'] : '';
    const username = typeof p['username'] === 'string' ? p['username'] : '';
    if (!userId || !username) return null;

    const sid = typeof p['sid'] === 'string' ? p['sid'] : undefined;
    if (sid && isGrantDenied(sid)) return null;

    // Read the user LIVE. Everything below is a fact the token cannot carry:
    // it was true when the session was minted and may not be true now.
    const user = getUserById(userId);
    if (!user) return null;
    if (user.enabled === false) return null;

    const iat = typeof p['iat'] === 'number' ? p['iat'] : 0;
    if (predatesInvalidationStamp(iat, user.credentialsInvalidBefore)) return null;

    return { userId, username, appName: expectedApp, role: user.role };
  } catch {
    return null;
  }
}
