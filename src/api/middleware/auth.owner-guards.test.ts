/**
 * Guards that must accompany API-key ownership resolution (DROP-075).
 *
 * Resolving `AuthContext.userId` to a key's `ownerUserId` removes an ACCIDENTAL
 * containment: while a key's userId was its own id, the key owned nothing and
 * matched no user record, so several under-gated paths were inert. Making the
 * key act as its owner arms them. These tests pin the guards that replace the
 * accident with an actual decision.
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
  suspendUser,
  deleteUser,
  updateUser,
  listApiKeys,
  verifyUserPassword,
} from './auth';
import { clockTick } from '../__testutils__/auth';

const PASSWORD = 'pw-bob-123456';

describe('API-key ownership guards', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-owner-guards-'));
    await initializeAuth({ credentialsPath: path.join(tmpDir, 'api-credentials.json') });
  });

  afterEach(async () => {
    resetAuth();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('a key stops working when its owner does', () => {
    it('rejects a key whose owner has been deleted', async () => {
      const bob = await createUser('bob', PASSWORD, 'user');
      const { key } = await createApiKey('bob-ci', 'user', undefined, undefined, bob.id);

      expect(await verifyApiKey(key)).not.toBeNull();

      await deleteUser(bob.id);

      // Otherwise the key keeps authenticating as bob's userId forever, with
      // canAccess to every app stamped with it and no account left to revoke.
      expect(await verifyApiKey(key)).toBeNull();
    });

    it('rejects a key whose owner has been suspended', async () => {
      const bob = await createUser('bob', PASSWORD, 'user');
      const { key } = await createApiKey('bob-ci', 'user', undefined, undefined, bob.id);

      // The key must provably PREDATE the stamp suspendUser writes; without
      // this both can land in one millisecond and the assertion inverts.
      await clockTick();
      await suspendUser(bob.id);

      expect(await verifyApiKey(key)).toBeNull();
    });

    it('rejects a key whose owner was disabled via updateUser', async () => {
      const bob = await createUser('bob', PASSWORD, 'user');
      const { key } = await createApiKey('bob-ci', 'user', undefined, undefined, bob.id);

      await clockTick();
      await updateUser(bob.id, { enabled: false });

      expect(await verifyApiKey(key)).toBeNull();
    });

    it('deleting a user also revokes their keys from the store', async () => {
      const bob = await createUser('bob', PASSWORD, 'user');
      const carol = await createUser('carol', 'pw-carol-12345', 'user');
      await createApiKey('bob-ci', 'user', undefined, undefined, bob.id);
      await createApiKey('carol-ci', 'user', undefined, undefined, carol.id);

      await deleteUser(bob.id);

      const names = listApiKeys().map(k => k.name);
      expect(names).not.toContain('bob-ci');
      expect(names).toContain('carol-ci');
    });

    it('suspending a user revokes their keys, as its docstring always promised', async () => {
      // The MECHANISM changed (DROP-130 Item 4): the key is no longer purged
      // from the store — it is stamped out of standing instead — but the
      // promise the docstring makes (the key stops working) still holds.
      const bob = await createUser('bob', PASSWORD, 'user');
      const { key } = await createApiKey('bob-ci', 'user', undefined, undefined, bob.id);

      await clockTick();
      await suspendUser(bob.id);

      expect(await verifyApiKey(key)).toBeNull();

      // The reversibility test: un-suspending must NOT resurrect a credential
      // that existed at suspension time — that would silently hand back
      // whatever the suspension was meant to contain. A key minted AFTER
      // re-enable must work normally.
      await updateUser(bob.id, { enabled: true });

      expect(await verifyApiKey(key)).toBeNull();

      // ...and the fresh key must provably POSTDATE the stamp, the mirror-image
      // ordering. Re-enabling does not re-stamp (setUserEnabled stamps only on
      // the transition TO disabled), so this ticks past the SUSPENSION stamp.
      await clockTick();
      const { key: freshKey } = await createApiKey('bob-ci-2', 'user', undefined, undefined, bob.id);
      expect(await verifyApiKey(freshKey)).not.toBeNull();
    });

    it('DROP-130 HIGH-1: the DASHBOARD disable path (updateUser, not suspendUser) is reversible-safe too', async () => {
      // UsersPage.tsx disables a user via PUT /auth/users/:id {enabled:false}
      // -> updateUser — never POST /admin/users/:id/suspend -> suspendUser.
      // Before HIGH-1, only suspendUser stamped `credentialsInvalidBefore`;
      // updateUser just flipped the flag. A disable -> re-enable cycle through
      // the ACTUAL dashboard path therefore resurrected every key verbatim,
      // even though the test above (which goes through suspendUser) looked
      // green the whole time.
      const bob = await createUser('bob-dashboard-disable', PASSWORD, 'user');
      const { key } = await createApiKey('bob-dashboard-ci', 'user', undefined, undefined, bob.id);

      await clockTick();
      await updateUser(bob.id, { enabled: false });
      expect(await verifyApiKey(key)).toBeNull();

      await updateUser(bob.id, { enabled: true });

      // The pre-existing key must NOT come back just because the account did.
      expect(await verifyApiKey(key)).toBeNull();

      await clockTick();
      const { key: freshKey } = await createApiKey(
        'bob-dashboard-ci-2',
        'user',
        undefined,
        undefined,
        bob.id
      );
      expect(await verifyApiKey(freshKey)).not.toBeNull();
    });

    it('leaves legacy ownerless keys alone when an unrelated user is deleted', async () => {
      const bob = await createUser('bob', PASSWORD, 'user');
      const { key } = await createApiKey('legacy', 'user');

      await deleteUser(bob.id);

      expect(await verifyApiKey(key)).not.toBeNull();
    });
  });

  describe('verifyUserPassword', () => {
    // Backs the password confirmation now required to delete an account.
    it('accepts the correct password for a user id', async () => {
      const bob = await createUser('bob', PASSWORD, 'user');
      expect(verifyUserPassword(bob.id, PASSWORD)).toBe(true);
    });

    it('rejects a wrong password', async () => {
      const bob = await createUser('bob', PASSWORD, 'user');
      expect(verifyUserPassword(bob.id, 'not-the-password')).toBe(false);
    });

    it('rejects an unknown user id without throwing', async () => {
      expect(verifyUserPassword('no-such-user', PASSWORD)).toBe(false);
    });

    it('rejects an API key id (keys are not user-backed principals)', async () => {
      const bob = await createUser('bob', PASSWORD, 'user');
      const { apiKey } = await createApiKey('bob-ci', 'user', undefined, undefined, bob.id);

      expect(verifyUserPassword(apiKey.id, PASSWORD)).toBe(false);
    });
  });
});
