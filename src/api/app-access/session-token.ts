/**
 * The browser session a visitor holds for ONE gated tenant app (DROP-152), and
 * (DROP-155) the browser session a GUEST holds for one — a person with no DROP
 * account at all, admitted by invite rather than by a dashboard bearer.
 *
 * Four credential classes now, alongside `oauth_access` (DROP's own API) and
 * `app_mcp` (a tenant's MCP endpoint): `app_session` for an account-holding
 * user, `app_guest_session` for a guest. Both live here rather than in
 * `auth.ts` — which is ~2k lines and imported by every route file — because
 * this file is small, self-contained, and both classes share one consumer
 * (the app-access gate).
 *
 * Both mint/verify pairs mirror `mintAppMcpAccessToken` deliberately, and the
 * parts they mirror are the parts that matter:
 *
 *  - **A distinct `token_use`** (`'app_session'` / `'app_guest_session'`), and
 *    each verifier rejects on a MISMATCHED `token_use` BEFORE it looks at
 *    anything else — nothing about audience, nothing about the app claim,
 *    nothing about the subject. That ordering is what keeps all four classes
 *    from ever authenticating against each other on an audience collision: a
 *    guest token presented where a user session is expected is rejected on
 *    its class alone, before either verifier would even notice the two
 *    happen to share an audience and an app name.
 *  - **No `role` claim on either.** A control-plane role is meaningless to a
 *    tenant app and would be a live escalation primitive if any future code
 *    built an `AuthContext` out of these claims. `AppGuestIdentity` goes
 *    further and has no `role` FIELD at all — not even a fixed one — because
 *    a guest is not merely a low-privilege user, it is a different kind of
 *    principal that `canOpen`'s `role === 'none'` refusal and the admin/owner
 *    evaluator clauses must never be reachable for. `AppSessionIdentity` is
 *    untouched by this change, on purpose: leaving it alone is what keeps its
 *    existing tests a valid regression net for the user class.
 *  - **An `app` claim** carrying the app name, so the verifier binds the token
 *    to the app it was presented to rather than re-deriving it from a
 *    spoofable request header.
 *  - **A `sid`**, so a session can be addressed individually, denylist-checked
 *    through the same `isGrantDenied` both classes share. For the guest class
 *    this is not optional the way it might look: a guest has fewer account-
 *    level revokers than a user to begin with (`disabled` plus removal,
 *    versus `enabled`, `credentialsInvalidBefore` AND `isGrantDenied`), so
 *    omitting the one revoker a guest CAN have would leave it the one
 *    credential class in this codebase with no addressable session at all.
 *
 *    Stated honestly for both classes: there is **no per-session revoker UI
 *    yet**. `denyGrant`'s only callers today are the OAuth refresh-token
 *    paths, and these sids are not persisted anywhere, so they cannot be
 *    enumerated to revoke one individually. What revokes a session TODAY is
 *    account-level, and takes effect on the next request because of the live
 *    re-read below. The claim is a `sid` exists so a revoker CAN be built
 *    without reminting; it is not that one is wired.
 *  - **A live re-read of the account/guest record on every verify**, never
 *    from the token. `verifyAppSessionToken` re-reads the user via
 *    `getUserById`; `verifyAppGuestSessionToken` re-reads the guest the same
 *    way, from `src/managers/app-guest`, and refuses on a missing, disabled,
 *    or invalidated record — the same posture, because it is the same
 *    argument: a signature proves the token was minted, not that the grant it
 *    named is still good, and this class passes through exactly one gate so
 *    there is no second checkpoint to catch that later.
 *
 * What neither mirrors from `mintAppMcpAccessToken` is its 15-minute TTL. That
 * number exists because a harvested MCP token has no revocation; a browser
 * session with a live per-request re-read has a different shape, and 15
 * minutes would convert a form POST into a GET every quarter of an hour. See
 * `SESSION_TTL_SECONDS`. The guest TTL is capped at the SAME value rather than
 * given a shorter one of its own: a guest session cookie's `Max-Age` is set
 * once, at the exchange, from a single constant shared by both classes: giving
 * the guest class a different number would require that call site to branch
 * on `record.kind` a second time just to pick a cookie lifetime, which is
 * exactly the kind of cross-class coupling the class-first verify ordering
 * above exists to avoid. "Not longer than the user session's 8h" is satisfied
 * by equality; it does not require going shorter.
 */

import * as crypto from 'crypto';
import * as jose from 'jose';
import {
  getUserById,
  getOAuthTokenSecret,
  predatesInvalidationStamp,
  isGrantDenied,
} from '../middleware/auth';
import { getAppGuestById } from '../../managers/app-guest';

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
 * Equal to `SESSION_TTL_SECONDS`, not a shorter number of its own — see the
 * module doc comment for why: the exchange sets ONE cookie `Max-Age` from a
 * shared constant, and "not longer than the user session's 8h" is satisfied
 * by equality without making that call site branch on which class it minted.
 */
export const GUEST_SESSION_TTL_SECONDS = SESSION_TTL_SECONDS;

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

/**
 * What a verified GUEST session proves.
 *
 * Deliberately has **no `role` field at all** — not `'none'`, not a fixed
 * low-privilege string. A guest is a different kind of principal, and the
 * gate's evaluator must find this type structurally incapable of satisfying
 * any admin/owner clause rather than relying on every future clause to keep
 * checking for a sentinel value. See `canOpenGuestSession` (`src/api/access.ts`,
 * a sibling change) for the evaluator side of that.
 */
export interface AppGuestIdentity {
  guestId: string;
  email: string;
  appName: string;
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

    // REQUIRED, not optional: a token without one would skip the denylist
    // entirely, which is a hole the current minter cannot reach but the type
    // allowed.
    const sid = typeof p['sid'] === 'string' ? p['sid'] : '';
    if (!sid || isGrantDenied(sid)) return null;

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

/** Mint a session for one guest on one app. */
export async function mintAppGuestSessionToken(
  guestId: string,
  email: string,
  appName: string,
  audience: string
): Promise<string> {
  const secret = getOAuthTokenSecret();
  if (!secret) throw new Error('Auth not initialized');
  return new jose.SignJWT({
    sub: guestId,
    email,
    token_use: 'app_guest_session',
    app: appName,
    aud: audience,
    // Per-session, denylist-checked below — required for the same reason it
    // is required on the user class: without it a guest session would be
    // revocable only by disabling or deleting the whole guest record, with no
    // way to end one browser's session in isolation.
    sid: crypto.randomBytes(16).toString('base64url'),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${GUEST_SESSION_TTL_SECONDS}s`)
    .sign(secret);
}

/**
 * Verify a GUEST session for ONE named app and ONE expected audience.
 *
 * Mirrors `verifyAppSessionToken` exactly in shape and ordering — class
 * first, then audience, then app, then the sid denylist, then a LIVE re-read
 * — because the argument for each check is the same argument, made about a
 * different record. See the module doc comment for why `token_use` is
 * checked before anything else: it is what stops a guest token and a user
 * token from ever authenticating as each other on an audience collision.
 *
 * `getAppGuestById` re-reads the guest record from `src/managers/app-guest`
 * on every call — never trusting the token's own claims for anything the
 * live record could have since changed. A guest with no `role` claim (there
 * is none to have) still needs the same "is this grant still good right now"
 * question answered, and this is where it gets answered.
 */
export async function verifyAppGuestSessionToken(
  token: string,
  expectedAudience: string,
  expectedApp: string
): Promise<AppGuestIdentity | null> {
  const secret = getOAuthTokenSecret();
  if (!secret) return null;

  try {
    const { payload } = await jose.jwtVerify(token, secret, { algorithms: ['HS256'] });
    const p = payload as Record<string, unknown>;

    // Class first, before audience — see the module doc comment.
    if (p['token_use'] !== 'app_guest_session') return null;
    if (p['aud'] !== expectedAudience) return null;
    if (p['app'] !== expectedApp) return null;

    const guestId = typeof p['sub'] === 'string' ? p['sub'] : '';
    const email = typeof p['email'] === 'string' ? p['email'] : '';
    if (!guestId || !email) return null;

    // REQUIRED, not optional — the same reasoning as the user class: a token
    // without one would skip the denylist entirely, and a guest has fewer
    // OTHER revokers than a user, so this one cannot be allowed to go missing.
    const sid = typeof p['sid'] === 'string' ? p['sid'] : '';
    if (!sid || isGrantDenied(sid)) return null;

    // Read the guest record LIVE. Everything below is a fact the token cannot
    // carry: it was true when the session was minted and may not be true now.
    const guest = getAppGuestById(guestId);
    if (!guest) return null;
    // Bound explicitly rather than assumed from the lookup key: if the
    // sibling store keys guests globally by id, a guest minted for one app
    // must not verify against a record that has since been re-pointed at, or
    // simply happens to also exist for, a different app.
    if (guest.appName !== expectedApp) return null;
    if (guest.disabled === true) return null;

    const iat = typeof p['iat'] === 'number' ? p['iat'] : 0;
    if (predatesInvalidationStamp(iat, guest.credentialsInvalidBefore)) return null;

    return { guestId, email, appName: expectedApp };
  } catch {
    return null;
  }
}
