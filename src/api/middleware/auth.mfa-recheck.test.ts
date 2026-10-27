/**
 * `completeMfaLogin` re-checks the account at completion. The challenge is
 * minted by a gate that may have shut since: a user disabled, scope-created or
 * contained (suspend / forced reset) after the challenge was issued must not be
 * able to finish the login with it.
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
  resetUserPassword,
} from './auth';
import { generateTotp } from '../../utils/totp';

const PW = 'password123';

describe('MFA completion re-checks the account', () => {
  let tmpDir: string;
  let credentialsPath: string;
  let nowSec: number;
  let dateSpy: jest.SpyInstance;
  let secret: string;
  let userId: string;
  let challengeToken: string;

  const boot = async (): Promise<void> => {
    resetAuth();
    await initializeAuth({
      credentialsPath,
      masterKeyPath: path.join(tmpDir, 'encryption.key'),
      enableJwt: true,
      enableApiKeys: true,
    });
  };

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-auth-mfa-recheck-'));
    credentialsPath = path.join(tmpDir, 'api-credentials.json');
    await fs.writeFile(path.join(tmpDir, 'encryption.key'), crypto.randomBytes(32).toString('hex'));

    // Pin the clock TOTP and the jose mock read; `new Date()` (the invalidation
    // stamp) stays real, which is far later than the pinned challenge `iat`.
    nowSec = 1_700_000_000;
    dateSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowSec * 1000);
    await boot();

    const u = await createUser({ username: 'mfa', role: 'user', credential: { password: PW } });
    userId = u.id;
    secret = (setupMfa(userId) as { secret: string }).secret;
    await enableMfa(userId, PW, secret, generateTotp(secret, nowSec));
    nowSec += 60;
    const res = await authenticateUser('mfa', PW);
    if (res.status !== 'mfa_required') throw new Error('expected a challenge');
    challengeToken = res.challengeToken;
  });

  afterEach(async () => {
    dateSpy.mockRestore();
    resetAuth();
    jest.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const editUser = async (edit: (u: Record<string, unknown>) => void): Promise<void> => {
    const store = JSON.parse(await fs.readFile(credentialsPath, 'utf-8'));
    edit(store.users.find((u: { username: string }) => u.username === 'mfa'));
    await fs.writeFile(credentialsPath, JSON.stringify(store));
    await boot();
  };

  it('control: completes when nothing changed', async () => {
    expect((await completeMfaLogin(challengeToken, generateTotp(secret, nowSec))).status).toBe('ok');
  });

  it('is invalid when the user was disabled after the challenge was issued', async () => {
    // Hand-disabled with no stamp, so only the explicit check can refuse it.
    await editUser((u) => {
      u.enabled = false;
    });
    expect((await completeMfaLogin(challengeToken, generateTotp(secret, nowSec))).status).toBe('invalid');
  });

  it('is invalid when the user was contained (forced reset) after the challenge was issued', async () => {
    await resetUserPassword(userId, 'brand-new-pass-1');
    expect((await completeMfaLogin(challengeToken, generateTotp(secret, nowSec))).status).toBe('invalid');
  });

  it('is invalid for a scope-created account', async () => {
    await editUser((u) => {
      u.createdByScope = true;
    });
    expect((await completeMfaLogin(challengeToken, generateTotp(secret, nowSec))).status).toBe('invalid');
  });
});
