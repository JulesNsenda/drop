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
  mintAppGuestSessionToken,
  verifyAppGuestSessionToken,
  SESSION_TTL_SECONDS,
  GUEST_SESSION_TTL_SECONDS,
} from './session-token';
// DROP-155: `src/managers/app-guest` is a SIBLING module built in parallel
// with this file and, as of this suite, has not landed. These imports and the
// `describe('app guest session token', ...)` block below are written against
// the interface `session-token.ts` needs from it — see that file's own
// `verifyAppGuestSessionToken` doc comment. Until the module exists this
// entire test FILE fails at module resolution (not just the guest block),
// because `session-token.ts` itself cannot compile without it. That failure
// is expected and reported, not worked around — see the implementer's report
// for why no mock is substituted here.
import {
  resetAppGuests,
  getAppGuestManager,
  createAppGuest,
  setAppGuestDisabled,
  deleteAppGuest,
} from '../../managers/app-guest';

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

/**
 * The `app_guest_session` credential class (DROP-155) — a fourth class for a
 * person with NO DROP account, admitted by invite rather than a dashboard
 * bearer. Mirrors the `app_session` suite above deliberately: the argument for
 * every live check is the same argument, made about a guest record instead of
 * a user record.
 *
 * `src/managers/app-guest` is a SIBLING module and may not exist yet — see the
 * import comment at the top of this file. If it hasn't landed, this entire
 * FILE fails at module resolution (not just this block), and that is the
 * expected, reported failure — not a bug in this suite.
 */
describe('app guest session token', () => {
  let tempDir: string;
  let guestId: string;

  const EMAIL = 'guest@example.com';

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-app-guest-session-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    resetAuth();
    await initializeAuth({
      credentialsPath: path.join(tempDir, 'credentials.json'),
      enableJwt: true,
      enableApiKeys: true,
    } as never);
    resetAppGuests();
    // Bind the store into tempDir BEFORE the first guest is created. Left
    // unbound it self-defaults from DROP_ROOT and writes this machine's real
    // `app-guests.json` — which passes on Windows (C:\drop is creatable) and
    // fails on a Linux runner with EACCES on /var/drop. CI has already caught
    // that exact shape once on this branch stack.
    getAppGuestManager({
      guestsFilePath: path.join(tempDir, 'app-guests.json'),
      invitesFilePath: path.join(tempDir, 'app-invites.json'),
    });
    const guest = await createAppGuest(APP, EMAIL);
    guestId = guest.id;
  });

  afterEach(async () => {
    resetAuth();
    resetAppGuests();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const mint = () => mintAppGuestSessionToken(guestId, EMAIL, APP, ORIGIN);

  it('round-trips and reports the identity, with NO role field at all', async () => {
    const identity = await verifyAppGuestSessionToken(await mint(), ORIGIN, APP);
    expect(identity).toEqual({ guestId, email: EMAIL, appName: APP });
    expect(identity).not.toHaveProperty('role');
  });

  it('is capped at the user session TTL, not longer', () => {
    // "≤ the user session's 8h" is satisfied by equality — see the module doc
    // comment for why the two classes deliberately share one constant rather
    // than each picking their own cookie lifetime.
    expect(GUEST_SESSION_TTL_SECONDS).toBeLessThanOrEqual(SESSION_TTL_SECONDS);
  });

  describe('revocation — a guest has fewer levers than a user', () => {
    it('refuses once the guest record is disabled', async () => {
      const token = await mint();
      await setAppGuestDisabled(guestId, true);
      expect(await verifyAppGuestSessionToken(token, ORIGIN, APP)).toBeNull();
    });

    it('refuses once the guest record is deleted', async () => {
      const token = await mint();
      await deleteAppGuest(guestId);
      expect(await verifyAppGuestSessionToken(token, ORIGIN, APP)).toBeNull();
    });

    it('refuses a grant that has been denied by sid — REQUIRED, same as the user class', async () => {
      // Without a `sid` claim a guest would be the one credential class in
      // this codebase with no addressable session — fewer revokers to begin
      // with makes this one non-negotiable, not less important.
      const token = await mint();
      const [, payloadB64] = token.split('.');
      const sid = JSON.parse(Buffer.from(payloadB64, 'base64url').toString()).sid as string;
      expect(sid).toBeTruthy();

      denyGrant(sid, GUEST_SESSION_TTL_SECONDS * 1000);
      expect(await verifyAppGuestSessionToken(token, ORIGIN, APP)).toBeNull();
    });
  });

  describe('binding', () => {
    it('refuses a guest token presented for a DIFFERENT app', async () => {
      expect(await verifyAppGuestSessionToken(await mint(), ORIGIN, 'otherapp')).toBeNull();
    });

    it('refuses a guest token presented on a DIFFERENT origin', async () => {
      expect(
        await verifyAppGuestSessionToken(await mint(), 'https://evil.example.com', APP)
      ).toBeNull();
    });

    it('refuses garbage and empty input', async () => {
      expect(await verifyAppGuestSessionToken('', ORIGIN, APP)).toBeNull();
      expect(await verifyAppGuestSessionToken('not.a.jwt', ORIGIN, APP)).toBeNull();
      expect(
        await verifyAppGuestSessionToken('{http.request.cookie.x}', ORIGIN, APP)
      ).toBeNull();
    });
  });

  describe('class isolation — the token_use-first ordering', () => {
    it('a USER session token is refused by the GUEST verifier', async () => {
      const user = await createUser('alice', 'password123', 'user');
      const userToken = await mintAppSessionToken(user.id, 'alice', APP, ORIGIN);
      expect(await verifyAppGuestSessionToken(userToken, ORIGIN, APP)).toBeNull();
    });

    it('a GUEST session token is refused by the USER verifier', async () => {
      const guestToken = await mint();
      expect(await verifyAppSessionToken(guestToken, ORIGIN, APP)).toBeNull();
    });
  });
});
