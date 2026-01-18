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
  authMiddleware,
  AuthContext,
} from '../middleware/auth';
import { ValidationError } from '../middleware/error';

const auth = new Hono();

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

  return c.json(
    success({
      token,
      tokenType: 'Bearer',
      expiresIn: 86400, // 24 hours
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

// GET /auth/users - List all users (admin only)
auth.get('/users', authMiddleware('admin'), async (c) => {
  const users = listUsers();
  return c.json(success(users));
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

export default auth;
