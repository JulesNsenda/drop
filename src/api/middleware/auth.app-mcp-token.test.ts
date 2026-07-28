/**
 * The `app_mcp` token class (Step 11, PR 2).
 *
 * These tokens are presented to TENANT apps. The properties that matter are
 * separation (one can never act as a DROP credential) and exactness (one app's
 * token is useless at another's endpoint).
 *
 * NOTE the standing caveat: the `jose` mock ignores the signing secret, so key
 * isolation is not exercised here — only the claim checks are. Same limitation
 * the OAuth access-token tests carry.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  initializeAuth,
  resetAuth,
  createUser,
  updateUser,
  mintAppMcpAccessToken,
  verifyAppMcpAccessToken,
  mintOAuthAccessToken,
  verifyOAuthAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  type User,
} from './auth';

const APP_AUD = 'https://alpha.example.com/mcp';
const DROP_AUD = 'https://drop.example.com/api/v1/mcp';

describe('app_mcp access tokens', () => {
  let tempDir: string;
  let user: User;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-appmcp-auth-'));
    resetAuth();
    await initializeAuth({
      credentialsPath: path.join(tempDir, 'credentials.json'),
      enableJwt: true,
      enableApiKeys: true,
    });
    user = await createUser('alice', 'correct-horse-battery-staple', 'user');
  });

  afterEach(async () => {
    resetAuth();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  });

  it('verifies for the app and audience it was minted for', async () => {
    const token = await mintAppMcpAccessToken(user, APP_AUD, 'alpha', 'sid-1');

    const identity = await verifyAppMcpAccessToken(token, APP_AUD, 'alpha');

    expect(identity).toEqual({ userId: user.id, username: 'alice', appName: 'alpha' });
  });

  it('is REJECTED at another app’s audience', async () => {
    const token = await mintAppMcpAccessToken(user, APP_AUD, 'alpha', 'sid-1');

    expect(await verifyAppMcpAccessToken(token, 'https://beta.example.com/mcp', 'beta')).toBeNull();
  });

  it('is REJECTED when the audience matches but the app name does not', async () => {
    // Binds the token to the app the gateway says it is serving. Without this,
    // two apps sharing a resolved URL (a misconfiguration, or a name reused
    // after deletion) would accept each other's tokens.
    const token = await mintAppMcpAccessToken(user, APP_AUD, 'alpha', 'sid-1');

    expect(await verifyAppMcpAccessToken(token, APP_AUD, 'beta')).toBeNull();
  });

  it('is REJECTED by DROP’s own OAuth verifier — the SEC-1 separation', async () => {
    // The whole point of a distinct token_use. Even if an audience ever
    // collided, an app-scoped token must not authenticate against DROP's
    // control plane, where it would carry the user's real role.
    const token = await mintAppMcpAccessToken(user, DROP_AUD, 'alpha', 'sid-1');

    expect(await verifyOAuthAccessToken(token, DROP_AUD)).toBeNull();
  });

  it('does NOT accept a DROP-scoped OAuth token — separation in the other direction', async () => {
    const token = await mintOAuthAccessToken(user, APP_AUD, 'sid-1');

    expect(await verifyAppMcpAccessToken(token, APP_AUD, 'alpha')).toBeNull();
  });

  it('carries no role claim', async () => {
    // A control-plane role is meaningless to a tenant and would be an
    // escalation primitive if any future code built an AuthContext from these.
    const token = await mintAppMcpAccessToken(user, APP_AUD, 'alpha');
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

    expect(claims.role).toBeUndefined();
    expect(claims.token_use).toBe('app_mcp');
    expect(claims.app).toBe('alpha');
  });

  it('stops verifying once the account is disabled', async () => {
    const token = await mintAppMcpAccessToken(user, APP_AUD, 'alpha', 'sid-1');
    await updateUser(user.id, { enabled: false });

    expect(await verifyAppMcpAccessToken(token, APP_AUD, 'alpha')).toBeNull();
  });

  it('rejects a garbage token', async () => {
    expect(await verifyAppMcpAccessToken('not.a.token', APP_AUD, 'alpha')).toBeNull();
  });
});

/**
 * A refresh grant remembers WHICH resource it was issued for.
 *
 * Without this the token endpoint recomputes DROP's own resource on every
 * refresh, so a grant consented for one tenant app would come back audienced at
 * DROP's control plane — an app-scoped credential escalating to every app its
 * user owns, silently, roughly fifteen minutes after consent.
 */
describe('refresh grants carry their resource', () => {
  let tempDir: string;
  let user: User;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-appmcp-refresh-'));
    resetAuth();
    await initializeAuth({
      credentialsPath: path.join(tempDir, 'credentials.json'),
      enableJwt: true,
      enableApiKeys: true,
    });
    user = await createUser('alice', 'correct-horse-battery-staple', 'user');
  });

  afterEach(async () => {
    resetAuth();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  });

  it('preserves the resource across rotation', async () => {
    const issued = await issueRefreshToken(user.id, 'client-1', 'sid-1', APP_AUD);

    const rotated = await rotateRefreshToken(issued);

    expect(rotated?.resource).toBe(APP_AUD);
  });

  it('preserves it across MANY rotations, not just the first', async () => {
    // The discriminating case. A carry that works once and then drops the value
    // is exactly the shape the `sid` bug had: correct on the first refresh and
    // degraded forever after.
    let token = await issueRefreshToken(user.id, 'client-1', 'sid-1', APP_AUD);

    for (let i = 0; i < 5; i += 1) {
      const rotated = await rotateRefreshToken(token);
      expect(rotated?.resource).toBe(APP_AUD);
      token = rotated!.refreshToken;
    }
  });

  it('reports no resource for a grant issued before the field existed', async () => {
    // Such a grant could only ever have been DROP's own resource — there was no
    // other mintable audience — so the caller's fallback is truthful.
    const issued = await issueRefreshToken(user.id, 'client-1', 'sid-1');

    const rotated = await rotateRefreshToken(issued);

    expect(rotated?.resource).toBeUndefined();
  });
});
