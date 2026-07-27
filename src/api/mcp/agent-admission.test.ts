/**
 * Rank-0 admission at the MCP gate (SEC-5, high).
 *
 * `authMiddleware('user')` ranks a scope-only principal at 0 and rejects it,
 * which is right for the general API but blocks the tokens `/mcp` exists to
 * serve. So `mcpAuthMiddleware` admits them — and the danger is admitting one
 * rank-0 key too many.
 *
 * DROP injects a rank-0 provisioning key into EVERY tenant container as
 * `DROP_API_KEY` (`createApiKey('app:<app>:provision', 'none', …)`). Admitting
 * rank-0 on role alone would authenticate that key here too, and a compromised
 * tenant app would escalate from "can call POST /auth/users" to "can create
 * and run arbitrary apps".
 *
 * TWO conditions keep it out, and mutation-checking showed they are
 * INDEPENDENT: it carries no `kind`, and its `users:create` scope is not agent
 * grammar. Either alone suffices, which is why the provisioning test below does
 * not isolate `kind` — the 'looks like an agent token' test is the one that
 * does.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Hono } from 'hono';
import {
  initializeAuth,
  resetAuth,
  createUser,
  createApiKey,
  mcpAuthMiddleware,
  AuthContext,
} from '../middleware/auth';

describe('MCP rank-0 admission', () => {
  let tempDir: string;
  let ownerId: string;

  const probe = async (headers: Record<string, string>) => {
    let seen: AuthContext | undefined;
    const app = new Hono();
    app.use('/mcp', mcpAuthMiddleware());
    app.post('/mcp', (c) => {
      seen = (c.get as (k: string) => AuthContext | undefined)('auth');
      return c.json({ ok: true });
    });
    const res = await app.request('/mcp', { method: 'POST', headers });
    return { status: res.status, auth: seen };
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-agent-admit-'));
    resetAuth();
    await initializeAuth({
      credentialsPath: path.join(tempDir, 'credentials.json'),
      enableJwt: true,
      enableApiKeys: true,
    });
    const owner = await createUser('owner', 'password123', 'user');
    ownerId = owner.id;
  });

  afterEach(async () => {
    resetAuth();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('ADMITS an agent token', async () => {
    const { key } = await createApiKey(
      'deploy-bot',
      'none',
      undefined,
      ['app:myapp:deploy'],
      ownerId,
      { kind: 'agent' }
    );

    const { status, auth } = await probe({ 'X-API-Key': key });

    expect(status).toBe(200);
    expect(auth?.role).toBe('none');
    expect(auth?.kind).toBe('agent');
  });

  it('REFUSES the provisioning key DROP injects into tenant containers', async () => {
    // THE SEC-5 case. Same rank-0 role. Excluded twice over — no `kind`, and
    // `users:create` is not agent grammar — so this asserts the OUTCOME rather
    // than either mechanism. If it ever passes, a compromised tenant app can
    // create and run arbitrary apps.
    const { key } = await createApiKey(
      'app:victim:provision',
      'none',
      undefined,
      ['users:create'],
      ownerId
    );

    // 403, not 401: the credential is VALID, its role is insufficient. That is
    // the platform's existing convention for the role gate, and keeping it
    // means a rejected agent token is indistinguishable from any other
    // under-privileged key.
    expect((await probe({ 'X-API-Key': key })).status).toBe(403);
  });

  it('refuses a rank-0 key that merely LOOKS like an agent token', async () => {
    // Agent-shaped scopes but no kind — e.g. a key hand-edited into the
    // credentials file, or minted by some future code path that forgets.
    const { key } = await createApiKey(
      'lookalike',
      'none',
      undefined,
      ['app:myapp:deploy'],
      ownerId
    );

    expect((await probe({ 'X-API-Key': key })).status).toBe(403);
  });

  it('refuses an agent token carrying no usable scope', async () => {
    // Right kind, nothing granted. Admitting it would put a principal with
    // zero authority in front of every tool's own checks.
    const { key } = await createApiKey('empty', 'none', undefined, ['garbage'], ownerId, {
      kind: 'agent',
    });

    expect((await probe({ 'X-API-Key': key })).status).toBe(403);
  });

  it('still admits an ordinary user key, unchanged', async () => {
    // The narrow admission must not have disturbed the existing path.
    const { key } = await createApiKey('normal', 'user', undefined, undefined, ownerId);

    const { status, auth } = await probe({ 'X-API-Key': key });

    expect(status).toBe(200);
    expect(auth?.role).toBe('user');
  });

  it('still refuses a readonly key, which ranks below user', async () => {
    const { key } = await createApiKey('ro', 'readonly', undefined, undefined, ownerId);

    expect((await probe({ 'X-API-Key': key })).status).toBe(403);
  });

  it('accepts an agent token presented as a Bearer, not only X-API-Key', async () => {
    const { key } = await createApiKey('bearer-bot', 'none', undefined, ['apps:create'], ownerId, {
      kind: 'agent',
    });

    expect((await probe({ Authorization: `Bearer ${key}` })).status).toBe(200);
  });
});
