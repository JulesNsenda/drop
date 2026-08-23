/**
 * The `app_session` credential class (DROP-152).
 *
 * The first version of this design specified only the MINT — four claim fields
 * — and said it "mirrored" `mintAppMcpAccessToken`. It did not mirror the half
 * that matters: that function's verifier re-reads the user record on every
 * request, because it is the ONLY gate its token class ever passes. A browser
 * session has the same property and a much longer life, so the omission bit
 * harder: a suspended account would have kept opening the app for the whole
 * cookie lifetime.
 *
 * These tests are mostly about that half.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import {
  initializeAuth,
  resetAuth,
  createUser,
  updateUser,
  suspendUser,
  denyGrant,
} from '../middleware/auth';
import {
  mintAppSessionToken,
  verifyAppSessionToken,
  SESSION_TTL_SECONDS,
} from './session-token';

const ORIGIN = 'https://myapp.dropkit.sh';
const APP = 'myapp';

describe('app session token', () => {
  let tempDir: string;
  let userId: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-app-session-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    resetAuth();
    await initializeAuth({
      credentialsPath: path.join(tempDir, 'credentials.json'),
      enableJwt: true,
      enableApiKeys: true,
    } as never);
    const user = await createUser('alice', 'password123', 'user');
    userId = user.id;
  });

  afterEach(async () => {
    resetAuth();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const mint = () => mintAppSessionToken(userId, 'alice', APP, ORIGIN);

  it('round-trips and reports the identity', async () => {
    const identity = await verifyAppSessionToken(await mint(), ORIGIN, APP);
    expect(identity).toEqual({ userId, username: 'alice', appName: APP, role: 'user' });
  });

  it('reads the role LIVE, never from the token', async () => {
    // The token carries no role claim at all — a control-plane role would be
    // meaningless to a tenant app and an escalation primitive if anything ever
    // built an AuthContext from these claims. Promoting the user must take
    // effect on the NEXT request, without re-minting.
    const token = await mint();
    expect((await verifyAppSessionToken(token, ORIGIN, APP))?.role).toBe('user');

    await updateUser(userId, { role: 'admin' });
    expect((await verifyAppSessionToken(token, ORIGIN, APP))?.role).toBe('admin');
  });

  describe('revocation — the half the design originally omitted', () => {
    it('refuses once the account is disabled', async () => {
      const token = await mint();
      await updateUser(userId, { enabled: false });
      expect(await verifyAppSessionToken(token, ORIGIN, APP)).toBeNull();
    });

    it('refuses once credentials are stamped invalid (suspend)', async () => {
      const token = await mint();
      await suspendUser(userId);
      expect(await verifyAppSessionToken(token, ORIGIN, APP)).toBeNull();
    });

    it('refuses a grant that has been denied by sid', async () => {
      // Without a `sid` claim the existing denyGrant primitive could not reach
      // this class at all, and a minted session would be revocable only by
      // suspending the whole account.
      const token = await mint();
      const [, payloadB64] = token.split('.');
      const sid = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()).sid as string;
      expect(sid).toBeTruthy();

      // Denied for the SESSION's lifetime, not the 15-minute default — a
      // denial that expires before the token does is not a denial.
      denyGrant(sid, SESSION_TTL_SECONDS * 1000);
      expect(await verifyAppSessionToken(token, ORIGIN, APP)).toBeNull();
    });

    it('refuses once the user is deleted', async () => {
      const token = await mint();
      resetAuth();
      expect(await verifyAppSessionToken(token, ORIGIN, APP)).toBeNull();
    });
  });

  describe('binding', () => {
    it('refuses a token presented for a DIFFERENT app', async () => {
      expect(await verifyAppSessionToken(await mint(), ORIGIN, 'otherapp')).toBeNull();
    });

    it('refuses a token presented on a DIFFERENT origin', async () => {
      expect(await verifyAppSessionToken(await mint(), 'https://evil.example.com', APP)).toBeNull();
    });

    it('refuses garbage and empty input', async () => {
      expect(await verifyAppSessionToken('', ORIGIN, APP)).toBeNull();
      expect(await verifyAppSessionToken('not.a.jwt', ORIGIN, APP)).toBeNull();
      // The value Caddy forwards when the cookie is absent.
      expect(
        await verifyAppSessionToken('{http.request.cookie.x}', ORIGIN, APP)
      ).toBeNull();
    });
  });

  it('has a browser-shaped TTL, not the MCP one', () => {
    // 15 minutes exists because a harvested MCP token has no revocation. This
    // class re-reads the user on every request, which is what bounds it — and
    // a 15-minute browser session would silently convert a form POST into a
    // GET four times an hour.
    expect(SESSION_TTL_SECONDS).toBe(8 * 60 * 60);
  });
});
