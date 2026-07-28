/**
 * App database inspector (M1 — DROP-120 database panel).
 *
 * docs/plans/2026-07-28-database-panel.md. Answers "does this app have a
 * database, and roughly what's in it" without any tenant-authored SQL: every
 * statement below is a constant in this file, with bound parameters used
 * where a value is needed. That property is what makes M1 safe without a new
 * database role, a REVOKE campaign, or cursor machinery — see the plan's
 * "Why M2 is deferred" section for the read-only-role class of problems this
 * intentionally does not take on.
 *
 * THE ONE RULE: every connection this module opens is made as the APP'S OWN
 * role, from `DatabaseProvisioner.getAppCredentials(appName)` — NEVER
 * `PostgresServer.getPool()` / `getSuperuserPoolConfig()`. Those are the
 * platform's superuser control-plane pool (provisioning, migrations, health)
 * and connect to the `postgres` database as `postgres`; using them here would
 * let any app's database panel read or touch every tenant's data. If you are
 * tempted to import `PostgresServer` into this file, stop — that is the bug
 * this module exists to not have.
 */

import { Client, ClientConfig } from 'pg';
import { getDatabaseProvisioner } from './index';
import { buildConnectionString } from './connection-string';
import type { DatabaseCredentials } from './database-provisioner';

// ── Public types ──────────────────────────────────────────────────────────

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

/**
 * Raised whenever the panel cannot answer — never thrown for "no database
 * provisioned", which is the normal case and reported as
 * `{ provisioned: false }` instead.
 */
export class DbUnavailableError extends Error {
  constructor(
    public readonly reason:
      | 'no-service'
      | 'busy'
      | 'unreachable'
      | 'conn-limit'
      | 'auth-failed'
      | 'credentials-missing',
    message: string
  ) {
    super(message);
    this.name = 'DbUnavailableError';
  }
}

// ── Timeouts (Client config only — NEVER `SET LOCAL`) ───────────────────────
//
// `SET LOCAL` outside a transaction block is a silent no-op with only a
// WARNING, and the ordering here is connect -> BEGIN, so a `SET LOCAL` issued
// before BEGIN would be exactly that trap. `idle_in_transaction_session_timeout`
// is not optional: a stalled JS path between BEGIN and ROLLBACK pins the
// cluster-wide xmin horizon and blocks VACUUM in every database on the
// instance, not just this one.

const CONNECT_TIMEOUT_MS = 3000;
const QUERY_TIMEOUT_MS = 2000;
const STATEMENT_TIMEOUT_MS = 2000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 5000;

/**
 * Build the pg Client config for `creds`. Loopback TCP unconditionally.
 *
 * Verified against the installed `pg`/`pg-connection-string` (2026-07-28):
 * `ConnectionParameters` merges as
 * `config = Object.assign({}, config, parse(config.connectionString))`
 * (pg/lib/connection-parameters.js), which looks like it could clobber the
 * four timeout fields below with whatever `parse()` returns — but
 * `pg-connection-string`'s `parse()` only ever emits keys sourced from the
 * URL itself (user/password/host/port/database/ssl/searchParams), and our
 * connection string carries no query string, so it never touches
 * `connectionTimeoutMillis` / `query_timeout` / `statement_timeout` /
 * `idle_in_transaction_session_timeout`. Confirmed server-side too:
 * `Client.getStartupConf()` (pg/lib/client.js) forwards `statement_timeout`
 * and `idle_in_transaction_session_timeout` in the startup packet — real
 * connect-time GUCs, not `SET LOCAL` — while `query_timeout` /
 * `connectionTimeoutMillis` are enforced client-side by node-postgres itself.
 */
function buildClientConfig(creds: DatabaseCredentials): ClientConfig {
  return {
    // The API process runs on the host (not inside a tenant's container) and
    // always can reach Postgres over loopback TCP. The socket form exists
    // only for containers (see connection-string.ts) and `getSocketDir()`
    // returns null on win32 — do not branch on isolation mode here.
    connectionString: buildConnectionString(creds, { kind: 'tcp', host: creds.host }),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
  };
}

// ── Bounded gate — N in flight, zero queue depth ────────────────────────────
//
// A global cap AND a per-app sub-cap so one app cannot starve the rest.
// Rejecting immediately (never queueing) is deliberate: a queue would
// accumulate requests whose clients have already gone by the time a slot
// frees up.

const GLOBAL_CAP = 4;
const PER_APP_CAP = 1;

let globalInFlight = 0;
const perAppInFlight = new Map<string, number>();

function acquireSlot(appName: string): void {
  if (globalInFlight >= GLOBAL_CAP) {
    console.warn('[db-panel] gate rejected (global cap)', {
      appName,
      globalInFlight,
      cap: GLOBAL_CAP,
    });
    throw new DbUnavailableError(
      'busy',
      'Database inspector is busy (global connection cap reached); try again shortly.'
    );
  }

  const appInFlight = perAppInFlight.get(appName) ?? 0;
  if (appInFlight >= PER_APP_CAP) {
    console.warn('[db-panel] gate rejected (per-app cap)', {
      appName,
      appInFlight,
      cap: PER_APP_CAP,
    });
    throw new DbUnavailableError(
      'busy',
      `Database inspector is already busy for "${appName}"; try again shortly.`
    );
  }

  globalInFlight += 1;
  perAppInFlight.set(appName, appInFlight + 1);
}

function releaseSlot(appName: string): void {
  globalInFlight = Math.max(0, globalInFlight - 1);
  const appInFlight = (perAppInFlight.get(appName) ?? 1) - 1;
  if (appInFlight <= 0) {
    perAppInFlight.delete(appName);
  } else {
    perAppInFlight.set(appName, appInFlight);
  }
}

/** Reset the gate's in-memory counters. Test-only. */
export function __resetGateForTests(): void {
  globalInFlight = 0;
  perAppInFlight.clear();
}

// ── Connection + read-only session envelope ─────────────────────────────────

/**
 * `BEGIN READ ONLY` -> `fn(client)` -> `ROLLBACK` -> `client.end()`.
 *
 * `client.end()` runs in a `finally` that covers every path, including `fn`
 * throwing: a leaked client is a permanent connection against a
 * `max_connections` fixed at initdb. `ROLLBACK` also runs on every path out
 * of the transaction (best-effort — the session may already be broken, e.g.
 * a `statement_timeout` firing) so a failed `fn` never leaves the app's
 * connection sitting `idle in transaction`.
 */
async function withReadOnlySession<T>(
  creds: DatabaseCredentials,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client(buildClientConfig(creds));
  try {
    await client.connect();
    await client.query('BEGIN READ ONLY');
    try {
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {
        // Best-effort — nothing more to do if the session is already broken.
      });
    }
  } finally {
    await client.end().catch(() => {
      // Best-effort — nothing more to do if the socket is already gone.
    });
  }
}

/** Acquire a gate slot, run the session, and always release the slot. */
async function withGatedReadOnlySession<T>(
  appName: string,
  creds: DatabaseCredentials,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  acquireSlot(appName);
  try {
    return await withReadOnlySession(creds, fn);
  } finally {
    releaseSlot(appName);
  }
}

/** Map a connect/query failure to the right `DbUnavailableError` reason and log once. */
function mapConnectError(err: unknown, appName: string): DbUnavailableError {
  const code = (err as { code?: string } | undefined)?.code;
  const message = err instanceof Error ? err.message : String(err);

  let reason: DbUnavailableError['reason'];
  if (code === '53300') {
    reason = 'conn-limit';
  } else if (code === '28P01' || code === '28000') {
    reason = 'auth-failed';
  } else {
    // ECONNREFUSED / ETIMEDOUT and anything else unrecognized default to
    // "unreachable" — the safest generic answer for a failed connect/query.
    reason = 'unreachable';
  }

  console.warn('[db-panel] connect failed', { appName, reason, code, message });
  return new DbUnavailableError(reason, `Could not reach the database for "${appName}": ${message}`);
}

// ── Fixed catalogue SQL (constants only — no tenant-controlled interpolation) ──

const OVERVIEW_SQL = `
  SELECT
    pg_database_size(current_database()) AS size_bytes,
    (SELECT count(*) FROM pg_stat_user_tables) AS table_count
`;

// Ordered by size desc, capped at 500 rows. Raw analyze timestamps are
// selected (not a SQL-side boolean) so "not yet analysed" is derived here in
// JS from the same two columns pg_stat_user_tables exposes.
const TABLES_SQL = `
  SELECT
    relname AS name,
    n_live_tup AS row_estimate,
    last_analyze,
    last_autoanalyze,
    pg_total_relation_size(relid) AS size_bytes
  FROM pg_stat_user_tables
  ORDER BY pg_total_relation_size(relid) DESC
  LIMIT 500
`;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Whether an app has a provisioned database, and if so its size and table
 * count. `{ provisioned: false }` is the normal, non-error answer for an app
 * with no database — never throw for it.
 */
export async function getOverview(appName: string): Promise<DbOverview> {
  const provisioner = getDatabaseProvisioner();
  if (!provisioner) {
    console.warn('[db-panel] connect failed', { appName, reason: 'no-service' });
    throw new DbUnavailableError('no-service', 'Database service is not available.');
  }

  const creds = provisioner.getAppCredentials(appName);
  if (!creds) {
    return { provisioned: false };
  }

  try {
    const row = await withGatedReadOnlySession(appName, creds, async (client) => {
      const result = await client.query(OVERVIEW_SQL);
      return result.rows[0] as { size_bytes: unknown; table_count: unknown };
    });

    return {
      provisioned: true,
      database: creds.database,
      sizeBytes: Number(row.size_bytes),
      tableCount: Number(row.table_count),
    };
  } catch (err) {
    if (err instanceof DbUnavailableError) throw err;
    throw mapConnectError(err, appName);
  }
}

/**
 * List an app's tables with a row estimate, whether that estimate has been
 * analysed, and on-disk size. Capped at 500 rows, ordered by size desc.
 *
 * Unlike `getOverview`, a missing database here IS an error
 * (`credentials-missing`) — `DbTable[]` has no representation for "not
 * provisioned"; callers are expected to check `getOverview` first.
 */
export async function listTables(appName: string): Promise<DbTable[]> {
  const provisioner = getDatabaseProvisioner();
  if (!provisioner) {
    console.warn('[db-panel] connect failed', { appName, reason: 'no-service' });
    throw new DbUnavailableError('no-service', 'Database service is not available.');
  }

  const creds = provisioner.getAppCredentials(appName);
  if (!creds) {
    console.warn('[db-panel] connect failed', { appName, reason: 'credentials-missing' });
    throw new DbUnavailableError(
      'credentials-missing',
      `No database credentials are stored for "${appName}".`
    );
  }

  try {
    const rows = await withGatedReadOnlySession(appName, creds, async (client) => {
      const result = await client.query(TABLES_SQL);
      return result.rows as Array<{
        name: string;
        row_estimate: unknown;
        last_analyze: unknown;
        last_autoanalyze: unknown;
        size_bytes: unknown;
      }>;
    });

    return rows.map((row) => ({
      name: row.name,
      rowEstimate: row.row_estimate === null || row.row_estimate === undefined ? null : Number(row.row_estimate),
      // A freshly-migrated table reads n_live_tup = 0 until autovacuum
      // analyses it — this flag is what stops the UI printing a confident
      // wrong 0. Loose `!= null` deliberately treats `undefined` the same as
      // `null`: if the driver ever hands back `undefined` instead of `null`,
      // this must still read as "not analysed", never silently flip to
      // "analysed" (which would be the confident-wrong-0 bug this exists to
      // prevent).
      analysed: row.last_analyze != null || row.last_autoanalyze != null,
      sizeBytes: Number(row.size_bytes),
    }));
  } catch (err) {
    if (err instanceof DbUnavailableError) throw err;
    throw mapConnectError(err, appName);
  }
}
