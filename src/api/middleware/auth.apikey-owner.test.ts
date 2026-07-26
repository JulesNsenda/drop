/**
 * Regression tests for API-key ownership attribution (DROP-075).
 *
 * The bug: `AuthContext.userId` was the KEY's own id, so every API key was a
 * fresh principal owning zero apps. Consequences, all exercised below:
 *   - each key carried a full DROP_MAX_APPS_PER_USER allowance
 *   - `getUserById(key.id)` returned null, silently discarding the owner's
 *     per-user `maxApps` override
 *   - apps the key created were owned by an id no human can log in as
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  initializeAuth,
  resetAuth,
  createUser,
  createApiKey,
  verifyApiKey,
  authMiddleware,
  AuthContext,
} from './auth';

/** Drive authMiddleware with a fake Hono context and capture the AuthContext it sets. */
async function authenticateWithKey(key: string): Promise<AuthContext | undefined> {
  let captured: AuthContext | undefined;
  const c = {
    req: {
      header: (name: string) => (name === 'X-API-Key' ? key : undefined),
      path: '/api/v1/apps',
      method: 'GET',
    },
    set: (k: string, v: unknown) => {
      if (k === 'auth') captured = v as AuthContext;
    },
    get: () => undefined,
    json: (body: unknown, status?: number) => ({ body, status }),
  };

  await authMiddleware()(c as never, async () => undefined);
  return captured;
}

describe('API key ownership attribution', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-apikey-owner-'));
    await initializeAuth({ credentialsPath: path.join(tmpDir, 'api-credentials.json') });
  });

  afterEach(async () => {
    resetAuth();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('resolves userId to the owning human, not the key id', async () => {
    const bob = await createUser('bob', 'pw-bob-123456', 'user');
    const { key, apiKey } = await createApiKey('bob-ci', 'user', undefined, undefined, bob.id);

    const auth = await authenticateWithKey(key);

    expect(auth).toBeDefined();
    expect(auth!.userId).toBe(bob.id);
    expect(auth!.userId).not.toBe(apiKey.id);
    expect(auth!.role).toBe('user');
    expect(auth!.authMethod).toBe('apikey');
  });

  it('two keys for the same human share one identity — no per-key quota reset', async () => {
    const bob = await createUser('bob', 'pw-bob-123456', 'user');
    const first = await createApiKey('bob-ci-1', 'user', undefined, undefined, bob.id);
    const second = await createApiKey('bob-ci-2', 'user', undefined, undefined, bob.id);

    const authA = await authenticateWithKey(first.key);
    const authB = await authenticateWithKey(second.key);

    // This is the actual defect: previously these were two distinct principals,
    // so an app-count quota keyed on userId gave each key a fresh allowance.
    expect(authA!.userId).toBe(bob.id);
    expect(authB!.userId).toBe(bob.id);
    expect(authA!.userId).toBe(authB!.userId);
  });

  it('keeps the owning user resolvable, so per-user maxApps overrides apply', async () => {
    const bob = await createUser('bob', 'pw-bob-123456', 'user');
    const { key } = await createApiKey('bob-ci', 'user', undefined, undefined, bob.id);

    const auth = await authenticateWithKey(key);

    // getAppLimit does getUserById(auth.userId); with the key id that was null,
    // so the override was silently ignored and the global default applied.
    const { getUserById } = await import('./auth');
    expect(getUserById(auth!.userId)).not.toBeNull();
    expect(getUserById(auth!.userId)!.username).toBe('bob');
  });

  it('distinct owners stay distinct principals', async () => {
    const bob = await createUser('bob', 'pw-bob-123456', 'user');
    const carol = await createUser('carol', 'pw-carol-12345', 'user');
    const bobKey = await createApiKey('bob-ci', 'user', undefined, undefined, bob.id);
    const carolKey = await createApiKey('carol-ci', 'user', undefined, undefined, carol.id);

    const authBob = await authenticateWithKey(bobKey.key);
    const authCarol = await authenticateWithKey(carolKey.key);

    expect(authBob!.userId).toBe(bob.id);
    expect(authCarol!.userId).toBe(carol.id);
    expect(authBob!.userId).not.toBe(authCarol!.userId);
  });

  // ── Backward compatibility ─────────────────────────────────────────────

  it('legacy keys with no ownerUserId keep the key id as userId', async () => {
    // Minted without an owner — the pre-DROP-075 shape. Its existing apps are
    // stamped with the key id, so changing this would orphan them.
    const { key, apiKey } = await createApiKey('legacy', 'user');

    const auth = await authenticateWithKey(key);

    expect(auth!.userId).toBe(apiKey.id);
    expect(apiKey.ownerUserId).toBeUndefined();
  });

  it('persists ownerUserId across a reload of the credentials store', async () => {
    const bob = await createUser('bob', 'pw-bob-123456', 'user');
    const { key } = await createApiKey('bob-ci', 'user', undefined, undefined, bob.id);

    resetAuth();
    await initializeAuth({ credentialsPath: path.join(tmpDir, 'api-credentials.json') });

    const reloaded = await verifyApiKey(key);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.ownerUserId).toBe(bob.id);

    const auth = await authenticateWithKey(key);
    expect(auth!.userId).toBe(bob.id);
  });

  it('does not disturb scopes or role on the resolved context', async () => {
    const bob = await createUser('bob', 'pw-bob-123456', 'user');
    const { key } = await createApiKey(
      'scoped',
      'none',
      undefined,
      ['users:create'],
      bob.id
    );

    const auth = await authenticateWithKey(key);

    expect(auth!.role).toBe('none');
    expect(auth!.scopes).toEqual(['users:create']);
    expect(auth!.userId).toBe(bob.id);
  });
});
