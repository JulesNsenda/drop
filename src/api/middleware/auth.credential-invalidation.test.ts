/**
 * `credentialsInvalidBefore` — the one stamp `suspendUser` (reversible
 * suspension) and `resetUserPassword` (forced-reset containment) both rely
 * on (DROP-130 Items 4 & 5).
 *
 * Before this, `suspendUser` hard-deleted `apiKeys`/`refreshTokens`, which is
 * exactly wrong at re-enable: `POST /admin/users/:id/unsuspend` only flips
 * `enabled` back to true, so every key/token/grant live AT suspension time
 * would resurrect verbatim — handing back precisely what containment was
 * for. `resetUserPassword`'s `mustChangePassword` flag never reached
 * anything but JWT sessions at all, so a forced reset never touched a CI key
 * or agent token.
 *
 * These tests pin the stamp itself: it must kill a pre-existing credential
 * and MUST NOT be undone by re-enabling the account or changing the
 * password, while a credential minted after the stamp must work normally —
 * including for a still-onboarding account, which never sets the stamp at
 * all.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Hono } from 'hono';
import {
  initializeAuth,
  resetAuth,
  createUser,
  createApiKey,
  verifyApiKey,
  listApiKeys,
  suspendUser,
  updateUser,
  resetUserPassword,
  changePassword,
  authenticateUser,
  issueRefreshToken,
  rotateRefreshToken,
  mintOAuthAccessToken,
  verifyOAuthAccessToken,
  mintAppMcpAccessToken,
  verifyAppMcpAccessToken,
  authMiddleware,
  AuthContext,
} from './auth';

const PASSWORD = 'pw-bob-123456';
const AUD = 'https://drop.example.com/api/v1/mcp';

/** Read the raw credentials file as loosely-typed JSON, for corrupting a record by hand. */
async function readRawStore(credentialsPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(credentialsPath, 'utf-8'));
}

async function writeRawStore(credentialsPath: string, store: Record<string, unknown>): Promise<void> {
  await fs.writeFile(credentialsPath, JSON.stringify(store));
}

/**
 * A JWT `iat` truncates to whole SECONDS, while `credentialsInvalidBefore` is
 * millisecond-precision ISO. Minting a token in the same wall-clock second as
 * the stamp can floor `iat` to a moment before the stamp even though the mint
 * happened after it — `predatesInvalidationStamp` then (correctly, per its
 * own fail-closed contract) treats it as predating. Real granularity limit,
 * not test flakiness — see the docstring on `predatesInvalidationStamp`. Only
 * a test that mints "after" a stamp set moments earlier needs this; sleep
 * past the second boundary rather than loosening the production comparison.
 */
async function waitPastSecondBoundary(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1100));
}

describe('credentialsInvalidBefore (DROP-130 Items 4 & 5)', () => {
  let tmpDir: string;
  let credentialsPath: string;

  type TestEnv = { Variables: { auth: AuthContext } };

  /** Drive authMiddleware with a fake X-API-Key request, capture the AuthContext (or status) it produces. */
  const probeWithKey = async (
    key: string
  ): Promise<{ status: number; auth: AuthContext | undefined }> => {
    let seen: AuthContext | undefined;
    const app = new Hono<TestEnv>();
    app.use('/probe', authMiddleware());
    app.get('/probe', (c) => {
      seen = c.get('auth');
      return c.json({ ok: true });
    });
    const res = await app.request('/probe', { headers: { 'X-API-Key': key } });
    return { status: res.status, auth: seen };
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-cred-invalidation-'));
    credentialsPath = path.join(tmpDir, 'api-credentials.json');
    await initializeAuth({ credentialsPath, enableJwt: true, enableApiKeys: true });
  });

  afterEach(async () => {
    resetAuth();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('verifyApiKey', () => {
    it('fails CLOSED when the stored key record has no createdAt at all', async () => {
      const bob = await createUser('bob-key-nocreated', PASSWORD, 'user');
      await suspendUser(bob.id);
      await updateUser(bob.id, { enabled: true });
      // Minted AFTER re-enable — would authenticate fine if createdAt were trusted.
      const { key } = await createApiKey('bob-key-nocreated-ci', 'user', undefined, undefined, bob.id);

      const store = await readRawStore(credentialsPath);
      const keys = store.apiKeys as Array<Record<string, unknown>>;
      const rec = keys.find((k) => k.name === 'bob-key-nocreated-ci');
      expect(rec).toBeDefined();
      delete (rec as Record<string, unknown>).createdAt;
      await writeRawStore(credentialsPath, store);

      resetAuth();
      await initializeAuth({ credentialsPath, enableJwt: true, enableApiKeys: true });

      expect(await verifyApiKey(key)).toBeNull();
    });

    it('fails CLOSED when the stored key record has an unparseable createdAt', async () => {
      const bob = await createUser('bob-key-badcreated', PASSWORD, 'user');
      await suspendUser(bob.id);
      await updateUser(bob.id, { enabled: true });
      const { key } = await createApiKey('bob-key-badcreated-ci', 'user', undefined, undefined, bob.id);

      const store = await readRawStore(credentialsPath);
      const keys = store.apiKeys as Array<Record<string, unknown>>;
      const rec = keys.find((k) => k.name === 'bob-key-badcreated-ci');
      expect(rec).toBeDefined();
      (rec as Record<string, unknown>).createdAt = 'not-a-date';
      await writeRawStore(credentialsPath, store);

      resetAuth();
      await initializeAuth({ credentialsPath, enableJwt: true, enableApiKeys: true });

      expect(await verifyApiKey(key)).toBeNull();
    });
  });

  describe('rotateRefreshToken', () => {
    it('rejects a refresh token issued BEFORE suspension, even after re-enable', async () => {
      const bob = await createUser('bob-refresh', PASSWORD, 'user');
      const refreshToken = await issueRefreshToken(bob.id, 'client-1', 'sid-1');

      await suspendUser(bob.id);
      await updateUser(bob.id, { enabled: true });

      expect(await rotateRefreshToken(refreshToken)).toBeNull();
    });

    it('accepts a refresh token issued AFTER re-enable', async () => {
      const bob = await createUser('bob-refresh-2', PASSWORD, 'user');
      await suspendUser(bob.id);
      await updateUser(bob.id, { enabled: true });

      const refreshToken = await issueRefreshToken(bob.id, 'client-1', 'sid-2');

      expect(await rotateRefreshToken(refreshToken)).not.toBeNull();
    });

    it('fails CLOSED when the stored record has no createdAt at all', async () => {
      const bob = await createUser('bob-refresh-3', PASSWORD, 'user');
      await suspendUser(bob.id);
      await updateUser(bob.id, { enabled: true });
      // Minted AFTER re-enable — would authenticate fine if createdAt were trusted.
      const refreshToken = await issueRefreshToken(bob.id, 'client-1', 'sid-3');

      const store = await readRawStore(credentialsPath);
      const records = store.refreshTokens as Array<Record<string, unknown>>;
      expect(records.length).toBeGreaterThan(0);
      delete records[records.length - 1].createdAt;
      await writeRawStore(credentialsPath, store);

      resetAuth();
      await initializeAuth({ credentialsPath, enableJwt: true, enableApiKeys: true });

      expect(await rotateRefreshToken(refreshToken)).toBeNull();
    });
  });

  describe('verifyOAuthAccessToken', () => {
    it('rejects an access token minted BEFORE suspension, for the rest of its lifetime', async () => {
      const bob = await createUser('bob-oauth', PASSWORD, 'user');
      const token = await mintOAuthAccessToken(bob, AUD, 'sid-oauth-1');
      expect(await verifyOAuthAccessToken(token, AUD)).not.toBeNull();

      await suspendUser(bob.id);
      await updateUser(bob.id, { enabled: true });

      expect(await verifyOAuthAccessToken(token, AUD)).toBeNull();
    });

    it('accepts an access token minted AFTER re-enable', async () => {
      const bob = await createUser('bob-oauth-2', PASSWORD, 'user');
      await suspendUser(bob.id);
      await updateUser(bob.id, { enabled: true });
      await waitPastSecondBoundary();

      const token = await mintOAuthAccessToken(bob, AUD, 'sid-oauth-2');

      expect(await verifyOAuthAccessToken(token, AUD)).not.toBeNull();
    }, 10_000);

    it('fails CLOSED when the token carries no iat claim', async () => {
      const bob = await createUser('bob-oauth-3', PASSWORD, 'user');
      await suspendUser(bob.id);
      await updateUser(bob.id, { enabled: true });

      // Hand-crafted to match the `jose` mock's format (header.payload.signature,
      // base64url JSON parts, signature === base64url('mock-signature')) but
      // deliberately omitting `iat` — a structurally valid, signature-verifying
      // token that simply never went through `.setIssuedAt()`.
      const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: bob.id,
          username: bob.username,
          role: bob.role,
          token_use: 'oauth_access',
          aud: AUD,
          sid: 'sid-oauth-3',
        })
      ).toString('base64url');
      const signature = Buffer.from('mock-signature').toString('base64url');
      const noIatToken = `${header}.${payload}.${signature}`;

      expect(await verifyOAuthAccessToken(noIatToken, AUD)).toBeNull();
    });
  });

  describe('verifyAppMcpAccessToken', () => {
    it('rejects an app-mcp token minted BEFORE a forced password reset', async () => {
      const bob = await createUser('bob-appmcp', PASSWORD, 'user');
      const token = await mintAppMcpAccessToken(bob, AUD, 'my-app', 'sid-app-1');
      expect(await verifyAppMcpAccessToken(token, AUD, 'my-app')).not.toBeNull();

      await resetUserPassword(bob.id, 'new-password-123456');

      expect(await verifyAppMcpAccessToken(token, AUD, 'my-app')).toBeNull();
    });

    it('accepts an app-mcp token minted AFTER the reset', async () => {
      const bob = await createUser('bob-appmcp-2', PASSWORD, 'user');
      await resetUserPassword(bob.id, 'new-password-123456');
      await waitPastSecondBoundary();

      const token = await mintAppMcpAccessToken(bob, AUD, 'my-app', 'sid-app-2');

      expect(await verifyAppMcpAccessToken(token, AUD, 'my-app')).not.toBeNull();
    }, 10_000);

    it('rejects an app-mcp token minted BEFORE suspension, even after re-enable — the resurrection case', async () => {
      // Same shape as the rotateRefreshToken/verifyOAuthAccessToken resurrection
      // tests above, for the fourth predatesInvalidationStamp call site: a
      // token live AT suspension time must not come back to life just because
      // the account was later re-enabled.
      const bob = await createUser('bob-appmcp-3', PASSWORD, 'user');
      const token = await mintAppMcpAccessToken(bob, AUD, 'my-app', 'sid-app-3');
      expect(await verifyAppMcpAccessToken(token, AUD, 'my-app')).not.toBeNull();

      await suspendUser(bob.id);
      await updateUser(bob.id, { enabled: true });

      expect(await verifyAppMcpAccessToken(token, AUD, 'my-app')).toBeNull();
    });

    it('accepts an app-mcp token minted AFTER re-enable', async () => {
      const bob = await createUser('bob-appmcp-4', PASSWORD, 'user');
      await suspendUser(bob.id);
      await updateUser(bob.id, { enabled: true });
      await waitPastSecondBoundary();

      const token = await mintAppMcpAccessToken(bob, AUD, 'my-app', 'sid-app-4');

      expect(await verifyAppMcpAccessToken(token, AUD, 'my-app')).not.toBeNull();
    }, 10_000);
  });

  describe('authMiddleware — session JWT (DROP-130 HIGH-3)', () => {
    // Until this item, a 24h session JWT — the credential class most likely
    // to be stolen — was the ONE type exempt from `credentialsInvalidBefore`
    // entirely, making `suspendUser`'s "every credential that already
    // existed stops authenticating" false for it. Same resurrection shape as
    // the verifyApiKey/rotateRefreshToken/verifyOAuthAccessToken/
    // verifyAppMcpAccessToken tests above, for the fifth call site.
    const probeJwt = async (token: string): Promise<{ status: number }> => {
      const app = new Hono<TestEnv>();
      app.get('/probe', authMiddleware(), (c) => c.json({ ok: true }));
      const res = await app.request('/probe', { headers: { Authorization: `Bearer ${token}` } });
      return { status: res.status };
    };

    const loginToken = async (username: string, password: string): Promise<string> => {
      const result = await authenticateUser(username, password);
      if (result.status !== 'ok') throw new Error(`login failed: ${JSON.stringify(result)}`);
      return result.token;
    };

    it('rejects a session JWT issued BEFORE suspension, even after re-enable — the resurrection case', async () => {
      const bob = await createUser('bob-jwt-suspend', PASSWORD, 'user');
      const before = await loginToken('bob-jwt-suspend', PASSWORD);

      await suspendUser(bob.id);
      await updateUser(bob.id, { enabled: true });

      expect((await probeJwt(before)).status).toBe(401);
    });

    it('accepts a session JWT issued AFTER re-enable', async () => {
      const bob = await createUser('bob-jwt-suspend-2', PASSWORD, 'user');
      await suspendUser(bob.id);
      await updateUser(bob.id, { enabled: true });
      await waitPastSecondBoundary();

      const after = await loginToken('bob-jwt-suspend-2', PASSWORD);

      expect((await probeJwt(after)).status).toBe(200);
    }, 10_000);

    it('rejects a session JWT issued BEFORE a forced password reset', async () => {
      const bob = await createUser('bob-jwt-reset-pre', PASSWORD, 'user');
      const before = await loginToken('bob-jwt-reset-pre', PASSWORD);

      await resetUserPassword(bob.id, 'new-password-123456');

      expect((await probeJwt(before)).status).toBe(401);
    });

    it('fails CLOSED when the JWT carries no iat claim', async () => {
      const bob = await createUser('bob-jwt-noiat', PASSWORD, 'user');
      await resetUserPassword(bob.id, 'new-password-123456');

      // Hand-crafted to match the `jose` mock's format (header.payload.signature,
      // base64url JSON parts, signature === base64url('mock-signature')) but
      // deliberately omitting `iat` — a structurally valid, signature-verifying
      // session token that simply never went through `.setIssuedAt()`.
      const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({ sub: bob.id, username: bob.username, role: bob.role })
      ).toString('base64url');
      const signature = Buffer.from('mock-signature').toString('base64url');
      const noIatToken = `${header}.${payload}.${signature}`;

      expect((await probeJwt(noIatToken)).status).toBe(401);
    });
  });

  describe('resetUserPassword — containment, not onboarding', () => {
    it('kills a pre-existing API key (a forced reset must reach non-JWT credentials too)', async () => {
      const bob = await createUser('bob-reset', PASSWORD, 'user');
      const { key } = await createApiKey('bob-reset-ci', 'user', undefined, undefined, bob.id);
      expect(await verifyApiKey(key)).not.toBeNull();

      await resetUserPassword(bob.id, 'new-password-123456');

      expect(await verifyApiKey(key)).toBeNull();
    });

    it('a fresh key minted AFTER the reset authenticates normally — programmatic recovery stays possible', async () => {
      // The exact scenario Item 5 exists to keep working: an admin can still
      // mint/use a CI key for this user without the human first completing
      // the interactive PUT /auth/password flow.
      const bob = await createUser('bob-reset-2', PASSWORD, 'user');
      await resetUserPassword(bob.id, 'new-password-123456');

      const { key } = await createApiKey('bob-reset-2-ci', 'user', undefined, undefined, bob.id);

      expect(await verifyApiKey(key)).not.toBeNull();
    });

    it('onboarding (createUser with mustChangePassword) does NOT stamp credentialsInvalidBefore', async () => {
      // An admin creating an account and immediately minting a key for it
      // (before the human ever logs in) must not find that key DOA — only a
      // CONTAINMENT reset does that, never onboarding.
      const carol = await createUser('carol-onboarding', PASSWORD, 'user', undefined, true);
      expect(carol.mustChangePassword).toBe(true);

      const { key } = await createApiKey('carol-onboarding-ci', 'user', undefined, undefined, carol.id);

      expect(await verifyApiKey(key)).not.toBeNull();
    });

    it('changePassword (self-service) does NOT clear the stamp — a contained credential stays dead', async () => {
      const bob = await createUser('bob-reset-3', PASSWORD, 'user');
      const { key } = await createApiKey('bob-reset-3-ci', 'user', undefined, undefined, bob.id);

      await resetUserPassword(bob.id, 'temp-password-123456');
      expect(await verifyApiKey(key)).toBeNull();

      // Bob completes the forced change — this must not resurrect the key
      // that was live before the reset.
      const changed = await changePassword(bob.id, 'temp-password-123456', 'final-password-123456');
      expect(changed).toBe(true);

      expect(await verifyApiKey(key)).toBeNull();

      const { key: freshKey } = await createApiKey('bob-reset-3-ci-2', 'user', undefined, undefined, bob.id);
      expect(await verifyApiKey(freshKey)).not.toBeNull();
    });
  });

  describe('listApiKeys — DROP-130 MEDIUM-7: killed credentials must not list as live', () => {
    it('flags a key invalidated once it predates the owner\'s containment stamp', async () => {
      const bob = await createUser('bob-listed', PASSWORD, 'user');
      const { apiKey } = await createApiKey('bob-listed-ci', 'user', undefined, undefined, bob.id);

      const before = listApiKeys().find((k) => k.id === apiKey.id);
      expect(before?.invalidated).toBeFalsy();

      await suspendUser(bob.id);

      const after = listApiKeys().find((k) => k.id === apiKey.id);
      expect(after?.invalidated).toBe(true);
    });

    it('does not flag a fresh key minted AFTER the stamp', async () => {
      const bob = await createUser('bob-listed-2', PASSWORD, 'user');
      await suspendUser(bob.id);
      await updateUser(bob.id, { enabled: true });

      const { apiKey } = await createApiKey('bob-listed-2-ci', 'user', undefined, undefined, bob.id);

      const listed = listApiKeys().find((k) => k.id === apiKey.id);
      expect(listed?.invalidated).toBeFalsy();
    });

    it('never flags a legacy ownerless key — there is no owner stamp to compare against', async () => {
      const { apiKey } = await createApiKey('legacy-listed', 'admin');

      const listed = listApiKeys().find((k) => k.id === apiKey.id);
      expect(listed?.invalidated).toBeFalsy();
    });
  });

  describe('authMiddleware — the ownerless-key hazard (Item 5 restructuring)', () => {
    it('an ownerless key keeps authenticating even while an unrelated user carries mustChangePassword + credentialsInvalidBefore', async () => {
      // This is the exact production shape the plan's "CRITICAL" warning
      // names: DROP_API_KEY (every tenant container) and cli-local (the CLI)
      // are BOTH minted ownerless. `authContext.userId` for an ownerless key
      // is the key's OWN id, never a real user id — so an unconditional
      // getUserById(authContext.userId) lookup here must find nothing and
      // must NOT 401.
      const { key: ownerlessKey } = await createApiKey('legacy-ownerless', 'admin');

      // A completely unrelated user is under containment at the same time —
      // proves the ownerless key's fate is not accidentally tied to whatever
      // OTHER user happens to be mid-incident.
      const victim = await createUser('victim-under-reset', PASSWORD, 'user');
      await resetUserPassword(victim.id, 'new-password-123456');

      const { status, auth } = await probeWithKey(ownerlessKey);

      expect(status).toBe(200);
      expect(auth?.role).toBe('admin');
      expect(auth?.authMethod).toBe('apikey');
    });

    it('an OWNED key minted AFTER a forced reset authenticates through authMiddleware, even though its owner still carries mustChangePassword', async () => {
      // The "no programmatic recovery" bug Item 5 exists to prevent, exercised
      // through the REAL authMiddleware code path (not verifyApiKey directly):
      // if the mustChangePassword 403 generalized to reach owned keys, this
      // key would 403 forever — the owner's mustChangePassword flag only
      // clears on an interactive PUT /auth/password, which a key can never do
      // on its owner's behalf.
      const bob = await createUser('bob-owned-key-post-reset', PASSWORD, 'user');
      await resetUserPassword(bob.id, 'new-password-123456');
      const { key } = await createApiKey('bob-owned-key-post-reset-ci', 'user', undefined, undefined, bob.id);

      const { status, auth } = await probeWithKey(key);

      expect(status).toBe(200);
      expect(auth?.userId).toBe(bob.id);
    });
  });

  describe('authMiddleware — mustChangePassword gate stays JWT-only', () => {
    /** Drive authMiddleware with a Bearer JWT against a small route set. */
    const probeJwt = async (
      token: string,
      opts: { method?: string; path?: string } = {}
    ): Promise<{ status: number }> => {
      const { method = 'GET', path = '/probe' } = opts;
      const app = new Hono<TestEnv>();
      app.use('*', authMiddleware());
      app.get('/probe', (c) => c.json({ ok: true }));
      app.put('/auth/password', (c) => c.json({ ok: true }));
      app.get('/auth/me', (c) => c.json({ ok: true }));
      const res = await app.request(path, { method, headers: { Authorization: `Bearer ${token}` } });
      return { status: res.status };
    };

    const loginToken = async (username: string, password: string): Promise<string> => {
      const result = await authenticateUser(username, password);
      if (result.status !== 'ok') throw new Error(`login failed: ${JSON.stringify(result)}`);
      return result.token;
    };

    it('403s a non-exempt route for a JWT session whose user must change their password', async () => {
      await createUser('dave-mustchange-1', PASSWORD, 'user', undefined, true);
      const token = await loginToken('dave-mustchange-1', PASSWORD);

      expect((await probeJwt(token)).status).toBe(403);
    });

    it('exempts PUT /auth/password and GET /auth/me from the gate', async () => {
      await createUser('dave-mustchange-2', PASSWORD, 'user', undefined, true);
      const token = await loginToken('dave-mustchange-2', PASSWORD);

      expect((await probeJwt(token, { method: 'PUT', path: '/auth/password' })).status).toBe(200);
      expect((await probeJwt(token, { method: 'GET', path: '/auth/me' })).status).toBe(200);
    });

    it('does not 403 once mustChangePassword is false (normal onboarded/self-signed-up session)', async () => {
      await createUser('dave-mustchange-3', PASSWORD, 'user');
      const token = await loginToken('dave-mustchange-3', PASSWORD);

      expect((await probeJwt(token)).status).toBe(200);
    });

    it('DROP-130 HIGH-3: 401s (not 403) a JWT re-issued within the same wall-clock second as a reset', async () => {
      // `resetUserPassword`'s stamp is millisecond-precision ISO; a JWT
      // `iat` truncates to whole SECONDS. A login that happens (as this one
      // does, synchronously, right after the reset) within the same second
      // floors to a moment at-or-before the stamp, so HIGH-3's check — which
      // runs BEFORE the mustChangePassword gate — correctly rejects it as
      // predating. This used to be the "403s a JWT session after
      // resetUserPassword" test; 401 is the right answer once the stamp
      // check exists, per `predatesInvalidationStamp`'s fail-closed contract
      // and `waitPastSecondBoundary`'s documented granularity limit (not
      // test flakiness — see its docstring above).
      const bob = await createUser('bob-jwt-reset', PASSWORD, 'user');
      const before = await loginToken('bob-jwt-reset', PASSWORD);
      expect((await probeJwt(before)).status).toBe(200);

      await resetUserPassword(bob.id, 'new-password-123456');
      const after = await loginToken('bob-jwt-reset', 'new-password-123456');

      expect((await probeJwt(after)).status).toBe(401);
    });

    it('still 403s (mustChangePassword) a JWT issued well AFTER a reset, once the stamp no longer applies', async () => {
      // Proves the mustChangePassword gate itself is untouched by HIGH-3 —
      // only a JWT minted close enough to the stamp to lose the
      // second-granularity race gets the 401 above.
      const bob = await createUser('bob-jwt-reset-2', PASSWORD, 'user');
      const before = await loginToken('bob-jwt-reset-2', PASSWORD);
      expect((await probeJwt(before)).status).toBe(200);

      await resetUserPassword(bob.id, 'new-password-123456');
      await waitPastSecondBoundary();
      const after = await loginToken('bob-jwt-reset-2', 'new-password-123456');

      expect((await probeJwt(after)).status).toBe(403);
      expect((await probeJwt(after, { method: 'PUT', path: '/auth/password' })).status).toBe(200);
    }, 10_000);
  });
});
