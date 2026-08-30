/**
 * Presentation helpers for the App Details database panel (DROP-120 M1).
 *
 * Extracted from `DatabaseTab.tsx` so they can be unit-tested: this package
 * has no test runner of its own, but the ROOT jest picks up `src/**./*.test.ts`,
 * and these are plain TypeScript with no JSX or React imports. The row-estimate
 * heuristic below is the only piece of client logic in this feature that
 * changes what answer an operator reads, so it should not ride on zero tests.
 */

export interface DbOverview {
  provisioned: boolean;
  database?: string;
  sizeBytes?: number;
  tableCount?: number;
}

export interface DbTable {
  name: string;
  rowEstimate: number | null;
  analysed: boolean;
  sizeBytes: number;
}

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

/**
 * A relation with real rows on disk sits well above this many bytes (a couple
 * of heap pages) — used to tell a genuinely empty table apart from a non-empty
 * one whose row estimate is lying.
 */
export const EMPTY_HEAP_THRESHOLD_BYTES = 16384;

/**
 * `n_live_tup` (row.rowEstimate) is maintained LIVE by the stats collector on
 * every DML at commit — it does NOT wait for ANALYZE, so a freshly migrated,
 * never-analysed table already reports a correct, positive count. (The column
 * that genuinely stays unreliable until ANALYZE runs is `pg_class.reltuples`,
 * which this panel never reads.)
 *
 * The one case a reported `0` DOES lie: a real, non-empty table whose
 * cumulative stats were reset (`pg_stat_reset()`, or a restore that doesn't
 * carry stats forward) reports `n_live_tup = 0` despite rows on disk. That is
 * distinguishable from a genuinely empty table by size — an empty relation is
 * a couple of on-disk pages at most, so a reported `0` with real bytes on disk
 * is the lie, not the truth.
 *
 * Both states were measured against a real PostgreSQL 16 during Gate 4; the
 * fixtures in the test beside this file are those exact readings. Do not
 * "simplify" this back to gating on `analysed` alone — that was tried, and it
 * hid correct positive counts on ordinary never-analysed tables.
 */
export function isUntrustedZero(row: DbTable): boolean {
  const estimate = row.rowEstimate ?? 0;
  return estimate === 0 && !row.analysed && row.sizeBytes > EMPTY_HEAP_THRESHOLD_BYTES;
}

export function formatRowEstimate(row: DbTable): string {
  if (isUntrustedZero(row)) return 'not yet analysed';
  return `≈ ${(row.rowEstimate ?? 0).toLocaleString()}`;
}

/**
 * One result from `POST /db/:name/query` (DROP-163).
 *
 * Every cell is a string or null, never a number or a Date. That is the
 * server's choice, not a limitation of this type: JSON cannot round-trip what
 * PostgreSQL returns — `bigint` loses precision past 2^53, `Date` arrives
 * timezone-shifted, `Buffer` becomes `{type:'Buffer',data:[…]}` — so the value
 * is rendered once, server-side, and the console displays exactly what came
 * back. `null` stays distinct from the empty string because those are
 * different answers.
 */
export interface DbQueryResponse {
  columns: string[];
  rows: Array<Array<string | null>>;
  rowCount: number;
  /** The cap was hit, so more rows existed than were returned. */
  truncated: boolean;
  durationMs: number;
}
