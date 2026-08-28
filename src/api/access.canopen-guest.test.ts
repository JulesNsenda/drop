/**
 * `canOpenGuestSession` — the guest arm of the access-gate rule (DROP-155).
 *
 * Two things are being pinned here, and only one of them is "does membership
 * work".
 *
 * The first is the CROSS-ARM property: `allow` and `guests` are different
 * namespaces holding different kinds of principal, and neither list may ever
 * admit the other's. The evaluator makes that structural — each arm is handed
 * only the slice of the policy it may read — so these tests are the runtime
 * witness that the structure is wired up the way the types claim.
 *
 * The second is that a guest has NO owner clause and NO admin clause. There is
 * no role on `AppGuestIdentity` to make one out of, and that absence is the
 * whole design: a future policy field that widens access for "any authenticated
 * principal" must not reach guests by default. If someone adds one and it does,
 * `admits nothing but an exact guests-list match` fails.
 */

import { canOpenGuestSession, canOpen } from './access';
import type { AppGuestIdentity } from './app-access/session-token';
import type { AppAccessPolicy } from '../managers/app/app-config';
import type { AuthContext } from './middleware/auth';

const GUEST_ID = 'guest:11111111-2222-3333-4444-555555555555';

const guest = (over: Partial<AppGuestIdentity> = {}): AppGuestIdentity => ({
  guestId: GUEST_ID,
  email: 'visitor@example.com',
  appName: 'invoices',
  ...over,
});

const policy = (over: Partial<AppAccessPolicy> = {}): AppAccessPolicy => ({
  mode: 'drop-users',
  allow: [],
  ...over,
});

describe('canOpenGuestSession', () => {
  it('admits a guest whose id is in the app policy guests list', () => {
    expect(canOpenGuestSession(guest(), policy({ guests: [GUEST_ID] }), 'invoices')).toBe(true);
  });

  it('refuses when the policy has no guests key at all', () => {
    // The ORDINARY state of every app on the estate — `guests` is optional and
    // absent on the overwhelming majority of configs. An implementation that
    // read `policy.guests.includes(...)` without the fallback would throw here
    // rather than refuse, and a throw at a forward_auth boundary is a 500,
    // whose failure direction depends on the caller rather than on this rule.
    expect(canOpenGuestSession(guest(), policy(), 'invoices')).toBe(false);
  });

  it('refuses a guest not on the list', () => {
    expect(
      canOpenGuestSession(guest(), policy({ guests: ['guest:someone-else'] }), 'invoices')
    ).toBe(false);
  });

  it('refuses when the identity names a DIFFERENT app than the one being opened', () => {
    // The second half of the app binding. The token verifier checks the `app`
    // claim and the guest record's own `appName`; this is the authorization
    // boundary re-asserting it rather than trusting admission was strict —
    // the same pair `canAccessScoped` argues for.
    expect(
      canOpenGuestSession(guest({ appName: 'payroll' }), policy({ guests: [GUEST_ID] }), 'invoices')
    ).toBe(false);
  });

  it('refuses an id that is not in the guest namespace, even when the list contains it', () => {
    // The `guest:` prefix is a namespace guarantee, and a guarantee the
    // authorization boundary does not depend on is not one. This is the
    // direction that matters: a `guests` array that came to hold a bare DROP
    // user id — a hand-edited config, a future writer that forgets to
    // namespace — must admit nothing.
    const bare = guest({ guestId: 'user-1' });
    expect(canOpenGuestSession(bare, policy({ guests: ['user-1'] }), 'invoices')).toBe(false);
  });

  it('is NOT satisfied by an allow-list entry, even one matching the guest id exactly', () => {
    // `allow` holds account principals. A guest id appearing there (an admin
    // pasting one into PUT /apps/:name/access) grants nothing.
    expect(
      canOpenGuestSession(guest(), policy({ allow: [GUEST_ID], guests: [] }), 'invoices')
    ).toBe(false);
  });

  it('has no owner clause — owning the app is not a thing a guest can do', () => {
    // There is no `app` argument to give a guest an ownership question with,
    // which is the point: this asserts the signature has not grown one.
    // @ts-expect-error — canOpenGuestSession takes no AppState.
    expect(canOpenGuestSession(guest(), { userId: GUEST_ID }, policy(), 'invoices')).toBe(false);
  });
});

describe('the account arm is not reachable through the guests list', () => {
  const ctx = (over: Partial<AuthContext> = {}): AuthContext => ({
    userId: 'user-1',
    username: 'alice',
    role: 'user',
    authMethod: 'jwt',
    ...over,
  });

  it('refuses a user whose id is in guests but not in allow', () => {
    // The mirror of the cross-arm test above. `accountAdmitted` is handed only
    // `Pick<AppAccessPolicy,'allow'>`, so this cannot pass without someone
    // deliberately widening the slice.
    expect(
      canOpen(ctx(), { userId: 'owner-1' }, policy({ allow: [], guests: ['user-1'] }))
    ).toBe(false);
  });

  it('still admits an admin regardless of the guests list', () => {
    // Pins that adding the guest arm did not disturb the account arm's own
    // rule — the admin clause is evaluated before anything reads a list.
    expect(
      canOpen(ctx({ role: 'admin' }), { userId: 'owner-1' }, policy({ guests: [GUEST_ID] }))
    ).toBe(true);
  });
});
