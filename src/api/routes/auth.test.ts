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

    describe('scoped users:create capability', () => {
      let scopedKey: string;
      let plainUserKey: string;

      beforeEach(async () => {
        const { key } = await createApiKey('waitlist-provision', 'none', undefined, ['users:create']);
        scopedKey = key;
        const { key: userKey } = await createApiKey('plain-user-key', 'user');
        plainUserKey = userKey;
      });

      it('scoped key can create a user-role account with no role specified, defaulting to user', async () => {
        const res = await app.request('/auth/users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': scopedKey,
          },
          body: JSON.stringify({
            username: 'scoped-created-user',
            password: 'password123',
          }),
        });

        expect(res.status).toBe(201);
        const data = (await res.json()) as ApiResponse<CreatedUserResponse>;
        expect(data.success).toBe(true);
        expect(data.data.username).toBe('scoped-created-user');
        expect(data.data.role).toBe('user');
      });

      it('scoped key requesting an admin role is rejected with 403 and creates no user', async () => {
        const res = await app.request('/auth/users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': scopedKey,
          },
          body: JSON.stringify({
            username: 'scoped-wants-admin',
            password: 'password123',
            role: 'admin',
          }),
        });

        expect(res.status).toBe(403);

        // Confirm no user was created (admin-only listing).
        const listRes = await app.request('/auth/users', {
          method: 'GET',
          headers: { Authorization: `Bearer ${adminToken}` },
        });
        const listData = (await listRes.json()) as ApiResponse<Array<{ username: string }>>;
        expect(listData.data.some((u) => u.username === 'scoped-wants-admin')).toBe(false);
      });

      it('admin token can still create an admin-role account', async () => {
        const res = await app.request('/auth/users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            username: 'second-admin',
            password: 'password123',
            role: 'admin',
          }),
        });

        expect(res.status).toBe(201);
        const data = (await res.json()) as ApiResponse<CreatedUserResponse>;
        expect(data.success).toBe(true);
        expect(data.data.role).toBe('admin');
      });

      it('scoped key is rejected (403) from the admin-only GET /auth/users listing', async () => {
        const res = await app.request('/auth/users', {
          method: 'GET',
          headers: { 'X-API-Key': scopedKey },
        });

        expect(res.status).toBe(403);
      });

      it('a plain non-admin user API key (no scope) cannot create users', async () => {
        const res = await app.request('/auth/users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': plainUserKey,
          },
          body: JSON.stringify({
            username: 'should-not-be-created',
            password: 'password123',
          }),
        });

        expect(res.status).toBe(403);
      });
    });
  });

  describe('DROP-130 Item 6 — users:create escalation containment', () => {
    it('a scoped users:create key cannot log in as the account it just created, closing the chain to PUT /auth/password and POST /apps/:name/source', async () => {
      // Step 1: a rank-0 key holding only the `users:create` capability
      // (ownerless, exactly the shape DROP_API_KEY is minted in) mints a
      // user with a caller-chosen password.
      const { key: scopedKey } = await createApiKey(
        'escalation-provision-key',
        'none',
        undefined,
        ['users:create']
      );

      const createRes = await app.request('/auth/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': scopedKey,
        },
        body: JSON.stringify({ username: 'escalation-target', password: 'attacker-chosen-pw' }),
      });
      expect(createRes.status).toBe(201);

      // Step 2: logging in with the SAME password the caller just chose is
      // refused — and with the exact same response shape as a wrong
      // password, so nothing distinguishes "blocked because scope-created"
      // from an ordinary failed login.
      const loginRes = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'escalation-target', password: 'attacker-chosen-pw' }),
      });
      expect(loginRes.status).toBe(401);
      const loginData = (await loginRes.json()) as ApiResponse<LoginResponse>;
      expect(loginData.success).toBe(false);
      expect(loginData.error?.message).toBe('Invalid username or password');
      expect(loginData.data).toBeUndefined();

      // Step 3: with no JWT ever issued, the next link in the published
      // escalation chain — PUT /auth/password, gated JWT-only by
      // interactiveSessionOnly, and the step that would have cleared
      // mustChangePassword on the way to a full `user` session — is
      // structurally unreachable: there is no Authorization header the
      // caller can present.
      const passwordChangeRes = await app.request('/auth/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPassword: 'attacker-chosen-pw',
          newPassword: 'irrelevant-new-pw',
        }),
      });
      expect(passwordChangeRes.status).toBe(401);
    });

    it('an admin-created account is NOT marked and can log in immediately', async () => {
      const createRes = await app.request('/auth/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ username: 'admin-created-user', password: 'admin-chosen-pw' }),
      });
      expect(createRes.status).toBe(201);

      const loginRes = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin-created-user', password: 'admin-chosen-pw' }),
      });
      expect(loginRes.status).toBe(200);
      const loginData = (await loginRes.json()) as ApiResponse<LoginResponse>;
      expect(loginData.success).toBe(true);
      expect(loginData.data.token).toBeDefined();
    });

    it('an admin resetting the password clears the marker, and login then works', async () => {
      const { key: scopedKey } = await createApiKey(
        'escalation-provision-key-2',
        'none',
        undefined,
        ['users:create']
      );

      const createRes = await app.request('/auth/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': scopedKey,
        },
        body: JSON.stringify({
          username: 'escalation-target-2',
          password: 'attacker-chosen-pw',
        }),
      });
      const created = (await createRes.json()) as ApiResponse<CreatedUserResponse>;

      const blockedLogin = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'escalation-target-2',
          password: 'attacker-chosen-pw',
        }),
      });
      expect(blockedLogin.status).toBe(401);

      const resetRes = await app.request(`/auth/users/${created.data.id}/reset-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ newPassword: 'admin-set-password-123' }),
      });
      expect(resetRes.status).toBe(200);

      const loginAfterReset = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'escalation-target-2',
          password: 'admin-set-password-123',
        }),
      });
      expect(loginAfterReset.status).toBe(200);
      const loginData = (await loginAfterReset.json()) as ApiResponse<LoginResponse>;
      expect(loginData.success).toBe(true);
      expect(loginData.data.token).toBeDefined();
    });
  });

  describe('PUT /auth/users/:id', () => {
    let targetUserId: string;

    beforeEach(async () => {
      const res = await app.request('/auth/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ username: 'update-target', password: 'password123', role: 'user' }),
      });
      const data = (await res.json()) as ApiResponse<CreatedUserResponse>;
      targetUserId = data.data.id;
    });

    it('should update role for admin', async () => {
      const res = await app.request(`/auth/users/${targetUserId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ role: 'readonly' }),
      });

      expect(res.status).toBe(200);
    });

    it('should return 400 (and not persist) for an arbitrary/garbage role string', async () => {
      // `role` is only a TypeScript annotation on the parsed body — without
      // runtime validation an arbitrary string would persist onto the user
      // record, and rank 0 under roleHierarchy's defensive `?? 0`, clamping
      // every API key this user owns down to nothing the moment a key's
      // standing is derived from its owner.
      const res = await app.request(`/auth/users/${targetUserId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ role: 'superadmin' }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as ApiResponse;
      expect(data.error?.code).toBe('VALIDATION_ERROR');

      const listRes = await app.request('/auth/users', {
        method: 'GET',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const listData = (await listRes.json()) as ApiResponse<Array<{ id: string; role: string }>>;
      expect(listData.data.find(u => u.id === targetUserId)?.role).toBe('user');
    });

    it('should return 400 for a negative maxApps', async () => {
      const res = await app.request(`/auth/users/${targetUserId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ maxApps: -1 }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as ApiResponse;
      expect(data.error?.code).toBe('VALIDATION_ERROR');
    });

    it('should return 400 (not 500) for a non-numeric maxApps', async () => {
      const res = await app.request(`/auth/users/${targetUserId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ maxApps: 'unlimited' }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as ApiResponse;
      expect(data.error?.code).toBe('VALIDATION_ERROR');
    });

    it('should accept maxApps: 0 (use global default)', async () => {
      const res = await app.request(`/auth/users/${targetUserId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ maxApps: 0 }),
      });

      expect(res.status).toBe(200);
    });

    it('should refuse to demote the LAST admin account', async () => {
      // `initializeAuth` auto-creates a default 'admin' account on first
      // boot, so at this point two admins exist ('admin' and 'testadmin').
      // Demote the auto-created one down to 'user' first — that must
      // succeed, since a second admin remains — leaving 'testadmin' as the
      // sole admin, which must then refuse to demote itself further.
      const listRes = await app.request('/auth/users', {
        method: 'GET',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const listData = (await listRes.json()) as ApiResponse<Array<{ id: string; username: string; role: string }>>;
      const defaultAdmin = listData.data.find(u => u.username === 'admin' && u.role === 'admin');
      expect(defaultAdmin).toBeDefined();

      const firstDemotion = await app.request(`/auth/users/${defaultAdmin!.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ role: 'user' }),
      });
      expect(firstDemotion.status).toBe(200);

      const meRes = await app.request('/auth/me', {
        method: 'GET',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const me = (await meRes.json()) as ApiResponse<UserResponse>;

      const res = await app.request(`/auth/users/${me.data.userId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ role: 'user' }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as ApiResponse;
      expect(data.error?.code).toBe('VALIDATION_ERROR');
    });

    it('allows demoting an admin when another admin remains', async () => {
      const secondAdminRes = await app.request('/auth/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          username: 'second-admin-demote',
          password: 'password123',
          role: 'admin',
        }),
      });
      const secondAdmin = (await secondAdminRes.json()) as ApiResponse<CreatedUserResponse>;

      const res = await app.request(`/auth/users/${secondAdmin.data.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ role: 'user' }),
      });

      expect(res.status).toBe(200);
    });

    it('should return 404 for a non-existent user id', async () => {
      const res = await app.request('/auth/users/non-existent-id', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({ role: 'readonly' }),
      });

      expect(res.status).toBe(404);
    });
  });
});
