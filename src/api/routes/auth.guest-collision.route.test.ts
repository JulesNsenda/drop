/**
 * The user END of DROP-155's email-collision rule, seen from the two ROUTES
 * that reach it (wave 3 Gate 2, security findings 2 and 10).
 *
 * The rule itself is fine. What was not fine is how its refusal escaped:
 *
 *  - `POST /auth/signup` echoed any unmatched error message on a 500. Since
 *    DROP-155 gave `createUser` a second business-rule throw, that turned an
 *    UNAUTHENTICATED route into a directory oracle over guest identities — an
 *    anonymous caller could test addresses one at a time and distinguish "held
 *    by a guest of some app here" from "free" and from "username taken". That
 *    is precisely what `inviteGuest`'s deliberately uniform refusal exists to
 *    prevent, reopened on the one surface with no credential in front of it.
 *  - `PUT /auth/users/:id` translates exactly one plain-`Error` message and
 *    rethrows the rest as infrastructure failures, so the same refusal arrived
 *    as a 500 — a security decision indistinguishable from an outage, and one
 *    the admin could not act on.
 *
 * Same defect, opposite directions: one leaked the message, the other lost it.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import {
  createTestApiServer,
  teardownTestApiServer,
  type TestApiServer,
} from '../__testutils__/api-server';
import { getAppGuestManager, resetAppGuests } from '../../managers/app-guest';

describe('the guest email-collision refusal, as the routes surface it', () => {
  let t: TestApiServer;
  let adminToken: string;
  let victimId: string;

  const bodyOf = async (res: Response) =>
    (await res.json()) as { error?: { message?: string; code?: string } };

  beforeEach(async () => {
    resetAppGuests();
    // Signup is an ApiServer CONFIG flag, not an env read at request time —
    // it defaults false (this platform is invitation-only), and the oracle
    // this suite is about only exists where an operator has turned it on.
    t = await createTestApiServer({
      port: 3189,
      tempPrefix: 'drop-guest-collision-',
      config: { allowSignup: true },
    });

    getAppGuestManager({
      guestsFilePath: path.join(t.tempDir, 'app-guests.json'),
      invitesFilePath: path.join(t.tempDir, 'app-guest-invites.json'),
    });
    await getAppGuestManager().load();
    await getAppGuestManager().resolveOrCreateGuest('taken@example.com', 'someapp', 'owner-1');

    await createUser('gov', 'password123', 'admin');
    adminToken = await getTestToken('gov', 'password123');
    const victim = await createUser('victim', 'password123', 'user');
    victimId = victim.id;
  });

  afterEach(async () => {
    resetAppGuests();
    resetAuth();
    await teardownTestApiServer(t);
  });

  const signup = (username: string, email?: string) =>
    t.hono.request('/api/v1/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password: 'password123', ...(email ? { email } : {}) }),
    });

  describe('POST /auth/signup is not an enumeration oracle', () => {
    it('never echoes the collision message', async () => {
      const res = await signup('newbie', 'taken@example.com');

      const body = await bodyOf(res);
      expect(body.error?.message).not.toMatch(/not available/i);
      expect(body.error?.message).toBe('Registration failed');
    });

    it('normalizes, so a case variant of a held address collides identically', async () => {
      // Named for what it asserts. The ORACLE property is the test above — this
      // one only pins that `Alice@X` and `alice@x` are one mailbox on the user
      // end, matching the guest end. A check that disagreed could be walked
      // past with a capital letter.
      const collision = await signup('newbie', 'taken@example.com');
      // A CASE variant of the same address. Not a whitespace one: the route
      // rejects surrounding whitespace with a 400 before `createUser` is
      // reached, so that would test the route's own format check rather than
      // the collision rule's normalization.
      const variant = await signup('newbie2', 'TAKEN@Example.com');

      expect(variant.status).toBe(collision.status);
      expect((await bodyOf(variant)).error?.message).toBe(
        (await bodyOf(collision)).error?.message
      );
    });

    it('still tells a caller plainly that a USERNAME is taken', async () => {
      // The one distinction that is deliberately kept: a username IS a public
      // identifier here, and 409 is what the signup form needs to show.
      // (An email is REQUIRED by this route, so it has to be supplied even
      // when the username is what collides.)
      const res = await signup('victim', 'someone-else@example.com');

      expect(res.status).toBe(409);
      expect((await bodyOf(res)).error?.message).toMatch(/already exists/i);
    });

    it('still creates an account with a free address', async () => {
      expect((await signup('newbie', 'free@example.com')).status).toBe(201);
    });
  });

  describe('PUT /auth/users/:id reports the refusal as a refusal', () => {
    const putUser = (id: string, body: unknown) =>
      t.hono.request(`/api/v1/auth/users/${id}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    it('400s rather than 500s when moving a user onto a guest address', async () => {
      const res = await putUser(victimId, { email: 'taken@example.com' });

      // 500 would be indistinguishable from an outage, and an admin cannot act
      // on it. This is a decision, so it reads as one.
      expect(res.status).toBe(400);
      expect((await bodyOf(res)).error?.message).toMatch(/not available/i);
    });

    it('still allows a free address', async () => {
      expect((await putUser(victimId, { email: 'free@example.com' })).status).toBe(200);
    });
  });

  describe('the corrupt-store direction', () => {
    it('refuses to create a user it cannot check, rather than guessing', async () => {
      // `emailHeldByAnyGuest` throws on a corrupt store, and that is the right
      // polarity: reporting "cannot tell" as "free" permits the very parallel
      // identity the rule exists to refuse.
      await fs.writeFile(path.join(t.tempDir, 'app-guests.json'), 'not json');
      await getAppGuestManager().load();

      await expect(
        createUser('another', 'password123', 'user', 'anything@example.com')
      ).rejects.toThrow();
    });
  });
});
