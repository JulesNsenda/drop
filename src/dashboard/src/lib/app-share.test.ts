import { gateNotReappliedText, inviteSecretUrl, shareRefusal } from './app-share';

/**
 * The refusal codes, copied verbatim from `src/api/routes/apps.share.ts`. If a
 * route ever renames one, these assertions are what notices — the components
 * would otherwise silently fall through to a generic red banner the operator
 * cannot act on.
 */
const SHARING_DISABLED = 'sharing_disabled';
const GUEST_INVITES_DISABLED = 'guest_invites_disabled';

describe('shareRefusal (DROP-153/155 platform toggles)', () => {
  it('distinguishes the two toggles — they are not interchangeable', () => {
    expect(shareRefusal({ status: 403, error: { details: { reason: SHARING_DISABLED } } })).toBe(
      'sharing'
    );
    expect(
      shareRefusal({ status: 403, error: { details: { reason: GUEST_INVITES_DISABLED } } })
    ).toBe('guests');
  });

  it('is null for a 403 that is an ordinary authorization failure', () => {
    // No `details.reason` at all: a plain forbidden, which must render as an
    // error rather than as the "ask an administrator to flip a switch" panel.
    expect(shareRefusal({ status: 403, error: { message: 'Forbidden' } })).toBeNull();
    expect(shareRefusal({ status: 403 })).toBeNull();
  });

  it('is null for the same reason code on a non-403 status', () => {
    // The status is half the contract. A 409 carrying a stray `reason` must
    // not silently blank the panel out into a first-run state.
    expect(shareRefusal({ status: 409, error: { details: { reason: SHARING_DISABLED } } })).toBeNull();
  });

  it('is null for an unrecognised reason code', () => {
    expect(shareRefusal({ status: 403, error: { details: { reason: 'something_new' } } })).toBeNull();
  });

  it('survives an error payload of the wrong shape', () => {
    // The dashboard cannot assume the error body is an object at all.
    expect(shareRefusal({ status: 403, error: 'nope' })).toBeNull();
    expect(shareRefusal({ status: 403, error: { details: null } })).toBeNull();
  });
});

describe('inviteSecretUrl (DROP-155 once-only invitation link)', () => {
  it('returns the link only when the server says no mail was sent', () => {
    expect(inviteSecretUrl({ mailSent: false, inviteUrl: 'https://drop/i#s' })).toBe(
      'https://drop/i#s'
    );
  });

  it('withholds a link that arrived alongside a DELIVERED invitation', () => {
    // The invariant, not a convenience: publishing the secret for an
    // invitation that was actually mailed would disclose it to someone the
    // server already decided should not see it.
    expect(inviteSecretUrl({ mailSent: true, inviteUrl: 'https://drop/i#s' })).toBeUndefined();
  });

  it('withholds when mailSent is absent — undefined is not false', () => {
    expect(inviteSecretUrl({ inviteUrl: 'https://drop/i#s' })).toBeUndefined();
  });

  it('is undefined when no link came back at all', () => {
    expect(inviteSecretUrl({ mailSent: false })).toBeUndefined();
    expect(inviteSecretUrl(undefined)).toBeUndefined();
  });
});

describe('gateNotReappliedText', () => {
  it('keeps the success and the failure in one sentence', () => {
    expect(gateNotReappliedText('Shared', 'caddy reload failed')).toBe(
      'Shared, but the gate was not re-applied: caddy reload failed'
    );
    expect(gateNotReappliedText('Revoked', 'boom')).toBe(
      'Revoked, but the gate was not re-applied: boom'
    );
  });
});
