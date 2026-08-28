/**
 * The single-use, flow-bound code (DROP-152).
 *
 * The interesting property is not "codes expire" — it is that a code minted in
 * ONE browser's flow is useless in another's. Without that, the gate has a
 * login-CSRF hole: an attacker mints a code for their own account and
 * navigates a victim to the exchange, after which the victim browses the app
 * as the attacker, entering data into the attacker's account while the tenant
 * is told by `X-Drop-Session-User-Id` that it is talking to someone else.
 *
 * Rotating the session cookie does not close that. It closes a different
 * attack — a tenant pre-planting a cookie — and the two were conflated in the
 * first version of this design.
 */

import {
  mintFlowId,
  mintAppAccessCode,
  consumeAppAccessCode,
  __resetAppAccessCodes,
} from './flow-code';

const base = () => ({
  kind: 'user' as const,
  userId: 'user-1',
  username: 'alice',
  appName: 'myapp',
  flowId: mintFlowId(),
  returnPath: '/reports',
});

const guestBase = () => ({
  kind: 'guest' as const,
  guestId: 'guest:1',
  email: 'guest@example.com',
  appName: 'myapp',
  flowId: mintFlowId(),
  returnPath: '/reports',
});

describe('app-access flow code', () => {
  beforeEach(() => __resetAppAccessCodes());

  it('round-trips a code within its own flow', () => {
    const params = base();
    const code = mintAppAccessCode(params);
    const record = consumeAppAccessCode(code, params.flowId);
    expect(record).toMatchObject({ userId: 'user-1', appName: 'myapp', returnPath: '/reports' });
  });

  it('is single-use', () => {
    const params = base();
    const code = mintAppAccessCode(params);
    expect(consumeAppAccessCode(code, params.flowId)).not.toBeNull();
    expect(consumeAppAccessCode(code, params.flowId)).toBeNull();
  });

  describe('the identity union — DROP-155', () => {
    // The naive shape was `Omit<AppAccessCodeRecord, 'expiresAt'>`, which
    // collapses a union to the INTERSECTION of its variants' keys and would
    // have let a guestId travel in a field named `userId`. These pin that the
    // two variants stay genuinely distinct at the type AND the runtime level.

    it('round-trips a GUEST code with guestId/email intact, kind: guest', () => {
      const params = guestBase();
      const code = mintAppAccessCode(params);
      const record = consumeAppAccessCode(code, params.flowId);
      expect(record).toMatchObject({
        kind: 'guest',
        guestId: 'guest:1',
        email: 'guest@example.com',
        appName: 'myapp',
        returnPath: '/reports',
      });
    });

    it('a guest record carries no userId/username at all', () => {
      const params = guestBase();
      const code = mintAppAccessCode(params);
      const record = consumeAppAccessCode(code, params.flowId) as unknown as Record<string, unknown>;
      expect(record.userId).toBeUndefined();
      expect(record.username).toBeUndefined();
    });

    it('a user record carries no guestId/email at all', () => {
      const params = base();
      const code = mintAppAccessCode(params);
      const record = consumeAppAccessCode(code, params.flowId) as unknown as Record<string, unknown>;
      expect(record.guestId).toBeUndefined();
      expect(record.email).toBeUndefined();
    });

    it('user and guest codes in concurrent flows stay independent', () => {
      const user = base();
      const guest = guestBase();
      const userCode = mintAppAccessCode(user);
      const guestCode = mintAppAccessCode(guest);

      expect(consumeAppAccessCode(userCode, user.flowId)?.kind).toBe('user');
      expect(consumeAppAccessCode(guestCode, guest.flowId)?.kind).toBe('guest');
    });
  });

  describe('flow binding — the login-CSRF defence', () => {
    it('REFUSES a code presented in a different flow', () => {
      // The attacker's code, the victim's browser. This is the whole attack.
      const attacker = base();
      const attackerCode = mintAppAccessCode(attacker);
      const victimFlow = mintFlowId();

      expect(consumeAppAccessCode(attackerCode, victimFlow)).toBeNull();
    });

    it('REFUSES a code when the browser has no flow cookie at all', () => {
      const params = base();
      const code = mintAppAccessCode(params);
      expect(consumeAppAccessCode(code, undefined)).toBeNull();
      expect(consumeAppAccessCode(code, '')).toBeNull();
    });

    it('BURNS the code on a flow mismatch', () => {
      // Deliberate: a code presented in the wrong flow is either an attack or a
      // hopelessly confused client, and neither should get a second attempt.
      // The delete happens before any validation, which is also what makes it
      // single-use under a replay race.
      const params = base();
      const code = mintAppAccessCode(params);

      expect(consumeAppAccessCode(code, mintFlowId())).toBeNull();
      // ...and now it is gone even for the rightful flow.
      expect(consumeAppAccessCode(code, params.flowId)).toBeNull();
    });

    it('does not admit on a flow id that merely shares a prefix', () => {
      const params = base();
      const code = mintAppAccessCode(params);
      expect(consumeAppAccessCode(code, params.flowId.slice(0, -1))).toBeNull();
    });
  });

  it('refuses an unknown code', () => {
    expect(consumeAppAccessCode('not-a-code', mintFlowId())).toBeNull();
  });

  it('expires', () => {
    const params = base();
    const code = mintAppAccessCode(params);
    // 60s TTL — short BECAUSE the code transits a URL that Caddy logs. Nobody
    // may extend this without first moving the code out of the query string.
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    expect(consumeAppAccessCode(code, params.flowId)).toBeNull();
    jest.restoreAllMocks();
  });

  it('keeps concurrent flows for different apps independent', () => {
    // Two tabs, two apps. Nothing here is keyed on anything but the code
    // itself, so neither flow can corrupt the other.
    const a = { ...base(), appName: 'alpha' };
    const b = { ...base(), appName: 'beta' };
    const codeA = mintAppAccessCode(a);
    const codeB = mintAppAccessCode(b);

    expect(consumeAppAccessCode(codeA, a.flowId)?.appName).toBe('alpha');
    expect(consumeAppAccessCode(codeB, b.flowId)?.appName).toBe('beta');
  });

  it('mints unpredictable ids', () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintFlowId()));
    expect(ids.size).toBe(200);
    expect(mintFlowId().length).toBeGreaterThanOrEqual(32);
  });

  it('carries the return path in the RECORD, not on the wire', () => {
    // A `return` riding the redirect chain is attacker-mutable between hops;
    // holding it here makes the validation load-bearing once instead of twice.
    const params = { ...base(), returnPath: '/a/b?x=1' };
    const code = mintAppAccessCode(params);
    expect(consumeAppAccessCode(code, params.flowId)?.returnPath).toBe('/a/b?x=1');
  });
});
