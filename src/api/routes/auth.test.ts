/**
 * Authentication Routes Tests
 */

import { Hono } from 'hono';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import authRoutes from './auth';
import { initializeAuth, createUser, createApiKey } from '../middleware/auth';
import { HttpError } from '../middleware/error';
import { error, ErrorCodes } from '../types';

interface ApiResponse<T = unknown> {
  success: boolean;
  data: T;
  error?: { code: string; message: string };
}

interface LoginResponse {
  token: string;
  tokenType: string;
  expiresIn: number;
}

interface ApiKeyResponse {
  key: string;
  id: string;
  name: string;
  prefix: string;
  role: string;
  createdAt: string;
  expiresAt?: string;
}

interface UserResponse {
  userId: string;
  username: string;
  role: string;
  authMethod: string;
}

interface CreatedUserResponse {
  id: string;
  username: string;
  role: string;
  createdAt: string;
}

interface ApiKeyListItem {
  id: string;
  name: string;
  prefix: string;
  role: string;
  createdAt: string;
  expiresAt?: string;
}

describe('Auth Routes', () => {
  let app: Hono;
  let tempDir: string;
  let credentialsPath: string;
  let adminToken: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-auth-routes-test-'));
    credentialsPath = path.join(tempDir, 'credentials.json');

    jest.spyOn(console, 'log').mockImplementation();

    await initializeAuth({
      credentialsPath,
      enableJwt: true,
      enableApiKeys: true,
    });

    // Create test admin user
    await createUser('testadmin', 'adminpass123', 'admin');

    // Set up Hono app with auth routes
    app = new Hono();
    app.route('/auth', authRoutes);

    // Error handler
    app.onError((err, c) => {
      if (err instanceof HttpError) {
        return c.json(error(err.code, err.message), err.statusCode as 400 | 401 | 403 | 404 | 409 | 500);
      }
      return c.json(error(ErrorCodes.INTERNAL_ERROR, err.message || 'Internal server error'), 500);
    });

    // Get admin token
    const loginRes = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testadmin', password: 'adminpass123' }),
    });
    const loginData = (await loginRes.json()) as ApiResponse<LoginResponse>;
    adminToken = loginData.data.token;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('POST /auth/login', () => {
    it('should return JWT token for valid credentials', async () => {
      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testadmin', password: 'adminpass123' }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as ApiResponse<LoginResponse>;
      expect(data.success).toBe(true);
      expect(data.data.token).toBeDefined();
      expect(data.data.tokenType).toBe('Bearer');
      expect(data.data.expiresIn).toBe(86400);
    });

    it('should return 401 for invalid password', async () => {
      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testadmin', password: 'wrongpassword' }),
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as ApiResponse;
      expect(data.success).toBe(false);
    });

    it('should return 401 for non-existent user', async () => {
      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'nonexistent', password: 'password123' }),
      });

      expect(res.status).toBe(401);
    });

    it('should return 400 for missing credentials', async () => {
      const res = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'testadmin' }),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/api-keys', () => {
    it('should create API key for admin', async () => {
      const res = await app.request('/auth/api-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: 'test-key', role: 'user' }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as ApiResponse<ApiKeyResponse>;
      expect(data.success).toBe(true);
      expect(data.data.key).toMatch(/^drop_/);
      expect(data.data.name).toBe('test-key');
    });

    it('should return 401 without auth', async () => {
      const res = await app.request('/auth/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'test-key' }),
      });

      expect(res.status).toBe(401);
    });

    it('should return 400 for missing name', async () => {
      const res = await app.request('/auth/api-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ role: 'user' }),
      });

      expect(res.status).toBe(400);
    });

    it('should return 400 for reserved name cli-local', async () => {
      const res = await app.request('/auth/api-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: 'cli-local' }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as ApiResponse;
      expect(data.error?.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 for whitespace-only name', async () => {
      const res = await app.request('/auth/api-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: '   ' }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as ApiResponse;
      expect(data.error?.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 for a name longer than 64 characters', async () => {
      const res = await app.request('/auth/api-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: 'a'.repeat(65) }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as ApiResponse;
      expect(data.error?.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 for expiresInDays: 0', async () => {
      const res = await app.request('/auth/api-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: 'zero-expiry-key', expiresInDays: 0 }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as ApiResponse;
      expect(data.error?.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 for a negative expiresInDays', async () => {
      const res = await app.request('/auth/api-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: 'negative-expiry-key', expiresInDays: -5 }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as ApiResponse;
      expect(data.error?.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 (not 500) for a non-numeric expiresInDays', async () => {
      const res = await app.request('/auth/api-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: 'non-numeric-expiry-key', expiresInDays: 'abc' }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as ApiResponse;
      expect(data.error?.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 for expiresInDays exceeding the 3650-day cap', async () => {
      const res = await app.request('/auth/api-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: 'huge-expiry-key', expiresInDays: 99999 }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as ApiResponse;
      expect(data.error?.code).toBe('VALIDATION_ERROR');
    });

    it('should create API key with a valid name and expiresInDays', async () => {
      const res = await app.request('/auth/api-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ name: 'valid-expiry-key', role: 'user', expiresInDays: 30 }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as ApiResponse<ApiKeyResponse>;
      expect(data.success).toBe(true);
      expect(data.data.key).toMatch(/^drop_/);
      expect(data.data.name).toBe('valid-expiry-key');
      expect(data.data.expiresAt).toBeDefined();
    });
  });

  describe('GET /auth/api-keys', () => {
    beforeEach(async () => {
      await createApiKey('key1', 'user');
      await createApiKey('key2', 'admin');
    });

    it('should list API keys for admin', async () => {
      const res = await app.request('/auth/api-keys', {
        method: 'GET',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as ApiResponse<ApiKeyListItem[]>;
      expect(data.success).toBe(true);
      expect(data.data.length).toBe(2);
    });

    it('should return 401 without auth', async () => {
      const res = await app.request('/auth/api-keys', {
        method: 'GET',
      });

      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /auth/api-keys/:id', () => {
    let apiKeyId: string;

    beforeEach(async () => {
      const { apiKey } = await createApiKey('delete-me', 'user');
      apiKeyId = apiKey.id;
    });

    it('should delete API key for admin', async () => {
      const res = await app.request(`/auth/api-keys/${apiKeyId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as ApiResponse<{ message: string }>;
      expect(data.success).toBe(true);
    });

    it('should return 404 for non-existent key', async () => {
      const res = await app.request('/auth/api-keys/non-existent-id', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.status).toBe(404);
    });
  });

  describe('GET /auth/me', () => {
    it('should return current user info', async () => {
      const res = await app.request('/auth/me', {
        method: 'GET',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as ApiResponse<UserResponse>;
      expect(data.success).toBe(true);
      expect(data.data.username).toBe('testadmin');
      expect(data.data.role).toBe('admin');
      expect(data.data.authMethod).toBe('jwt');
    });

    it('should return 401 without auth', async () => {
      const res = await app.request('/auth/me', {
        method: 'GET',
      });

      expect(res.status).toBe(401);
    });
  });

  describe('GET /auth/users', () => {
    it('should list users for admin', async () => {
      const res = await app.request('/auth/users', {
        method: 'GET',
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as ApiResponse<unknown[]>;
      expect(data.success).toBe(true);
      expect(Array.isArray(data.data)).toBe(true);
    });
  });

  describe('POST /auth/users', () => {
    it('should create new user for admin', async () => {
      const res = await app.request('/auth/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          username: 'newuser',
          password: 'password123',
          role: 'user',
        }),
      });

      expect(res.status).toBe(201);
      const data = (await res.json()) as ApiResponse<CreatedUserResponse>;
      expect(data.success).toBe(true);
      expect(data.data.username).toBe('newuser');
    });

    it('should return 400 for short password', async () => {
      const res = await app.request('/auth/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          username: 'shortpass',
          password: '123',
          role: 'user',
        }),
      });

      expect(res.status).toBe(400);
    });

    it('should return 409 for duplicate username', async () => {
      const res = await app.request('/auth/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          username: 'testadmin',
          password: 'password123',
        }),
      });

      expect(res.status).toBe(409);
    });
  });
});
