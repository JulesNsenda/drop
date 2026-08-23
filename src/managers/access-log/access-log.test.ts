/**
 * AccessLogService (DROP-152)
 *
 * Covers the load-bearing properties from the review findings: the
 * `.access.log` extension (LogRetentionService prunes on that pattern),
 * JSONL round-tripping, window aggregation collapsing repeats into a count,
 * the byte cap suppressing refusals but never admits, `flush()` draining
 * pending state, and that a write failure never throws.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AccessLogService } from './access-log';

async function readRows(tmpDir: string, day: string): Promise<Record<string, unknown>[]> {
  const file = path.join(tmpDir, 'access', `${day}.access.log`);
  const content = await fs.readFile(file, 'utf-8');
  return content
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('AccessLogService', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-access-log-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('writes to <logsRoot>/access/<YYYY-MM-DD>.access.log, not .jsonl', async () => {
    const svc = new AccessLogService(tmpDir, { windowMs: 10 });
    svc.record({ appName: 'demo', decision: 'admit', userId: 'u1' });
    await svc.flush();

    const accessDir = path.join(tmpDir, 'access');
    const files = await fs.readdir(accessDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${today()}.access.log`);
    expect(files[0].endsWith('.access.log')).toBe(true);
    expect(files[0].endsWith('.jsonl')).toBe(false);
  });

  it('round-trips a JSONL entry through record + flush', async () => {
    const svc = new AccessLogService(tmpDir, { windowMs: 10 });
    svc.record({
      appName: 'demo',
      decision: 'refuse',
      username: 'alice',
      reason: 'no-access-grant',
    });
    await svc.flush();

    const rows = await readRows(tmpDir, today());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      appName: 'demo',
      decision: 'refuse',
      username: 'alice',
      reason: 'no-access-grant',
      count: 1,
    });
    expect(typeof rows[0].timestamp).toBe('string');
  });

  it('collapses identical (app, principal, decision) hits inside the window into one row with a count', async () => {
    const svc = new AccessLogService(tmpDir, { windowMs: 50 });
    for (let i = 0; i < 5; i++) {
      svc.record({ appName: 'demo', decision: 'refuse', reason: 'no-access-grant' });
    }

    await new Promise((resolve) => setTimeout(resolve, 150));

    const rows = await readRows(tmpDir, today());
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(5);
  });

  it('keeps separate aggregates per principal and per decision', async () => {
    const svc = new AccessLogService(tmpDir, { windowMs: 50 });
    svc.record({ appName: 'demo', decision: 'refuse', userId: 'u1' });
    svc.record({ appName: 'demo', decision: 'refuse', userId: 'u2' });
    svc.record({ appName: 'demo', decision: 'admit', userId: 'u1' });

    await new Promise((resolve) => setTimeout(resolve, 150));

    const rows = await readRows(tmpDir, today());
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.count === 1)).toBe(true);
  });

  it('flush() writes pending aggregates immediately, without waiting for the window', async () => {
    const svc = new AccessLogService(tmpDir, { windowMs: 60_000 });
    svc.record({ appName: 'demo', decision: 'admit', userId: 'u1' });
    svc.record({ appName: 'demo', decision: 'admit', userId: 'u1' });
    svc.record({ appName: 'demo', decision: 'admit', userId: 'u1' });

    await svc.flush();

    const rows = await readRows(tmpDir, today());
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(3);
  });

  it('caps refusal rows per app per day but never suppresses admits', async () => {
    // A tiny cap so the very first refusal write already exceeds it.
    const svc = new AccessLogService(tmpDir, {
      windowMs: 10,
      capBytesPerAppPerDay: 1,
      summaryIntervalMs: 60_000,
    });

    // First refuse: cap not yet reached (starts at 0 bytes), so it writes
    // and pushes the counter past the 1-byte cap.
    svc.record({ appName: 'demo', decision: 'refuse', reason: 'first' });
    await svc.flush();

    let rows = await readRows(tmpDir, today());
    expect(rows).toHaveLength(1);

    // Second and third refuse: cap is now exceeded, so these are suppressed
    // (counted, not written) rather than appearing as per-event rows. One
    // flush() call drains both the (aggregated) pending refuse hit and the
    // suppressed-refusal summary together.
    svc.record({ appName: 'demo', decision: 'refuse', reason: 'second' });
    svc.record({ appName: 'demo', decision: 'refuse', reason: 'third' });
    await svc.flush();

    rows = await readRows(tmpDir, today());
    // The first refusal row, plus one suppressed-refusal summary row — never
    // one row per suppressed hit.
    expect(rows).toHaveLength(2);
    expect(rows[1].reason).toBe('refusal-cap-reached: summary of suppressed rows');
    expect(rows[1].count).toBe(2);

    // Admits must never be suppressed by the refusal cap.
    svc.record({ appName: 'demo', decision: 'admit', userId: 'u1' });
    await svc.flush();

    rows = await readRows(tmpDir, today());
    expect(rows).toHaveLength(3);
    expect(rows.some((r) => r.decision === 'admit')).toBe(true);
  });

  it('flush() emits a summary row for suppressed refusals', async () => {
    const svc = new AccessLogService(tmpDir, {
      windowMs: 10,
      capBytesPerAppPerDay: 1,
      summaryIntervalMs: 60_000,
    });

    svc.record({ appName: 'demo', decision: 'refuse', reason: 'first' });
    await svc.flush();
    svc.record({ appName: 'demo', decision: 'refuse', reason: 'second' });
    await svc.flush();
    svc.record({ appName: 'demo', decision: 'refuse', reason: 'third' });

    // flush() must drain both the pending aggregate AND the accumulated
    // suppressed-refusal counter, not just the former.
    await svc.flush();

    const rows = await readRows(tmpDir, today());
    const summaryRow = rows.find((r) => r.count === 1 && r.reason !== 'first');
    expect(summaryRow).toBeDefined();
    expect(summaryRow?.appName).toBe('demo');
    expect(summaryRow?.decision).toBe('refuse');
  });

  it('never throws when the write path is unwritable', async () => {
    // Put a plain FILE where the "access" directory needs to be created, so
    // fs.mkdir(..., { recursive: true }) fails with ENOTDIR.
    await fs.writeFile(path.join(tmpDir, 'access'), 'not a directory');

    const svc = new AccessLogService(tmpDir, { windowMs: 10 });

    expect(() => {
      svc.record({ appName: 'demo', decision: 'admit', userId: 'u1' });
    }).not.toThrow();

    await expect(svc.flush()).resolves.toBeUndefined();
  });
});
