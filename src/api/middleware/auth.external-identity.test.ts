/**
 * External (SSO) identity records, the private post-authentication gate, and
 * passwordless accounts (DROP-239 Item 1).
 *
 * The field lives in `api-credentials.json` but is typed `unknown` and read
 * through one accessor, so the load-bearing claims here are the negative ones:
 * a malformed field makes every identity operation refuse WITHOUT being
 * filtered by DROP or quarantining the store (and with it every user), and a
 * contained user's identities are not honoured.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  initializeAuth,
  resetAuth,
  createUser,
  deleteUser,
  suspendUser,
  updateUser,
  resetUserPassword,
  verifyUserPassword,
  authenticateUser,
  setupMfa,
  enableMfa,
  getUserById,
  completeExternalIdentityLogin,
  linkExternalIdentity,
  unlinkExternalIdentity,
  classifyExternalIdentity,
  hasNoWorkingLoginMethod,
  confirmAccountPassword,
  changePassword,
  listExternalIdentities,
} from './auth';
import { clockTick } from '../__testutils__/auth';
import { generateTotp } from '../../utils/totp';
import { getAppGuestManager, resetAppGuests } from '../../managers/app-guest';

const ISS = 'https://accounts.google.com';
const GH = 'https://github.example';
const PW = 'password123';

describe('external identities (DROP-239 Item 1)', () => {
  let tmpDir: string;
  let credentialsPath: string;

  const readRaw = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await fs.readFile(credentialsPath, 'utf-8'));
  const writeRaw = async (store: Record<string, unknown>): Promise<void> => {
    await fs.writeFile(credentialsPath, JSON.stringify(store));
  };
  const boot = async (): Promise<void> => {
    resetAuth();
    await initializeAuth({
      credentialsPath,
      masterKeyPath: path.join(tmpDir, 'encryption.key'),
      enableJwt: true,
      enableApiKeys: true,
    });
  };
  /** Edit the raw store (e.g. to plant a legacy hash or a bad field), then reload it. */
  const editRaw = async (edit: (store: Record<string, any>) => void): Promise<void> => {
    const store = await readRaw();
    edit(store);
    await writeRaw(store);
    await boot();
  };
  const nowIso = (): string => new Date().toISOString();
  const legacyHash = (password: string): string => {
    const salt = crypto.randomBytes(8).toString('hex');
    return `${salt}:${crypto.createHash('sha256').update(password + salt).digest('hex')}`;
  };
  const link = (userId: string, subject: string, issuer = ISS, authenticatedAt = nowIso(), sessionUserId = userId) =>
    linkExternalIdentity(userId, { issuer, subject }, { authenticatedAt, sessionUserId });

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    resetAppGuests();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-auth-extid-'));
    credentialsPath = path.join(tmpDir, 'api-credentials.json');
    await fs.writeFile(path.join(tmpDir, 'encryption.key'), crypto.randomBytes(32).toString('hex'));
    await boot();
  });

  afterEach(async () => {
    resetAppGuests();
    resetAuth();
    jest.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('linking and resolution', () => {
    it('resolves a linked identity to a session for its user', async () => {
      const alice = await createUser({ username: 'alice', role: 'user', credential: { password: PW } });
      expect(await link(alice.id, 'sub-1')).toEqual({ status: 'linked' });

      const res = await completeExternalIdentityLogin(ISS, 'sub-1');
      expect(res.status).toBe('ok');
      expect((await completeExternalIdentityLogin(ISS, 'other')).status).toBe('not_linked');
      expect((await completeExternalIdentityLogin(GH, 'sub-1')).status).toBe('not_linked');
    });

    it('is unique on (issuer, subject): a second user cannot take it, the same user is idempotent', async () => {
      const alice = await createUser({ username: 'alice', role: 'user', credential: { password: PW } });
      const bob = await createUser({ username: 'bob', role: 'user', credential: { password: PW } });
      await link(alice.id, 'sub-1');

      expect(await link(bob.id, 'sub-1')).toEqual({ status: 'already_linked' });
      expect(await link(alice.id, 'sub-1')).toEqual({ status: 'already_linked_to_user' });
      expect(listExternalIdentities(bob.id)).toEqual([]);
    });

    it('allows one trusted identity per issuer per user, but the same subject text under another issuer', async () => {
      const alice = await createUser({ username: 'alice', role: 'user', credential: { password: PW } });
      await link(alice.id, 'sub-1');

      expect(await link(alice.id, 'sub-2')).toEqual({ status: 'issuer_taken' });
      expect(await link(alice.id, 'sub-1', GH)).toEqual({ status: 'linked' });
      expect((listExternalIdentities(alice.id) as unknown[]).length).toBe(2);
    });

    it('refuses an unknown user and never writes User.email', async () => {
      expect(await link('nope', 's')).toEqual({ status: 'user_not_found' });
      const alice = await createUser({ username: 'alice', role: 'user', credential: { password: PW } });
      await linkExternalIdentity(
        alice.id,
        { issuer: ISS, subject: 's', email: 'idp@x.com' },
        { authenticatedAt: nowIso(), sessionUserId: alice.id }
      );
      expect(getUserById(alice.id)?.email).toBeUndefined();
      expect((listExternalIdentities(alice.id) as { email?: string }[])[0].email).toBe('idp@x.com');
    });

    it('persists across a restart and unlinks one issuer', async () => {
      const alice = await createUser({ username: 'alice', role: 'user', credential: { password: PW } });
      await link(alice.id, 'sub-1');
      await boot();
      expect((await completeExternalIdentityLogin(ISS, 'sub-1')).status).toBe('ok');

      expect(await unlinkExternalIdentity(alice.id, 'https://nope')).toBe('not_found');
      expect(await unlinkExternalIdentity(alice.id, ISS)).toBe('unlinked');
      expect((await completeExternalIdentityLogin(ISS, 'sub-1')).status).toBe('not_linked');
    });

    it('is purged when the user is deleted', async () => {
      await createUser({ username: 'root', role: 'admin', credential: { password: PW } });
      const alice = await createUser({ username: 'alice', role: 'user', credential: { password: PW } });
      const bob = await createUser({ username: 'bob', role: 'user', credential: { password: PW } });
      await link(alice.id, 'sub-a');
      await link(bob.id, 'sub-b');

      await deleteUser(alice.id);

      expect((await completeExternalIdentityLogin(ISS, 'sub-a')).status).toBe('not_linked');
      const raw = (await readRaw()).externalIdentities as { userId: string }[];
      expect(raw.map((i) => i.userId)).toEqual([bob.id]);
    });

    it('reports a row whose owner is missing as user_missing', async () => {
      await editRaw((s) => {
        s.externalIdentities = [{ issuer: ISS, subject: 'ghost', userId: 'no-such-user', linkedAt: nowIso() }];
      });
      expect((await completeExternalIdentityLogin(ISS, 'ghost')).status).toBe('user_missing');
    });
  });

  describe('the gate, reached through an identity', () => {
    it('returns disabled for a trusted identity of a disabled account', async () => {
      await createUser({ username: 'root', role: 'admin', credential: { password: PW } });
      const bob = await createUser({ username: 'bob', role: 'user', credential: { password: PW } });
      await link(bob.id, 'sub-1');
      // Disabled without a stamp (older records / hand edits): the gate answers.
      await editRaw((s) => {
        s.users.find((u: { username: string }) => u.username === 'bob').enabled = false;
      });
      expect((await completeExternalIdentityLogin(ISS, 'sub-1')).status).toBe('disabled');
    });

    it('refuses a scope-created account', async () => {
      const u = await createUser({ username: 'scoped', role: 'user', credential: { password: PW }, createdByScope: true });
      await link(u.id, 'sub-1');
      expect((await completeExternalIdentityLogin(ISS, 'sub-1')).status).toBe('awaiting_admin_password');
    });

    it('issues an MFA challenge for an MFA user instead of a session', async () => {
      const u = await createUser({ username: 'mfa', role: 'user', credential: { password: PW } });
      const setup = setupMfa(u.id) as { secret: string };
      expect(
        (await enableMfa(u.id, PW, setup.secret, generateTotp(setup.secret, Math.floor(Date.now() / 1000)))).status
      ).toBe('ok');
      await link(u.id, 'sub-1');
      expect((await completeExternalIdentityLogin(ISS, 'sub-1')).status).toBe('mfa_required');
    });
  });

  describe('a malformed identities field', () => {
    const corruptions: [string, unknown][] = [
      ['not an array', { oops: true }],
      ['an entry that is not an object', ['nope']],
      ['an entry missing its subject', [{ issuer: ISS, userId: 'u', linkedAt: '2026-01-01T00:00:00.000Z' }]],
      ['a non-string email', [{ issuer: ISS, subject: 's', userId: 'u', linkedAt: '2026-01-01T00:00:00.000Z', email: 5 }]],
      [
        'two identities for one user at one issuer',
        [
          { issuer: ISS, subject: 's1', userId: 'u1', linkedAt: '2026-01-01T00:00:00.000Z' },
          { issuer: ISS, subject: 's2', userId: 'u1', linkedAt: '2026-01-01T00:00:00.000Z' },
        ],
      ],
      [
        'a duplicated (issuer, subject)',
        [
          { issuer: ISS, subject: 's', userId: 'u1', linkedAt: '2026-01-01T00:00:00.000Z' },
          { issuer: ISS, subject: 's', userId: 'u2', linkedAt: '2026-01-01T00:00:00.000Z' },
        ],
      ],
    ];

    it.each(corruptions)('refuses everything, filters nothing, quarantines nothing: %s', async (_name, bad) => {
      await createUser({ username: 'root', role: 'admin', credential: { password: PW } });
      const alice = await createUser({ username: 'alice', role: 'user', credential: { password: PW } });
      const bob = await createUser({ username: 'bob', role: 'user', credential: { password: PW } });
      await link(alice.id, 'sub-a');
      await editRaw((s) => {
        s.externalIdentities = bad;
      });

      // The users survived the reload: no whole-store quarantine.
      expect(getUserById(alice.id)?.username).toBe('alice');
      expect((await fs.readdir(tmpDir)).filter((f) => f.includes('.corrupt-'))).toEqual([]);

      expect((await completeExternalIdentityLogin(ISS, 'sub-a')).status).toBe('corrupt');
      expect(listExternalIdentities(alice.id)).toBe('corrupt');
      expect(await link(bob.id, 'sub-b')).toEqual({ status: 'corrupt' });
      expect(await unlinkExternalIdentity(alice.id, ISS)).toBe('corrupt');
      expect(classifyExternalIdentity(ISS, 'sub-a')).toBe('corrupt');
      await expect(
        createUser({
          username: 'jit',
          role: 'user',
          email: 'jit@x.com',
          credential: { externalIdentity: { issuer: ISS, subject: 'new' } },
        })
      ).rejects.toThrow(/unreadable/);

      // A normal write (deleting a user) leaves the field as found.
      expect(await deleteUser(bob.id)).toBe(true);
      expect((await readRaw()).externalIdentities).toEqual(bad);
    });

    it('logs once and writes a 0600 copy of the raw field beside the store', async () => {
      const bad = { oops: true };
      await editRaw((s) => {
        s.externalIdentities = bad;
      });
      await createUser({ username: 'root', role: 'admin', credential: { password: PW } });
      const errors = console.error as unknown as jest.Mock;
      errors.mockClear();

      listExternalIdentities('x');
      listExternalIdentities('x');
      expect(errors).toHaveBeenCalledTimes(1);

      const deadline = Date.now() + 3000;
      let copies: string[] = [];
      while (Date.now() < deadline) {
        copies = (await fs.readdir(tmpDir)).filter((f) => f.startsWith('api-credentials.json.identities-corrupt-'));
        if (copies.length) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(copies).toHaveLength(1);
      expect(JSON.parse(await fs.readFile(path.join(tmpDir, copies[0]), 'utf-8'))).toEqual(bad);
      if (process.platform !== 'win32') {
        expect((await fs.stat(path.join(tmpDir, copies[0]))).mode & 0o777).toBe(0o600);
      }
    });
  });

  describe('containment', () => {
    it('does not honour an identity linked before a forced reset, and lists it as stale', async () => {
      const alice = await createUser({ username: 'alice', role: 'user', credential: { password: PW } });
      await link(alice.id, 'sub-1');
      await clockTick();
      await resetUserPassword(alice.id, 'brand-new-pass-1');

      expect((await completeExternalIdentityLogin(ISS, 'sub-1')).status).toBe('stale');
      const list = listExternalIdentities(alice.id) as { stale?: true }[];
      expect(list[0].stale).toBe(true);
    });

    it('does not honour an identity linked before a suspension, even after re-enable', async () => {
      await createUser({ username: 'root', role: 'admin', credential: { password: PW } });
      const bob = await createUser({ username: 'bob', role: 'user', credential: { password: PW } });
      await link(bob.id, 'sub-1');
      await clockTick();
      await suspendUser(bob.id);
      await updateUser(bob.id, { enabled: true });

      expect((await completeExternalIdentityLogin(ISS, 'sub-1')).status).toBe('stale');
    });

    it('re-links a stale identity from a session that postdates the stamp (relinked)', async () => {
      const alice = await createUser({ username: 'alice', role: 'user', credential: { password: PW } });
      await link(alice.id, 'sub-1');
      await clockTick();
      await resetUserPassword(alice.id, 'brand-new-pass-1');
      await clockTick();

      expect(await link(alice.id, 'sub-1')).toEqual({ status: 'relinked' });
      expect((await completeExternalIdentityLogin(ISS, 'sub-1')).status).toBe('ok');
      expect((listExternalIdentities(alice.id) as unknown[]).length).toBe(1);
    });

    it('replaces a stale row at the same issuer for a DIFFERENT subject, but not a trusted one', async () => {
      const alice = await createUser({ username: 'alice', role: 'user', credential: { password: PW } });
      await link(alice.id, 'old');
      await clockTick();
      await resetUserPassword(alice.id, 'brand-new-pass-1');
      await clockTick();

      expect(await link(alice.id, 'new')).toEqual({ status: 'relinked' });
      expect((await completeExternalIdentityLogin(ISS, 'old')).status).toBe('not_linked');
      expect((await completeExternalIdentityLogin(ISS, 'new')).status).toBe('ok');
      // 'new' is trusted now, so a third subject at the issuer is refused.
      expect(await link(alice.id, 'third')).toEqual({ status: 'issuer_taken' });
    });

    it('refuses to link from a session that predates the stamp', async () => {
      const alice = await createUser({ username: 'alice', role: 'user', credential: { password: PW } });
      const before = nowIso();
      await clockTick();
      await resetUserPassword(alice.id, 'brand-new-pass-1');

      expect(await link(alice.id, 'sub-1', ISS, before)).toEqual({ status: 'stale_session' });
      expect(listExternalIdentities(alice.id)).toEqual([]);
    });

    it('refuses to link a disabled user', async () => {
      await createUser({ username: 'root', role: 'admin', credential: { password: PW } });
      const bob = await createUser({ username: 'bob', role: 'user', credential: { password: PW } });
      await updateUser(bob.id, { enabled: false });
      await clockTick();
      expect(await link(bob.id, 'sub-1')).toEqual({ status: 'user_disabled' });
    });

    it('treats a row whose owner is gone as absent: replaced, and logged', async () => {
      const alice = await createUser({ username: 'alice', role: 'user', credential: { password: PW } });
      await editRaw((s) => {
        s.externalIdentities = [{ issuer: ISS, subject: 'sub-1', userId: 'deleted-user', linkedAt: nowIso() }];
      });
      expect(await link(alice.id, 'sub-1')).toEqual({ status: 'linked' });
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('missing user deleted-user'));
      expect(((await readRaw()).externalIdentities as unknown[]).length).toBe(1);
      expect((await completeExternalIdentityLogin(ISS, 'sub-1')).status).toBe('ok');
    });
  });

  describe('classifyExternalIdentity', () => {
    it('answers with a status only, for every state', async () => {
      await createUser({ username: 'root', role: 'admin', credential: { password: PW } });
      const alice = await createUser({ username: 'alice', role: 'user', credential: { password: PW } });
      expect(classifyExternalIdentity(ISS, 'sub-1')).toBe('not_linked');
      await link(alice.id, 'sub-1');
      expect(classifyExternalIdentity(ISS, 'sub-1')).toBe('found');
      await clockTick();
      await resetUserPassword(alice.id, 'brand-new-pass-1');
      expect(classifyExternalIdentity(ISS, 'sub-1')).toBe('stale');
      await editRaw((st) => {
        st.externalIdentities = [{ issuer: ISS, subject: 'g', userId: 'ghost', linkedAt: nowIso() }];
      });
      expect(classifyExternalIdentity(ISS, 'g')).toBe('user_missing');
      await editRaw((st) => {
        st.externalIdentities = 'bad';
      });
      expect(classifyExternalIdentity(ISS, 'g')).toBe('corrupt');
    });
  });

  describe('createUser', () => {
    const sso = (username: string, subject: string, extra: { email?: string; role?: 'user' | 'readonly' } = {}) =>
      createUser({
        username,
        role: extra.role ?? 'user',
        email: extra.email ?? `${username}@example.test`,
        credential: { externalIdentity: { issuer: ISS, subject } },
      });

    it('the identity credential is passwordless: no verifiable password, no password login, marker exposed', async () => {
      const p = await sso('sso-user', 'sub-1', { email: 'sso@x.com' });
      expect(p.passwordless).toBe(true);
      expect(p.mustChangePassword).toBeUndefined();
      expect(verifyUserPassword(p.id, '')).toBe(false);
      expect((await authenticateUser('sso-user', 'anything')).status).toBe('invalid');
      expect(getUserById(p.id)?.passwordless).toBe(true);
    });

    it('mustChangePassword is not expressible on the identity branch', () => {
      // Compile-time guarantee (this file is type-checked by ts-jest).
      const ok = (input: Parameters<typeof createUser>[0]) => input;
      ok({
        username: 'x',
        role: 'user',
        email: 'x@x.com',
        mustChangePassword: true,
        // @ts-expect-error mustChangePassword is only legal with a password credential
        credential: { externalIdentity: { issuer: ISS, subject: 's' } },
      });
    });

    it('goes through the role, duplicate-name and guest-collision guards', async () => {
      await expect(
        createUser({
          username: 'x',
          role: 'superuser' as unknown as 'user',
          email: 'x@x.com',
          credential: { externalIdentity: { issuer: ISS, subject: 's' } },
        })
      ).rejects.toThrow(/Invalid role/);

      await createUser({ username: 'taken', role: 'user', credential: { password: PW } });
      await expect(sso('taken', 'sub-t')).rejects.toThrow(/already exists/);

      getAppGuestManager({
        guestsFilePath: path.join(tmpDir, 'app-guests.json'),
        invitesFilePath: path.join(tmpDir, 'app-guest-invites.json'),
      });
      await getAppGuestManager().load();
      await getAppGuestManager().resolveOrCreateGuest('guest@example.com', 'someapp', 'owner-1');
      await expect(sso('newbie', 'g', { email: 'Guest@Example.com' })).rejects.toThrow(/not available/);
      expect((await readRaw()).externalIdentities).toBeUndefined();
    });

    it('refuses an email any user already holds (JIT must not mint a twin), in the same section', async () => {
      await createUser({ username: 'holder', role: 'user', email: 'Held@Example.com', credential: { password: PW } });
      await expect(sso('twin', 'sub-2', { email: 'held@example.com' })).rejects.toThrow(/not available/);
      expect(((await readRaw()).users as { username: string }[]).some((u) => u.username === 'twin')).toBe(false);
      expect((await readRaw()).externalIdentities).toBeUndefined();
    });

    it('refuses a passwordless admin', async () => {
      await expect(
        createUser({
          username: 'boss',
          role: 'admin',
          email: 'boss@x.com',
          credential: { externalIdentity: { issuer: ISS, subject: 's' } },
        })
      ).rejects.toThrow(/cannot be an admin/);
    });

    it('updateUser refuses to promote a passwordless account to admin (beside the other role guards)', async () => {
      const p = await sso('sso-user', 'sub-1');
      await expect(updateUser(p.id, { role: 'admin' })).rejects.toThrow(/cannot be an admin/);
      expect(getUserById(p.id)?.role).toBe('user');
      expect(await updateUser(p.id, { role: 'readonly' })).toBe(true);
      // A password account is unaffected.
      const q = await createUser({ username: 'pw-user', role: 'user', credential: { password: PW } });
      expect(await updateUser(q.id, { role: 'admin' })).toBe(true);
    });

    it('creates the user AND its identity in one save', async () => {
      const p = await createUser({
        username: 'jit',
        role: 'user',
        email: 'jit@x.com',
        credential: { externalIdentity: { issuer: ISS, subject: 'sub-1' } },
      });
      const raw = await readRaw();
      expect((raw.users as { id: string }[]).some((u) => u.id === p.id)).toBe(true);
      expect(raw.externalIdentities).toEqual([
        expect.objectContaining({ issuer: ISS, subject: 'sub-1', userId: p.id, email: 'jit@x.com' }),
      ]);
      expect((await completeExternalIdentityLogin(ISS, 'sub-1')).status).toBe('ok');
    });

    it('refuses an already-linked identity and leaves no user behind', async () => {
      const alice = await createUser({ username: 'alice', role: 'user', credential: { password: PW } });
      await link(alice.id, 'sub-1');
      await expect(sso('dup', 'sub-1')).rejects.toThrow(/already linked/);
      expect(((await readRaw()).users as { username: string }[]).some((u) => u.username === 'dup')).toBe(false);
    });

    it('treats an orphaned row as absent, logging it exactly as link does', async () => {
      await editRaw((st) => {
        st.externalIdentities = [{ issuer: ISS, subject: 'sub-1', userId: 'deleted', linkedAt: nowIso() }];
      });
      const p = await sso('jit', 'sub-1');
      const rows = (await readRaw()).externalIdentities as { userId: string }[];
      expect(rows.map((r) => r.userId)).toEqual([p.id]);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('missing user deleted'));
    });

    it('resetUserPassword clears the passwordless marker and the new password then works', async () => {
      const p = await sso('sso-user', 'sub-1');
      await resetUserPassword(p.id, 'real-password-1');
      expect(getUserById(p.id)?.passwordless).toBeUndefined();
      expect(verifyUserPassword(p.id, 'real-password-1')).toBe(true);
    });

    it('containment recovery for a passwordless user: admin reset, then a re-link from a post-stamp session', async () => {
      await createUser({ username: 'root', role: 'admin', credential: { password: PW } });
      const p = await sso('sso-user', 'sub-1');
      await clockTick();
      await suspendUser(p.id);
      await updateUser(p.id, { enabled: true });
      expect((await completeExternalIdentityLogin(ISS, 'sub-1')).status).toBe('stale');

      await clockTick();
      await resetUserPassword(p.id, 'real-password-1');
      expect((await authenticateUser('sso-user', 'real-password-1')).status).toBe('ok');
      await clockTick();
      expect(await link(p.id, 'sub-1')).toEqual({ status: 'relinked' });
      expect((await completeExternalIdentityLogin(ISS, 'sub-1')).status).toBe('ok');
    });
  });

  describe('the gate (password path) and the legacy hash upgrade', () => {
    const rawHashOf = async (username: string): Promise<string> =>
      ((await readRaw()).users as { username: string; passwordHash: string }[]).find((u) => u.username === username)!
        .passwordHash;

    const plantLegacy = async (username: string, extra: Record<string, unknown> = {}) =>
      editRaw((s) => {
        const u = s.users.find((x: { username: string }) => x.username === username);
        u.passwordHash = legacyHash(PW);
        Object.assign(u, extra);
      });

    it('an ok login upgrades a legacy hash', async () => {
      await createUser({ username: 'old', role: 'user', credential: { password: PW } });
      await plantLegacy('old');
      expect((await authenticateUser('old', PW)).status).toBe('ok');
      expect(await rawHashOf('old')).toMatch(/^scrypt:/);
    });

    it('a wrong password does not upgrade', async () => {
      await createUser({ username: 'old', role: 'user', credential: { password: PW } });
      await plantLegacy('old');
      const before = await rawHashOf('old');
      expect((await authenticateUser('old', 'wrong')).status).toBe('invalid');
      expect(await rawHashOf('old')).toBe(before);
    });

    it('an MFA user is upgraded at the challenge', async () => {
      const u = await createUser({ username: 'old', role: 'user', credential: { password: PW } });
      const setup = setupMfa(u.id) as { secret: string };
      await enableMfa(u.id, PW, setup.secret, generateTotp(setup.secret, Math.floor(Date.now() / 1000)));
      await plantLegacy('old');
      expect((await authenticateUser('old', PW)).status).toBe('mfa_required');
      expect(await rawHashOf('old')).toMatch(/^scrypt:/);
    });

    it('a disabled or scope-created account is also upgraded (intended: the password matched)', async () => {
      await createUser({ username: 'off', role: 'user', credential: { password: PW } });
      await createUser({ username: 'scoped', role: 'user', credential: { password: PW } });
      await plantLegacy('off', { enabled: false });
      await plantLegacy('scoped', { createdByScope: true });
      expect((await authenticateUser('off', PW)).status).toBe('disabled');
      expect((await authenticateUser('scoped', PW)).status).toBe('awaiting_admin_password');
      expect(await rawHashOf('off')).toMatch(/^scrypt:/);
      expect(await rawHashOf('scoped')).toMatch(/^scrypt:/);
    });
  });

  describe('fix loop 3', () => {
    const sso = (username: string, subject: string, email = `${username}@example.test`) =>
      createUser({ username, role: 'user', email, credential: { externalIdentity: { issuer: ISS, subject } } });

    it('a really suspended account answers disabled (not stale); re-enabled, its old identity is stale', async () => {
      await createUser({ username: 'root', role: 'admin', credential: { password: PW } });
      const p = await sso('sso-user', 'sub-1');
      await clockTick();
      await suspendUser(p.id);
      expect((await completeExternalIdentityLogin(ISS, 'sub-1')).status).toBe('disabled');
      await updateUser(p.id, { enabled: true });
      expect((await completeExternalIdentityLogin(ISS, 'sub-1')).status).toBe('stale');
    });

    it('hasNoWorkingLoginMethod: passwordless with only stale identities, not otherwise', async () => {
      await createUser({ username: 'root', role: 'admin', credential: { password: PW } });
      const p = await sso('sso-user', 'sub-1');
      const q = await createUser({ username: 'pw-user', role: 'user', credential: { password: PW } });
      expect(hasNoWorkingLoginMethod(p.id)).toBe(false);
      await clockTick();
      await suspendUser(p.id);
      await updateUser(p.id, { enabled: true });
      expect(hasNoWorkingLoginMethod(p.id)).toBe(true);
      expect(hasNoWorkingLoginMethod(q.id)).toBe(false);
      await clockTick();
      await resetUserPassword(p.id, 'real-password-1');
      expect(hasNoWorkingLoginMethod(p.id)).toBe(false); // no longer passwordless
    });

    it('an address an identity account holds is refused to a password account, at create and at update', async () => {
      await sso('sso-user', 'sub-1', 'Held@Example.com');
      await expect(
        createUser({ username: 'late', role: 'user', email: 'held@example.com', credential: { password: PW } })
      ).rejects.toThrow('That email address is not available.');
      const q = await createUser({ username: 'q', role: 'user', email: 'q@example.com', credential: { password: PW } });
      await expect(updateUser(q.id, { email: 'HELD@example.com' })).rejects.toThrow('That email address is not available.');
      // Unchanged: password-to-password duplicates, and the identity account's own address.
      await createUser({ username: 'dup1', role: 'user', email: 'same@example.com', credential: { password: PW } });
      await createUser({ username: 'dup2', role: 'user', email: 'same@example.com', credential: { password: PW } });
      const holder = (await readRaw()).users as { id: string; username: string }[];
      const ssoId = holder.find((u) => u.username === 'sso-user')!.id;
      expect(await updateUser(ssoId, { email: 'held@example.com' })).toBe(true);
    });

    it('the identity branch requires the top-level email, and stores it on the identity', async () => {
      await expect(
        createUser({
          username: 'noemail',
          role: 'user',
          credential: { externalIdentity: { issuer: ISS, subject: 's' } },
        } as unknown as Parameters<typeof createUser>[0])
      ).rejects.toThrow(/requires an email/);
      const p = await sso('with-email', 'sub-9', 'one@example.com');
      expect(getUserById(p.id)?.email).toBe('one@example.com');
      expect((listExternalIdentities(p.id) as { email?: string }[])[0].email).toBe('one@example.com');
    });

    it('a link is refused unless the session belongs to the user being linked', async () => {
      const alice = await createUser({ username: 'alice', role: 'user', credential: { password: PW } });
      const bob = await createUser({ username: 'bob', role: 'user', credential: { password: PW } });
      expect(await link(bob.id, 'sub-1', ISS, nowIso(), alice.id)).toEqual({ status: 'session_mismatch' });
      expect(listExternalIdentities(bob.id)).toEqual([]);
    });

    it('the primitives refuse a passwordless account distinctly', async () => {
      const p = await sso('sso-user', 'sub-1');
      expect(await changePassword(p.id, 'x', 'longenough1')).toBe('passwordless');
      expect(setupMfa(p.id)).toBe('passwordless');
      expect((await enableMfa(p.id, 'x', 'SECRET', '123456')).status).toBe('passwordless');
      expect(confirmAccountPassword(p.id, 'x')).toBe('passwordless');
      const q = await createUser({ username: 'pw', role: 'user', credential: { password: PW } });
      expect(confirmAccountPassword(q.id, PW)).toBe('ok');
      expect(confirmAccountPassword(q.id, 'nope')).toBe('invalid');
      expect(await changePassword(q.id, 'nope', 'longenough1')).toBe('invalid');
    });

    it('an orphan row is logged only when the write happens', async () => {
      const alice = await createUser({ username: 'alice', role: 'user', credential: { password: PW } });
      await link(alice.id, 'a');
      await editRaw((st) => {
        st.externalIdentities.push({ issuer: ISS, subject: 'b', userId: 'ghost', linkedAt: nowIso() });
      });
      const warn = console.warn as unknown as jest.Mock;
      warn.mockClear();
      // alice already has a trusted identity at the issuer: refused, nothing written.
      expect(await link(alice.id, 'b')).toEqual({ status: 'issuer_taken' });
      expect(warn).not.toHaveBeenCalled();
      expect(((await readRaw()).externalIdentities as unknown[]).length).toBe(2);
    });
  });
});
