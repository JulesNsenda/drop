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
import { tryLogActivity } from '../../managers/activity';
import { getStateManager } from '../../managers/app/state-manager';
import { ValidationError } from '../middleware/error';

const auth = new Hono();

// GET /auth/status - Public endpoint to check if auth is enabled
auth.get('/status', (c) => {
  const enabled = isAuthEnabled();
  return c.json(success({ enabled }));
});

// POST /auth/signup - Self-service user registration
auth.post('/signup', async (c) => {
  if (!isSignupEnabled()) {
    return c.json(error(ErrorCodes.UNAUTHORIZED, 'Self-service signup is not enabled on this instance'), 403);
  }

  const body = await c.req.json<{ username: string; password: string; email: string }>();

  if (!body.username || !body.password || !body.email) {
    throw new ValidationError('Username, email, and password are required');
  }

  if (body.username.length < 3 || !/^[a-zA-Z0-9_-]+$/.test(body.username)) {
    throw new ValidationError('Username must be at least 3 characters (letters, numbers, hyphens, underscores)');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    throw new ValidationError('Invalid email address');
  }

  if (body.password.length < 8) {
    throw new ValidationError('Password must be at least 8 characters');
  }

  try {
    const user = await createUser(body.username, body.password, 'user', body.email);
    await tryLogActivity({ action: 'signup', userId: user.id, username: user.username });
    return c.json(success({
      id: user.id,
      username: user.username,
      role: user.role,
      message: 'Account created. You can now sign in.',
    }), 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Registration failed';
    if (message.includes('already exists')) {
      return c.json(error(ErrorCodes.CONFLICT, message), 409);
    }
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }
});

// POST /auth/login - Authenticate and get JWT token (or MFA challenge)
auth.post('/login', async (c) => {
  const body = await c.req.json<{ username: string; password: string }>();

  if (!body.username || !body.password) {
    throw new ValidationError('Username and password are required');
  }

  const result = await authenticateUser(body.username, body.password);

  if (result.status === 'invalid' || result.status === 'disabled') {
    return c.json(error(ErrorCodes.UNAUTHORIZED, 'Invalid username or password'), 401);
  }

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
      user: user ? {
        id: user.id,
        username: user.username,
        role: user.role,
        email: (user as any).email,
        mustChangePassword: (user as any).mustChangePassword === true,
      } : undefined,
    })
  );
});

// POST /auth/api-keys - Create a new API key (admin only)
auth.post('/api-keys', authMiddleware('admin'), async (c) => {
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

  // Who the key acts for. Explicit `ownerUserId` wins; otherwise the key is
  // attributed to the admin creating it. Never left unset: a key with no owner
  // is a principal no human can log in as, so the apps it creates are visible
  // to nobody but an admin and count against no user's quota.
  const callerAuth = (c.get as (k: string) => AuthContext | undefined)('auth');
  let ownerUserId = callerAuth?.userId;

  if (body.ownerUserId !== undefined) {
    if (typeof body.ownerUserId !== 'string' || !getUserById(body.ownerUserId)) {
      throw new ValidationError('ownerUserId must reference an existing user');
    }
    ownerUserId = body.ownerUserId;
  }

  const { key, apiKey } = await createApiKey(
    name,
    body.role || 'user',
    body.expiresInDays,
    undefined,
    ownerUserId
  );

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
auth.get('/api-keys', authMiddleware('admin'), async (c) => {
  const keys = listApiKeys();
  return c.json(success(keys));
});

// DELETE /auth/api-keys/:id - Delete an API key (admin only)
auth.delete('/api-keys/:id', authMiddleware('admin'), async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Missing id'), 400);
  const deleted = await deleteApiKey(id);

  if (!deleted) {
    return c.json(error(ErrorCodes.NOT_FOUND, 'API key not found'), 404);
  }

  return c.json(success({ message: 'API key deleted' }));
});

// GET /auth/me - Get current user info
auth.get('/me', authMiddleware(), async (c) => {
  // Auth context is set by authMiddleware
  const authContext = (c.req as unknown as { auth?: AuthContext }).auth ||
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
auth.put('/password', authMiddleware(), async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext;
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
auth.get('/users', authMiddleware('admin'), async (c) => {
  const users = listUsers();

  let allApps: Array<{ userId?: string }> = [];
  try {
    allApps = getStateManager().getAllApps();
  } catch {
    // State manager not initialized
  }

  const enriched = users.map((u) => ({
    ...u,
    enabled: (u as any).enabled !== false,
    appCount: allApps.filter((a) => a.userId === u.id).length,
  }));

  return c.json(success(enriched));
});

// POST /auth/users - Create a new user (admin: any role; scoped 'users:create' caller: 'user' role only)
auth.post('/users', authMiddleware(), requireCapability('users:create'), async (c) => {
  const body = await c.req.json<{ username: string; password: string; role?: 'admin' | 'user' | 'readonly' }>();

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
    return c.json(error(ErrorCodes.UNAUTHORIZED, 'This token may only create user-role accounts'), 403);
  }

  try {
    const user = await createUser(body.username, body.password, body.role || 'user', undefined, true);
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
    throw err;
  }
});

// PUT /auth/users/:id - Update user (admin only)
auth.put('/users/:id', authMiddleware('admin'), async (c) => {
  const id = c.req.param('id');
  if (!id) return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Missing id'), 400);
  const body = await c.req.json<{ enabled?: boolean; role?: 'admin' | 'user' | 'readonly' }>();

  const updated = await updateUser(id, body);
  if (!updated) {
    return c.json(error(ErrorCodes.NOT_FOUND, 'User not found'), 404);
  }

  return c.json(success({ message: 'User updated' }));
});

// POST /auth/users/:id/reset-password - Admin reset user password
auth.post('/users/:id/reset-password', authMiddleware('admin'), async (c) => {
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

  return c.json(success({ message: 'Password reset' }));
});

// DELETE /auth/account - Delete own account
auth.delete('/account', authMiddleware(), async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext;

  try {
    await deleteUser(authCtx.userId);
    await tryLogActivity({ action: 'delete', userId: authCtx.userId, username: authCtx.username, detail: 'Account deleted' });
    return c.json(success({ message: 'Account deleted' }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to delete account';
    return c.json(error(ErrorCodes.BAD_REQUEST, message), 400);
  }
});

// POST /auth/mfa/verify - Complete MFA login (challengeToken + 6-digit code)
auth.post('/mfa/verify', async (c) => {
  const body = await c.req.json<{ challengeToken: string; code: string }>();
  if (!body.challengeToken || !body.code) {
    throw new ValidationError('challengeToken and code are required');
  }

  const result = await completeMfaLogin(body.challengeToken, body.code);

  if (result.status === 'expired') {
    return c.json(error(ErrorCodes.UNAUTHORIZED, 'Challenge token expired. Please log in again.'), 401);
  }
  if (result.status === 'attempt_limit') {
    return c.json(error(ErrorCodes.UNAUTHORIZED, 'Too many failed attempts. Please log in again.'), 401);
  }
  if (result.status === 'invalid') {
    return c.json(error(ErrorCodes.MFA_INVALID, 'Invalid authentication code.'), 401);
  }

  // status === 'ok'
  await tryLogActivity({ action: 'login_mfa_ok', userId: result.user.id, username: result.user.username });
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
auth.post('/mfa/setup', authMiddleware(), async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext;
  const setup = setupMfa(authCtx.userId);
  if (!setup) {
    return c.json(error(ErrorCodes.NOT_FOUND, 'User not found'), 404);
  }
  return c.json(success({ uri: setup.uri, secret: setup.secret }));
});

// POST /auth/mfa/enable - Persist and activate TOTP for the authenticated user
auth.post('/mfa/enable', authMiddleware(), async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext;
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
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'MFA encryption key not available. Contact the server operator.'), 500);
  }

  await tryLogActivity({ action: 'mfa_enabled', userId: authCtx.userId, username: authCtx.username });
  return c.json(success({ message: 'Two-factor authentication enabled' }));
});

// POST /auth/mfa/disable - Disable TOTP (requires a valid current TOTP code)
auth.post('/mfa/disable', authMiddleware(), async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext;
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

  await tryLogActivity({ action: 'mfa_disabled', userId: authCtx.userId, username: authCtx.username });
  return c.json(success({ message: 'Two-factor authentication disabled' }));
});

export default auth;
