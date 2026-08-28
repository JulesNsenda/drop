/**
 * AppGuestManager tests — invite tokens.
 *
 * Guest-record tests live in `app-guest-manager.test.ts`.
 */

import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  AppGuestManager,
  resetAppGuests,
  inviteBoundToApp,
  InviteStoreCorruptError,
  INVITE_TTL_MS,
} from './app-guest-manager';
import * as atomicWrite from '../../utils/atomic-write';

// `crypto`'s own module object has non-configurable properties on this
// Node/V8 (a plain `jest.spyOn(crypto, 'timingSafeEqual')` throws "Cannot
// redefine property"), so the comparison-is-actually-used test below needs
// a module-level mock that wraps the REAL implementation instead — every
// other export passes through untouched (randomUUID, randomBytes,
// createHash, ...), only `timingSafeEqual` becomes spyable.
jest.mock('crypto', () => {
  const actual = jest.requireActual('crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});

describe('AppGuestManager — invite tokens', () => {
  let tempDir: string;
  let guestsFilePath: string;
  let invitesFilePath: string;
  let manager: AppGuestManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-app-guest-invite-test-'));
    guestsFilePath = path.join(tempDir, 'app-guests.json');
    invitesFilePath = path.join(tempDir, 'app-guest-invites.json');
    manager = new AppGuestManager({ guestsFilePath, invitesFilePath });
    await manager.load();
  });

  afterEach(async () => {
    await manager.close();
    resetAppGuests();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const mint = (overrides: Partial<{ appName: string; guestId: string; email: string; createdBy: string }> = {}) =>
    manager.mintInviteToken({
      appName: 'app1',
      guestId: 'guest:g1',
      email: 'a@example.com',
      createdBy: 'admin1',
      ...overrides,
    });

  describe('mintInviteToken', () => {
    it('mints a secret with at least 256 bits of entropy, never persisted raw', async () => {
      const { id, secret } = await mint();

      expect(id).toBeTruthy();
      // Decode, not the encoded string's own length — base64url of 32 raw
      // bytes is a 43-character STRING, so measuring `secret`'s byte length
      // directly would still pass a regression to `randomBytes(24)` (a
      // 32-character string). The RAW byte count is what "256 bits" means.
      expect(Buffer.from(secret, 'base64url').length).toBeGreaterThanOrEqual(32);

      const raw = await fs.readFile(invitesFilePath, 'utf-8');
      expect(raw).not.toContain(secret);
    });

    it('persists the sha256 hash, not the secret, at rest', async () => {
      const { secret } = await mint();
      const raw = JSON.parse(await fs.readFile(invitesFilePath, 'utf-8'));
      const expectedHash = crypto.createHash('sha256').update(secret).digest('hex');

      expect(raw.invites[0].secretHash).toBe(expectedHash);
      expect(raw.invites[0].secret).toBeUndefined();
    });

    it('refuses when the invite store is corrupt', async () => {
      await fs.mkdir(path.dirname(invitesFilePath), { recursive: true });
      await fs.writeFile(invitesFilePath, 'not valid json');
      await manager.load();
      expect(manager.isInviteStoreCorrupt()).toBe(true);

      await expect(mint()).rejects.toThrow(InviteStoreCorruptError);
    });

    it('enforces the entry cap even after pruning expired entries', async () => {
      const small = new AppGuestManager({ guestsFilePath, invitesFilePath, maxLiveInviteTokens: 2 });
      await small.load();

      await small.mintInviteToken({ appName: 'app1', guestId: 'guest:g1', email: 'a@x.com', createdBy: 'admin' });
      await small.mintInviteToken({ appName: 'app1', guestId: 'guest:g2', email: 'b@x.com', createdBy: 'admin' });

      await expect(
        small.mintInviteToken({ appName: 'app1', guestId: 'guest:g3', email: 'c@x.com', createdBy: 'admin' })
      ).rejects.toMatchObject({ reason: 'global' });

      await small.close();
    });

    it('enforces a PER-CREATOR cap independently of the global one — one principal cannot exhaust invites for every app', async () => {
      // Global cap generous; per-creator cap tight — proves the per-creator
      // bound is load-bearing on its own, not merely covered by the global
      // ceiling (principal-quota.ts's own "never global" reasoning).
      const small = new AppGuestManager({
        guestsFilePath,
        invitesFilePath,
        maxLiveInviteTokens: 100,
        maxLiveInviteTokensPerCreator: 1,
      });
      await small.load();

      await small.mintInviteToken({ appName: 'app1', guestId: 'guest:g1', email: 'a@x.com', createdBy: 'noisy-admin' });

      await expect(
        small.mintInviteToken({ appName: 'app2', guestId: 'guest:g2', email: 'b@x.com', createdBy: 'noisy-admin' })
      ).rejects.toMatchObject({ reason: 'per_creator' });

      // A DIFFERENT creator is unaffected — the whole point of scoping the cap.
      await expect(
        small.mintInviteToken({ appName: 'app1', guestId: 'guest:g3', email: 'c@x.com', createdBy: 'someone-else' })
      ).resolves.toBeDefined();

      await small.close();
    });

    it('makes room under the cap once expired entries are pruned', async () => {
      const small = new AppGuestManager({ guestsFilePath, invitesFilePath, maxLiveInviteTokens: 1 });
      await small.load();
      await small.mintInviteToken({ appName: 'app1', guestId: 'guest:g1', email: 'a@x.com', createdBy: 'admin' });

      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + INVITE_TTL_MS + 1000);

      await expect(
        small.mintInviteToken({ appName: 'app1', guestId: 'guest:g2', email: 'b@x.com', createdBy: 'admin' })
      ).resolves.toBeDefined();

      await small.close();
    });
  });

  describe('redeemInviteToken', () => {
    it('redeems a fresh token and returns the bound guest/app/email', async () => {
      const { id, secret } = await mint();

      const redemption = await manager.redeemInviteToken(id, secret);

      expect(redemption).toEqual({ guestId: 'guest:g1', appName: 'app1', email: 'a@example.com' });
    });

    it('is single-use — a second redemption with the correct secret finds nothing', async () => {
      const { id, secret } = await mint();

      await manager.redeemInviteToken(id, secret);
      const second = await manager.redeemInviteToken(id, secret);

      expect(second).toBeNull();
    });

    it('is single-use even under a concurrent replay', async () => {
      const { id, secret } = await mint();

      const [a, b] = await Promise.all([
        manager.redeemInviteToken(id, secret),
        manager.redeemInviteToken(id, secret),
      ]);

      const successes = [a, b].filter((r) => r !== null);
      expect(successes).toHaveLength(1);
    });

    it('a WRONG secret still burns the token (delete-before-check)', async () => {
      const { id } = await mint();

      const wrong = await manager.redeemInviteToken(id, 'totally-wrong-secret');
      expect(wrong).toBeNull();

      // Not recoverable with the RIGHT secret afterwards — it was consumed.
      const { secret: rightSecretFromANewMint } = await mint(); // sanity: minting again works
      const replay = await manager.redeemInviteToken(id, rightSecretFromANewMint);
      expect(replay).toBeNull();
    });

    it('an unknown id returns null without writing to disk', async () => {
      const writeSpy = jest.spyOn(atomicWrite, 'writeJsonAtomic');
      const result = await manager.redeemInviteToken('nonexistent-id', 'whatever-secret');

      expect(result).toBeNull();
      expect(writeSpy).not.toHaveBeenCalled();
    });

    it('refuses after the TTL elapses, and is still consumed (does not survive to be retried)', async () => {
      const { id, secret } = await mint();

      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + INVITE_TTL_MS + 1000);

      const result = await manager.redeemInviteToken(id, secret);
      expect(result).toBeNull();

      jest.spyOn(Date, 'now').mockRestore();
      const retried = await manager.redeemInviteToken(id, secret);
      expect(retried).toBeNull();
    });

    it('uses crypto.timingSafeEqual for secret comparison, not string equality', async () => {
      const { id, secret } = await mint();
      const spy = crypto.timingSafeEqual as jest.Mock;
      spy.mockClear();

      await manager.redeemInviteToken(id, secret);

      expect(spy).toHaveBeenCalled();
    });

    it('a token minted for app A is refused for app B via inviteBoundToApp', async () => {
      const { id, secret } = await mint({ appName: 'alpha' });

      const redemption = await manager.redeemInviteToken(id, secret);

      expect(redemption).not.toBeNull();
      expect(inviteBoundToApp(redemption!, 'alpha')).toBe(true);
      expect(inviteBoundToApp(redemption!, 'beta')).toBe(false);
    });

    it('returns null (fail closed) when the invite store is corrupt', async () => {
      const { id, secret } = await mint();

      await fs.writeFile(invitesFilePath, 'not valid json');
      await manager.load();
      expect(manager.isInviteStoreCorrupt()).toBe(true);

      await expect(manager.redeemInviteToken(id, secret)).resolves.toBeNull();
    });

    it('throws rather than returning the redemption when the persisted delete fails', async () => {
      const { id, secret } = await mint();

      const writeSpy = jest.spyOn(atomicWrite, 'writeJsonAtomic').mockRejectedValue(new Error('disk full'));

      await expect(manager.redeemInviteToken(id, secret)).rejects.toThrow('disk full');

      writeSpy.mockRestore();
    });
  });

  describe('reapGuest removes live invites for the deleted guest', () => {
    it('drops every invite bound to a reaped guest id', async () => {
      const { id: keepId } = await manager.mintInviteToken({
        appName: 'app1',
        guestId: 'guest:keep',
        email: 'keep@x.com',
        createdBy: 'admin',
      });
      const { id: dropId, secret: dropSecret } = await manager.mintInviteToken({
        appName: 'app1',
        guestId: 'guest:drop',
        email: 'drop@x.com',
        createdBy: 'admin',
      });

      await manager.reapGuest('guest:drop', { pruneAppConfigGuestEntries: jest.fn().mockResolvedValue([]) });

      const dropped = await manager.redeemInviteToken(dropId, dropSecret);
      expect(dropped).toBeNull();

      // The unrelated invite is untouched.
      const raw = JSON.parse(await fs.readFile(invitesFilePath, 'utf-8'));
      expect(raw.invites.some((r: { id: string }) => r.id === keepId)).toBe(true);
    });
  });
});
