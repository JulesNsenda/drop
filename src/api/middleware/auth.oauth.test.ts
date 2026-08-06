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
  MAX_REFRESH_TOKENS_PER_USER,
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

  // Item 6 (DROP-131): per-user cap, evicting oldest-first.
  describe('per-user cap on refresh-token records', () => {
    async function readStoredRefreshTokens(): Promise<Array<{ userId: string; clientId: string }>> {
      const raw = JSON.parse(await fs.readFile(credentialsPath, 'utf-8')) as {
        refreshTokens?: Array<{ userId: string; clientId: string }>;
      };
      return raw.refreshTokens ?? [];
    }

    it('keeps exactly the cap for one user and drops the OLDEST records first', async () => {
      const user = await createUser('capuser', 'password123', 'user');
      const overflow = 5;

      for (let i = 0; i < MAX_REFRESH_TOKENS_PER_USER + overflow; i++) {
        // clientId doubles as a label so survivors are identifiable below.
        await issueRefreshToken(user.id, `client-${i}`);
      }

      const stored = await readStoredRefreshTokens();
      const userRecords = stored.filter((r) => r.userId === user.id);
      expect(userRecords).toHaveLength(MAX_REFRESH_TOKENS_PER_USER);

      // The survivors are the LAST MAX_REFRESH_TOKENS_PER_USER issued —
      // client-{overflow}..client-{overflow + cap - 1} — never the first ones.
      const survivorIds = userRecords.map((r) => r.clientId).sort();
      const expectedIds = Array.from(
        { length: MAX_REFRESH_TOKENS_PER_USER },
        (_, i) => `client-${i + overflow}`
      ).sort();
      expect(survivorIds).toEqual(expectedIds);
    });

    it("never evicts another user's records when one user hits the cap", async () => {
      const userA = await createUser('capuserA', 'password123', 'user');
      const userB = await createUser('capuserB', 'password123', 'user');
      const tokenB = await issueRefreshToken(userB.id, 'client-b');

      for (let i = 0; i < MAX_REFRESH_TOKENS_PER_USER + 3; i++) {
        await issueRefreshToken(userA.id, `client-a-${i}`);
      }

      const stored = await readStoredRefreshTokens();
      expect(stored.filter((r) => r.userId === userA.id)).toHaveLength(MAX_REFRESH_TOKENS_PER_USER);
      expect(stored.filter((r) => r.userId === userB.id)).toHaveLength(1);

      // userB's own (untouched) grant still rotates fine.
      const rotated = await rotateRefreshToken(tokenB);
      expect(rotated).not.toBeNull();
    });

    it('lets a user AT the cap rotate repeatedly without ever losing their grant', async () => {
      const user = await createUser('capuserC', 'password123', 'user');
      // The token under test is the FIRST (oldest) one issued — the exact
      // record eviction would reach for if it ran on the un-spliced array,
      // since the rest of the loop below issues nine newer siblings that
      // push this user to the cap.
      let current = '';
      for (let i = 0; i < MAX_REFRESH_TOKENS_PER_USER; i++) {
        const issued = await issueRefreshToken(user.id, `client-c-${i}`);
        if (i === 0) current = issued;
      }
      // user now holds exactly MAX_REFRESH_TOKENS_PER_USER records — at the cap.

      for (let i = 0; i < 5; i++) {
        const rotated = await rotateRefreshToken(current);
        expect(rotated).not.toBeNull();
        current = rotated!.refreshToken;

        const stored = await readStoredRefreshTokens();
        expect(stored.filter((r) => r.userId === user.id)).toHaveLength(MAX_REFRESH_TOKENS_PER_USER);
      }

      // The token from the last rotation is still a live, working grant.
      const finalRotation = await rotateRefreshToken(current);
      expect(finalRotation).not.toBeNull();
    });
  });
});
