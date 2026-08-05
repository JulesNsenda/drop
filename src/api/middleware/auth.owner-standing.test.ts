/**
 * Owner-derived API-key standing (DROP-130 Item 3).
 *
 * Before this item, `apiKeyAuthContext` built the whole AuthContext from the
 * key record alone: `role: key.role`, `username: key.name`, `scopes:
 * key.scopes` — frozen at mint time, never re-checked against the owner.
 * The JWT path already re-reads `userRecord.role` on every request, which is
 * why a demotion bites there immediately; a key kept the demoted owner's OLD
 * authority until it was deleted or expired.
 *
 * The suite could not previously tell a RIGHT clamp from a WRONG one: no
 * existing test minted a key whose role outranked its owner's. These tests
 * exist to close that gap, with special attention to the one direction that
 * would be catastrophic to get backwards — see 'the owner-wins direction'
 * below.
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
  updateUser,
  authMiddleware,
  requireCapability,
  mcpAuthMiddleware,
  AuthContext,
} from './auth';

describe('owner-derived API-key standing', () => {
  let tempDir: string;
  let credentialsPath: string;

  type TestEnv = { Variables: { auth: AuthContext } };

  /** Drive one middleware chain with a fake X-API-Key request, capture the AuthContext it sets. */
  const probeWith = async (
    mw: (app: Hono<TestEnv>) => void,
    key: string,
    presentAs: 'x-api-key' | 'bearer' = 'x-api-key'
  ): Promise<{ status: number; auth: AuthContext | undefined }> => {
    let seen: AuthContext | undefined;
    const app = new Hono<TestEnv>();
    mw(app);
    app.get('/probe', (c) => {
      seen = c.get('auth');
      return c.json({ ok: true });
    });
    const headers: Record<string, string> =
      presentAs === 'x-api-key' ? { 'X-API-Key': key } : { Authorization: `Bearer ${key}` };
    const res = await app.request('/probe', { headers });
    return { status: res.status, auth: seen };
  };

  const userGate = (app: Hono<TestEnv>) => app.use('/probe', authMiddleware('user'));
  const adminGate = (app: Hono<TestEnv>) => app.use('/probe', authMiddleware('admin'));
  const anyAuth = (app: Hono<TestEnv>) => app.use('/probe', authMiddleware());
  const capabilityGate = (app: Hono<TestEnv>) =>
    app.use('/probe', authMiddleware(), requireCapability('users:create'));
  const mcpGate = (app: Hono<TestEnv>) => app.use('/probe', mcpAuthMiddleware());

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-owner-standing-'));
    credentialsPath = path.join(tempDir, 'credentials.json');
    await initializeAuth({ credentialsPath, enableJwt: true, enableApiKeys: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    resetAuth();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('the owner-wins direction (the catastrophic one to get backwards)', () => {
    it('an admin-owned agent token still 403s a user-gated route', async () => {
      // A key's role is deliberately BELOW its owner's here — agent tokens are
      // always minted role:'none' regardless of who mints them. An "owner
      // wins" (max-of-the-two) implementation would promote this to 'admin'
      // and pass straight through; minRole (lower-of-the-two) must not.
      const admin = await createUser('root-agent-owner', 'password123', 'admin');
      const { key } = await createApiKey(
        'agent-bot',
        'none',
        undefined,
        ['app:demo:deploy'],
        admin.id,
        { kind: 'agent' }
      );

      const { status } = await probeWith(userGate, key);

      expect(status).toBe(403);
    });

    it('the SAME token is still admitted at the MCP gate — via resolveAgentToken/kind, not role', async () => {
      // Proves the role clamp does not collide with the legitimate agent
      // path: mcpAuthMiddleware admits rank-0 agent tokens on kind+scope, a
      // check that is entirely independent of the role clamp above.
      const admin = await createUser('root-agent-owner-2', 'password123', 'admin');
      const { key } = await createApiKey(
        'agent-bot-2',
        'none',
        undefined,
        ['app:demo:deploy'],
        admin.id,
        { kind: 'agent' }
      );

      const { status, auth } = await probeWith(mcpGate, key);

      expect(status).toBe(200);
      // Still 'none' — owned by an admin, but a role:'none' key's clamped
      // role is ALWAYS 'none' (minRole picks the lower rank regardless of
      // which side is higher).
      expect(auth?.role).toBe('none');
      expect(auth?.userId).toBe(admin.id);
      expect(auth?.kind).toBe('agent');
    });
  });

  it("a demoted owner's admin-role key loses admin standing on the very next request", async () => {
    const owner = await createUser('carol-demoted', 'password123', 'admin');
    const { key } = await createApiKey('carol-admin-key', 'admin', undefined, undefined, owner.id);

    const before = await probeWith(adminGate, key);
    expect(before.status).toBe(200);

    await updateUser(owner.id, { role: 'readonly' });

    const after = await probeWith(adminGate, key);
    expect(after.status).toBe(403);
  });

  it("attributes an owned key's request to the OWNER's username, not the key's own name", async () => {
    const owner = await createUser('grace-owner', 'password123', 'user');
    const { key } = await createApiKey('grace-ci-key', 'user', undefined, undefined, owner.id);

    const { auth } = await probeWith(anyAuth, key);

    expect(auth?.username).toBe('grace-owner');
    expect(auth?.username).not.toBe('grace-ci-key');
    // The credential itself stays identifiable via principalId (Item 1) even
    // though the row no longer names it as `username`.
    expect(auth?.principalId).toMatch(/^key:/);
  });

  it('an ownerless key is byte-identically unaffected by the owner-derived clamp', async () => {
    const { key, apiKey } = await createApiKey('legacy-full', 'admin', undefined, ['users:create']);

    const { auth } = await probeWith(anyAuth, key);

    expect(auth).toEqual({
      userId: apiKey.id,
      username: 'legacy-full',
      role: 'admin',
      authMethod: 'apikey',
      scopes: ['users:create'],
      principalId: `key:${apiKey.id}`,
    });
  });

  it("a key holding 'users:create' loses that capability once its owner is demoted below 'user'", async () => {
    // THE escalation Item 3's scope clamp exists to close: clamping `role`
    // alone leaves this frozen, because requireCapability's scope arm
    // (`auth.role === 'admin' || auth.scopes?.includes(cap)`) never
    // consults role at all.
    const owner = await createUser('dave-owner', 'password123', 'user');
    const { key } = await createApiKey(
      'dave-cap-key',
      'user',
      undefined,
      ['users:create'],
      owner.id
    );

    const before = await probeWith(capabilityGate, key);
    expect(before.status).toBe(200);

    await updateUser(owner.id, { role: 'readonly' });

    const after = await probeWith(capabilityGate, key);
    expect(after.status).toBe(403);
  });

  it("suppresses a control-plane scope on a role:'none' key even with a perfectly healthy (not demoted) owner", async () => {
    // A role:'none' key's clamped role is ALWAYS 'none' (minRole picks the
    // lower rank regardless of the owner), so this must not depend on the
    // owner ever having been demoted — an owner:'user' key at mint time is
    // enough. Without this test, `clampedRole !== 'readonly'` (suppress only
    // AT that one rank) would satisfy the demotion test above and still
    // leave a `role:'none'` key free to carry 'users:create' forever, which
    // is precisely finding F's escalation shape.
    const owner = await createUser('holly-owner', 'password123', 'user');
    const { key } = await createApiKey(
      'holly-scoped-none-key',
      'none',
      undefined,
      ['users:create'],
      owner.id
    );

    const { auth } = await probeWith(anyAuth, key);
    expect(auth?.scopes).not.toContain('users:create');

    const { status } = await probeWith(capabilityGate, key);
    expect(status).toBe(403);
  });

  it('does NOT suppress the app: agent-scope grammar, even when the clamped role is none', async () => {
    // The other side of the same clamp: it must not confuse a legitimate
    // agent-grammar scope with a control-plane one. A role:'none' key's
    // clamped role is always 'none' (below 'user'), so this is the case that
    // would break EVERY agent token if the suppression were too broad.
    const owner = await createUser('erin-owner', 'password123', 'user');
    const { key } = await createApiKey(
      'erin-agent-key',
      'none',
      undefined,
      ['app:demo:deploy', 'apps:create'],
      owner.id,
      { kind: 'agent' }
    );

    const { auth } = await probeWith(anyAuth, key);

    expect(auth?.scopes).toEqual(['app:demo:deploy', 'apps:create']);
  });

  describe('boot warning for a key that already outranks its owner', () => {
    // `POST /auth/api-keys` (and `createApiKey` itself) has always permitted
    // an explicit ownerUserId naming any user, with no check that the key's
    // OWN role does not exceed it — so this shape is possible today, and
    // after this item such a key silently loses standing. A key that starts
    // 403ing with no signal anywhere is not acceptable.
    it('warns, naming the key, when its role outranks its owner', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const ro = await createUser('eve-mismatch-owner', 'password123', 'readonly');
      await createApiKey('mismatched-key', 'admin', undefined, undefined, ro.id);

      warnSpy.mockClear();
      resetAuth();
      await initializeAuth({ credentialsPath, enableJwt: true, enableApiKeys: true });

      const warned = warnSpy.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('mismatched-key') &&
          call[0].includes('outranks')
      );
      expect(warned).toBe(true);
    });

    it('stays silent for an admin-owned agent token — role BELOW owner is not a mismatch', async () => {
      // Deliberately the widest rank gap in the other direction (key 'none',
      // owner 'admin'), not an equal-rank fixture: an equal-rank pair cannot
      // discriminate a `>` vs `<` (or `>=`) comparison bug, since neither
      // side of a flipped operator fires when the ranks are equal. This is
      // also the exact shape every agent token has — pinning it here means a
      // boot with agent tokens in play does not spam a false "outranks"
      // warning for every one of them.
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      const admin = await createUser('frank-admin-owner', 'password123', 'admin');
      await createApiKey('agent-token-key', 'none', undefined, ['app:demo:deploy'], admin.id, {
        kind: 'agent',
      });

      warnSpy.mockClear();
      resetAuth();
      await initializeAuth({ credentialsPath, enableJwt: true, enableApiKeys: true });

      const warned = warnSpy.mock.calls.some(
        (call) => typeof call[0] === 'string' && call[0].includes('agent-token-key')
      );
      expect(warned).toBe(false);
    });
  });
});
