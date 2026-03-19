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
  changePassword,
  updateUser,
  authMiddleware,
  isAuthEnabled,
  AuthContext,
} from '../middleware/auth';
import { getActivityLog } from '../../managers/activity';
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
  const body = await c.req.json<{ username: string; password: string }>();

  if (!body.username || !body.password) {
    throw new ValidationError('Username and password are required');
  }

  if (body.username.length < 3 || !/^[a-zA-Z0-9_-]+$/.test(body.username)) {
    throw new ValidationError('Username must be at least 3 characters (letters, numbers, hyphens, underscores)');
  }

  if (body.password.length < 8) {
    throw new ValidationError('Password must be at least 8 characters');
  }

  try {
    const user = await createUser(body.username, body.password, 'user');
    try { await getActivityLog().log({ action: 'signup', userId: user.id, username: user.username }); } catch {}
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

// POST /auth/login - Authenticate and get JWT token
auth.post('/login', async (c) => {
  const body = await c.req.json<{ username: string; password: string }>();

  if (!body.username || !body.password) {
    throw new ValidationError('Username and password are required');
  }

  const token = await authenticateUser(body.username, body.password);

  if (!token) {
    return c.json(error(ErrorCodes.UNAUTHORIZED, 'Invalid username or password'), 401);
  }

  const user = getUser(body.username);
  try { await getActivityLog().log({ action: 'login', userId: user?.id, username: body.username }); } catch {}
  return c.json(
    success({
      token,
      tokenType: 'Bearer',
      expiresIn: 86400,
      user: user ? { id: user.id, username: user.username, role: user.role } : undefined,
    })
  );
});

// POST /auth/api-keys - Create a new API key (admin only)
auth.post('/api-keys', authMiddleware('admin'), async (c) => {
  const body = await c.req.json<{ name: string; role?: 'admin' | 'user' | 'readonly'; expiresInDays?: number }>();

  if (!body.name) {
    throw new ValidationError('API key name is required');
  }

  const { key, apiKey } = await createApiKey(body.name, body.role || 'user', body.expiresInDays);

  return c.json(
    success({
      key, // Only returned once!
      id: apiKey.id,
      name: apiKey.name,
      prefix: apiKey.prefix,
      role: apiKey.role,
      createdAt: apiKey.createdAt,
      expiresAt: apiKey.expiresAt,
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

  return c.json(
    success({
      userId: authContext.userId,
      username: authContext.username,
      role: authContext.role,
      authMethod: authContext.authMethod,
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

// POST /auth/users - Create a new user (admin only)
auth.post('/users', authMiddleware('admin'), async (c) => {
  const body = await c.req.json<{ username: string; password: string; role?: 'admin' | 'user' | 'readonly' }>();

  if (!body.username || !body.password) {
    throw new ValidationError('Username and password are required');
  }

  if (body.password.length < 8) {
    throw new ValidationError('Password must be at least 8 characters');
  }

  try {
    const user = await createUser(body.username, body.password, body.role || 'user');
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
  const body = await c.req.json<{ enabled?: boolean; role?: 'admin' | 'user' | 'readonly' }>();

  const updated = await updateUser(id, body);
  if (!updated) {
    return c.json(error(ErrorCodes.NOT_FOUND, 'User not found'), 404);
  }

  return c.json(success({ message: 'User updated' }));
});

export default auth;
