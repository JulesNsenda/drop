/**
 * Authentication Routes
 *
 * Endpoints for authentication and API key management.
 */

import { Hono } from 'hono';
import { success, error, ErrorCodes } from '../types';
import {
  authenticateUser,
  createApiKey,
  deleteApiKey,
  listApiKeys,
  listUsers,
  createUser,
  getUser,
  getUserById,
  changePassword,
  verifyUserPassword,
  updateUser,
  resetUserPassword,
  deleteUser,
  authMiddleware,
  requireCapability,
  isAuthEnabled,
  isSignupEnabled,
  setupMfa,
  enableMfa,
  disableMfa,
  completeMfaLogin,
  AuthContext,
} from '../middleware/auth';
import { tryLogActivity, logActivityFor } from '../../managers/activity';
import { getStateManager } from '../../managers/app/state-manager';
import { canAccess, interactiveSessionOnly } from '../access';
import { assertMintable } from '../agent-scopes';
import { ValidationError } from '../middleware/error';

const auth = new Hono();

/** Default life of an agent token: long enough for a deploy, short enough to forget about. */
const DEFAULT_AGENT_TOKEN_MINUTES = 60;
/** Ceiling. A scope-only token is still a credential; a standing one defeats the point. */
const MAX_AGENT_TOKEN_MINUTES = 60 * 24 * 7;

// GET /auth/status - Public endpoint to check if auth is enabled
auth.get('/status', c => {
  const enabled = isAuthEnabled();
  return c.json(success({ enabled }));
});

// POST /auth/signup - Self-service user registration
auth.post('/signup', async c => {
  if (!isSignupEnabled()) {
    return c.json(
      error(ErrorCodes.UNAUTHORIZED, 'Self-service signup is not enabled on this instance'),
      403
    );
  }

  const body = await c.req.json<{ username: string; password: string; email: string }>();

  if (!body.username || !body.password || !body.email) {
    throw new ValidationError('Username, email, and password are required');
  }

  if (body.username.length < 3 || !/^[a-zA-Z0-9_-]+$/.test(body.username)) {
    throw new ValidationError(
      'Username must be at least 3 characters (letters, numbers, hyphens, underscores)'
    );
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    throw new ValidationError('Invalid email address');
  }

  if (body.password.length < 8) {
    throw new ValidationError('Password must be at least 8 characters');
  }

  try {
    const user = await createUser(body.username, body.password, 'user', body.email);
    // Stays on tryLogActivity, not logActivityFor: identity here is the
    // account this request just created, not an ambient AuthContext — there
    // is no request auth to derive it from (signup precedes it).
    await tryLogActivity({ action: 'signup', userId: user.id, username: user.username });
    return c.json(
      success({
        id: user.id,
        username: user.username,
        role: user.role,
        message: 'Account created. You can now sign in.',
      }),
      201
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Registration failed';
    if (message.includes('already exists')) {
      return c.json(error(ErrorCodes.CONFLICT, message), 409);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }
});

// POST /auth/login - Authenticate and get JWT token (or MFA challenge)
auth.post('/login', async c => {
  const body = await c.req.json<{ username: string; password: string }>();

  if (!body.username || !body.password) {
    throw new ValidationError('Username and password are required');
  }

  const result = await authenticateUser(body.username, body.password);

  // DROP-130 Item 6: `awaiting_admin_password` (a scoped-`users:create`
  // account whose password has never been set by an admin) maps to the exact
  // same response as `invalid` / `disabled` — a distinct message here would
  // tell a caller who already knows the account exists (they created it)
  // that their escalation attempt was specifically recognised, rather than
  // just rejected like any other failed login.
  if (
    result.status === 'invalid' ||
    result.status === 'disabled' ||
    result.status === 'awaiting_admin_password'
  ) {
    return c.json(error(ErrorCodes.UNAUTHORIZED, 'Invalid username or password'), 401);
  }

  // Both of these stay on tryLogActivity, not logActivityFor: this request
  // IS the authentication, so there is no AuthContext yet to derive from.
  if (result.status === 'mfa_required') {
    await tryLogActivity({ action: 'login_mfa_challenge', username: body.username });
    return c.json(success({ mfaRequired: true, challengeToken: result.challengeToken }));
  }

  // status === 'ok'
  const user = getUser(body.username);
  await tryLogActivity({ action: 'login', userId: user?.id, username: body.username });
  return c.json(
    success({
      token: result.token,
      tokenType: 'Bearer',
      expiresIn: 86400,
      user: user
        ? {
            id: user.id,
            username: user.username,
            role: user.role,
            email: (user as any).email,
            mustChangePassword: (user as any).mustChangePassword === true,
          }
        : undefined,
    })
  );
});

// POST /auth/api-keys - Create a new API key (admin only)
auth.post('/api-keys', authMiddleware('admin'), async c => {
  const body = await c.req.json<{
    name: string;
    role?: 'admin' | 'user' | 'readonly';
    expiresInDays?: number;
    ownerUserId?: string;
  }>();

  const name = typeof body.name === 'string' ? body.name.trim() : body.name;
  if (!name) {
    throw new ValidationError('API key name is required');
  }
  if (name.length > 64) {
    throw new ValidationError('API key name must be 64 characters or fewer');
  }
  if (name === 'cli-local') {
    throw new ValidationError("This name is reserved for the platform's local CLI key");
  }

  if (
    body.expiresInDays !== undefined &&
    !(
      typeof body.expiresInDays === 'number' &&
      Number.isInteger(body.expiresInDays) &&
      body.expiresInDays >= 1 &&
      body.expiresInDays <= 3650
    )
  ) {
    throw new ValidationError('expiresInDays must be an integer between 1 and 3650');
  }

  // `role` is only a TypeScript annotation on `body` — validate it at runtime,
  // or an arbitrary string (or 'none', which the declared type excludes) is
  // persisted onto the key and evaluated by every later role check.
  if (body.role !== undefined && !['admin', 'user', 'readonly'].includes(body.role)) {
    throw new ValidationError('role must be one of: admin, user, readonly');
  }

  // Who the key acts for. Explicit `ownerUserId` wins; otherwise the key is
  // attributed to the caller. Never left unset, and never set to something
  // that isn't a real user: a key whose owner can't be resolved reproduces the
  // exact bug this field exists to fix, while looking correct.
  //
  // The default needs the same validation as the explicit value, because the
  // caller is not always user-backed — `cli-local` (platform.ts) is a legacy
  // admin KEY with no owner of its own, so `callerAuth.userId` is a key id
  // there, and its id is regenerated on every platform start.
  const callerAuth = (c.get as (k: string) => AuthContext | undefined)('auth');
  const requestedOwner = body.ownerUserId !== undefined ? body.ownerUserId : callerAuth?.userId;

  if (callerAuth && (typeof requestedOwner !== 'string' || !getUserById(requestedOwner))) {
    throw new ValidationError(
      body.ownerUserId !== undefined
        ? 'ownerUserId must reference an existing user'
        : 'ownerUserId is required when the caller is not itself a user (e.g. the local CLI key)'
    );
  }
  const ownerUserId = requestedOwner;

  const { key, apiKey } = await createApiKey(
    name,
    body.role || 'user',
    body.expiresInDays,
    undefined,
    ownerUserId
  );

  // Record who minted the key and for whom. `ownerUserId` accepts any existing
  // user (including another admin) and `AuthContext.username` is the free-text
  // key name, so without this an admin could mint {ownerUserId: <other-admin>,
  // name: "<their-username>"} and have every later action attributed to them —
  // with the minting itself leaving no trace at all.
  await logActivityFor(callerAuth, {
    action: 'apikey-create',
    detail: `key=${apiKey.id} name=${apiKey.name} role=${apiKey.role} owner=${apiKey.ownerUserId ?? 'none'}`,
  });

  return c.json(
    success({
      key, // Only returned once!
      id: apiKey.id,
      name: apiKey.name,
      prefix: apiKey.prefix,
      role: apiKey.role,
      createdAt: apiKey.createdAt,
      expiresAt: apiKey.expiresAt,
      ownerUserId: apiKey.ownerUserId,
    }),
    201
  );
});

// GET /auth/api-keys - List all API keys (admin only)
auth.get('/api-keys', authMiddleware('admin'), async c => {
  const keys = listApiKeys();
  return c.json(success(keys));
});

// DELETE /auth/api-keys/:id - Delete an API key (admin only)
auth.delete('/api-keys/:id', authMiddleware('admin'), async c => {
  const id = c.req.param('id');
  if (!id) return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Missing id'), 400);
  const deleted = await deleteApiKey(id);

  if (!deleted) {
    return c.json(error(ErrorCodes.NOT_FOUND, 'API key not found'), 404);
  }

  return c.json(success({ message: 'API key deleted' }));
});

// GET /auth/me - Get current user info
auth.get('/me', authMiddleware(), async c => {
  // Auth context is set by authMiddleware
  const authContext =
    (c.req as unknown as { auth?: AuthContext }).auth ||
    (c.get as (key: string) => AuthContext | undefined)('auth');

  if (!authContext) {
    return c.json(error(ErrorCodes.UNAUTHORIZED, 'Not authenticated'), 401);
  }

  const meUser = getUserById(authContext.userId);
  return c.json(
    success({
      userId: authContext.userId,
      username: authContext.username,
      role: authContext.role,
      authMethod: authContext.authMethod,
      mustChangePassword: meUser?.mustChangePassword === true,
      mfaEnabled: meUser?.mfaEnabled === true,
    })
  );
});

// PUT /auth/password - Change own password
//
// Interactive-session only. `changePassword` reports whether `currentPassword`
// matched, so with a key acting as its owner this route is an online password
// oracle against the owner — reachable with ANY key, including a `readonly`
// one or one injected into a deployed app, and a correct guess hands over the
// account outright. Keys minted without an explicit owner default to the
// minting admin, so the default target is an admin.
auth.put('/password', authMiddleware(), async c => {
  const gate = interactiveSessionOnly(
    (c.get as (k: string) => AuthContext | undefined)('auth'),
    'Changing your password'
  );
  if (!gate.ok) {
    return c.json(error(ErrorCodes.UNAUTHORIZED, gate.message), 403);
  }
  const authCtx = gate.requester;
  const body = await c.req.json<{ currentPassword: string; newPassword: string }>();

  if (!body.currentPassword || !body.newPassword) {
    throw new ValidationError('Current password and new password are required');
  }
  if (body.newPassword.length < 8) {
    throw new ValidationError('New password must be at least 8 characters');
  }

  const changed = await changePassword(authCtx.userId, body.currentPassword, body.newPassword);
  if (!changed) {
    return c.json(error(ErrorCodes.UNAUTHORIZED, 'Current password is incorrect'), 401);
  }

  return c.json(success({ message: 'Password changed' }));
});

// GET /auth/users - List all users with app counts (admin only)
auth.get('/users', authMiddleware('admin'), async c => {
  const users = listUsers();

  let allApps: Array<{ userId?: string }> = [];
  try {
    allApps = getStateManager().getAllApps();
  } catch {
    // State manager not initialized
  }

  const enriched = users.map(u => ({
    ...u,
    enabled: (u as any).enabled !== false,
    appCount: allApps.filter(a => a.userId === u.id).length,
  }));

  return c.json(success(enriched));
});

// POST /auth/users - Create a new user (admin: any role; scoped 'users:create' caller: 'user' role only)
auth.post('/users', authMiddleware(), requireCapability('users:create'), async c => {
  const body = await c.req.json<{
    username: string;
    password: string;
    role?: 'admin' | 'user' | 'readonly';
  }>();

  if (!body.username || !body.password) {
    throw new ValidationError('Username and password are required');
  }

  if (body.password.length < 8) {
    throw new ValidationError('Password must be at least 8 characters');
  }

  // Scope-based (non-admin) callers may only create 'user'-role accounts, and an
  // explicit request for any other role is rejected (never silently downgraded).
  // Only enforced when an auth context is present: a missing context means auth
  // is disabled (open single-operator box), where the pre-existing behavior of
  // allowing any role is preserved.
  const authCtx = (c.get as Function)('auth') as AuthContext | undefined;
  if (authCtx && authCtx.role !== 'admin' && body.role !== undefined && body.role !== 'user') {
    return c.json(
      error(ErrorCodes.UNAUTHORIZED, 'This token may only create user-role accounts'),
      403
    );
  }

  // DROP-130 Item 6: mark the account as created through the SCOPED
  // (non-admin, capability-only) path whenever the caller itself is not an
  // admin — the same test the role-clamp check above uses, since both ask
  // "is a non-admin capability holder driving this request", not "did the
  // request body ask for a non-default role". `createUser` stamps
  // `createdByScope` on the record; `authenticateUser` then refuses to log
  // this account in until an admin resets its password (`resetUserPassword`,
  // which clears the marker) — closing the chain this credential would
  // otherwise reach: login -> PUT /auth/password (JWT-only, exempt from the
  // mustChangePassword 403) -> POST /apps/:name/source, whose new-app scope
  // check in upload-preflight.ts applies only to rank-0 callers. Never set
  // when auth is disabled (no authCtx) — that preserves the pre-existing,
  // effectively-admin behaviour of an open single-operator box.
  const createdByScope = authCtx !== undefined && authCtx.role !== 'admin';

  try {
    const user = await createUser(
      body.username,
      body.password,
      body.role || 'user',
      undefined,
      true,
      createdByScope
    );
    return c.json(
      success({
        id: user.id,
        username: user.username,
        role: user.role,
        createdAt: user.createdAt,
      }),
      201
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      return c.json(error(ErrorCodes.CONFLICT, err.message), 409);
    }
    // DROP-130 HIGH-4: `createUser` now validates `role` itself (this route
    // never did, unlike PUT /auth/users/:id) — translate its plain Error
    // into the same VALIDATION_ERROR shape that route uses.
    if (err instanceof Error && err.message.startsWith('Invalid role:')) {
      return c.json(error(ErrorCodes.VALIDATION_ERROR, err.message), 400);
    }
    throw err;
  }
});

// PUT /auth/users/:id - Update user (admin only)
auth.put('/users/:id', authMiddleware('admin'), async c => {
  const id = c.req.param('id');
  if (!id) return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Missing id'), 400);
  const body = await c.req.json<{
    enabled?: boolean;
    role?: 'admin' | 'user' | 'readonly';
    maxApps?: number;
    email?: string;
  }>();

  // `role` and `maxApps` are only TypeScript annotations on `body` — validate
  // at runtime, or an arbitrary string / non-numeric value is persisted onto
  // the user record. Same shape as POST /auth/api-keys' `role` check. This
  // matters beyond this route: a corrupted role ranks 0 under `roleHierarchy`'s
  // defensive `?? 0`, which would clamp every API key this user owns down to
  // nothing the moment their standing is derived from it.
  if (body.role !== undefined && !['admin', 'user', 'readonly'].includes(body.role)) {
    throw new ValidationError('role must be one of: admin, user, readonly');
  }
  if (
    body.maxApps !== undefined &&
    !(typeof body.maxApps === 'number' && Number.isInteger(body.maxApps) && body.maxApps >= 0)
  ) {
    throw new ValidationError('maxApps must be a non-negative integer');
  }

  try {
    const updated = await updateUser(id, body);
    if (!updated) {
      return c.json(error(ErrorCodes.NOT_FOUND, 'User not found'), 404);
    }
  } catch (err) {
    // updateUser throws a plain Error for exactly one business-rule guard
    // (mirroring deleteUser's own last-admin guard) — match that specific
    // message and translate it to 400. Anything else (e.g. the credentials
    // write itself failing) is an infrastructure error, not bad input, and
    // must fall through to the global error handler rather than be reported
    // to the client as a VALIDATION_ERROR with the raw message attached.
    if (err instanceof Error && err.message === 'Cannot demote the last admin account') {
      return c.json(error(ErrorCodes.VALIDATION_ERROR, err.message), 400);
    }
    throw err;
  }

  return c.json(success({ message: 'User updated' }));
});

// POST /auth/users/:id/reset-password - Admin reset user password
auth.post('/users/:id/reset-password', authMiddleware('admin'), async c => {
  const id = c.req.param('id');
  if (!id) return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Missing id'), 400);
  const body = await c.req.json<{ newPassword: string }>();

  if (!body.newPassword || body.newPassword.length < 8) {
    throw new ValidationError('New password must be at least 8 characters');
  }

  const reset = await resetUserPassword(id, body.newPassword);
  if (!reset) {
    return c.json(error(ErrorCodes.NOT_FOUND, 'User not found'), 404);
  }

  // DROP-130 MEDIUM-8: this call stamps `credentialsInvalidBefore` — killing
  // every API key, agent token and refresh token the user holds — and clears
  // `createdByScope`, with no trace anywhere until now. Without an activity
  // row, the activity log can't explain why a fleet of keys stopped
  // authenticating right after this request.
  const callerAuth = (c.get as (k: string) => AuthContext | undefined)('auth');
  await logActivityFor(callerAuth, {
    action: 'password-reset',
    detail: `user=${id}`,
  });

  return c.json(success({ message: 'Password reset' }));
});

/**
 * DELETE /auth/account - Delete own account.
 *
 * Interactive-session only, and password-confirmed. Both guards exist because
 * `AuthContext.userId` now resolves to an API key's `ownerUserId`: without
 * them, ANY key issued to a CI job or a deployed app — including a `readonly`
 * one, since this route requires no role — would delete its owner's account on
 * a single unauthenticated-in-spirit call. Before ownership resolution this was
 * accidentally inert (a key's id is never in `credentials.users`, so
 * `deleteUser` was a guaranteed no-op), so the containment was a side effect of
 * the bug rather than a decision.
 */
auth.delete('/account', authMiddleware(), async c => {
  const gate = interactiveSessionOnly(
    (c.get as (k: string) => AuthContext | undefined)('auth'),
    'Account deletion'
  );
  if (!gate.ok) {
    return c.json(error(ErrorCodes.UNAUTHORIZED, gate.message), 403);
  }
  const authCtx = gate.requester;

  const confirmBody = await c.req
    .json<{ password?: string }>()
    .catch(() => ({ password: undefined }));
  if (!confirmBody.password) {
    throw new ValidationError('Current password is required to delete your account');
  }
  if (!verifyUserPassword(authCtx.userId, confirmBody.password)) {
    return c.json(error(ErrorCodes.UNAUTHORIZED, 'Current password is incorrect'), 401);
  }

  try {
    await deleteUser(authCtx.userId);
    await logActivityFor(authCtx, {
      action: 'delete',
      detail: 'Account deleted',
    });
    return c.json(success({ message: 'Account deleted' }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete account';
    return c.json(error(ErrorCodes.BAD_REQUEST, message), 400);
  }
});

// POST /auth/mfa/verify - Complete MFA login (challengeToken + 6-digit code)
auth.post('/mfa/verify', async c => {
  const body = await c.req.json<{ challengeToken: string; code: string }>();
  if (!body.challengeToken || !body.code) {
    throw new ValidationError('challengeToken and code are required');
  }

  const result = await completeMfaLogin(body.challengeToken, body.code);

  if (result.status === 'expired') {
    return c.json(
      error(ErrorCodes.UNAUTHORIZED, 'Challenge token expired. Please log in again.'),
      401
    );
  }
  if (result.status === 'attempt_limit') {
    return c.json(
      error(ErrorCodes.UNAUTHORIZED, 'Too many failed attempts. Please log in again.'),
      401
    );
  }
  if (result.status === 'invalid') {
    return c.json(error(ErrorCodes.MFA_INVALID, 'Invalid authentication code.'), 401);
  }

  // status === 'ok'
  // Stays on tryLogActivity, not logActivityFor: completing the MFA
  // challenge IS the authentication — there is no AuthContext yet.
  await tryLogActivity({
    action: 'login_mfa_ok',
    userId: result.user.id,
    username: result.user.username,
  });
  return c.json(
    success({
      token: result.token,
      tokenType: 'Bearer',
      expiresIn: 86400,
      // Mirror POST /auth/login: return the user so the client keeps the
      // real role after MFA (otherwise an admin is shown as a plain user).
      user: result.user,
    })
  );
});

// POST /auth/mfa/setup - Generate a candidate TOTP secret (not persisted until enabled)
//
// Interactive-session only: this mints a candidate TOTP secret and a
// provisioning URI (which embeds the account label) FOR THE OWNER with no
// password check. Enrolling a second factor is an account-credential
// operation, not something a deployed app's key should perform.
auth.post('/mfa/setup', authMiddleware(), async c => {
  const gate = interactiveSessionOnly(
    (c.get as (k: string) => AuthContext | undefined)('auth'),
    'Two-factor enrolment'
  );
  if (!gate.ok) {
    return c.json(error(ErrorCodes.UNAUTHORIZED, gate.message), 403);
  }
  const authCtx = gate.requester;
  const setup = setupMfa(authCtx.userId);
  if (!setup) {
    return c.json(error(ErrorCodes.NOT_FOUND, 'User not found'), 404);
  }
  return c.json(success({ uri: setup.uri, secret: setup.secret }));
});

// POST /auth/mfa/enable - Persist and activate TOTP for the authenticated user
//
// Interactive-session only. It takes the account password, so with a key
// acting as its owner this is a second password oracle alongside
// PUT /auth/password.
auth.post('/mfa/enable', authMiddleware(), async c => {
  const gate = interactiveSessionOnly(
    (c.get as (k: string) => AuthContext | undefined)('auth'),
    'Enabling two-factor authentication'
  );
  if (!gate.ok) {
    return c.json(error(ErrorCodes.UNAUTHORIZED, gate.message), 403);
  }
  const authCtx = gate.requester;
  const body = await c.req.json<{ password: string; secret: string; code: string }>();
  if (!body.password || !body.secret || !body.code) {
    throw new ValidationError('password, secret, and code are required');
  }

  const result = await enableMfa(authCtx.userId, body.password, body.secret, body.code);

  if (result.status === 'invalid_password') {
    return c.json(error(ErrorCodes.UNAUTHORIZED, 'Current password is incorrect'), 401);
  }
  if (result.status === 'invalid_code') {
    return c.json(error(ErrorCodes.MFA_INVALID, 'Code does not match the provided secret'), 400);
  }
  if (result.status === 'no_key') {
    return c.json(
      error(
        ErrorCodes.INTERNAL_ERROR,
        'MFA encryption key not available. Contact the server operator.'
      ),
      500
    );
  }

  await logActivityFor(authCtx, {
    action: 'mfa_enabled',
  });
  return c.json(success({ message: 'Two-factor authentication enabled' }));
});

// POST /auth/mfa/disable - Disable TOTP (requires a valid current TOTP code)
//
// Interactive-session only. `disableMfa` reports `invalid_code` and — unlike
// the login MFA path, which limits attempts on the challenge token — keeps NO
// failed-attempt counter. With a key acting as its owner that is an unlimited
// online brute force against a 6-digit code that strips the owner's second
// factor on success.
auth.post('/mfa/disable', authMiddleware(), async c => {
  const gate = interactiveSessionOnly(
    (c.get as (k: string) => AuthContext | undefined)('auth'),
    'Disabling two-factor authentication'
  );
  if (!gate.ok) {
    return c.json(error(ErrorCodes.UNAUTHORIZED, gate.message), 403);
  }
  const authCtx = gate.requester;
  const body = await c.req.json<{ code: string }>();
  if (!body.code) {
    throw new ValidationError('code is required');
  }

  const result = await disableMfa(authCtx.userId, body.code);

  if (result.status === 'not_enabled') {
    return c.json(error(ErrorCodes.BAD_REQUEST, 'Two-factor authentication is not enabled'), 400);
  }
  if (result.status === 'invalid_code') {
    return c.json(error(ErrorCodes.MFA_INVALID, 'Invalid authentication code'), 401);
  }

  await logActivityFor(authCtx, {
    action: 'mfa_disabled',
  });
  return c.json(success({ message: 'Two-factor authentication disabled' }));
});

/**
 * POST /auth/agent-tokens - mint a scope-only token for an autonomous caller.
 *
 * Distinct from POST /auth/api-keys in three ways that matter:
 *
 *  - role is ALWAYS 'none'. An agent token has no role standing whatsoever;
 *    its entire authority is the scope list, checked by canAccessScoped.
 *    There is no parameter to raise it, because there is no reason to.
 *  - the requester may only grant apps they can already reach. assertMintable
 *    enforces that; without it any authenticated user mints
 *    app:<someone-elses-app>:deploy for themselves.
 *  - expiry is in MINUTES and is capped. A credential handed to an autonomous
 *    caller should outlive its task by minutes.
 *
 * Gated at `user` (not admin) deliberately: this grants a SUBSET of what the
 * caller already holds, so requiring an admin would make the safe path the
 * inconvenient one and push people towards long-lived full-role keys.
 */
auth.post('/agent-tokens', authMiddleware('user'), async (c) => {
  const requester = (c.get as (k: string) => AuthContext | undefined)('auth');
  const body = await c.req.json<{
    name?: string;
    scopes?: unknown;
    expiresInMinutes?: number;
  }>();

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new ValidationError('A name is required');
  if (name.length > 64) throw new ValidationError('Name must be 64 characters or fewer');

  const minutes = body.expiresInMinutes ?? DEFAULT_AGENT_TOKEN_MINUTES;
  if (
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > MAX_AGENT_TOKEN_MINUTES
  ) {
    throw new ValidationError(
      `expiresInMinutes must be an integer between 1 and ${MAX_AGENT_TOKEN_MINUTES}`
    );
  }

  // The requester's OWN reach, evaluated per app named. An admin passes
  // everything via canAccess; anyone else only their own apps. A name that
  // does not resolve to a live app fails too — you cannot pre-grant against a
  // name you do not hold, which would otherwise be a way to claim one.
  // The token's owner is the requester, so a scope must name an app the
  // REQUESTER owns — not merely one they can reach. For everyone but an admin
  // those are the same thing. For an admin they are not: canAccess passes on
  // role, so an admin could mint app:<other-user's-app>:deploy and get back a
  // 201 for a token that is rank-0 at check time and therefore fails
  // canAccess forever. A credential that can never work is a footgun, not a
  // grant.
  const check = assertMintable(body.scopes, (appName) => {
    const app = getStateManager().getApp(appName);
    return !!app && canAccess(requester, app) && app.userId === requester?.userId;
  });
  if (!check.ok) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, check.reason ?? 'Invalid scopes'), 400);
  }

  const { key, apiKey } = await createApiKey(
    name,
    'none',
    undefined,
    check.normalized,
    requester?.userId,
    { expiresInMinutes: minutes, kind: 'agent' }
  );

  await logActivityFor(requester, {
    action: 'agent-token-issue',
    detail: `${check.normalized?.length ?? 0} scope(s), ${minutes}m`,
  });

  // The raw key is returned ONCE and never stored.
  return c.json(
    success({
      id: apiKey.id,
      name: apiKey.name,
      key,
      scopes: apiKey.scopes,
      expiresAt: apiKey.expiresAt,
    }),
    201
  );
});

/**
 * DELETE /auth/agent-tokens/:id - revoke one of YOUR OWN agent tokens.
 *
 * Minting is gated at `user`, so revocation must be too. Without this a user
 * who leaks a token has no kill switch at all: DELETE /auth/api-keys/:id is
 * admin-only, and the expiry ceiling is a week. Creating a credential you
 * cannot destroy is worse than not offering it.
 *
 * Deliberately narrow — it deletes only `kind: 'agent'` keys the caller owns,
 * so it cannot become a back door to revoking someone else's key, or an
 * admin's ordinary API key, from a `user` gate.
 */
auth.delete('/agent-tokens/:id', authMiddleware('user'), async (c) => {
  const requester = (c.get as (k: string) => AuthContext | undefined)('auth');
  const id = c.req.param('id');
  if (!id) return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Missing id'), 400);

  const mine = listApiKeys().find(
    (k) => k.id === id && k.kind === 'agent' && k.ownerUserId === requester?.userId
  );
  // One 404 for missing, foreign, and not-an-agent-token — no existence oracle
  // over other people's key ids.
  if (!mine) {
    return c.json(error(ErrorCodes.NOT_FOUND, `No agent token found for '${id}'`), 404);
  }

  await deleteApiKey(id);
  return c.json(success({ revoked: true }));
});

export default auth;
