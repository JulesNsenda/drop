/**
 * The row-estimate heuristic is the one piece of client logic in the database
 * panel that changes what answer an operator reads, so it gets real tests even
 * though this package has no test runner — the root jest picks these up.
 *
 * The fixtures are not invented. They are the exact readings taken from a real
 * PostgreSQL 16 during Gate 4 of DROP-120, against a table with 7 rows and a
 * genuinely empty one:
 *
 *   -- 7 rows inserted, never analysed, stats intact:
 *   relname | n_live_tup | last_analyze | size
 *   todos   |          7 |              | 32768
 *
 *   -- same table after pg_stat_reset(): the count now LIES
 *   todos   |          0 |              | 32768
 *
 *   -- genuinely empty
 *   empty_table |      0 |              |     0
 */

import {
  EMPTY_HEAP_THRESHOLD_BYTES,
  formatBytes,
  formatRowEstimate,
  isUntrustedZero,
  type DbTable,
} from './db-format';

const table = (over: Partial<DbTable> = {}): DbTable => ({
  name: 'todos',
  rowEstimate: 0,
  analysed: false,
  sizeBytes: 0,
  ...over,
});

describe('isUntrustedZero', () => {
  it('trusts a positive estimate on a never-analysed table (the ordinary case)', () => {
    // Gate 4: 7 real rows, never analysed, and n_live_tup already correct.
    // Gating on `analysed` alone would hide this correct 7 behind a hedge.
    expect(isUntrustedZero(table({ rowEstimate: 7, analysed: false, sizeBytes: 32768 }))).toBe(false);
    expect(formatRowEstimate(table({ rowEstimate: 7, analysed: false, sizeBytes: 32768 }))).toBe('≈ 7');
  });

  it('distrusts zero rows reported against real bytes on disk (the stats-reset lie)', () => {
    // Gate 4: the same 7-row table after pg_stat_reset().
    const row = table({ rowEstimate: 0, analysed: false, sizeBytes: 32768 });
    expect(isUntrustedZero(row)).toBe(true);
    expect(formatRowEstimate(row)).toBe('not yet analysed');
  });

  it('reports a genuinely empty table as zero, not as unknown', () => {
    const row = table({ rowEstimate: 0, analysed: false, sizeBytes: 0 });
    expect(isUntrustedZero(row)).toBe(false);
    expect(formatRowEstimate(row)).toBe('≈ 0');
  });

  it('trusts zero once the table has actually been analysed', () => {
    // An analysed table reporting 0 against real size is a truthful 0 — e.g.
    // every row deleted, with the pages not yet vacuumed away.
    const row = table({ rowEstimate: 0, analysed: true, sizeBytes: 32768 });
    expect(isUntrustedZero(row)).toBe(false);
    expect(formatRowEstimate(row)).toBe('≈ 0');
  });

  it('treats a null estimate as zero rather than throwing', () => {
    expect(formatRowEstimate(table({ rowEstimate: null, sizeBytes: 0 }))).toBe('≈ 0');
    expect(isUntrustedZero(table({ rowEstimate: null, sizeBytes: 32768 }))).toBe(true);
  });

  it('puts the boundary strictly above the empty-heap threshold', () => {
    // Exactly at the threshold is still "small enough to be empty"; one byte
    // over is not. Pins the comparison so a `>=`/`>` slip is caught.
    expect(isUntrustedZero(table({ sizeBytes: EMPTY_HEAP_THRESHOLD_BYTES }))).toBe(false);
    expect(isUntrustedZero(table({ sizeBytes: EMPTY_HEAP_THRESHOLD_BYTES + 1 }))).toBe(true);
  });
});

describe('formatBytes', () => {
  it('scales KB / MB / GB', () => {
    expect(formatBytes(0)).toBe('0 KB');
    expect(formatBytes(32768)).toBe('32 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB');
  });

  it('formats the real database size Gate 4 measured', () => {
    expect(formatBytes(7852515)).toBe('7.5 MB');
  });
});
