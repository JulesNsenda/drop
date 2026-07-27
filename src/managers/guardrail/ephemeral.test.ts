/**
 * Ephemeral deploys.
 *
 * Every property here is about what an agent can do with "throwaway": invent
 * unbounded names, take every slot on the box, or route unreviewed code past a
 * gate an operator set.
 */

import {
  ephemeralAppName,
  resolveTtlMinutes,
  checkEphemeralQuota,
  ephemeralAutoPromoteAllowed,
  isExpired,
  maxTtlMinutes,
  MAX_APP_NAME,
  SUFFIX_HEX_CHARS,
} from './ephemeral';
import { isValidAppName } from '../../api/middleware/validate';

describe('ephemeralAppName', () => {
  const fixed = () => 'abcdef0123456789';

  it('appends a random suffix so two deploys of the same name do not collide', () => {
    const a = ephemeralAppName('preview');
    const b = ephemeralAppName('preview');

    expect(a).not.toBe(b);
    expect(a).toMatch(/^preview-[a-f0-9]{10}$/);
  });

  it('NEVER exceeds the 64-character app-name limit', () => {
    // v1's scheme was "64 chars plus a short suffix", which overflows outright.
    const name = ephemeralAppName('x'.repeat(200), fixed);

    expect(name).not.toBeNull();
    expect(name!.length).toBeLessThanOrEqual(MAX_APP_NAME);
    expect(isValidAppName(name!)).toBe(true);
  });

  it('truncates the CALLER portion, never the random suffix', () => {
    // Truncating after appending would cut the random part off and reintroduce
    // exactly the collisions the suffix exists to prevent (SEC-16).
    const name = ephemeralAppName('y'.repeat(200), fixed);

    expect(name!.endsWith(fixed().slice(0, SUFFIX_HEX_CHARS))).toBe(true);
  });

  it('produces a valid name from input that is entirely illegal', () => {
    const name = ephemeralAppName('!!!///...', fixed);

    expect(name).not.toBeNull();
    expect(isValidAppName(name!)).toBe(true);
  });

  it('produces a valid name when the caller supplies nothing', () => {
    const name = ephemeralAppName(undefined, fixed);

    expect(isValidAppName(name!)).toBe(true);
  });

  it('refuses rather than returning a name the platform will reject', () => {
    // A weak randomness source must fail the deploy, not silently produce a
    // colliding or invalid name.
    expect(ephemeralAppName('preview', () => '')).toBeNull();
    expect(ephemeralAppName('preview', () => 'ab')).toBeNull();
  });

  it('strips a leading character APP_NAME_RE would reject', () => {
    // The rule requires the first character to be alphanumeric.
    const name = ephemeralAppName('-leading-dash', fixed);

    expect(isValidAppName(name!)).toBe(true);
  });
});

describe('resolveTtlMinutes', () => {
  const saved = process.env.DROP_MAX_EPHEMERAL_TTL_MIN;

  afterEach(() => {
    if (saved === undefined) delete process.env.DROP_MAX_EPHEMERAL_TTL_MIN;
    else process.env.DROP_MAX_EPHEMERAL_TTL_MIN = saved;
  });

  it('defaults to 60 minutes', () => {
    expect(resolveTtlMinutes(undefined)).toBe(60);
  });

  it('honours a requested TTL inside the cap', () => {
    expect(resolveTtlMinutes(120)).toBe(120);
  });

  it('clamps to the cap rather than trusting the caller', () => {
    expect(resolveTtlMinutes(999_999)).toBe(maxTtlMinutes());
  });

  it('gives a NONSENSE ttl the default, not the maximum', () => {
    // The failure direction matters: an unparseable number must not buy the
    // longest possible lifetime on the box.
    expect(resolveTtlMinutes(NaN)).toBe(60);
    expect(resolveTtlMinutes(-5)).toBe(60);
    expect(resolveTtlMinutes(0)).toBe(60);
  });

  it('respects a lowered cap even for the default', () => {
    process.env.DROP_MAX_EPHEMERAL_TTL_MIN = '10';
    expect(resolveTtlMinutes(undefined)).toBe(10);
  });
});

describe('isExpired', () => {
  const now = 1_000_000;

  it('is false before the deadline and true after', () => {
    expect(isExpired({ expiresAt: new Date(now + 1000).toISOString() }, now)).toBe(false);
    expect(isExpired({ expiresAt: new Date(now - 1000).toISOString() }, now)).toBe(true);
  });

  it('treats a MALFORMED deadline as expired, not immortal', () => {
    // Every comparison against NaN is false, so a naive `at <= now` keeps a
    // corrupt record alive forever — and an ephemeral that never expires is
    // just an app nobody meant to create.
    expect(isExpired({ expiresAt: 'garbage' }, now)).toBe(true);
  });

  it('treats a record with no deadline as not expired', () => {
    // A non-ephemeral app has none, and must never be swept.
    expect(isExpired({}, now)).toBe(false);
  });
});

describe('checkEphemeralQuota', () => {
  const now = 1_000_000;
  const live = (over: Partial<{ name: string; principalId: string; userId: string }>) => ({
    name: over.name ?? 'e',
    principalId: over.principalId,
    userId: over.userId,
    expiresAt: new Date(now + 60_000).toISOString(),
  });
  const saved = process.env.DROP_MAX_EPHEMERAL_PER_PRINCIPAL;

  afterEach(() => {
    if (saved === undefined) delete process.env.DROP_MAX_EPHEMERAL_PER_PRINCIPAL;
    else process.env.DROP_MAX_EPHEMERAL_PER_PRINCIPAL = saved;
  });

  it('allows a caller under the limit', () => {
    const result = checkEphemeralQuota(
      [live({ name: 'a', principalId: 'key:1', userId: 'u1' })],
      { principalId: 'key:1', userId: 'u1' },
      now
    );

    expect(result.allowed).toBe(true);
  });

  it('refuses a caller at the limit', () => {
    const mine = ['a', 'b', 'c'].map((n) =>
      live({ name: n, principalId: 'key:1', userId: 'u1' })
    );

    expect(checkEphemeralQuota(mine, { principalId: 'key:1', userId: 'u1' }, now).allowed).toBe(
      false
    );
  });

  it('does NOT let one tenant block everyone else', () => {
    // The SEC-7 defect: a single global cap is a denial of service handed to
    // any tenant — three ephemerals and nobody else on the box can make one.
    const theirs = ['a', 'b', 'c', 'd', 'e'].map((n) =>
      live({ name: n, principalId: 'key:hog', userId: 'hog' })
    );

    const result = checkEphemeralQuota(theirs, { principalId: 'key:me', userId: 'me' }, now);

    expect(result.allowed).toBe(true);
  });

  it('counts per USER too, so re-minting a credential does not reset it', () => {
    // An agent gets a new principalId from a fresh grant. The user window spans
    // every credential that human has.
    const mine = ['a', 'b', 'c'].map((n, i) =>
      live({ name: n, principalId: `key:${i}`, userId: 'u1' })
    );

    const result = checkEphemeralQuota(mine, { principalId: 'key:brand-new', userId: 'u1' }, now);

    expect(result.allowed).toBe(false);
  });

  it('ignores EXPIRED ephemerals, which are not occupying anything', () => {
    const stale = ['a', 'b', 'c'].map((n) => ({
      name: n,
      principalId: 'key:1',
      userId: 'u1',
      expiresAt: new Date(now - 60_000).toISOString(),
    }));

    expect(checkEphemeralQuota(stale, { principalId: 'key:1', userId: 'u1' }, now).allowed).toBe(
      true
    );
  });

  it('says why it refused, so a caller can act', () => {
    const mine = ['a', 'b', 'c'].map((n) => live({ name: n, principalId: 'key:1' }));

    const result = checkEphemeralQuota(mine, { principalId: 'key:1' }, now);

    expect(result.reason).toMatch(/limit is 3/);
  });
});

describe('ephemeralAutoPromoteAllowed', () => {
  const saved = process.env.DROP_EPHEMERAL_AUTO_PROMOTE;

  afterEach(() => {
    if (saved === undefined) delete process.env.DROP_EPHEMERAL_AUTO_PROMOTE;
    else process.env.DROP_EPHEMERAL_AUTO_PROMOTE = saved;
  });

  it('is OFF when the platform default is manual, whatever the flag says', () => {
    // The v1 defect: forcing `auto` for ephemerals let an agent bypass an
    // operator's DROP_DEFAULT_PROMOTION=manual simply by passing
    // `ephemeral: true` — the gate would be optional to exactly the caller it
    // was written for.
    process.env.DROP_EPHEMERAL_AUTO_PROMOTE = 'true';

    expect(ephemeralAutoPromoteAllowed('manual')).toBe(false);
  });

  it('is off by default even on an auto platform', () => {
    delete process.env.DROP_EPHEMERAL_AUTO_PROMOTE;
    expect(ephemeralAutoPromoteAllowed('auto')).toBe(false);
  });

  it('is on only when explicitly enabled on an auto platform', () => {
    process.env.DROP_EPHEMERAL_AUTO_PROMOTE = 'true';
    expect(ephemeralAutoPromoteAllowed('auto')).toBe(true);
  });

  it('needs the exact string, so a truthy typo does not enable it', () => {
    process.env.DROP_EPHEMERAL_AUTO_PROMOTE = 'yes';
    expect(ephemeralAutoPromoteAllowed('auto')).toBe(false);
  });
});
