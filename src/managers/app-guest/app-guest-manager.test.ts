/**
 * AppGuestManager tests — guest records + the reaper.
 *
 * Invite token tests live in `app-guest-manager.invites.test.ts`.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  AppGuestManager,
  getAppGuestManager,
  resetAppGuests,
  getAppGuestById,
  emailHeldByAnyGuest,
  createAppGuest,
  setAppGuestDisabled,
  deleteAppGuest,
  GuestStoreCorruptError,
} from './app-guest-manager';
import * as atomicWrite from '../../utils/atomic-write';

describe('AppGuestManager — guest records', () => {
  let tempDir: string;
  let guestsFilePath: string;
  let invitesFilePath: string;
  let manager: AppGuestManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-app-guest-test-'));
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

  describe('load', () => {
    it('tolerates a missing store (starts empty, not corrupt)', () => {
      expect(manager.isCorrupt()).toBe(false);
      expect(manager.listGuests()).toEqual([]);
    });

    it('a corrupt store fails closed: every read/write refuses, and isCorrupt() reports it', async () => {
      await fs.mkdir(path.dirname(guestsFilePath), { recursive: true });
      await fs.writeFile(guestsFilePath, 'not valid json');

      await manager.load();

      expect(manager.isCorrupt()).toBe(true);
      expect(manager.listGuests()).toEqual([]);
      expect(manager.getGuestById('guest:whatever')).toBeUndefined();
      expect(manager.guestExists('guest:whatever')).toBe(false);
      await expect(manager.resolveOrCreateGuest('a@example.com', 'app1', 'admin1')).rejects.toThrow(
        GuestStoreCorruptError
      );
      await expect(manager.disableGuest('guest:whatever', 'admin1')).rejects.toThrow(GuestStoreCorruptError);
    });

    it('a valid-JSON-but-wrong-shape file is also corrupt, not "empty"', async () => {
      await fs.mkdir(path.dirname(guestsFilePath), { recursive: true });
      await fs.writeFile(guestsFilePath, JSON.stringify({ notGuests: [] }));

      await manager.load();

      expect(manager.isCorrupt()).toBe(true);
    });

    it('drops a malformed row (missing the guest: prefix) without marking the whole store corrupt', async () => {
      await fs.mkdir(path.dirname(guestsFilePath), { recursive: true });
      await fs.writeFile(
        guestsFilePath,
        JSON.stringify({
          version: 1,
          guests: [
            { id: 'not-namespaced', email: 'a@x.com', appName: 'app1', createdAt: 'x', createdBy: 'u', disabled: false },
            { id: 'guest:ok', email: 'b@x.com', appName: 'app1', createdAt: 'x', createdBy: 'u', disabled: false },
          ],
        })
      );

      await manager.load();

      expect(manager.isCorrupt()).toBe(false);
      expect(manager.getGuestById('not-namespaced')).toBeUndefined();
      expect(manager.getGuestById('guest:ok')).toBeDefined();
    });

    it('a persisted guest reloads intact under a fresh instance', async () => {
      const created = await manager.resolveOrCreateGuest('a@example.com', 'app1', 'admin1');

      const reloaded = new AppGuestManager({ guestsFilePath, invitesFilePath });
      await reloaded.load();

      expect(reloaded.getGuestById(created.id)).toEqual(created);
      await reloaded.close();
    });
  });

  describe('resolveOrCreateGuest', () => {
    it('creates a namespaced, normalized-email guest on first call', async () => {
      const record = await manager.resolveOrCreateGuest('  Someone@Example.com  ', 'app1', 'admin1');

      expect(record.id.startsWith('guest:')).toBe(true);
      expect(record.email).toBe('someone@example.com');
      expect(record.appName).toBe('app1');
      expect(record.createdBy).toBe('admin1');
      expect(record.disabled).toBe(false);
    });

    it('returns the SAME record for the same (email, app) on a second call, never a duplicate', async () => {
      const first = await manager.resolveOrCreateGuest('a@example.com', 'app1', 'admin1');
      const second = await manager.resolveOrCreateGuest('a@example.com', 'app1', 'admin2');

      expect(second.id).toBe(first.id);
      expect(second.createdBy).toBe('admin1'); // provenance of the FIRST resolver, unchanged
      expect(manager.listGuests()).toHaveLength(1);
    });

    it('the same email invited to a DIFFERENT app gets a separate guest record', async () => {
      const a = await manager.resolveOrCreateGuest('a@example.com', 'app1', 'admin1');
      const b = await manager.resolveOrCreateGuest('a@example.com', 'app2', 'admin1');

      expect(a.id).not.toBe(b.id);
      expect(manager.listGuests()).toHaveLength(2);
    });

    it('concurrent resolve-or-create for the same (email, app) yields exactly one guest', async () => {
      // Artificial delay on the underlying write so any interleaving window
      // would be real, not incidentally closed by a fast in-memory test.
      const writeSpy = jest.spyOn(atomicWrite, 'writeJsonAtomic').mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      const [a, b] = await Promise.all([
        manager.resolveOrCreateGuest('race@example.com', 'app1', 'admin1'),
        manager.resolveOrCreateGuest('race@example.com', 'app1', 'admin2'),
      ]);

      expect(a.id).toBe(b.id);
      expect(manager.listGuests().filter((g) => g.email === 'race@example.com')).toHaveLength(1);
      writeSpy.mockRestore();
    });

    it('returns a still-disabled record unmodified — no silent re-enable via re-invite', async () => {
      const created = await manager.resolveOrCreateGuest('a@example.com', 'app1', 'admin1');
      await manager.disableGuest(created.id, 'admin1');

      const resolved = await manager.resolveOrCreateGuest('a@example.com', 'app1', 'admin2');

      expect(resolved.id).toBe(created.id);
      expect(resolved.disabled).toBe(true);
    });
  });

  describe('disableGuest', () => {
    it('sets disabled, disabledBy and stamps credentialsInvalidBefore', async () => {
      const created = await manager.resolveOrCreateGuest('a@example.com', 'app1', 'admin1');

      const disabled = await manager.disableGuest(created.id, 'admin1');

      expect(disabled?.disabled).toBe(true);
      expect(disabled?.disabledBy).toBe('admin1');
      expect(disabled?.credentialsInvalidBefore).toBeDefined();
    });

    it('returns null for an unknown guest id', async () => {
      await expect(manager.disableGuest('guest:nobody', 'admin1')).resolves.toBeNull();
    });

    it('is idempotent — a second disable does not re-stamp credentialsInvalidBefore', async () => {
      const created = await manager.resolveOrCreateGuest('a@example.com', 'app1', 'admin1');
      const first = await manager.disableGuest(created.id, 'admin1');
      const stamp = first?.credentialsInvalidBefore;

      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await manager.disableGuest(created.id, 'admin2');

      expect(second?.credentialsInvalidBefore).toBe(stamp);
      expect(second?.disabledBy).toBe('admin1');
    });

    it('durability before acknowledgement: does not resolve before the write settles', async () => {
      const created = await manager.resolveOrCreateGuest('a@example.com', 'app1', 'admin1');

      // Signalled once the mock is actually INVOKED, rather than assumed
      // after N microtask ticks — `doPersistGuests` awaits a real `fs.mkdir`
      // first, which needs an actual event-loop turn (libuv), not just a
      // flushed microtask queue, so a fixed tick count is a flaky proxy for
      // "the write has started".
      let releaseWrite: (() => void) | undefined;
      let notifyWriteStarted: (() => void) | undefined;
      const writeStarted = new Promise<void>((resolve) => {
        notifyWriteStarted = resolve;
      });
      const writeSpy = jest.spyOn(atomicWrite, 'writeJsonAtomic').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releaseWrite = resolve;
            notifyWriteStarted?.();
          })
      );

      let settled = false;
      const promise = manager.disableGuest(created.id, 'admin1').then((r) => {
        settled = true;
        return r;
      });

      await writeStarted;
      // The write has started but not been released — the ack must still be pending.
      expect(settled).toBe(false);

      releaseWrite?.();
      const result = await promise;

      expect(settled).toBe(true);
      expect(result?.disabled).toBe(true);
      writeSpy.mockRestore();
    });

    it('a transient write failure does not permanently disable later saves on this store', async () => {
      const created = await manager.resolveOrCreateGuest('a@example.com', 'app1', 'admin1');

      const writeSpy = jest
        .spyOn(atomicWrite, 'writeJsonAtomic')
        .mockRejectedValueOnce(new Error('transient EBUSY'))
        .mockImplementation(async () => undefined);

      await expect(manager.disableGuest(created.id, 'admin1')).rejects.toThrow('transient EBUSY');

      // A later, unrelated write must still succeed rather than inheriting
      // the rejection from the failed one.
      const other = await manager.resolveOrCreateGuest('b@example.com', 'app1', 'admin1');
      expect(other.id).toBeDefined();

      writeSpy.mockRestore();
    });
  });

  describe('touchLastSeen', () => {
    it('updates lastSeenAt without the caller awaiting a write', async () => {
      const created = await manager.resolveOrCreateGuest('a@example.com', 'app1', 'admin1');
      expect(created.lastSeenAt).toBeUndefined();

      // Wraps the REAL implementation rather than replacing it — this test
      // still exercises a genuine write, but tracks completion so the test
      // (and this file's afterEach removing tempDir) can wait for it, rather
      // than racing it. Polls with a real short delay, not `setImmediate`:
      // the real write goes through `fs.mkdir` + `fsync` + rename, and
      // `atomic-write.ts`'s own rename-retry loop (Windows AV/indexer lock)
      // can add up to ~300ms — comfortably more than any microtask-only or
      // setImmediate-only poll would ever wait.
      const actualWrite = atomicWrite.writeJsonAtomic;
      let writeCompleted = false;
      let writeError: unknown;
      const writeSpy = jest.spyOn(atomicWrite, 'writeJsonAtomic').mockImplementation(async (...args) => {
        try {
          await actualWrite(...args);
          writeCompleted = true;
        } catch (err) {
          writeError = err;
          throw err;
        }
      });

      manager.touchLastSeen(created.id);

      // Fire-and-forget: the in-memory record is updated synchronously,
      // before the underlying write has even started.
      expect(manager.getGuestById(created.id)?.lastSeenAt).toBeDefined();
      expect(writeCompleted).toBe(false);

      for (let i = 0; i < 100 && !writeCompleted && !writeError; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (writeError) throw writeError;
      expect(writeCompleted).toBe(true);
      writeSpy.mockRestore();
    });

    it('a failed persist is caught, not an unhandled rejection, and does not throw', async () => {
      const created = await manager.resolveOrCreateGuest('a@example.com', 'app1', 'admin1');
      const writeSpy = jest.spyOn(atomicWrite, 'writeJsonAtomic').mockRejectedValue(new Error('disk full'));
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      expect(() => manager.touchLastSeen(created.id)).not.toThrow();

      // `doPersistGuests` awaits a real `fs.mkdir` before the (mocked)
      // write, so the catch's console.error is an actual event-loop turn
      // away, not just a microtask — poll with `setImmediate` (which runs
      // after pending I/O callbacks) rather than a fixed number of
      // `Promise.resolve()` ticks, which left this logging AFTER the test
      // (and its temp dir) had already torn down.
      for (let i = 0; i < 20 && errorSpy.mock.calls.length === 0; i++) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('failed to persist lastSeenAt'),
        expect.any(Error)
      );

      writeSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('is a no-op when the store is corrupt', async () => {
      await fs.mkdir(path.dirname(guestsFilePath), { recursive: true });
      await fs.writeFile(guestsFilePath, 'not valid json');
      await manager.load();

      expect(() => manager.touchLastSeen('guest:whatever')).not.toThrow();
    });
  });

  describe('reapGuest', () => {
    it('revokes app-config access BEFORE removing the local guest record', async () => {
      const created = await manager.resolveOrCreateGuest('a@example.com', 'app1', 'admin1');
      const callOrder: string[] = [];
      const pruneSpy = jest.fn().mockImplementation(async () => {
        callOrder.push('app-config-prune');
        // The local record must still exist at the moment app-config is pruned.
        expect(manager.getGuestById(created.id)).toBeDefined();
        return [];
      });

      await manager.reapGuest(created.id, { pruneAppConfigGuestEntries: pruneSpy });
      callOrder.push('local-removed');

      expect(pruneSpy).toHaveBeenCalledWith(created.id);
      expect(callOrder).toEqual(['app-config-prune', 'local-removed']);
      expect(manager.getGuestById(created.id)).toBeUndefined();
    });

    it('is idempotent for a guest id already gone from the local store (boot-pass shape)', async () => {
      const pruneSpy = jest.fn().mockResolvedValue([]);
      await expect(
        manager.reapGuest('guest:never-existed', { pruneAppConfigGuestEntries: pruneSpy })
      ).resolves.toBeUndefined();
      expect(pruneSpy).toHaveBeenCalledWith('guest:never-existed');
    });

    it('is skipped ENTIRELY when the guest store is corrupt — never prunes app-config while blind', async () => {
      await fs.mkdir(path.dirname(guestsFilePath), { recursive: true });
      await fs.writeFile(guestsFilePath, 'not valid json');
      await manager.load();
      expect(manager.isCorrupt()).toBe(true);

      const pruneSpy = jest.fn().mockResolvedValue([]);
      await manager.reapGuest('guest:whatever', { pruneAppConfigGuestEntries: pruneSpy });

      expect(pruneSpy).not.toHaveBeenCalled();
    });

    it('propagates an error from the app-config prune rather than silently removing the local record anyway', async () => {
      const created = await manager.resolveOrCreateGuest('a@example.com', 'app1', 'admin1');
      const pruneSpy = jest.fn().mockRejectedValue(new Error('app-config write failed'));

      await expect(
        manager.reapGuest(created.id, { pruneAppConfigGuestEntries: pruneSpy })
      ).rejects.toThrow('app-config write failed');

      // Access was not confirmed revoked, so the local record must still be there.
      expect(manager.getGuestById(created.id)).toBeDefined();
    });
  });

  describe('emailHeldByAnyGuest', () => {
    it('is true once ANY guest holds the email, regardless of which app', async () => {
      await manager.resolveOrCreateGuest('taken@example.com', 'app1', 'admin1');

      expect(manager.emailHeldByAnyGuest('taken@example.com')).toBe(true);
      expect(manager.emailHeldByAnyGuest('Taken@Example.com')).toBe(true); // normalized
      expect(manager.emailHeldByAnyGuest('free@example.com')).toBe(false);
    });

    it('THROWS rather than returning false when the store is corrupt — the opposite polarity from the other reads', async () => {
      await fs.mkdir(path.dirname(guestsFilePath), { recursive: true });
      await fs.writeFile(guestsFilePath, 'not valid json');
      await manager.load();
      expect(manager.isCorrupt()).toBe(true);

      expect(() => manager.emailHeldByAnyGuest('anyone@example.com')).toThrow(GuestStoreCorruptError);
    });
  });

  describe('singleton + getAppGuestById (session-token.ts contract)', () => {
    it('getAppGuestById is synchronous and reads the singleton', async () => {
      resetAppGuests();
      const singleton = getAppGuestManager({ guestsFilePath, invitesFilePath });
      await singleton.load();
      const created = await singleton.resolveOrCreateGuest('a@example.com', 'app1', 'admin1');

      const result = getAppGuestById(created.id);

      expect(result).toEqual(created);
    });

    it('getAppGuestById returns undefined for an unknown id, synchronously', () => {
      resetAppGuests();
      getAppGuestManager({ guestsFilePath, invitesFilePath });
      expect(getAppGuestById('guest:nope')).toBeUndefined();
    });
  });

  describe('module-level convenience exports (session-token.test.ts contract)', () => {
    beforeEach(async () => {
      resetAppGuests();
      const singleton = getAppGuestManager({ guestsFilePath, invitesFilePath });
      await singleton.load();
    });

    it('createAppGuest(appName, email) resolves-or-creates with that argument order', async () => {
      const guest = await createAppGuest('app1', 'a@example.com');
      expect(guest.appName).toBe('app1');
      expect(guest.email).toBe('a@example.com');
      expect(guest.createdBy).toBe('system');
    });

    it('setAppGuestDisabled(id, true) disables', async () => {
      const guest = await createAppGuest('app1', 'a@example.com');
      const result = await setAppGuestDisabled(guest.id, true);
      expect(result?.disabled).toBe(true);
    });

    it('setAppGuestDisabled(id, false) REJECTS (not a synchronous throw) — there is no re-enable', async () => {
      const guest = await createAppGuest('app1', 'a@example.com');
      // A synchronous `throw` out of an `async`-typed function would bypass
      // `.catch()` entirely — assert the rejection form directly, which is
      // what distinguishes this from a plain function that happens to throw.
      await expect(setAppGuestDisabled(guest.id, false)).rejects.toThrow(
        /cannot be re-enabled/
      );
    });

    it('deleteAppGuest removes the guest (via the reaper, app-config prune skipped when uninitialized)', async () => {
      const guest = await createAppGuest('app1', 'a@example.com');
      await deleteAppGuest(guest.id);
      expect(getAppGuestById(guest.id)).toBeUndefined();
    });

    it('emailHeldByAnyGuest sees a guest created through createAppGuest', async () => {
      await createAppGuest('app1', 'a@example.com');
      expect(emailHeldByAnyGuest('a@example.com')).toBe(true);
      expect(emailHeldByAnyGuest('nobody@example.com')).toBe(false);
    });
  });
});
