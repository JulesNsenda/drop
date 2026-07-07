/**
 * Authentication Middleware Tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  initializeAuth,
  createUser,
  authenticateUser,
  verifyJwt,
  createApiKey,
  verifyApiKey,
  deleteApiKey,
  listApiKeys,
  listUsers,
  isAuthEnabled,
  authMiddleware,
  optionalAuthMiddleware,
  resetAuth,
} from './auth';
import { getTestToken } from '../__testutils__/auth';

describe('Auth Middleware', () => {
  let tempDir: string;
  let credentialsPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-auth-test-'));
    credentialsPath = path.join(tempDir, 'credentials.json');
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('initializeAuth', () => {
    it('should create credentials file if it does not exist', async () => {
      await initializeAuth({
        credentialsPath,
        enableJwt: true,
        enableApiKeys: true,
      });

      const exists = await fs.access(credentialsPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });

    it('should create default admin user on first initialization', async () => {
      // Capture console output
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      await initializeAuth({
        credentialsPath,
        enableJwt: true,
        enableApiKeys: true,
      });

      // Check that default admin password was logged
      const calls = consoleSpy.mock.calls.flat().join(' ');
      expect(calls).toContain('admin');
      expect(calls).toContain('Password');

      consoleSpy.mockRestore();
    });

    it('should load existing credentials file', async () => {
      // Create initial credentials
      await initializeAuth({
        credentialsPath,
        enableJwt: true,
        enableApiKeys: true,
      });

      // Create a user
      await createUser('testuser', 'password123', 'user');

      // Re-initialize (simulating restart)
      await initializeAuth({
        credentialsPath,
        enableJwt: true,
        enableApiKeys: true,
      });

      // User should still exist
      const users = listUsers();
      expect(users.find(u => u.username === 'testuser')).toBeDefined();
    });

    it('quarantines a corrupt credentials file instead of silently overwriting it', async () => {
      jest.spyOn(console, 'log').mockImplementation();
      jest.spyOn(console, 'error').mockImplementation();

      // A populated credentials store exists on disk...
      await initializeAuth({ credentialsPath, enableJwt: true, enableApiKeys: true });
      await createUser('realuser', 'password123', 'user');
      expect(await fs.readFile(credentialsPath, 'utf-8')).toContain('realuser');

      // ...then it gets corrupted on disk. On restart we must NOT wipe it and
      // mint a fresh default admin without a trace — the corrupt bytes must be
      // preserved for recovery.
      const corruptBytes = '{ half-written garbage that will not parse';
      await fs.writeFile(credentialsPath, corruptBytes);
      resetAuth();
      await initializeAuth({ credentialsPath, enableJwt: true, enableApiKeys: true });

      const files = await fs.readdir(tempDir);
      const quarantined = files.filter((f) => f.startsWith('credentials.json.corrupt-'));
      expect(quarantined).toHaveLength(1);
      expect(await fs.readFile(path.join(tempDir, quarantined[0]), 'utf-8')).toBe(corruptBytes);

      jest.restoreAllMocks();
    });

    it('quarantines a valid-JSON-but-wrong-shape credentials file', async () => {
      jest.spyOn(console, 'log').mockImplementation();
      jest.spyOn(console, 'error').mockImplementation();

      await fs.writeFile(credentialsPath, JSON.stringify({ not: 'a credentials store' }));
      resetAuth();
      await initializeAuth({ credentialsPath, enableJwt: true, enableApiKeys: true });

      const files = await fs.readdir(tempDir);
      expect(files.filter((f) => f.startsWith('credentials.json.corrupt-'))).toHaveLength(1);

      jest.restoreAllMocks();
    });

    it('does NOT quarantine on first run (missing file)', async () => {
      jest.spyOn(console, 'log').mockImplementation();
      await initializeAuth({ credentialsPath, enableJwt: true, enableApiKeys: true });

      const files = await fs.readdir(tempDir);
      expect(files.some((f) => f.startsWith('credentials.json.corrupt-'))).toBe(false);

      jest.restoreAllMocks();
    });
  });

  describe('createUser', () => {
    beforeEach(async () => {
      jest.spyOn(console, 'log').mockImplementation();
      await initializeAuth({
        credentialsPath,
        enableJwt: true,
        enableApiKeys: true,
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should create a new user', async () => {
      const user = await createUser('newuser', 'password123', 'user');

      expect(user.username).toBe('newuser');
      expect(user.role).toBe('user');
      expect(user.id).toBeDefined();
      expect(user.passwordHash).toBeDefined();
    });

    it('should throw if user already exists', async () => {
      await createUser('duplicate', 'password123', 'user');

      await expect(createUser('duplicate', 'password456', 'user')).rejects.toThrow(
        "User 'duplicate' already exists"
      );
    });

    it('should create users with different roles', async () => {
      const adminUser = await createUser('adminuser', 'password123', 'admin');
      const readonlyUser = await createUser('readonlyuser', 'password123', 'readonly');

      expect(adminUser.role).toBe('admin');
      expect(readonlyUser.role).toBe('readonly');
    });
  });

  describe('authenticateUser', () => {
    beforeEach(async () => {
      jest.spyOn(console, 'log').mockImplementation();
      resetAuth();
      await initializeAuth({
        credentialsPath,
        enableJwt: true,
        enableApiKeys: true,
      });
      await createUser('testuser', 'correctpassword', 'user');
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should return status ok with JWT token for valid credentials', async () => {
      const result = await authenticateUser('testuser', 'correctpassword');
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(typeof result.token).toBe('string');
      expect(result.token.split('.').length).toBe(3); // JWT has 3 parts
    });

    it('should return status invalid for wrong password', async () => {
      const result = await authenticateUser('testuser', 'wrongpassword');
      expect(result.status).toBe('invalid');
    });

    it('should return status invalid for non-existent user', async () => {
      const result = await authenticateUser('nonexistent', 'password');
      expect(result.status).toBe('invalid');
    });
  });

  describe('verifyJwt', () => {
    let validToken: string;

    beforeEach(async () => {
      jest.spyOn(console, 'log').mockImplementation();
      resetAuth();
      await initializeAuth({
        credentialsPath,
        enableJwt: true,
        enableApiKeys: true,
      });
      await createUser('testuser', 'password123', 'user');
      validToken = await getTestToken('testuser', 'password123');
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should verify a valid JWT token', async () => {
      const payload = await verifyJwt(validToken);

      expect(payload).toBeDefined();
      expect(payload!.username).toBe('testuser');
      expect(payload!.role).toBe('user');
    });

    it('should return null for invalid token', async () => {
      const payload = await verifyJwt('invalid.token.here');

      expect(payload).toBeNull();
    });

    it('should return null for tampered token', async () => {
      const tamperedToken = validToken.slice(0, -5) + 'XXXXX';
      const payload = await verifyJwt(tamperedToken);

      expect(payload).toBeNull();
    });
  });

  describe('API Key Management', () => {
    beforeEach(async () => {
      jest.spyOn(console, 'log').mockImplementation();
      await initializeAuth({
        credentialsPath,
        enableJwt: true,
        enableApiKeys: true,
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should create an API key', async () => {
      const { key, apiKey } = await createApiKey('test-key', 'user');

      expect(key).toMatch(/^drop_/);
      expect(apiKey.name).toBe('test-key');
      expect(apiKey.role).toBe('user');
      expect(apiKey.prefix).toBe(key.substring(0, 12));
    });

    it('should verify a valid API key', async () => {
      const { key } = await createApiKey('verify-key', 'admin');
      const verified = await verifyApiKey(key);

      expect(verified).toBeDefined();
      expect(verified!.name).toBe('verify-key');
      expect(verified!.role).toBe('admin');
    });

    it('should return null for invalid API key', async () => {
      const verified = await verifyApiKey('drop_invalidkey12345');

      expect(verified).toBeNull();
    });

    it('should create API key with expiration', async () => {
      const { apiKey } = await createApiKey('expiring-key', 'user', 30);

      expect(apiKey.expiresAt).toBeDefined();
      const expiresAt = new Date(apiKey.expiresAt!);
      const expectedDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      expect(Math.abs(expiresAt.getTime() - expectedDate.getTime())).toBeLessThan(5000);
    });

    it('should reject expired API key', async () => {
      // Create a key with -1 days expiration (already expired)
      const { key, apiKey } = await createApiKey('expired-key', 'user', -1);

      // Verify the key has an expiration in the past
      expect(new Date(apiKey.expiresAt!).getTime()).toBeLessThan(Date.now());

      // Key should be rejected
      const verified = await verifyApiKey(key);
      expect(verified).toBeNull();
    });

    it('should delete an API key', async () => {
      const { apiKey } = await createApiKey('delete-key', 'user');
      const deleted = await deleteApiKey(apiKey.id);

      expect(deleted).toBe(true);

      // Verify it's gone
      const keys = listApiKeys();
      expect(keys.find(k => k.id === apiKey.id)).toBeUndefined();
    });

    it('should return false when deleting non-existent key', async () => {
      const deleted = await deleteApiKey('non-existent-id');
      expect(deleted).toBe(false);
    });

    it('should list API keys without revealing hashes', async () => {
      await createApiKey('list-key-1', 'user');
      await createApiKey('list-key-2', 'admin');

      const keys = listApiKeys();
      expect(keys.length).toBe(2);
      keys.forEach(key => {
        expect(key).not.toHaveProperty('keyHash');
      });
    });
  });

  describe('listUsers', () => {
    beforeEach(async () => {
      jest.spyOn(console, 'log').mockImplementation();
      await initializeAuth({
        credentialsPath,
        enableJwt: true,
        enableApiKeys: true,
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should list users without revealing password hashes', async () => {
      await createUser('user1', 'password1', 'user');
      await createUser('user2', 'password2', 'admin');

      const users = listUsers();
      // Admin user + 2 created users
      expect(users.length).toBeGreaterThanOrEqual(2);
      users.forEach(user => {
        expect(user).not.toHaveProperty('passwordHash');
      });
    });
  });

  describe('isAuthEnabled', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should return true when JWT is enabled', async () => {
      jest.spyOn(console, 'log').mockImplementation();
      await initializeAuth({
        credentialsPath,
        enableJwt: true,
        enableApiKeys: false,
      });

      expect(isAuthEnabled()).toBe(true);
    });

    it('should return true when API keys are enabled', async () => {
      jest.spyOn(console, 'log').mockImplementation();
      await initializeAuth({
        credentialsPath,
        enableJwt: false,
        enableApiKeys: true,
      });

      expect(isAuthEnabled()).toBe(true);
    });
  });

  describe('authMiddleware', () => {
    let validToken: string;
    let validApiKey: string;

    beforeEach(async () => {
      jest.spyOn(console, 'log').mockImplementation();
      resetAuth();
      await initializeAuth({
        credentialsPath,
        enableJwt: true,
        enableApiKeys: true,
      });
      await createUser('testuser', 'password123', 'user');
      validToken = await getTestToken('testuser', 'password123');
      const { key } = await createApiKey('test-api-key', 'admin');
      validApiKey = key;
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    function createMockContext(headers: Record<string, string> = {}, path = '/api/v1/apps', method = 'GET'): {
      c: { req: { header: (name: string) => string | undefined; path: string; method: string }; json: jest.Mock; set: jest.Mock };
      next: jest.Mock;
    } {
      return {
        c: {
          req: {
            header: (name: string) => headers[name],
            path,
            method,
          },
          json: jest.fn().mockReturnValue({ status: 401 } as Response),
          set: jest.fn(),
        },
        next: jest.fn().mockResolvedValue(undefined),
      };
    }

    it('should authenticate with valid JWT token', async () => {
      const { c, next } = createMockContext({
        Authorization: `Bearer ${validToken}`,
      });

      const middleware = authMiddleware();
      await middleware(c as never, next);

      expect(next).toHaveBeenCalled();
      expect(c.set).toHaveBeenCalledWith('auth', expect.objectContaining({
        username: 'testuser',
        authMethod: 'jwt',
      }));
    });

    it('should authenticate with valid API key', async () => {
      const { c, next } = createMockContext({
        'X-API-Key': validApiKey,
      });

      const middleware = authMiddleware();
      await middleware(c as never, next);

      expect(next).toHaveBeenCalled();
      expect(c.set).toHaveBeenCalledWith('auth', expect.objectContaining({
        authMethod: 'apikey',
      }));
    });

    it('should reject request without authentication', async () => {
      const { c, next } = createMockContext({});

      const middleware = authMiddleware();
      await middleware(c as never, next);

      expect(next).not.toHaveBeenCalled();
      expect(c.json).toHaveBeenCalled();
    });

    it('should reject invalid JWT token', async () => {
      const { c, next } = createMockContext({
        Authorization: 'Bearer invalid.token.here',
      });

      const middleware = authMiddleware();
      await middleware(c as never, next);

      expect(next).not.toHaveBeenCalled();
    });

    it('should check role hierarchy', async () => {
      // User with 'user' role trying to access admin endpoint
      const { c, next } = createMockContext({
        Authorization: `Bearer ${validToken}`,
      });

      const middleware = authMiddleware('admin');
      await middleware(c as never, next);

      // Should be rejected due to insufficient role
      expect(next).not.toHaveBeenCalled();
    });

    it('should allow higher role to access lower role endpoint', async () => {
      // Admin API key accessing user endpoint
      const { c, next } = createMockContext({
        'X-API-Key': validApiKey,
      });

      const middleware = authMiddleware('user');
      await middleware(c as never, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('optionalAuthMiddleware', () => {
    let validToken: string;

    beforeEach(async () => {
      jest.spyOn(console, 'log').mockImplementation();
      resetAuth();
      await initializeAuth({
        credentialsPath,
        enableJwt: true,
        enableApiKeys: true,
      });
      await createUser('testuser', 'password123', 'user');
      validToken = await getTestToken('testuser', 'password123');
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    function createMockContext(headers: Record<string, string> = {}): {
      c: { req: { header: (name: string) => string | undefined }; set: jest.Mock; get: jest.Mock };
      next: jest.Mock;
    } {
      let authValue: unknown = undefined;
      return {
        c: {
          req: {
            header: (name: string) => headers[name],
          },
          set: jest.fn((key: string, value: unknown) => {
            if (key === 'auth') authValue = value;
          }),
          get: jest.fn((key: string) => key === 'auth' ? authValue : undefined),
        },
        next: jest.fn().mockResolvedValue(undefined),
      };
    }

    it('should parse auth if present', async () => {
      const { c, next } = createMockContext({
        Authorization: `Bearer ${validToken}`,
      });

      const middleware = optionalAuthMiddleware();
      await middleware(c as never, next);

      expect(next).toHaveBeenCalled();
      expect(c.set).toHaveBeenCalledWith('auth', expect.objectContaining({
        username: 'testuser',
      }));
    });

    it('should continue without auth if not present', async () => {
      const { c, next } = createMockContext({});

      const middleware = optionalAuthMiddleware();
      await middleware(c as never, next);

      expect(next).toHaveBeenCalled();
      expect(c.set).not.toHaveBeenCalled();
    });
  });
});
