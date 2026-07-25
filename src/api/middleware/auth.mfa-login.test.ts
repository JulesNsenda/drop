/**
 * MFA login role-propagation regression test.
 *
 * Bug: after enabling MFA, an admin who completed 2FA was shown as a plain
 * `user` in the dashboard. Root cause was that `completeMfaLogin` (and the
 * `POST /auth/mfa/verify` response) returned only the token — no user object —
 * so the client never received the role on the MFA path (unlike POST
 * /auth/login). The session JWT itself always carried the correct role, so this
 * was a display/authorization-context bug, not a token downgrade.
 *
 * This guards that `completeMfaLogin` returns the user (with the real role).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import {
  initializeAuth,
  resetAuth,
  createUser,
  setupMfa,
  enableMfa,
  authenticateUser,
  completeMfaLogin,
} from './auth';
import { generateTotp } from '../../utils/totp';

describe('MFA login returns the user role (regression)', () => {
  let tempDir: string;
  let nowSec: number;
  let dateSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-auth-mfa-test-'));
    const credentialsPath = path.join(tempDir, 'credentials.json');
    // MFA secrets are encrypted at rest with the platform master key.
    const masterKeyPath = path.join(tempDir, 'encryption.key');
    await fs.writeFile(masterKeyPath, crypto.randomBytes(32).toString('hex'));

    // Control the clock the TOTP + jose-mock read via Date.now(). generateTotp
    // takes explicit seconds, so we only need to pin Date.now().
    nowSec = 1_700_000_000;
    dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowSec * 1000);

    resetAuth();
    await initializeAuth({ credentialsPath, masterKeyPath, enableJwt: true, enableApiKeys: true });
  });

  afterEach(async () => {
    dateSpy.mockRestore();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('completeMfaLogin returns the admin user (role) after a valid code', async () => {
    const admin = await createUser('mfaadmin', 'password123', 'admin');

    // Enable MFA at the current step.
    const setup = setupMfa(admin.id);
    expect(setup).not.toBeNull();
    const enableRes = await enableMfa(admin.id, 'password123', setup!.secret, generateTotp(setup!.secret, nowSec));
    expect(enableRes.status).toBe('ok');

    // Advance two steps so the verify code is a different (later) step than the
    // one enable consumed — replay protection rejects reusing the same step.
    nowSec += 60;

    const authRes = await authenticateUser('mfaadmin', 'password123');
    expect(authRes.status).toBe('mfa_required');
    const challengeToken = authRes.status === 'mfa_required' ? authRes.challengeToken : '';

    const verifyRes = await completeMfaLogin(challengeToken, generateTotp(setup!.secret, nowSec));

    expect(verifyRes.status).toBe('ok');
    if (verifyRes.status === 'ok') {
      expect(verifyRes.token).toBeTruthy();
      expect(verifyRes.user.role).toBe('admin');
      expect(verifyRes.user.username).toBe('mfaadmin');
      expect(verifyRes.user.id).toBe(admin.id);
    }
  });
});
