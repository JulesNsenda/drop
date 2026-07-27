/**
 * Deploy circuit breaker.
 *
 * The property that makes this safe to put in front of every deploy: it stops
 * a LOOP, not a user. An agent making progress must never be throttled, and a
 * cooldown that has been served must not re-trip instantly.
 */

import { DeployBreaker, breakerKey, automationKey } from './deploy-breaker';

const OPTS = { threshold: 3, windowMs: 60_000, cooldownMs: 300_000 };

describe('DeployBreaker', () => {
  let breaker: DeployBreaker;

  beforeEach(() => {
    breaker = new DeployBreaker(OPTS);
  });

  it('allows deploys until the threshold', () => {
    const t = 1_000_000;
    expect(breaker.check('k', t).allowed).toBe(true);
    breaker.recordFailure('k', t);
    breaker.recordFailure('k', t + 1000);
    expect(breaker.check('k', t + 2000).allowed).toBe(true);
  });

  it('opens on the Nth failure', () => {
    const t = 1_000_000;
    breaker.recordFailure('k', t);
    breaker.recordFailure('k', t + 1000);
    const verdict = breaker.recordFailure('k', t + 2000);

    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('A SUCCESS CLEARS THE WINDOW ENTIRELY', () => {
    // The property that keeps this from punishing progress. A decrement would
    // leave the caller one stumble from a trip, forever.
    const t = 1_000_000;
    breaker.recordFailure('k', t);
    breaker.recordFailure('k', t + 1000);

    breaker.recordSuccess('k');

    expect(breaker.check('k', t + 2000).failures).toBe(0);
    // ...and it now takes a full threshold again to trip.
    breaker.recordFailure('k', t + 3000);
    breaker.recordFailure('k', t + 4000);
    expect(breaker.check('k', t + 5000).allowed).toBe(true);
  });

  it('forgets failures that age out of the window', () => {
    // Two failures an hour apart are not a loop.
    const t = 1_000_000;
    breaker.recordFailure('k', t);
    breaker.recordFailure('k', t + 1000);

    // Past the window measured from the LAST failure, not the first — at
    // t + windowMs the second failure is still only 59s old.
    const later = t + 1000 + OPTS.windowMs + 1;
    expect(breaker.check('k', later).failures).toBe(0);

    breaker.recordFailure('k', later);
    breaker.recordFailure('k', later + 1);
    expect(breaker.check('k', later + 2).allowed).toBe(true);
  });

  it('closes once the cooldown is served, with a CLEAN window', () => {
    // Carrying the old failures across the cooldown would re-trip on the very
    // next failure — one bad patch becoming a permanent block.
    const t = 1_000_000;
    breaker.recordFailure('k', t);
    breaker.recordFailure('k', t);
    breaker.recordFailure('k', t);
    expect(breaker.check('k', t).allowed).toBe(false);

    // ONE verdict, asserted twice. Two sequential check() calls would hide a
    // regression here: the first consumes the cooldown transition, so the
    // second sees an already-pruned window and reports 0 either way.
    const after = t + OPTS.cooldownMs + 1;
    const reopened = breaker.check('k', after);
    expect(reopened.allowed).toBe(true);
    expect(reopened.failures).toBe(0);

    breaker.recordFailure('k', after);
    expect(breaker.check('k', after).allowed).toBe(true);
  });

  it('reports how long is left while open', () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) breaker.recordFailure('k', t);

    const verdict = breaker.check('k', t + 60_000);

    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBe(Math.ceil((OPTS.cooldownMs - 60_000) / 1000));
  });

  it('keeps keys independent', () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) breaker.recordFailure('a', t);

    expect(breaker.check('a', t).allowed).toBe(false);
    expect(breaker.check('b', t).allowed).toBe(true);
  });
});

describe('breakerKey', () => {
  it('keys a redeploy on app AND principal', () => {
    // Per-app so one runaway agent cannot throttle another agent working on the
    // same app; per-principal so it cannot be dodged by switching apps.
    expect(breakerKey('key:t1', 'myapp')).toBe('myapp::key:t1');
    expect(breakerKey('key:t1', 'myapp')).not.toBe(breakerKey('key:t2', 'myapp'));
    expect(breakerKey('key:t1', 'myapp')).not.toBe(breakerKey('key:t1', 'other'));
  });

  it('keys a NEW app on the principal, never the name', () => {
    // Step 10 gives every ephemeral deploy a fresh random name, so a per-name
    // key would start at zero every time — and the loop worth stopping is
    // exactly the one that keeps inventing names.
    const a = breakerKey('key:t1');
    const b = breakerKey('key:t1');

    expect(a).toBe(b);
    expect(a).toContain('__new__');
  });

  it('does not collide a new-app key with a real app called __new__', () => {
    expect(breakerKey('key:t1')).not.toBe(breakerKey('key:t1', '__new__'));
  });

  it('still keys an anonymous caller rather than sharing one bucket with named ones', () => {
    expect(breakerKey(undefined, 'myapp')).toBe('myapp::anonymous');
    expect(breakerKey(undefined, 'myapp')).not.toBe(breakerKey('key:t1', 'myapp'));
  });
});

describe('automationKey', () => {
  it('separates webhook and watcher traffic per app', () => {
    // A stolen webhook secret buys an unmetered build loop otherwise, and
    // builds are the most expensive thing on the box.
    expect(automationKey('webhook', 'myapp')).toBe('webhook::myapp');
    expect(automationKey('watcher', 'myapp')).toBe('watcher::myapp');
    expect(automationKey('webhook', 'myapp')).not.toBe(automationKey('watcher', 'myapp'));
  });
});
