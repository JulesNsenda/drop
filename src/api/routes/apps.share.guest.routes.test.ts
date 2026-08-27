/**
 * The owner surface for GUESTS (DROP-155 wave 3c).
 *
 * The `{ email }` branch, the guest revoke route, and the three places the
 * DROP-152/153 rules had to learn that a second list of people exists.
 *
 * Section B of the plan is what most of this is about, and it is worth
 * restating because it is not obvious: `[].every()` is `true`. An app gated by
 * an ADMIN whose entire population was admin-INVITED GUESTS therefore passed
 * the "every allow entry is requester-authored" test on an empty `allow`, and
 * could be cleared — un-gating it — by any owner. The same blind spot made the
 * entry cap and the owner's own view count only half the people with access.
 *
 * The refusals are uniform on purpose. An owner who could tell "that address
 * belongs to a DROP account" from "that address has never been seen" would
 * have a directory oracle over every account on the platform, one address at a
 * time.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createUser, updateUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager } from '../../managers/app/state-manager';
import { setPlatformOps, resetPlatformOps, type PlatformOps } from '../platform-ops';
import { makePlatformOpsStub } from '../__testutils__/platform-ops';
import {
  createTestApiServer,
  teardownTestApiServer,
  type TestApiServer,
} from '../__testutils__/api-server';
import {
  getAppConfigService,
  resetAppConfigService,
  type AppAccessPolicy,
} from '../../managers/app/app-config';
import { getSettingsManager, resetSettingsManager } from '../../managers/settings/settings-manager';
import { getMailQuota, resetMailQuota } from '../../managers/guardrail/principal-quota';
import { setPublicUrl, setApiRuntimeConfig } from '../runtime-config';
import { getAppGuestManager, resetAppGuests } from '../../managers/app-guest';
import * as mailer from '../../managers/mailer/mailer';

const APP = 'myapp';

const ENFORCEABLE = {
  enforceable: true,
  blockers: [],
  reasons: [],
  featureEnabled: true,
};

describe('/apps/:name/share — the guest branch (DROP-155)', () => {
  let t: TestApiServer;
  let ownerToken: string;
  let ownerId: string;
  let adminToken: string;
  let adminId: string;
  let otherOwnerId: string;
  let sendMock: jest.SpyInstance;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  const post = (headers: Record<string, string>, body: unknown) =>
    t.hono.request(`/api/v1/apps/${APP}/share`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const get = (headers: Record<string, string>) =>
    t.hono.request(`/api/v1/apps/${APP}/share`, { headers });

  const delGuest = (guestId: string, headers: Record<string, string>) =>
    t.hono.request(`/api/v1/apps/${APP}/share/guests/${guestId}`, { method: 'DELETE', headers });

  const delAll = (headers: Record<string, string>) =>
    t.hono.request(`/api/v1/apps/${APP}/share`, { method: 'DELETE', headers });

  const bodyOf = async (res: Response) =>
    (await res.json()) as {
      data?: {
        inviteUrl?: string;
        mailSent?: boolean;
        message?: string;
        revoked?: boolean;
        ownGuests?: { guestId: string; email: string; disabled: boolean }[];
        ownGrants?: { userId: string }[];
        othersGrantedCount?: number;
      };
      error?: { message: string };
    };

  const policy = (): AppAccessPolicy | undefined =>
    getAppConfigService().getConfig(APP)?.access;

  const seedPolicy = (over: Partial<AppAccessPolicy> = {}) =>
    getAppConfigService().setAccessPolicy(APP, () => ({
      mode: 'drop-users' as const,
      allow: [],
      ...over,
    }));

  beforeEach(async () => {
    resetAppConfigService();
    resetSettingsManager();
    resetAppGuests();
    resetMailQuota();

    t = await createTestApiServer({
      port: 3181,
      tempPrefix: 'drop-share-guest-',
      activityLog: true,
    });

    await fs.mkdir(path.join(t.tempDir, 'appconf'), { recursive: true });
    await fs.mkdir(path.join(t.tempDir, 'webapps', APP), { recursive: true });
    getAppConfigService({
      configDir: path.join(t.tempDir, 'appconf'),
      webappsDir: path.join(t.tempDir, 'webapps'),
    });
    await getAppConfigService().upsertConfig(APP, { type: 'nodejs', port: 4000 });

    getAppGuestManager({
      guestsFilePath: path.join(t.tempDir, 'app-guests.json'),
      invitesFilePath: path.join(t.tempDir, 'app-guest-invites.json'),
    });
    await getAppGuestManager().load();

    getSettingsManager({ settingsFilePath: path.join(t.tempDir, 'settings.json') });
    await getSettingsManager().setAppSharingEnabled(true);
    await getSettingsManager().setGuestInvitesEnabled(true);

    getMailQuota(path.join(t.tempDir, 'mail-quotas.json'));
    setPublicUrl('https://dashboard.example.com');
    setApiRuntimeConfig({ domainSuffix: 'dropkit.sh' });
    // The default: no relay reachable, so nothing is sent. That is the state
    // this box is actually in, and the state `inviteUrl` exists for.
    sendMock = jest.spyOn(mailer, 'sendTemplatedMail').mockResolvedValue({ status: 'unavailable' });

    const admin = await createUser('gov', 'password123', 'admin');
    adminId = admin.id;
    adminToken = await getTestToken('gov', 'password123');
    const owner = await createUser('owner', 'password123', 'user');
    ownerId = owner.id;
    ownerToken = await getTestToken('owner', 'password123');
    const other = await createUser('other-owner', 'password123', 'user');
    otherOwnerId = other.id;

    const sm = getStateManager();
    await sm.registerApp(APP, path.join(t.tempDir, 'webapps', APP), 'nodejs');
    await sm.updateApp(APP, { userId: ownerId, port: 4000 });

    setPlatformOps(
      makePlatformOpsStub({
        assessAccessGate: jest.fn().mockResolvedValue(ENFORCEABLE),
      } as Partial<PlatformOps>)
    );
  });

  afterEach(async () => {
    sendMock.mockRestore();
    setPublicUrl(undefined);
    resetPlatformOps();
    resetAppConfigService();
    resetSettingsManager();
    resetAppGuests();
    resetMailQuota();
    resetAuth();
    await teardownTestApiServer(t);
  });

  describe('POST { email }', () => {
    it('is refused while the operator opt-in is off', async () => {
      await getSettingsManager().setGuestInvitesEnabled(false);

      const res = await post(bearer(ownerToken), { email: 'v@example.com', gateApp: true });

      expect(res.status).toBe(403);
      // Nothing was created on the way to the refusal.
      expect(getAppGuestManager().listGuests()).toHaveLength(0);
    });

    it('refuses username and email together rather than silently preferring one', async () => {
      const res = await post(bearer(ownerToken), {
        username: 'gov',
        email: 'v@example.com',
        gateApp: true,
      });
      expect(res.status).toBe(400);
    });

    it('invites, records provenance, and returns the link when no relay is configured', async () => {
      const res = await post(bearer(ownerToken), { email: 'Visitor@Example.COM', gateApp: true });

      expect(res.status).toBe(200);
      const body = await bodyOf(res);
      expect(body.data?.mailSent).toBe(false);

      const guests = getAppGuestManager().listGuests();
      expect(guests).toHaveLength(1);
      // Normalized on the way in — one mailbox is one identity however typed.
      expect(guests[0].email).toBe('visitor@example.com');

      expect(policy()?.guests).toEqual([guests[0].id]);
      expect(policy()?.guestGrantedBy).toEqual({ [guests[0].id]: ownerId });

      // The link is on the PLATFORM origin, carries the id in the path and the
      // secret in the fragment, and never names the app's own hostname.
      const url = new URL(body.data?.inviteUrl as string);
      expect(url.origin).toBe('https://dashboard.example.com');
      expect(url.pathname).toBe(`/api/v1/app-access/invite/${url.pathname.split('/').pop()}`);
      expect(url.hash.length).toBeGreaterThan(1);
      expect(body.data?.inviteUrl).not.toContain('dropkit.sh');
    });

    it('does NOT return the link when the relay was actually dialed', async () => {
      // `attempted` means the message may yet be delivered, so handing the
      // link back as well would widen the disclosure for no gain.
      sendMock.mockResolvedValue({ status: 'attempted' });

      const body = await bodyOf(
        await post(bearer(ownerToken), { email: 'v@example.com', gateApp: true })
      );

      expect(body.data?.mailSent).toBe(true);
      expect(body.data?.inviteUrl).toBeUndefined();
    });

    it('refuses an address that belongs to a DROP account, with no guest created', async () => {
      await updateUser(adminId, { email: 'gov@example.com' });

      const res = await post(bearer(ownerToken), { email: 'GOV@example.com', gateApp: true });

      expect(res.status).toBe(400);
      expect(getAppGuestManager().listGuests()).toHaveLength(0);
    });

    it('refuses an unknown address the SAME way it refuses a taken one', async () => {
      // The oracle check: the two answers must be indistinguishable in status
      // and message, or an owner can enumerate accounts one address at a time.
      await updateUser(adminId, { email: 'gov@example.com' });
      await seedPolicy();

      const taken = await post(bearer(ownerToken), { email: 'gov@example.com', gateApp: true });
      const malformed = await post(bearer(ownerToken), { email: 'not-an-email', gateApp: true });

      expect(malformed.status).toBe(taken.status);
    });

    it('refuses to create a policy without gateApp, leaving no guest behind', async () => {
      const res = await post(bearer(ownerToken), { email: 'v@example.com' });

      expect(res.status).toBe(409);
      // The pre-check exists for exactly this: `resolveOrCreateGuest` would
      // otherwise have created a record holding the address against the
      // collision rule for a grant that was never made.
      expect(getAppGuestManager().listGuests()).toHaveLength(0);
    });

    it('is idempotent — a re-invite mints a fresh link without a second entry', async () => {
      const first = await bodyOf(
        await post(bearer(ownerToken), { email: 'v@example.com', gateApp: true })
      );
      const second = await bodyOf(
        await post(bearer(ownerToken), { email: 'v@example.com', gateApp: true })
      );

      expect(policy()?.guests).toHaveLength(1);
      expect(second.data?.inviteUrl).not.toBe(first.data?.inviteUrl);
    });
  });

  describe('the cap counts PEOPLE, not lists', () => {
    it('refuses a guest once allow + guests reaches the cap', async () => {
      // Two independent caps would let an owner admit twice as many people by
      // alternating between the lists.
      const allow = Array.from({ length: 200 }, (_, i) => `user-${i}`);
      await seedPolicy({ allow });

      const res = await post(bearer(ownerToken), { email: 'v@example.com', gateApp: true });

      expect(res.status).toBe(409);
      expect((await bodyOf(res)).error?.message).toContain('200 people with access');
    });

    it('counts existing guests against a USERNAME grant too', async () => {
      const guests = Array.from({ length: 200 }, (_, i) => `guest:${i}`);
      await seedPolicy({ guests });
      await createUser('alice', 'password123', 'user');

      const res = await post(bearer(ownerToken), { username: 'alice' });

      expect(res.status).toBe(409);
    });
  });

  describe('the clear-all rule sees guests (plan section B)', () => {
    it('refuses an owner clearing a policy holding an ADMIN-invited guest', async () => {
      // `[].every()` is true, so before DROP-155 an empty `allow` plus a full
      // `guests` list cleared cleanly — un-gating an app an admin had gated.
      await seedPolicy({
        allow: [],
        guests: ['guest:admin-invited'],
        guestGrantedBy: { 'guest:admin-invited': adminId },
      });

      const res = await delAll(bearer(ownerToken));

      expect(res.status).toBe(409);
      expect(policy()).toBeDefined();
    });

    it('still lets an owner clear a policy that is entirely their own', async () => {
      await seedPolicy({
        allow: [],
        guests: ['guest:mine'],
        guestGrantedBy: { 'guest:mine': ownerId },
      });

      const res = await delAll(bearer(ownerToken));

      expect(res.status).toBe(200);
      expect(policy()).toBeUndefined();
    });
  });

  describe('ownView', () => {
    it('shows the caller their own invitees and counts everyone else as a number', async () => {
      await seedPolicy({
        allow: [],
        guests: ['guest:mine', 'guest:theirs'],
        guestGrantedBy: { 'guest:mine': ownerId, 'guest:theirs': otherOwnerId },
      });

      const body = await bodyOf(await get(bearer(ownerToken)));

      expect(body.data?.ownGuests?.map(g => g.guestId)).toEqual(['guest:mine']);
      // Someone else's invitee is a COUNT, never an address — the same rule
      // `grantedBy` enforces for account grants.
      expect(body.data?.othersGrantedCount).toBe(1);
    });
  });

  describe('DELETE /share/guests/:guestId', () => {
    const invite = async (email: string, token = ownerToken) => {
      await post(bearer(token), { email, gateApp: true });
      const record = getAppGuestManager().listGuests().find(g => g.email === email);
      return record!;
    };

    it('lets the owner revoke someone they invited, and takes live invites with it', async () => {
      const guest = await invite('v@example.com');
      const live = await getAppGuestManager().mintInviteToken({
        appName: APP,
        guestId: guest.id,
        email: guest.email,
        createdBy: ownerId,
      });

      const res = await delGuest(guest.id, bearer(ownerToken));

      expect(res.status).toBe(200);
      expect((await bodyOf(res)).data?.revoked).toBe(true);
      expect(policy()?.guests ?? []).toEqual([]);
      expect(policy()?.guestGrantedBy ?? {}).toEqual({});
      expect(getAppGuestManager().getGuestById(guest.id)).toBeUndefined();
      // A revoke that left an invite redeemable would put the same person back
      // on the list with one click.
      expect(await getAppGuestManager().redeemInviteToken(live.id, live.secret)).toBeNull();
    });

    it('is a silent no-op for a guest the caller did not invite', async () => {
      const guest = await invite('v@example.com');
      await getAppConfigService().setAccessPolicy(APP, existing => ({
        ...(existing.access as AppAccessPolicy),
        guestGrantedBy: { [guest.id]: otherOwnerId },
      }));

      const res = await delGuest(guest.id, bearer(ownerToken));

      // 200-not-revoked rather than 403: a distinguishable refusal is a
      // membership oracle over the list `ownView` reduces to a count.
      expect(res.status).toBe(200);
      expect((await bodyOf(res)).data?.revoked).toBe(false);
      expect(policy()?.guests).toEqual([guest.id]);
    });

    it('lets an admin revoke anyone', async () => {
      const guest = await invite('v@example.com');

      const res = await delGuest(guest.id, bearer(adminToken));

      expect(res.status).toBe(200);
      expect(policy()?.guests ?? []).toEqual([]);
    });

    it('refuses an OWNER removing a DISABLED record — delete-then-reinvite is a bypass', async () => {
      // Deleting the record frees the (email, appName) key, so an owner who
      // could delete it could re-invite the same address a second later and get
      // a fresh, ENABLED guest. That is a clean bypass of an admin's disable
      // performed entirely through owner-level routes.
      const guest = await invite('v@example.com');
      await getAppGuestManager().disableGuest(guest.id, adminId);

      const res = await delGuest(guest.id, bearer(ownerToken));

      expect(res.status).toBe(403);
      expect(getAppGuestManager().getGuestById(guest.id)).toBeDefined();
    });

    it('lets an ADMIN remove a disabled record', async () => {
      const guest = await invite('v@example.com');
      await getAppGuestManager().disableGuest(guest.id, adminId);

      const res = await delGuest(guest.id, bearer(adminToken));

      expect(res.status).toBe(200);
      expect(getAppGuestManager().getGuestById(guest.id)).toBeUndefined();
    });
  });

  describe('the other end of the collision rule', () => {
    it('refuses creating a DROP user with an address a guest already holds', async () => {
      await post(bearer(ownerToken), { email: 'v@example.com', gateApp: true });

      await expect(
        createUser('newbie', 'password123', 'user', 'V@Example.com')
      ).rejects.toThrow(/not available/);
    });

    it('refuses MOVING an existing user onto a guest address', async () => {
      // A check only on create is walked past by an update one request later.
      await post(bearer(ownerToken), { email: 'v@example.com', gateApp: true });

      await expect(updateUser(adminId, { email: 'v@example.com' })).rejects.toThrow(
        /not available/
      );
    });

    it('still bootstraps a user with NO email while the guest store is corrupt', async () => {
      // `emailHeldByAnyGuest` throws on a corrupt store — the right direction
      // for a check that cannot rule out a parallel identity. But the default
      // admin is created through this same function with no email at all, and
      // refusing that because an unrelated file is unreadable bricks the box.
      await fs.writeFile(path.join(t.tempDir, 'app-guests.json'), 'not json');
      await getAppGuestManager().load();
      expect(getAppGuestManager().isCorrupt()).toBe(true);

      await expect(createUser('bootstrap', 'password123', 'admin')).resolves.toBeDefined();
    });
  });
});
