/**
 * Per-principal deploy quota.
 *
 * The property that makes this worth having alongside the breaker: it counts
 * VOLUME, not failures. A caller who succeeds every time is still spending
 * build capacity, and the breaker — which resets on success — never sees them.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PrincipalQuota, quotaKeysFor, resetPrincipalQuota } from './principal-quota';

describe('quotaKeysFor', () => {
  const savedPrincipal = process.env.DROP_MAX_REDEPLOYS_PER_HOUR;
  const savedOwner = process.env.DROP_MAX_REDEPLOYS_PER_HOUR_PER_USER;

  afterEach(() => {
    if (savedPrincipal === undefined) delete process.env.DROP_MAX_REDEPLOYS_PER_HOUR;
    else process.env.DROP_MAX_REDEPLOYS_PER_HOUR = savedPrincipal;
    if (savedOwner === undefined) delete process.env.DROP_MAX_REDEPLOYS_PER_HOUR_PER_USER;
    else process.env.DROP_MAX_REDEPLOYS_PER_HOUR_PER_USER = savedOwner;
  });

  it('quotas the credential AND the human behind it', () => {
    // Two windows for the same reason the breaker has two: `oauth:<sub>::<sid>`
    // embeds the session, so a fresh grant is a fresh principal with a fresh
    // allowance. The owner window spans every session that human has.
    const keys = quotaKeysFor({ principalId: 'oauth:u1::s1', actorUserId: 'u1' });

    expect(keys.map((k) => k.kind)).toEqual(['principal', 'owner']);
    expect(keys[1].key).toContain('u1');
  });

  it('gives the owner window a LOOSER limit than the credential', () => {
    // It spans every session and app the human has, so a limit as tight as the
    // per-credential one would throttle normal multi-app work.
    const keys = quotaKeysFor({ principalId: 'oauth:u1::s1', actorUserId: 'u1' });

    expect(keys[1].limit).toBeGreaterThan(keys[0].limit);
  });

  it('does NOT quota automation', () => {
    // Every platform restart re-deploys the whole fleet through the watcher.
    // Charging that to anyone would spend a human's hourly allowance on a
    // reboot they did not ask for.
    expect(quotaKeysFor({})).toEqual([]);
    expect(quotaKeysFor({ automationSource: 'webhook' })).toEqual([]);
  });

  it('gives a credential with no known human only its own window', () => {
    // Never a shared `owner::anonymous` bucket — that would let any such caller
    // exhaust every other's allowance.
    const keys = quotaKeysFor({ principalId: 'key:t1' });

    expect(keys).toHaveLength(1);
    expect(keys[0].kind).toBe('principal');
  });

  it('honours the env overrides', () => {
    process.env.DROP_MAX_REDEPLOYS_PER_HOUR = '3';
    process.env.DROP_MAX_REDEPLOYS_PER_HOUR_PER_USER = '7';

    const keys = quotaKeysFor({ principalId: 'key:t1', actorUserId: 'u1' });

    expect(keys[0].limit).toBe(3);
    expect(keys[1].limit).toBe(7);
  });

  it('ignores a nonsense override rather than disabling the quota', () => {
    // parseInt('') is NaN and parseInt('0') is 0; either would silently mean
    // "no limit" if taken at face value.
    process.env.DROP_MAX_REDEPLOYS_PER_HOUR = 'not-a-number';
    expect(quotaKeysFor({ principalId: 'key:t1' })[0].limit).toBe(20);

    process.env.DROP_MAX_REDEPLOYS_PER_HOUR = '0';
    expect(quotaKeysFor({ principalId: 'key:t1' })[0].limit).toBe(20);
  });
});

describe('PrincipalQuota', () => {
  let tempDir: string;
  let quota: PrincipalQuota;
  const KEYS = [{ key: 'key:t1', limit: 3, kind: 'principal' as const }];

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-quota-'));
    quota = new PrincipalQuota(path.join(tempDir, 'principal-quotas.json'));
    await quota.initialize();
  });

  afterEach(async () => {
    // Recording persists fire-and-forget, so the last write can still be in
    // flight here — on Windows that races the rmdir into ENOTEMPTY.
    await quota.flush();
    resetPrincipalQuota();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('allows up to the limit and refuses the next', () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(quota.check(KEYS, t + i).allowed).toBe(true);
      quota.record(KEYS, t + i);
    }

    expect(quota.check(KEYS, t + 4).allowed).toBe(false);
  });

  it('counts SUCCESSFUL deploys — this is a volume cap, not a failure counter', () => {
    // The whole reason it exists alongside the breaker, which resets on
    // success and so never throttles a caller who keeps succeeding.
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) quota.record(KEYS, t + i);

    // No notion of outcome was ever passed in, and the window is full.
    expect(quota.check(KEYS, t + 4).allowed).toBe(false);
  });

  it('reports how long until room frees, measured from the OLDEST deploy', () => {
    const t = 1_000_000;
    quota.record(KEYS, t);
    quota.record(KEYS, t + 60_000);
    quota.record(KEYS, t + 120_000);

    const verdict = quota.check(KEYS, t + 120_000);

    // The first deploy ages out an hour after IT happened, not after the last:
    // 3600s minus the 120s already elapsed. Measuring from the newest would
    // report 3600 and hold the caller out longer than the window actually runs.
    expect(verdict.retryAfterSeconds).toBe(3480);
  });

  it('frees room as deploys age out of the window', () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) quota.record(KEYS, t + i);
    expect(quota.check(KEYS, t + 4).allowed).toBe(false);

    expect(quota.check(KEYS, t + 60 * 60 * 1000 + 10).allowed).toBe(true);
  });

  it('keeps keys independent', () => {
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) quota.record(KEYS, t + i);

    expect(quota.check([{ key: 'key:t2', limit: 3, kind: 'principal' }], t).allowed).toBe(true);
  });

  it('refuses on the FIRST key that is full, checking both', () => {
    const t = 1_000_000;
    const keys = [
      { key: 'key:t1', limit: 10, kind: 'principal' as const },
      { key: 'owner::u1', limit: 2, kind: 'owner' as const },
    ];
    quota.record(keys, t);
    quota.record(keys, t + 1);

    const verdict = quota.check(keys, t + 2);

    expect(verdict.allowed).toBe(false);
    // The owner window is the one that ran out, so its limit is reported.
    expect(verdict.limit).toBe(2);
  });

  it('persists across a restart, so a process bounce is not a free reset', () => {
    // The file is durability; without it, anything that restarts the platform
    // hands every caller a clean allowance — and a push to develop restarts
    // this platform.
    const t = Date.now();
    for (let i = 0; i < 3; i++) quota.record(KEYS, t + i);

    return new Promise<void>((resolve) => {
      setTimeout(async () => {
        const revived = new PrincipalQuota(path.join(tempDir, 'principal-quotas.json'));
        await revived.initialize();

        expect(revived.check(KEYS, t + 4).allowed).toBe(false);
        resolve();
      }, 50);
    });
  });

  it('does not fail OPEN when the store cannot be written', async () => {
    // In-memory is authoritative on purpose. If the file were the source of
    // truth, anyone who could make a write fail would have a bypass.
    const unwritable = new PrincipalQuota(path.join(tempDir, 'nope', '\0bad', 'q.json'));
    await unwritable.initialize();
    const t = 1_000_000;

    for (let i = 0; i < 3; i++) unwritable.record(KEYS, t + i);

    expect(unwritable.check(KEYS, t + 4).allowed).toBe(false);
  });

  it('never evicts a live entry to make room for a new principal', async () => {
    quota = new PrincipalQuota(path.join(tempDir, 'capped.json'), { maxTrackedPrincipals: 5 });
    await quota.initialize();
    // The discriminating check. Evicting by age or insertion order would throw
    // out whichever record is closest to its limit — exactly what a caller
    // minting identities in a loop is trying to achieve.
    const t = 1_000_000;
    const victim = [{ key: 'key:nearly-full', limit: 3, kind: 'principal' as const }];
    for (let i = 0; i < 3; i++) quota.record(victim, t + i);
    expect(quota.check(victim, t + 4).allowed).toBe(false);

    // Flood well past the cap with fresh principals.
    for (let i = 0; i < 20; i++) {
      quota.record([{ key: `key:mint-${i}`, limit: 3, kind: 'principal' }], t + 5);
    }

    expect(quota.check(victim, t + 6).allowed).toBe(false);
    expect(quota.used('key:nearly-full', t + 6)).toBe(3);
  });

  it('keeps counting OWNER windows even past the principal cap', async () => {
    quota = new PrincipalQuota(path.join(tempDir, 'capped2.json'), { maxTrackedPrincipals: 5 });
    await quota.initialize();
    // The graceful degradation: per-principal tracking stops growing, but the
    // window a re-minting caller cannot escape keeps enforcing.
    const t = 1_000_000;
    for (let i = 0; i < 20; i++) {
      quota.record([{ key: `key:mint-${i}`, limit: 3, kind: 'principal' }], t);
    }

    const owner = [{ key: 'owner::u1', limit: 2, kind: 'owner' as const }];
    quota.record(owner, t + 1);
    quota.record(owner, t + 2);

    expect(quota.check(owner, t + 3).allowed).toBe(false);
  });
});
