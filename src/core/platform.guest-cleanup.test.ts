/**
 * The platform's two guest-cleanup paths (DROP-155): app DELETION and the
 * boot SWEEP.
 *
 * Neither is enforcement — `verifyAppGuestSessionToken` re-reads the guest
 * record live on every request, so nothing here is what stops a revoked guest
 * getting in. They exist for two other reasons, and the tests are shaped
 * around those rather than around "cleanup happens":
 *
 *  - DELETION frees the app NAME. A guest record is keyed on (email, appName),
 *    and every check the verifier makes still passes for a record whose app
 *    was deleted and re-registered by someone else. That makes a left-behind
 *    guest an admission credential for the NEXT tenant's app — the same
 *    next-tenant-inherits problem the log and appdata purges exist for, with
 *    a worse artifact.
 *  - The SWEEP keeps `access.guests` readable as the authoritative answer to
 *    "who can open this app", which an operator and the share panel both read
 *    without cross-checking a second store.
 *
 * The single most important assertion in this file is the CORRUPT-STORE one.
 * With the guest store unreadable, "this guest has no record" and "this guest
 * exists and we cannot see it" are the same observation — so a sweep that
 * pruned what it could see would turn one unreadable file into permanent
 * deletion of every guest grant on the estate, on a boot nobody was watching.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DropPlatform, createPlatform } from './platform';
import {
  getAppConfigService,
  resetAppConfigService,
  type AppConfigService,
} from '../managers/app/app-config';
import { getAppGuestManager, resetAppGuests } from '../managers/app-guest';
import type { AppGuestManager } from '../managers/app-guest';

describe('platform guest cleanup (DROP-155)', () => {
  let platform: DropPlatform;
  let tempDir: string;
  let guestsFilePath: string;
  let invitesFilePath: string;
  let configService: AppConfigService;
  let guests: AppGuestManager;
  let logs: { warns: string[]; infos: string[] };

  const seedGuestPolicy = async (appName: string, guestIds: string[]): Promise<void> => {
    await configService.upsertConfig(appName, { type: 'nodejs', port: 4000 });
    await configService.setAccessPolicy(appName, () => ({
      mode: 'drop-users',
      allow: [],
      guests: guestIds,
      guestGrantedBy: Object.fromEntries(guestIds.map((id) => [id, 'owner-1'])),
    }));
  };

  const attachLogCapture = (p: DropPlatform) => {
    const warns: string[] = [];
    const infos: string[] = [];
    (p as unknown as { logger: unknown }).logger = {
      error: () => undefined,
      warn: (msg: string) => warns.push(msg),
      info: (msg: string) => infos.push(msg),
      debug: () => undefined,
      appEvent: () => undefined,
      platformEvent: () => undefined,
    } as never;
    return { warns, infos };
  };

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-guest-cleanup-'));
    guestsFilePath = path.join(tempDir, 'app-guests.json');
    invitesFilePath = path.join(tempDir, 'app-guest-invites.json');

    resetAppGuests();
    resetAppConfigService();

    configService = getAppConfigService({
      configDir: path.join(tempDir, 'appconf', 'webapps'),
      webappsDir: path.join(tempDir, 'webapps'),
    });
    await configService.initialize();

    guests = getAppGuestManager({ guestsFilePath, invitesFilePath });
    await guests.load();

    platform = createPlatform({
      dropRoot: tempDir,
      appsDirectory: path.join(tempDir, 'webapps'),
      logLevel: 'error',
      autoBuild: false,
      autoStart: false,
      caddyfilePath: path.join(tempDir, 'Caddyfile'),
      apiPort: 3000,
    });
    logs = attachLogCapture(platform);
    (platform as unknown as Record<string, unknown>).appConfigService = configService;
    (platform as unknown as Record<string, unknown>).stateManager = {
      getApp: jest.fn().mockReturnValue(undefined),
      hasApp: jest.fn().mockReturnValue(false),
    };
  });

  afterEach(async () => {
    resetAppGuests();
    resetAppConfigService();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const purge = (name: string, opts: { keepData?: boolean } = {}) =>
    (platform as unknown as {
      purgeAppArtifacts(n: string, o?: { keepData?: boolean }): Promise<void>;
    }).purgeAppArtifacts(name, opts);

  const sweep = () =>
    (platform as unknown as { pruneStaleGuestGrants(): Promise<void> }).pruneStaleGuestGrants();

  describe('purgeAppArtifacts', () => {
    it('revokes every guest of the deleted app, and only that app', async () => {
      const doomed = await guests.resolveOrCreateGuest('a@example.com', 'invoices', 'owner-1');
      const alsoDoomed = await guests.resolveOrCreateGuest('b@example.com', 'invoices', 'owner-1');
      // The SAME address on a different app is a SEPARATE record (that is the
      // store's de-dup key), and deleting `invoices` must not touch it.
      const survivor = await guests.resolveOrCreateGuest('a@example.com', 'payroll', 'owner-1');
      await seedGuestPolicy('invoices', [doomed.id, alsoDoomed.id]);
      await seedGuestPolicy('payroll', [survivor.id]);

      await purge('invoices');

      expect(guests.getGuestById(doomed.id)).toBeUndefined();
      expect(guests.getGuestById(alsoDoomed.id)).toBeUndefined();
      expect(guests.getGuestById(survivor.id)).toBeDefined();
      expect(configService.getConfig('payroll')?.access?.guests).toEqual([survivor.id]);
    });

    it('takes the app-config grants with the records, provenance included', async () => {
      const guest = await guests.resolveOrCreateGuest('a@example.com', 'invoices', 'owner-1');
      await seedGuestPolicy('invoices', [guest.id]);

      await purge('invoices');

      const access = configService.getConfig('invoices')?.access;
      expect(access?.guests ?? []).toEqual([]);
      expect(access?.guestGrantedBy ?? {}).toEqual({});
    });

    it('takes live invites with them — an invite outlives nothing', async () => {
      const guest = await guests.resolveOrCreateGuest('a@example.com', 'invoices', 'owner-1');
      const invite = await guests.mintInviteToken({
        appName: 'invoices',
        guestId: guest.id,
        email: guest.email,
        createdBy: 'owner-1',
      });
      await seedGuestPolicy('invoices', [guest.id]);

      await purge('invoices');

      expect(await guests.redeemInviteToken(invite.id, invite.secret)).toBeNull();
    });

    it('revokes guests even with keepData — a third party\u2019s grant is not the owner\u2019s data', async () => {
      // `keepData` exists so a delete-and-redeploy keeps the owner's database,
      // Redis and appdata. A grant to someone else is not that, and re-creating
      // the app must not silently re-admit people invited to the app that used
      // to be there.
      const guest = await guests.resolveOrCreateGuest('a@example.com', 'invoices', 'owner-1');
      await seedGuestPolicy('invoices', [guest.id]);

      await purge('invoices', { keepData: true });

      expect(guests.getGuestById(guest.id)).toBeUndefined();
    });

    it('touches NOTHING when the guest store is corrupt, and says so', async () => {
      const guest = await guests.resolveOrCreateGuest('a@example.com', 'invoices', 'owner-1');
      await seedGuestPolicy('invoices', [guest.id]);

      await fs.writeFile(guestsFilePath, 'not json at all');
      await guests.load();
      expect(guests.isCorrupt()).toBe(true);

      await purge('invoices');

      // The grant is still on the config: an unreadable store is not a licence
      // to strip access records we cannot verify.
      expect(configService.getConfig('invoices')?.access?.guests).toEqual([guest.id]);
      expect(logs.warns.join(' ')).toMatch(/guest store is unreadable/i);
    });
  });

  describe('pruneStaleGuestGrants', () => {
    it('drops grant entries with no backing record', async () => {
      const live = await guests.resolveOrCreateGuest('a@example.com', 'invoices', 'owner-1');
      await seedGuestPolicy('invoices', [live.id, 'guest:00000000-0000-0000-0000-000000000000']);

      await sweep();

      expect(configService.getConfig('invoices')?.access?.guests).toEqual([live.id]);
      expect(logs.infos.join(' ')).toMatch(/Pruned 1 guest grant/);
    });

    it('drops the stranded provenance entry with the grant', async () => {
      const stale = 'guest:00000000-0000-0000-0000-000000000000';
      await seedGuestPolicy('invoices', [stale]);

      await sweep();

      expect(configService.getConfig('invoices')?.access?.guestGrantedBy ?? {}).toEqual({});
    });

    it('leaves a fully-consistent estate untouched and logs nothing', async () => {
      const live = await guests.resolveOrCreateGuest('a@example.com', 'invoices', 'owner-1');
      await seedGuestPolicy('invoices', [live.id]);

      await sweep();

      expect(configService.getConfig('invoices')?.access?.guests).toEqual([live.id]);
      expect(logs.infos.join(' ')).not.toMatch(/Pruned/);
    });

    it('SKIPS ENTIRELY when the guest store is corrupt, rather than pruning what it can see', async () => {
      // The one that matters. Every id below LOOKS stale while the store is
      // unreadable, because `guestExists` cannot answer. A sweep that trusted
      // that answer would delete every guest grant on the estate in one boot.
      const live = await guests.resolveOrCreateGuest('a@example.com', 'invoices', 'owner-1');
      const other = await guests.resolveOrCreateGuest('b@example.com', 'payroll', 'owner-1');
      await seedGuestPolicy('invoices', [live.id]);
      await seedGuestPolicy('payroll', [other.id]);

      await fs.writeFile(guestsFilePath, '{ broken');
      await guests.load();
      expect(guests.isCorrupt()).toBe(true);

      await sweep();

      expect(configService.getConfig('invoices')?.access?.guests).toEqual([live.id]);
      expect(configService.getConfig('payroll')?.access?.guests).toEqual([other.id]);
      expect(logs.warns.join(' ')).toMatch(/skipping the stale-guest-grant sweep/i);
    });

    it('is safe with no app configs at all', async () => {
      await expect(sweep()).resolves.toBeUndefined();
    });
  });

  describe('sweepGuestRetention', () => {
    const retentionSweep = () =>
      (platform as unknown as { sweepGuestRetention(): Promise<void> }).sweepGuestRetention();

    const backdate = async (id: string, lastSeenAt: string) => {
      const file = guestsFilePath;
      const raw = JSON.parse(await fs.readFile(file, 'utf-8'));
      const rows = Array.isArray(raw) ? raw : raw.guests;
      for (const row of rows) if (row.id === id) row.lastSeenAt = lastSeenAt;
      await fs.writeFile(file, JSON.stringify(raw));
      await guests.load();
    };
    const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

    it('reaps an expired guest AND its grant', async () => {
      // Reaping removes both because they are one operation. An expired guest
      // losing access is the intent, not a side effect: a grant nobody has used
      // inside the window has outlived its reason.
      const stale = await guests.resolveOrCreateGuest('old@example.com', 'invoices', 'owner-1');
      const fresh = await guests.resolveOrCreateGuest('new@example.com', 'invoices', 'owner-1');
      await seedGuestPolicy('invoices', [stale.id, fresh.id]);
      await backdate(stale.id, daysAgo(200));

      await retentionSweep();

      expect(guests.getGuestById(stale.id)).toBeUndefined();
      expect(guests.getGuestById(fresh.id)).toBeDefined();
      expect(configService.getConfig('invoices')?.access?.guests).toEqual([fresh.id]);
    });

    it('does nothing while the store is corrupt', async () => {
      const guest = await guests.resolveOrCreateGuest('old@example.com', 'invoices', 'owner-1');
      await seedGuestPolicy('invoices', [guest.id]);
      await backdate(guest.id, daysAgo(200));
      await fs.writeFile(guestsFilePath, 'not json');
      await guests.load();

      await retentionSweep();

      expect(configService.getConfig('invoices')?.access?.guests).toEqual([guest.id]);
    });

    it('never logs the address it reaped', async () => {
      // A retention sweep that logged what it deleted would put the personal
      // data back into a store with a longer life than the one it removed it
      // from.
      const guest = await guests.resolveOrCreateGuest('old@example.com', 'invoices', 'owner-1');
      await seedGuestPolicy('invoices', [guest.id]);
      await backdate(guest.id, daysAgo(200));

      await retentionSweep();

      expect(logs.infos.join(' ')).toMatch(/Reaped 1 guest record/);
      expect(logs.infos.join(' ')).not.toContain('old@example.com');
    });
  });
});
