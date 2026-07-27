/**
 * Stable principal identity (Step 6a).
 *
 * `principalId` answers "who do I rate-limit and attribute against", which is
 * NOT the same question as `userId`'s "who owns this". They diverge on the
 * OAuth path, where one human can hold many concurrent agent sessions.
 *
 * The property these tests exist for: **a refresh must not change the
 * principal.** Access tokens live 15 minutes and rotate on every use, so
 * keying on the token (`jti`) would reset the principal roughly four times an
 * hour — resetting quotas, accreting a store row per minted token, and
 * fragmenting the audit trail into unjoinable slices, all with no attacker
 * effort.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Hono } from 'hono';
import {
  initializeAuth,
  authMiddleware,
  suspendUser,
  deleteUser,
  AuthContext,
  resetAuth,
  createUser,
  createApiKey,
  mintOAuthAccessToken,
  verifyOAuthAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  getUserById,
} from './auth';

const AUD = 'https://drop.example.com/api/v1/mcp';

describe('principalId', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-principal-'));
    resetAuth();
    await initializeAuth({
      credentialsPath: path.join(tempDir, 'credentials.json'),
      enableJwt: true,
      enableApiKeys: true,
    });
  });

  afterEach(async () => {
    resetAuth();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('oauth', () => {
    it('SURVIVES a refresh — the whole point of the sid', async () => {
      // The defect this prevents: with a per-token principal, one refresh
      // resets the quota. An agent could double its allowance by refreshing.
      const user = await createUser('alice', 'password123', 'user');

      const sid = 'grant-sid-1';
      const first = await mintOAuthAccessToken(user, AUD, sid);
      const refreshToken = await issueRefreshToken(user.id, 'client-1', sid);

      const rotated = await rotateRefreshToken(refreshToken);
      expect(rotated).not.toBeNull();
      const second = await mintOAuthAccessToken(user, AUD, rotated!.sid);

      const before = await verifyOAuthAccessToken(first, AUD);
      const after = await verifyOAuthAccessToken(second, AUD);

      expect(before?.principalId).toBe(`oauth:${user.id}::${sid}`);
      expect(after?.principalId).toBe(before?.principalId);
    });

    it('survives REPEATED refreshes, not just the first', async () => {
      // A carry that works once but re-mints on the second rotation would pass
      // the test above and still reset hourly in practice.
      const user = await createUser('alice', 'password123', 'user');
      const sid = 'grant-sid-2';
      let token = await issueRefreshToken(user.id, 'client-1', sid);

      for (let i = 0; i < 4; i++) {
        const rotated = await rotateRefreshToken(token);
        expect(rotated!.sid).toBe(sid);
        token = rotated!.refreshToken;
      }
    });

    it('separates two concurrent sessions for the SAME user', async () => {
      // Ownership is shared; metering is not. Two agent sessions must not be
      // able to spend each other's budget.
      const user = await createUser('alice', 'password123', 'user');

      const a = await verifyOAuthAccessToken(await mintOAuthAccessToken(user, AUD, 'sid-a'), AUD);
      const b = await verifyOAuthAccessToken(await mintOAuthAccessToken(user, AUD, 'sid-b'), AUD);

      expect(a?.userId).toBe(b?.userId); // same owner
      expect(a?.principalId).not.toBe(b?.principalId); // different principals
    });

    it('degrades to the coarse principal for a token minted before sid existed', async () => {
      // Never wrong, just coarse. The GRANT self-heals on its next rotation
      // (see 'legacy grants' below); this covers the already-minted token.
      const user = await createUser('alice', 'password123', 'user');

      const ctx = await verifyOAuthAccessToken(await mintOAuthAccessToken(user, AUD), AUD);

      expect(ctx?.principalId).toBe(`oauth:${user.id}`);
    });
  });

  describe('api keys', () => {
    // Driven through authMiddleware with an X-API-Key header, the way
    // auth.apikey-owner.test.ts does — apiKeyAuthContext is not exported, and
    // asserting on verifyApiKey's ApiKey return would test nothing about the
    // AuthContext this is all about.
    const contextFor = async (rawKey: string): Promise<AuthContext> => {
      let seen: AuthContext | undefined;
      const app = new Hono();
      app.use('/probe', authMiddleware());
      app.get('/probe', (c) => {
        seen = (c.get as (k: string) => AuthContext)('auth');
        return c.json({ ok: true });
      });
      await app.request('/probe', { headers: { 'X-API-Key': rawKey } });
      return seen as AuthContext;
    };

    it('meters per KEY while ownership stays with the OWNER', async () => {
      // Both halves matter and they pull in opposite directions. Two keys for
      // one human must be metered apart (principalId), yet both must still
      // resolve to that human for access checks (userId) — DROP-075's fix.
      const owner = await createUser('bob', 'password123', 'user');
      const one = await createApiKey('ci-a', 'user', undefined, undefined, owner.id);
      const two = await createApiKey('ci-b', 'user', undefined, undefined, owner.id);

      const ctxOne = await contextFor(one.key);
      const ctxTwo = await contextFor(two.key);

      // Metered apart.
      expect(ctxOne.principalId).toBe(`key:${one.apiKey.id}`);
      expect(ctxOne.principalId).not.toBe(ctxTwo.principalId);
      // Owned together — principalId must NOT have become what canAccess reads.
      expect(ctxOne.userId).toBe(owner.id);
      expect(ctxTwo.userId).toBe(owner.id);
    });
  });

  describe('namespacing', () => {
    it('does not alias a JWT session with an OAuth grant for the same user', async () => {
      // Unprefixed, `jwt -> sub` and a sid-less `oauth -> userId` are the SAME
      // string — so a runaway agent session would trip the circuit breaker on
      // the human's own dashboard deploys and spend their quota.
      const user = await createUser('dave', 'password123', 'user');
      const oauthCtx = await verifyOAuthAccessToken(await mintOAuthAccessToken(user, AUD), AUD);

      expect(oauthCtx?.principalId).not.toBe(`jwt:${user.id}`);
      expect(oauthCtx?.principalId).toBe(`oauth:${user.id}`);
    });
  });

  describe('revocation', () => {
    it('kills an OAuth grant when the user is SUSPENDED', async () => {
      // Suspension blocked login and purged API keys, but every outstanding
      // refresh token kept minting fresh 15-minute access tokens forever:
      // refresh records carry no expiry and the refresh path never checked
      // `enabled`. revokeAllRefreshTokensForUser existed for exactly this and
      // had no caller anywhere.
      const user = await createUser('eve', 'password123', 'user');
      const refreshToken = await issueRefreshToken(user.id, 'client-1', 'sid-e');

      await suspendUser(user.id);

      expect(await rotateRefreshToken(refreshToken)).toBeNull();
    });

    it('kills an OAuth grant when the user is DELETED', async () => {
      const admin = await createUser('root', 'password123', 'admin');
      const user = await createUser('frank', 'password123', 'user');
      const refreshToken = await issueRefreshToken(user.id, 'client-1', 'sid-f');

      await deleteUser(user.id);

      expect(await rotateRefreshToken(refreshToken)).toBeNull();
      expect(admin.id).toBeDefined();
    });
  });

  describe('access-token denylist (6e)', () => {
    // Revoking a refresh token or disabling a user stops NEW access tokens
    // being minted. It does nothing about one already in the wild, and those
    // live 15 minutes — so "revoked" meant "revoked within a quarter of an
    // hour", which is exactly the window an incident happens in.

    it('kills a LIVE access token when its grant is revoked', async () => {
      const user = await createUser('ivan', 'password123', 'user');
      const sid = 'sid-live-1';
      const token = await mintOAuthAccessToken(user, AUD, sid);
      const refreshToken = await issueRefreshToken(user.id, 'client-1', sid);

      // Valid right up until the revocation.
      expect(await verifyOAuthAccessToken(token, AUD)).not.toBeNull();

      await revokeRefreshToken(refreshToken);

      expect(await verifyOAuthAccessToken(token, AUD)).toBeNull();
    });

    it('kills a LIVE access token when the user is suspended', async () => {
      const user = await createUser('judy', 'password123', 'user');
      const token = await mintOAuthAccessToken(user, AUD, 'sid-live-2');
      expect(await verifyOAuthAccessToken(token, AUD)).not.toBeNull();

      await suspendUser(user.id);

      expect(await verifyOAuthAccessToken(token, AUD)).toBeNull();
    });

    it('kills EVERY grant of a suspended user, not just one', async () => {
      // Denying by user has to cover sessions the revoker never saw.
      const user = await createUser('karl', 'password123', 'user');
      const a = await mintOAuthAccessToken(user, AUD, 'sid-a');
      const b = await mintOAuthAccessToken(user, AUD, 'sid-b');

      await suspendUser(user.id);

      expect(await verifyOAuthAccessToken(a, AUD)).toBeNull();
      expect(await verifyOAuthAccessToken(b, AUD)).toBeNull();
    });

    it('does not touch a DIFFERENT user or a different grant', async () => {
      // A denylist that over-matches is an outage, not a fix.
      const victim = await createUser('mallory', 'password123', 'user');
      const bystander = await createUser('trent', 'password123', 'user');
      const bystanderToken = await mintOAuthAccessToken(bystander, AUD, 'sid-ok');
      const otherGrant = await mintOAuthAccessToken(bystander, AUD, 'sid-other');

      await suspendUser(victim.id);

      expect(await verifyOAuthAccessToken(bystanderToken, AUD)).not.toBeNull();
      expect(await verifyOAuthAccessToken(otherGrant, AUD)).not.toBeNull();
    });

    it('denies only the revoked grant, leaving the user other sessions alive', async () => {
      // Revoking one refresh token must not log the human out everywhere.
      const user = await createUser('nina', 'password123', 'user');
      const doomedSid = 'sid-doomed';
      const keptSid = 'sid-kept';
      const doomed = await mintOAuthAccessToken(user, AUD, doomedSid);
      const kept = await mintOAuthAccessToken(user, AUD, keptSid);
      const refreshToken = await issueRefreshToken(user.id, 'client-1', doomedSid);

      await revokeRefreshToken(refreshToken);

      expect(await verifyOAuthAccessToken(doomed, AUD)).toBeNull();
      expect(await verifyOAuthAccessToken(kept, AUD)).not.toBeNull();
    });
  });

  describe('legacy grants', () => {
    it('self-heals a sid-less grant on its first rotation', async () => {
      // `...(sid ? {sid} : {})` carried `undefined` through UNLIMITED
      // rotations, so a pre-upgrade grant would never heal and its principal
      // would stay permanently coarse — not "ages out in 15 minutes", as an
      // earlier version of this comment claimed.
      const user = await createUser('grace', 'password123', 'user');
      const refreshToken = await issueRefreshToken(user.id, 'client-1');

      const rotated = await rotateRefreshToken(refreshToken);

      expect(rotated?.sid).toEqual(expect.any(String));
      expect(rotated?.sid).not.toHaveLength(0);
    });

    it('then keeps that healed sid stable across later rotations', async () => {
      const user = await createUser('heidi', 'password123', 'user');
      let token = await issueRefreshToken(user.id, 'client-1');

      const first = await rotateRefreshToken(token);
      token = first!.refreshToken;
      const second = await rotateRefreshToken(token);

      expect(second?.sid).toBe(first?.sid);
    });
  });

  describe('ownership is unaffected', () => {
    it('keeps userId as the OWNER on every path', async () => {
      // principalId must not have quietly become the thing canAccess reads —
      // that would make one agent session unable to see its own user's apps.
      const user = await createUser('carol', 'password123', 'user');
      const ctx = await verifyOAuthAccessToken(
        await mintOAuthAccessToken(user, AUD, 'sid-x'),
        AUD
      );

      expect(ctx?.userId).toBe(user.id);
      expect(getUserById(user.id)?.username).toBe('carol');
    });
  });
});
