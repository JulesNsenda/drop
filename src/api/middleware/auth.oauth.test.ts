/**
 * OAuth 2.1 token machinery tests (PRD-041, unit C: mint/verify + refresh
 * tokens + the general-API rejection gate).
 *
 * The `jose` mock used under Jest (`src/__mocks__/jose.ts`) ignores the
 * signing secret entirely — it only checks a fixed "mock-signature" and
 * `exp`. Real crypto key-isolation between `jwtSecret` and `oauthTokenSecret`
 * is therefore NOT exercised here; these tests instead pin the *testable*
 * guarantee — the claim-based gates (`token_use`, `aud`) — per
 * docs/plans/2026-07-10-mcp-oauth.md ("jose mock can't prove crypto key
 * isolation").
 */

import { Hono } from 'hono';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as jose from 'jose';
import {
  initializeAuth,
  resetAuth,
  createUser,
  mintOAuthAccessToken,
  verifyOAuthAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  authMiddleware,
  AuthContext,
} from './auth';

const AUDIENCE = 'https://drop.example.com/api/v1/mcp';

describe('OAuth access tokens (PRD-041)', () => {
  let tempDir: string;
  let credentialsPath: string;

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-auth-oauth-test-'));
    credentialsPath = path.join(tempDir, 'credentials.json');
    resetAuth();
    await initializeAuth({ credentialsPath, enableJwt: true, enableApiKeys: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('verifyOAuthAccessToken', () => {
    it('accepts a token minted with the matching audience', async () => {
      const user = await createUser('mcpuser', 'password123', 'user');
      const token = await mintOAuthAccessToken(user, AUDIENCE);

      const ctx = await verifyOAuthAccessToken(token, AUDIENCE);

      expect(ctx).not.toBeNull();
      expect(ctx?.userId).toBe(user.id);
      expect(ctx?.username).toBe('mcpuser');
      expect(ctx?.role).toBe('user');
      expect(ctx?.authMethod).toBe('oauth');
    });

    it('returns null for a wrong audience', async () => {
      const user = await createUser('mcpuser2', 'password123', 'user');
      const token = await mintOAuthAccessToken(user, AUDIENCE);

      const ctx = await verifyOAuthAccessToken(token, 'https://drop.example.com/api/v1/mcp-other');

      expect(ctx).toBeNull();
    });

    it('returns null when token_use is absent (e.g. a session-JWT-shaped token)', async () => {
      const user = await createUser('mcpuser3', 'password123', 'user');
      // Same audience claim, but no token_use — must still be rejected.
      const bogus = await new jose.SignJWT({
        sub: user.id,
        username: user.username,
        role: user.role,
        aud: AUDIENCE,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('15m')
        .sign(new TextEncoder().encode('irrelevant-under-jose-mock'));

      const ctx = await verifyOAuthAccessToken(bogus, AUDIENCE);

      expect(ctx).toBeNull();
    });

    it('returns null when token_use carries some other value', async () => {
      const user = await createUser('mcpuser4', 'password123', 'user');
      const bogus = await new jose.SignJWT({
        sub: user.id,
        username: user.username,
        role: user.role,
        token_use: 'something_else',
        aud: AUDIENCE,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('15m')
        .sign(new TextEncoder().encode('irrelevant-under-jose-mock'));

      const ctx = await verifyOAuthAccessToken(bogus, AUDIENCE);

      expect(ctx).toBeNull();
    });
  });

  describe('general authMiddleware rejects OAuth access tokens', () => {
    type TestEnv = { Variables: { auth: AuthContext } };

    function buildApp(): Hono<TestEnv> {
      const app = new Hono<TestEnv>();
      app.get('/apps', authMiddleware(), (c) => c.json({ ok: true }));
      return app;
    }

    it('401s an oauth_access token presented as a general-API Bearer token', async () => {
      const app = buildApp();
      const user = await createUser('mcpuser5', 'password123', 'user');
      const token = await mintOAuthAccessToken(user, AUDIENCE);

      const res = await app.request('/apps', { headers: { Authorization: `Bearer ${token}` } });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: { message: string } };
      expect(body.error?.message).toMatch(/oauth access tokens/i);
    });
  });
});

describe('OAuth refresh tokens (PRD-041)', () => {
  let tempDir: string;
  let credentialsPath: string;

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-auth-refresh-test-'));
    credentialsPath = path.join(tempDir, 'credentials.json');
    resetAuth();
    await initializeAuth({ credentialsPath, enableJwt: true, enableApiKeys: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('issue -> rotate returns a new token and invalidates the old one', async () => {
    const user = await createUser('refreshuser', 'password123', 'user');
    const original = await issueRefreshToken(user.id, 'drop-mcp-client');

    const rotated = await rotateRefreshToken(original);
    expect(rotated).not.toBeNull();
    expect(rotated?.userId).toBe(user.id);
    expect(rotated?.clientId).toBe('drop-mcp-client');
    expect(rotated?.refreshToken).not.toBe(original);

    // The old (already-rotated) token must not work a second time.
    const secondAttempt = await rotateRefreshToken(original);
    expect(secondAttempt).toBeNull();

    // The newly rotated token should itself still be usable (rotation chain).
    const rotatedAgain = await rotateRefreshToken(rotated!.refreshToken);
    expect(rotatedAgain).not.toBeNull();
  });

  it('revokeRefreshToken invalidates a token', async () => {
    const user = await createUser('revokeuser', 'password123', 'user');
    const token = await issueRefreshToken(user.id, 'drop-mcp-client');

    const revoked = await revokeRefreshToken(token);
    expect(revoked).toBe(true);

    const rotateAfterRevoke = await rotateRefreshToken(token);
    expect(rotateAfterRevoke).toBeNull();

    // Revoking an unknown/already-revoked token returns false, not a throw.
    const revokedAgain = await revokeRefreshToken(token);
    expect(revokedAgain).toBe(false);
  });

  it('rotating an unknown refresh token returns null', async () => {
    const result = await rotateRefreshToken('this-token-was-never-issued');
    expect(result).toBeNull();
  });
});
