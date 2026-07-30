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
      | 'credentials-missing'
      // No credentials and no orphan database either — the ordinary "this
      // app just has no database" case for `listTables` (which, unlike
      // `getOverview`, has no `{provisioned:false}` shape to answer with).
      | 'not-provisioned'
      // SQLSTATE 3D000 — the database named in stored credentials was
      // dropped out from under them.
      | 'database-missing',
    message: string
  ) {
    super(message);
    this.name = 'DbUnavailableError';
  }
}

/**
 * Thrown by `buildClientConfig` if it is ever asked to build a connection as
 * the platform's `postgres` superuser, or for an app name in the
 * `_`-prefixed internal namespace (e.g. `_internal`, `DatabaseProvisioner`'s
 * own control-plane database — see `getAppCredentials('_internal')`, which
 * can legitimately return superuser credentials). This is THE ONE RULE from
 * the module doc above, enforced in code: containment elsewhere (route-level
 * app-name validation, ownership resolution) should already make this
 * unreachable, but if a future caller ever bypasses it, this must fail loud,
 * not get silently relabelled "PostgreSQL is not reachable" by
 * `mapConnectError` — hence a distinct class, never a `DbUnavailableError`.
 */
class SuperuserCredentialGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SuperuserCredentialGuardError';
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
 * Build the pg Client config for `creds`. Loopback TCP unconditionally, as
 * discrete fields — never a connection string.
 *
 * `pg` re-parses a `connectionString` with `pg-connection-string`'s
 * `parse()`, which re-splits the string on `@`/`/` to find the authority.
 * `DatabaseProvisioner.generatePassword()` cannot emit either character
 * today, so this is unreachable in practice — but a password that could
 * would re-split the authority and point a live credentialed connection at
 * an attacker-influenced host. Free to close by never building a string in
 * the first place: `{host, port, user, password, database}` are handed to
 * `pg` as discrete fields, which it uses as-is with no second parse pass.
 *
 * Guards THE ONE RULE from the module doc first: refuses to build a config
 * for the `postgres` superuser or the `_`-prefixed internal namespace. See
 * `SuperuserCredentialGuardError`.
 */
function buildClientConfig(creds: DatabaseCredentials, appName: string): ClientConfig {
  if (creds.user === 'postgres' || appName.startsWith('_')) {
    throw new SuperuserCredentialGuardError(
      `Refusing to build a database-panel connection for "${appName}": these credentials ` +
        `would connect as the platform superuser, never the app's own role.`
    );
  }

  return {
    host: creds.host,
    port: creds.port,
    user: creds.user,
    password: creds.password,
    database: creds.database,
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
// 2, not 1: React StrictMode double-invokes the mount effect in dev, firing
// two concurrent same-app requests on every open of the tab. The global cap
// (4) is what actually protects `max_connections`; this one only needs to
// stop a single app from monopolising the gate.
const PER_APP_CAP = 2;

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
  appName: string,
  creds: DatabaseCredentials,
  fn: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client(buildClientConfig(creds, appName));
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
    return await withReadOnlySession(appName, creds, fn);
  } finally {
    releaseSlot(appName);
  }
}

/** Map a connect/query failure to the right `DbUnavailableError` reason and log once. */
function mapConnectError(err: unknown, appName: string): DbUnavailableError {
  const code = (err as { code?: string } | undefined)?.code;
  const name = err instanceof Error ? err.name : typeof err;
  const message = err instanceof Error ? err.message : String(err);

  let reason: DbUnavailableError['reason'];
  if (code === '53300') {
    reason = 'conn-limit';
  } else if (code === '28P01' || code === '28000') {
    reason = 'auth-failed';
  } else if (code === '3D000') {
    // invalid_catalog_name — the database named in stored credentials no
    // longer exists on the server.
    reason = 'database-missing';
  } else {
    // ECONNREFUSED / ETIMEDOUT / ENOTFOUND / EHOSTUNREACH and anything else
    // unrecognized default to "unreachable" — the safest generic answer for
    // a failed connect/query.
    reason = 'unreachable';
  }

  // Never log the raw driver message (`err.message`) — `code`/`name` are
  // enough to grep by, and this is the module's only observability, so it
  // must never become a place a driver-authored string leaks through.
  console.warn('[db-panel] connect failed', { appName, reason, code, name });
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
    console.warn('[db-panel] unavailable', { appName, reason: 'no-service' });
    throw new DbUnavailableError('no-service', 'Database service is not available.');
  }

  const creds = provisioner.getAppCredentials(appName);
  if (!creds) {
    // No stored credentials is normally just "no database" — but a corrupt
    // db-credentials.json is quarantined and the in-memory registry cleared
    // (see DatabaseProvisioner.loadCredentials), which would otherwise make
    // an app WITH a live database silently report {provisioned:false}. Check
    // for that orphan case before answering — this is the one situation an
    // operator most needs the truth.
    //
    // `orphanDatabaseExists` already fails soft to `false` internally, but
    // this is still a diagnostic on top of the normal path: an unexpected
    // throw here must never turn a working panel into a 500, so it is
    // treated the same as a `false` answer rather than propagated.
    const orphaned = await provisioner.orphanDatabaseExists(appName).catch(() => false);
    if (orphaned) {
      console.warn('[db-panel] unavailable', { appName, reason: 'credentials-missing' });
      throw new DbUnavailableError(
        'credentials-missing',
        `A database exists for "${appName}" but its stored credentials are missing. ` +
          `db-credentials.json may have been quarantined to a ".corrupt-*" file beside it.`
      );
    }
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
    if (err instanceof SuperuserCredentialGuardError) throw err;
    throw mapConnectError(err, appName);
  }
}

/**
 * List an app's tables with a row estimate, whether that estimate has been
 * analysed, and on-disk size. Capped at 500 rows, ordered by size desc.
 *
 * Unlike `getOverview`, a missing database here IS an error — `DbTable[]`
 * has no representation for "not provisioned"; callers are expected to check
 * `getOverview` first. Which reason depends on the exact same
 * `orphanDatabaseExists` check `getOverview` makes: no credentials and no
 * live orphan database → `not-provisioned` (the ordinary case); no
 * credentials but a live orphan database → `credentials-missing` (quarantined
 * `db-credentials.json`, the case an operator most needs the truth about).
 */
export async function listTables(appName: string): Promise<DbTable[]> {
  const provisioner = getDatabaseProvisioner();
  if (!provisioner) {
    console.warn('[db-panel] unavailable', { appName, reason: 'no-service' });
    throw new DbUnavailableError('no-service', 'Database service is not available.');
  }

  const creds = provisioner.getAppCredentials(appName);
  if (!creds) {
    // See the identical check in getOverview — same reasoning applies here:
    // a corrupt db-credentials.json quarantines the in-memory entry without
    // touching the live database, and that orphan case must not be reported
    // as the ordinary "no database" answer.
    const orphaned = await provisioner.orphanDatabaseExists(appName).catch(() => false);
    if (orphaned) {
      console.warn('[db-panel] unavailable', { appName, reason: 'credentials-missing' });
      throw new DbUnavailableError(
        'credentials-missing',
        `A database exists for "${appName}" but its stored credentials are missing. ` +
          `db-credentials.json may have been quarantined to a ".corrupt-*" file beside it.`
      );
    }
    console.warn('[db-panel] unavailable', { appName, reason: 'not-provisioned' });
    throw new DbUnavailableError('not-provisioned', `No database is provisioned for "${appName}".`);
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
      // `analysed` tracks whether ANALYZE/autovacuum has ever run — NOT
      // whether `row_estimate` (n_live_tup) is trustworthy on its own.
      // `n_live_tup` is maintained live by the stats collector on every DML
      // at commit, so a freshly-migrated, never-analysed table already
      // reports a correct count; it does not wait for ANALYZE (that's
      // `pg_class.reltuples`, sitting at its own "never analyzed" sentinel
      // until ANALYZE runs — a column this panel never reads). The lie this
      // flag actually guards against: a real, non-empty table whose
      // cumulative stats were reset (e.g. `pg_stat_reset()`) can report
      // `n_live_tup = 0` too — see DatabaseTab's `formatRowEstimate`, which
      // resolves that against on-disk size. Loose `!= null` deliberately
      // treats `undefined` the same as `null`: if the driver ever hands back
      // `undefined` instead of `null`, this must still read as "not
      // analysed", never silently flip to "analysed".
      analysed: row.last_analyze != null || row.last_autoanalyze != null,
      sizeBytes: Number(row.size_bytes),
    }));
  } catch (err) {
    if (err instanceof DbUnavailableError) throw err;
    if (err instanceof SuperuserCredentialGuardError) throw err;
    throw mapConnectError(err, appName);
  }
}
