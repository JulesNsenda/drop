/**
 * app-db-inspector unit tests (M1 — DROP-120 database panel).
 *
 * Coverage goals (see docs/plans/2026-07-28-database-panel.md, "Tests"):
 * - the client is end()ed when `fn` throws, not just on success
 * - ROLLBACK is issued before end()
 * - the gate rejects a 5th concurrent call (different apps), and a 2nd
 *   concurrent call for the SAME app, immediately with reason 'busy' —
 *   never by queueing
 * - the gate releases slots after both success and failure
 * - no-credentials -> {provisioned:false}, no connection attempted
 * - provisioner null -> DbUnavailableError('no-service')
 * - each pg error class maps to the right reason
 * - analysed:false when both analyze timestamps are null
 * - the connection string used is the TCP form, never the superuser pool
 */

import { Client } from 'pg';
import * as databaseModule from './index';
import { getOverview, listTables, DbUnavailableError, __resetGateForTests } from './app-db-inspector';
import type { DatabaseCredentials } from './database-provisioner';

// jest.mock factory is hoisted — keep it a pure jest.fn() stub (same
// convention as database-provisioner.test.ts) and configure per-test in
// beforeEach/each test body instead of here.
jest.mock('pg', () => ({
  Client: jest.fn(),
}));

const MockClient = Client as jest.MockedClass<typeof Client>;

function makeCreds(appName: string): DatabaseCredentials {
  return {
    host: 'localhost',
    port: 5433,
    database: `drop_${appName.replace(/[^a-z0-9]/gi, '_')}`,
    user: `drop_${appName.replace(/[^a-z0-9]/gi, '_')}_user`,
    password: 'testpassword',
    connectionString: `postgresql://drop_${appName}_user:testpassword@localhost:5433/drop_${appName}`,
  };
}

type MockClientOverrides = {
  connect?: jest.Mock;
  query?: jest.Mock;
  end?: jest.Mock;
};

/** Default happy-path client: BEGIN/ROLLBACK succeed, any other query returns one overview row. */
function makeMockClient(overrides: MockClientOverrides = {}) {
  return {
    connect: overrides.connect ?? jest.fn().mockResolvedValue(undefined),
    query:
      overrides.query ??
      jest.fn((sql: string) => {
        if (/BEGIN|ROLLBACK/i.test(sql)) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [{ size_bytes: '100', table_count: '1' }] });
      }),
    end: overrides.end ?? jest.fn().mockResolvedValue(undefined),
  };
}

function createDeferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Point getDatabaseProvisioner() at a stub whose getAppCredentials looks up `creds`. */
function stubProvisioner(creds: Record<string, DatabaseCredentials | null>) {
  const getAppCredentials = jest.fn((appName: string) => creds[appName] ?? null);
  jest.spyOn(databaseModule, 'getDatabaseProvisioner').mockReturnValue({
    getAppCredentials,
  } as unknown as databaseModule.DatabaseProvisioner);
  return getAppCredentials;
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  __resetGateForTests();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── provisioner / credentials states ────────────────────────────────────────

describe('getOverview — service/credential states', () => {
  it('returns {provisioned:false} without attempting a connection when no credentials exist', async () => {
    stubProvisioner({});

    const overview = await getOverview('ghost-app');

    expect(overview).toEqual({ provisioned: false });
    expect(MockClient).not.toHaveBeenCalled();
  });

  it('throws DbUnavailableError("no-service") when the provisioner is unavailable', async () => {
    jest.spyOn(databaseModule, 'getDatabaseProvisioner').mockReturnValue(null);

    await expect(getOverview('any-app')).rejects.toBeInstanceOf(DbUnavailableError);
    await expect(getOverview('any-app')).rejects.toMatchObject({ reason: 'no-service' });
    expect(MockClient).not.toHaveBeenCalled();
  });

  it('returns overview stats for a provisioned app', async () => {
    const creds = makeCreds('myapp');
    stubProvisioner({ myapp: creds });
    MockClient.mockImplementation(() => makeMockClient() as unknown as Client);

    const overview = await getOverview('myapp');

    expect(overview).toEqual({
      provisioned: true,
      database: creds.database,
      sizeBytes: 100,
      tableCount: 1,
    });
  });
});

describe('listTables — service/credential states', () => {
  it('throws DbUnavailableError("credentials-missing") when no credentials exist, no connection attempted', async () => {
    stubProvisioner({});

    await expect(listTables('ghost-app')).rejects.toBeInstanceOf(DbUnavailableError);
    await expect(listTables('ghost-app')).rejects.toMatchObject({ reason: 'credentials-missing' });
    expect(MockClient).not.toHaveBeenCalled();
  });

  it('throws DbUnavailableError("no-service") when the provisioner is unavailable', async () => {
    jest.spyOn(databaseModule, 'getDatabaseProvisioner').mockReturnValue(null);

    await expect(listTables('any-app')).rejects.toMatchObject({ reason: 'no-service' });
    expect(MockClient).not.toHaveBeenCalled();
  });
});

// ── row mapping ──────────────────────────────────────────────────────────────

describe('listTables — row mapping', () => {
  it('maps rows, capping nothing here (SQL LIMIT is the cap) and ordering is whatever the query returns', async () => {
    const creds = makeCreds('myapp');
    stubProvisioner({ myapp: creds });
    MockClient.mockImplementation(
      () =>
        makeMockClient({
          query: jest.fn((sql: string) => {
            if (/BEGIN|ROLLBACK/i.test(sql)) return Promise.resolve({ rows: [] });
            return Promise.resolve({
              rows: [
                {
                  name: 'big_table',
                  row_estimate: '4200',
                  last_analyze: '2026-07-01T00:00:00.000Z',
                  last_autoanalyze: null,
                  size_bytes: '8192',
                },
              ],
            });
          }),
        }) as unknown as Client
    );

    const tables = await listTables('myapp');

    expect(tables).toEqual([
      { name: 'big_table', rowEstimate: 4200, analysed: true, sizeBytes: 8192 },
    ]);
  });

  it('returns analysed:false when both last_analyze and last_autoanalyze are null', async () => {
    const creds = makeCreds('myapp');
    stubProvisioner({ myapp: creds });
    MockClient.mockImplementation(
      () =>
        makeMockClient({
          query: jest.fn((sql: string) => {
            if (/BEGIN|ROLLBACK/i.test(sql)) return Promise.resolve({ rows: [] });
            return Promise.resolve({
              rows: [
                {
                  name: 'fresh_table',
                  row_estimate: '0',
                  last_analyze: null,
                  last_autoanalyze: null,
                  size_bytes: '0',
                },
              ],
            });
          }),
        }) as unknown as Client
    );

    const tables = await listTables('myapp');

    expect(tables).toHaveLength(1);
    expect(tables[0].analysed).toBe(false);
    // The raw n_live_tup=0 is still surfaced — analysed:false is what tells
    // the caller not to trust it as a confident answer.
    expect(tables[0].rowEstimate).toBe(0);
  });
});

// ── connection string / superuser-pool avoidance ────────────────────────────

describe('connection construction', () => {
  it('connects using the TCP connection-string form, never a socket form or the superuser pool config', async () => {
    const creds = makeCreds('myapp');
    stubProvisioner({ myapp: creds });
    MockClient.mockImplementation(() => makeMockClient() as unknown as Client);

    await getOverview('myapp');

    expect(MockClient).toHaveBeenCalledTimes(1);
    const config = MockClient.mock.calls[0][0] as { connectionString?: string; database?: string };

    expect(config.connectionString).toMatch(/^postgresql:\/\/.*@localhost:5433\/drop_myapp$/);
    // Never the socket form (percent-encoded directory in the host position).
    expect(config.connectionString).not.toContain('%2F');
    // Never built from a superuser pool config — no bare `database` field
    // pointing at 'postgres', and no 'postgres' user in the string.
    expect(config.database).toBeUndefined();
    expect(config.connectionString).not.toContain('postgres:');
  });

  it('sets timeouts on the Client config, not via SET LOCAL', async () => {
    const creds = makeCreds('myapp');
    stubProvisioner({ myapp: creds });
    MockClient.mockImplementation(() => makeMockClient() as unknown as Client);

    await getOverview('myapp');

    const config = MockClient.mock.calls[0][0] as Record<string, unknown>;
    expect(config.connectionTimeoutMillis).toBe(3000);
    expect(config.query_timeout).toBe(2000);
    expect(config.statement_timeout).toBe(2000);
    expect(config.idle_in_transaction_session_timeout).toBe(5000);
  });
});

// ── session lifecycle: end() always runs, ROLLBACK before end() ────────────

describe('session lifecycle', () => {
  it('ends the client even when fn throws (the query after BEGIN rejects)', async () => {
    const creds = makeCreds('myapp');
    stubProvisioner({ myapp: creds });
    const endMock = jest.fn().mockResolvedValue(undefined);
    MockClient.mockImplementation(
      () =>
        makeMockClient({
          query: jest.fn((sql: string) => {
            if (/BEGIN|ROLLBACK/i.test(sql)) return Promise.resolve({ rows: [] });
            return Promise.reject(new Error('select failed'));
          }),
          end: endMock,
        }) as unknown as Client
    );

    await expect(getOverview('myapp')).rejects.toBeInstanceOf(DbUnavailableError);
    expect(endMock).toHaveBeenCalledTimes(1);
  });

  it('issues ROLLBACK before end()', async () => {
    const creds = makeCreds('myapp');
    stubProvisioner({ myapp: creds });
    const order: string[] = [];
    MockClient.mockImplementation(
      () =>
        ({
          connect: jest.fn().mockResolvedValue(undefined),
          query: jest.fn((sql: string) => {
            if (/ROLLBACK/i.test(sql)) order.push('ROLLBACK');
            else if (/BEGIN/i.test(sql)) order.push('BEGIN');
            else order.push('SELECT');
            return Promise.resolve({ rows: [{ size_bytes: '1', table_count: '1' }] });
          }),
          end: jest.fn(async () => {
            order.push('end');
          }),
        }) as unknown as Client
    );

    await getOverview('myapp');

    expect(order).toEqual(['BEGIN', 'SELECT', 'ROLLBACK', 'end']);
  });

  it('still ends the client (after ROLLBACK best-effort) when connect() itself fails', async () => {
    const creds = makeCreds('myapp');
    stubProvisioner({ myapp: creds });
    const endMock = jest.fn().mockResolvedValue(undefined);
    MockClient.mockImplementation(
      () =>
        makeMockClient({
          connect: jest.fn().mockRejectedValue(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })),
          end: endMock,
        }) as unknown as Client
    );

    await expect(getOverview('myapp')).rejects.toMatchObject({ reason: 'unreachable' });
    expect(endMock).toHaveBeenCalledTimes(1);
  });
});

// ── error mapping ────────────────────────────────────────────────────────────

describe('error mapping', () => {
  const cases: Array<{ code: string | undefined; expected: DbUnavailableError['reason'] }> = [
    { code: 'ECONNREFUSED', expected: 'unreachable' },
    { code: 'ETIMEDOUT', expected: 'unreachable' },
    { code: '53300', expected: 'conn-limit' },
    { code: '28P01', expected: 'auth-failed' },
    { code: '28000', expected: 'auth-failed' },
    { code: undefined, expected: 'unreachable' },
  ];

  it.each(cases)('maps pg error code $code to reason $expected', async ({ code, expected }) => {
    const creds = makeCreds('myapp');
    stubProvisioner({ myapp: creds });
    const err = Object.assign(new Error('pg failure'), { code });
    MockClient.mockImplementation(
      () => makeMockClient({ connect: jest.fn().mockRejectedValue(err) }) as unknown as Client
    );

    await expect(getOverview('myapp')).rejects.toBeInstanceOf(DbUnavailableError);
    await expect(getOverview('myapp')).rejects.toMatchObject({ reason: expected });
  });

  it('logs one greppable [db-panel] warn line on a connect failure', async () => {
    const creds = makeCreds('myapp');
    stubProvisioner({ myapp: creds });
    const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    MockClient.mockImplementation(
      () => makeMockClient({ connect: jest.fn().mockRejectedValue(err) }) as unknown as Client
    );

    await getOverview('myapp').catch((e) => e);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[db-panel] connect failed',
      expect.objectContaining({ appName: 'myapp', reason: 'unreachable' })
    );
  });
});

// ── bounded gate: reject, never queue ───────────────────────────────────────

describe('gate — bounded, not a queue', () => {
  it('rejects a 5th concurrent call across different apps immediately with reason busy, without queueing', async () => {
    stubProvisioner({
      app1: makeCreds('app1'),
      app2: makeCreds('app2'),
      app3: makeCreds('app3'),
      app4: makeCreds('app4'),
      app5: makeCreds('app5'),
    });
    const heldOpen = createDeferred<void>();
    MockClient.mockImplementation(
      () => makeMockClient({ connect: jest.fn(() => heldOpen.promise) }) as unknown as Client
    );

    // Four calls started but not awaited — each suspends at `await
    // client.connect()`, holding its gate slot open.
    const p1 = getOverview('app1');
    const p2 = getOverview('app2');
    const p3 = getOverview('app3');
    const p4 = getOverview('app4');

    // The 5th (a different app — this is the GLOBAL cap, not the per-app
    // one) must reject immediately: no waiting on the four still-pending
    // connections.
    await expect(getOverview('app5')).rejects.toMatchObject({ reason: 'busy' });

    heldOpen.resolve();
    await Promise.allSettled([p1, p2, p3, p4]);
  });

  it('rejects a 2nd concurrent call for the SAME app immediately with reason busy (per-app cap)', async () => {
    stubProvisioner({ appX: makeCreds('appX') });
    const heldOpen = createDeferred<void>();
    MockClient.mockImplementation(
      () => makeMockClient({ connect: jest.fn(() => heldOpen.promise) }) as unknown as Client
    );

    const p1 = getOverview('appX');
    // Global cap (4) is nowhere near reached — this must be rejected by the
    // PER-APP cap (1) specifically.
    await expect(getOverview('appX')).rejects.toMatchObject({ reason: 'busy' });

    heldOpen.resolve();
    await Promise.allSettled([p1]);
  });

  it('logs one greppable [db-panel] warn line on a gate rejection', async () => {
    stubProvisioner({ appX: makeCreds('appX') });
    const heldOpen = createDeferred<void>();
    MockClient.mockImplementation(
      () => makeMockClient({ connect: jest.fn(() => heldOpen.promise) }) as unknown as Client
    );

    const p1 = getOverview('appX');
    await getOverview('appX').catch((e) => e);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[db-panel] gate rejected (per-app cap)',
      expect.objectContaining({ appName: 'appX', cap: 1 })
    );

    heldOpen.resolve();
    await Promise.allSettled([p1]);
  });

  it('releases slots after success — sequential calls never see busy', async () => {
    stubProvisioner({ appX: makeCreds('appX') });
    MockClient.mockImplementation(() => makeMockClient() as unknown as Client);

    for (let i = 0; i < 6; i++) {
      await expect(getOverview('appX')).resolves.toMatchObject({ provisioned: true });
    }
  });

  it('releases slots after failure so a burst does not permanently wedge the gate', async () => {
    stubProvisioner({
      'fail-0': makeCreds('fail-0'),
      'fail-1': makeCreds('fail-1'),
      'fail-2': makeCreds('fail-2'),
      'fail-3': makeCreds('fail-3'),
      'ok-1': makeCreds('ok-1'),
      'ok-2': makeCreds('ok-2'),
      'ok-3': makeCreds('ok-3'),
      'ok-4': makeCreds('ok-4'),
    });
    MockClient.mockImplementation(
      () =>
        makeMockClient({
          connect: jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })),
        }) as unknown as Client
    );

    // Exhaust the global cap (4) with failures, sequentially — each settles
    // (and its slot releases) before the next starts.
    for (let i = 0; i < 4; i++) {
      await expect(getOverview(`fail-${i}`)).rejects.toMatchObject({ reason: 'unreachable' });
    }

    // A fresh burst of 4 CONCURRENT calls afterwards must all succeed —
    // proving the earlier failures released their slots instead of wedging
    // the gate permanently at "4 in flight forever".
    MockClient.mockImplementation(() => makeMockClient() as unknown as Client);
    const results = await Promise.all([
      getOverview('ok-1'),
      getOverview('ok-2'),
      getOverview('ok-3'),
      getOverview('ok-4'),
    ]);
    results.forEach((r) => expect(r.provisioned).toBe(true));
  });
});
