/**
 * Detach limits — cooldown + per-owner dump-byte budget.
 *
 * Pure with respect to the platform, so these tests exercise only arithmetic
 * and a real (flat) temp directory — no app/platform fixtures needed.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import {
  checkDetachCooldown,
  checkDumpByteBudget,
  pruneOwnerDumpsToFit,
  detachCooldownMs,
  predeleteMaxBytes,
} from './detach-limits';

const MB = 1024 * 1024;

describe('detachCooldownMs / predeleteMaxBytes', () => {
  const savedCooldown = process.env.DROP_DETACH_COOLDOWN_MINUTES;
  const savedMax = process.env.DROP_PREDELETE_MAX_MB;

  afterEach(() => {
    if (savedCooldown === undefined) delete process.env.DROP_DETACH_COOLDOWN_MINUTES;
    else process.env.DROP_DETACH_COOLDOWN_MINUTES = savedCooldown;
    if (savedMax === undefined) delete process.env.DROP_PREDELETE_MAX_MB;
    else process.env.DROP_PREDELETE_MAX_MB = savedMax;
  });

  it('defaults to 10 minutes for the cooldown', () => {
    delete process.env.DROP_DETACH_COOLDOWN_MINUTES;
    expect(detachCooldownMs()).toBe(10 * 60 * 1000);
  });

  it('honours a valid cooldown override', () => {
    process.env.DROP_DETACH_COOLDOWN_MINUTES = '5';
    expect(detachCooldownMs()).toBe(5 * 60 * 1000);
  });

  it('falls back to the default cooldown on garbage, not "no cooldown"', () => {
    process.env.DROP_DETACH_COOLDOWN_MINUTES = '-1';
    expect(detachCooldownMs()).toBe(10 * 60 * 1000);
  });

  it('defaults to 2048MB for the byte budget', () => {
    delete process.env.DROP_PREDELETE_MAX_MB;
    expect(predeleteMaxBytes()).toBe(2048 * MB);
  });

  it('honours a valid byte-budget override', () => {
    process.env.DROP_PREDELETE_MAX_MB = '100';
    expect(predeleteMaxBytes()).toBe(100 * MB);
  });

  it('falls back to the default byte budget on garbage, not "no limit"', () => {
    process.env.DROP_PREDELETE_MAX_MB = 'nonsense';
    expect(predeleteMaxBytes()).toBe(2048 * MB);
  });
});

describe('checkDetachCooldown', () => {
  it('allows an app that has never been detached', () => {
    expect(checkDetachCooldown({ lastDetachAt: undefined, now: 1000, cooldownMs: 60_000 })).toEqual({
      allowed: true,
    });
    expect(checkDetachCooldown({ lastDetachAt: null, now: 1000, cooldownMs: 60_000 })).toEqual({
      allowed: true,
    });
  });

  it('refuses within the cooldown window and reports retryAfterSeconds', () => {
    const verdict = checkDetachCooldown({ lastDetachAt: 0, now: 30_000, cooldownMs: 60_000 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBe(30);
  });

  it('allows once the cooldown has fully elapsed', () => {
    expect(checkDetachCooldown({ lastDetachAt: 0, now: 60_000, cooldownMs: 60_000 })).toEqual({
      allowed: true,
    });
  });

  it('allows past the cooldown window', () => {
    expect(checkDetachCooldown({ lastDetachAt: 0, now: 120_000, cooldownMs: 60_000 })).toEqual({
      allowed: true,
    });
  });

  it('rounds retryAfterSeconds up so a client never polls a moment too early', () => {
    const verdict = checkDetachCooldown({ lastDetachAt: 0, now: 59_500, cooldownMs: 60_000 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterSeconds).toBe(1);
  });
});

describe('checkDumpByteBudget / pruneOwnerDumpsToFit', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-detach-limits-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const writeDump = async (name: string, bytes: number, ageMs = 0) => {
    const full = path.join(dir, name);
    await fs.writeFile(full, Buffer.alloc(bytes));
    if (ageMs > 0) {
      const then = new Date(Date.now() - ageMs);
      await fs.utimes(full, then, then);
    }
    return full;
  };

  it('returns allowed:true with zero usage when the owner directory does not exist yet', async () => {
    const verdict = await checkDumpByteBudget(path.join(dir, 'never-created'), 10 * MB);
    expect(verdict).toEqual({ allowed: true, usedBytes: 0, limitBytes: 10 * MB });
  });

  it('sums every recognized dump artifact under the owner directory (no prefix list needed)', async () => {
    // .dump, .restore-role.sql AND .dump.partial all count — the budget must
    // never undercount what a fail-closed gate is measuring. An unrecognized
    // extension is still excluded.
    await writeDump('drop_myapp-2026-01-01.dump', 1000);
    await writeDump('drop_myapp-2026-01-02.dump', 2000);
    await writeDump('drop_myapp-2026-01-01.restore-role.sql', 999);
    await writeDump('drop_myapp-2026-01-03.dump.partial', 500);
    await writeDump('drop_myapp-2026-01-01.notes.txt', 111);

    const verdict = await checkDumpByteBudget(dir, 10 * MB);

    expect(verdict.usedBytes).toBe(1000 + 2000 + 999 + 500);
    expect(verdict.allowed).toBe(true);
  });

  it('checkDumpByteBudget has no prefix filter — it counts every dump under the owner directory', async () => {
    // Unlike pruneOwnerDumpsToFit's optional dbNamePrefix, the budget check
    // always sums the WHOLE owner directory — every file under it belongs
    // to that owner by construction (per-owner directories, not a shared
    // one), so there is nothing to scope out.
    await writeDump('drop_app-2026-01-01.dump', 2 * MB);
    await writeDump('drop_app2-2026-01-01.dump', 3 * MB);

    const verdict = await checkDumpByteBudget(dir, 10 * MB);

    expect(verdict.usedBytes).toBe(5 * MB);
  });

  it('refuses once the owner is over the ceiling', async () => {
    await writeDump('drop_myapp-2026-01-01.dump', 6 * MB);

    const verdict = await checkDumpByteBudget(dir, 5 * MB);

    expect(verdict.allowed).toBe(false);
    expect(verdict.usedBytes).toBe(6 * MB);
    expect(verdict.limitBytes).toBe(5 * MB);
  });

  it('does not count a symlink at its target size (lstat, not stat)', async () => {
    // A real (non-symlink) 1MB dump plus a symlink NAMED like a dump but
    // pointing at something far larger must be charged only the 1MB —
    // otherwise an attacker could inflate an owner's counted usage (and
    // permanently trip the budget refusal) without writing that many bytes
    // under the owner directory at all.
    const bigTarget = path.join(dir, 'not-counted-target.bin');
    await fs.writeFile(bigTarget, Buffer.alloc(5 * MB));
    await writeDump('drop_myapp-2026-01-01.dump', 1 * MB);
    try {
      await fs.symlink(bigTarget, path.join(dir, 'drop_myapp-2026-01-02.dump'));
    } catch {
      // Symlinks may require elevated privilege on some Windows setups —
      // skip rather than fail the suite over an environment limitation.
      return;
    }

    const verdict = await checkDumpByteBudget(dir, 10 * MB);

    expect(verdict.usedBytes).toBe(1 * MB);
  });

  it('prunes the OLDEST dumps first, and their sibling restore-role.sql, until under the ceiling', async () => {
    const oldest = await writeDump('drop_myapp-2020-01-01.dump', 4 * MB, 3 * 24 * 60 * 60 * 1000);
    await fs.writeFile(oldest.replace(/\.dump$/, '.restore-role.sql'), 'sibling');
    await writeDump('drop_myapp-2025-06-01.dump', 4 * MB, 1 * 24 * 60 * 60 * 1000);
    const newest = await writeDump('drop_myapp-2026-01-01.dump', 4 * MB, 0);

    const result = await pruneOwnerDumpsToFit(dir, 6 * MB);

    expect(result.prunedFiles).toEqual(['drop_myapp-2020-01-01.dump', 'drop_myapp-2025-06-01.dump']);
    expect(result.prunedBytes).toBe(8 * MB);

    const remaining = await fs.readdir(dir);
    expect(remaining).toContain(path.basename(newest));
    expect(remaining).not.toContain('drop_myapp-2020-01-01.dump');
    expect(remaining).not.toContain('drop_myapp-2020-01-01.restore-role.sql');
    expect(remaining).not.toContain('drop_myapp-2025-06-01.dump');
  });

  it('a dbNamePrefix scopes pruning to one app\'s own dumps, never a sibling\'s', async () => {
    // Same owner directory, two apps. Pruning scoped to "drop_myapp" must
    // never touch "drop_otherapp"'s dump even though it is older and the
    // combined total is over budget — this is what closes the cross-app-
    // eviction finding within a single owner's directory.
    await writeDump('drop_otherapp-2020-01-01.dump', 50 * MB, 10 * 24 * 60 * 60 * 1000);
    await writeDump('drop_myapp-2026-01-01.dump', 1 * MB);

    const result = await pruneOwnerDumpsToFit(dir, 1 * MB, 0, 'drop_myapp');

    expect(result.prunedFiles).toEqual([]);
    const remaining = await fs.readdir(dir);
    expect(remaining).toContain('drop_otherapp-2020-01-01.dump');
  });

  it('a dbNamePrefix requires the separator, so it can\'t match a different app sharing a string prefix', async () => {
    // "drop_app" must not match "drop_app2-...dump" — that would let one
    // app's own-scoped prune reach into an unrelated app's dump just
    // because its db name is a string prefix of the victim's.
    await writeDump('drop_app2-2020-01-01.dump', 5 * MB, 10 * 24 * 60 * 60 * 1000);

    const result = await pruneOwnerDumpsToFit(dir, 1 * MB, 0, 'drop_app');

    expect(result.prunedFiles).toEqual([]);
    const remaining = await fs.readdir(dir);
    expect(remaining).toContain('drop_app2-2020-01-01.dump');
  });

  it('accounts for an incoming estimate so pruning makes room for a dump not yet written', async () => {
    await writeDump('drop_myapp-2025-01-01.dump', 2 * MB, 1000);
    await writeDump('drop_myapp-2026-01-01.dump', 2 * MB);

    // 4MB used + a 3MB incoming dump = 7MB against a 5MB ceiling: must prune
    // the oldest file even though the CURRENT usage alone (4MB) is under it.
    const result = await pruneOwnerDumpsToFit(dir, 5 * MB, 3 * MB);

    expect(result.prunedFiles).toEqual(['drop_myapp-2025-01-01.dump']);
  });

  it('prunes nothing when already under the ceiling', async () => {
    await writeDump('drop_myapp-2026-01-01.dump', 1 * MB);

    const result = await pruneOwnerDumpsToFit(dir, 5 * MB);

    expect(result).toEqual({ prunedFiles: [], prunedBytes: 0 });
  });
});
