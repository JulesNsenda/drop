/**
 * `runQuery` — the database panel's read-only SQL console (DROP-163, M2).
 *
 * M1 deferred this with a threat model rather than a TODO, and the controls it
 * named are what these tests pin. Two of them are properties of PostgreSQL
 * itself, not of this code, so they were verified against a real PostgreSQL 16
 * before any of this was written:
 *
 *  - the extended protocol refuses more than one command per message
 *    (`42601`), while the DEFAULT protocol runs `SELECT 1; INSERT …` happily;
 *  - `BEGIN READ ONLY` refuses a `SECURITY DEFINER` function's INSERT (`25006`)
 *    and `CREATE TEMP TABLE`, neither of which a `SELECT`-only grant can stop.
 *
 * The mocked client below cannot re-prove those — a mock refuses whatever it is
 * told to refuse. What it CAN pin is that this module still asks for them: that
 * the tenant SQL goes out on `queryMode: 'extended'` and inside a cursor, that
 * rows come back positionally, and that the caps are applied. If someone later
 * "simplifies" the cursor away or drops the query mode, these fail.
 *
 * Two of these tests exist because a live run found the bug and a mocked one
 * had not: `temp_file_limit` is superuser-context (so setting it per-session
 * refused EVERY query with `42501`), and node-postgres returns rows as objects
 * (so positional indexing rendered a grid of nulls).
 */

import { runQuery, DbQueryError, DbUnavailableError, MAX_QUERY_ROWS, __resetGateForTests } from './app-db-inspector';
import * as dbIndex from './index';

jest.mock('pg', () => {
  const state = {
    queries: [] as Array<string | { text: string; [k: string]: unknown }>,
    fetchRows: [] as unknown[],
    fields: [] as Array<{ name: string }>,
    failOn: null as { match: RegExp; error: Error } | null,
  };
  class Client {
    constructor(public config: unknown) {}
    async connect() {}
    async end() {}
    async query(q: string | { text: string; [k: string]: unknown }) {
      state.queries.push(q);
      const text = typeof q === 'string' ? q : q.text;
      if (state.failOn && state.failOn.match.test(text)) throw state.failOn.error;
      if (/^FETCH/.test(text)) {
        return { rows: state.fetchRows, fields: state.fields };
      }
      return { rows: [], fields: [] };
    }
  }
  return { Client, Pool: class {}, __state: state };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pgMock = require('pg') as {
  __state: {
    queries: Array<string | { text: string; [k: string]: unknown }>;
    fetchRows: unknown[];
    fields: Array<{ name: string }>;
    failOn: { match: RegExp; error: Error } | null;
  };
};

const CREDS = {
  host: '127.0.0.1',
  port: 5433,
  user: 'drop_demo_user',
  password: 'pw',
  database: 'drop_demo',
};

/** The text of every statement this module sent, in order. */
const sent = () => pgMock.__state.queries.map(q => (typeof q === 'string' ? q : q.text));
/** The options object for the statement carrying the tenant's SQL. */
const cursorCall = () =>
  pgMock.__state.queries.find(
    q => typeof q === 'object' && /DECLARE/.test(q.text)
  ) as { text: string; queryMode?: string } | undefined;

beforeEach(() => {
  __resetGateForTests();
  pgMock.__state.queries = [];
  pgMock.__state.fetchRows = [];
  pgMock.__state.fields = [];
  pgMock.__state.failOn = null;
  jest.spyOn(dbIndex, 'getDatabaseProvisioner').mockReturnValue({
    getAppCredentials: () => CREDS,
  } as unknown as ReturnType<typeof dbIndex.getDatabaseProvisioner>);
});

afterEach(() => jest.restoreAllMocks());

describe('the controls runQuery relies on', () => {
  it('sends the tenant SQL on the EXTENDED protocol', async () => {
    // Load-bearing, not decorative: measured against PostgreSQL 16, the default
    // protocol runs `SELECT 1; INSERT …` and the extended one refuses it
    // (42601). If this option is ever dropped, statement stacking comes back.
    pgMock.__state.fields = [{ name: 'id' }];
    pgMock.__state.fetchRows = [[1]];

    await runQuery('demo', 'SELECT id FROM items');

    expect(cursorCall()?.queryMode).toBe('extended');
  });

  it('wraps the tenant SQL in a NO SCROLL cursor rather than executing it directly', async () => {
    // The row cap has to be server-side. `rows: n` on the driver is not one —
    // node-postgres re-`Execute`s on `portalSuspended`, so it caps the batch.
    await runQuery('demo', 'SELECT * FROM items');

    const declare = cursorCall();
    expect(declare?.text).toMatch(/^DECLARE \w+ NO SCROLL CURSOR FOR SELECT \* FROM items$/);
    expect(sent().some(t => /^FETCH FORWARD \d+ FROM/.test(t))).toBe(true);
  });

  it('never sends the tenant SQL as a bare statement', async () => {
    // The one thing that must not happen: the SQL reaching the server outside
    // the cursor declaration, where the extended-protocol refusal would not
    // apply to it.
    await runQuery('demo', 'SELECT secret FROM vault');

    const bare = sent().filter(t => t === 'SELECT secret FROM vault');
    expect(bare).toEqual([]);
  });

  it('sets work_mem but NOT temp_file_limit', async () => {
    // `temp_file_limit`'s pg_settings.context is `superuser`, and this module
    // connects as the app's unprivileged role. Setting it does not degrade
    // gracefully — PostgreSQL refuses the whole statement with `42501`, which
    // took EVERY query on this path down until a live run caught it. It belongs
    // at the role level (database-provisioner.ts) and must never come back
    // here. `work_mem` is USERSET and does work.
    await runQuery('demo', 'SELECT 1');

    expect(sent().some(t => /SET LOCAL work_mem/.test(t))).toBe(true);
    expect(sent().some(t => /temp_file_limit/.test(t))).toBe(false);
  });
});

describe('results', () => {
  it('reads rows positionally, so a duplicate column name is not lost', async () => {
    // node-postgres returns rows as OBJECTS keyed by column name unless asked
    // otherwise, which made positional indexing yield undefined for every cell
    // — a grid of nulls, found live. `rowMode: 'array'` fixes that AND keeps
    // `SELECT 1 AS a, 2 AS a` from collapsing to one column.
    pgMock.__state.fields = [{ name: 'a' }, { name: 'a' }];
    pgMock.__state.fetchRows = [[1, 2]];

    const result = await runQuery('demo', 'SELECT 1 AS a, 2 AS a');

    expect(result.columns).toEqual(['a', 'a']);
    expect(result.rows).toEqual([['1', '2']]);
  });

  it('renders every value as a string or null, losslessly', async () => {
    // JSON cannot round-trip what Postgres returns: bigint loses precision past
    // 2^53, Date becomes timezone-shifted, Buffer becomes {type:'Buffer',…}.
    const when = new Date('2026-08-30T12:00:00.000Z');
    pgMock.__state.fields = [{ name: 'n' }, { name: 'big' }, { name: 'ts' }, { name: 'buf' }, { name: 'j' }];
    pgMock.__state.fetchRows = [[null, '9007199254740993', when, Buffer.from([0xde, 0xad]), { a: 1 }]];

    const result = await runQuery('demo', 'SELECT …');

    expect(result.rows[0]).toEqual([
      null,
      '9007199254740993',
      '2026-08-30T12:00:00.000Z',
      '\\xdead',
      '{"a":1}',
    ]);
  });

  it('fetches one more row than asked, and reports truncation without counting the rest', async () => {
    pgMock.__state.fields = [{ name: 'id' }];
    pgMock.__state.fetchRows = [[1], [2], [3]];

    const result = await runQuery('demo', 'SELECT id FROM items', 2);

    expect(sent().some(t => t.includes('FETCH FORWARD 3 FROM'))).toBe(true);
    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('does not claim truncation when the result exactly fills the cap', async () => {
    pgMock.__state.fields = [{ name: 'id' }];
    pgMock.__state.fetchRows = [[1], [2]];

    const result = await runQuery('demo', 'SELECT id FROM items', 2);

    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it('caps a caller asking for more than the maximum', async () => {
    await runQuery('demo', 'SELECT 1', 10_000);

    expect(sent().some(t => t.includes(`FETCH FORWARD ${MAX_QUERY_ROWS + 1} FROM`))).toBe(true);
  });

  it.each([0, -5, NaN, 0.4])('falls back to the default for a nonsense limit (%p)', async (limit) => {
    // One answer for every spelling of nonsense. Clamping instead gave two:
    // `0` fell through `||` to the default while `-5` floored to 1, so the same
    // bad input produced 100 rows or 1 depending on its sign.
    await runQuery('demo', 'SELECT 1', limit);

    expect(sent().some(t => t.includes('FETCH FORWARD 101 FROM'))).toBe(true);
  });
});

describe('refusals', () => {
  it('refuses empty SQL before opening a connection', async () => {
    await expect(runQuery('demo', '   ')).rejects.toMatchObject({ reason: 'empty' });
    expect(pgMock.__state.queries).toEqual([]);
  });

  it('refuses oversize SQL before opening a connection', async () => {
    await expect(runQuery('demo', 'x'.repeat(9000))).rejects.toMatchObject({ reason: 'too-long' });
    expect(pgMock.__state.queries).toEqual([]);
  });

  it('reports a SQLSTATE failure as the caller\'s answer, not a platform fault', async () => {
    // A syntax error or a read-only violation means PostgreSQL understood the
    // request and refused it. Mapping that to "database unavailable" would tell
    // the operator the platform is broken when their query is.
    pgMock.__state.failOn = {
      match: /DECLARE/,
      error: Object.assign(new Error('cannot execute INSERT in a read-only transaction'), {
        code: '25006',
      }),
    };

    await expect(runQuery('demo', 'SELECT sneaky()')).rejects.toBeInstanceOf(DbQueryError);
    await expect(runQuery('demo', 'SELECT sneaky()')).rejects.toThrow(/25006/);
  });

  it('still reports a connection failure as unavailable', async () => {
    // No SQLSTATE — a socket-level failure is a platform fault and must keep
    // its existing shape rather than being relabelled a bad query.
    pgMock.__state.failOn = {
      match: /BEGIN/,
      error: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    };

    await expect(runQuery('demo', 'SELECT 1')).rejects.toBeInstanceOf(DbUnavailableError);
  });

  it('refuses when no database is provisioned', async () => {
    jest.spyOn(dbIndex, 'getDatabaseProvisioner').mockReturnValue({
      getAppCredentials: () => undefined,
    } as unknown as ReturnType<typeof dbIndex.getDatabaseProvisioner>);

    await expect(runQuery('demo', 'SELECT 1')).rejects.toMatchObject({ reason: 'not-provisioned' });
  });
});
