/**
 * DatabaseProvisioner unit tests (M2d).
 *
 * Coverage goals:
 * - getEnvVars() returns correct env vars using stored credentials.
 * - getEnvVars({ pgHost }) rewrites PGHOST and DATABASE_URL for Docker mode.
 * - provisionAppDatabase() issues REVOKE FROM PUBLIC after granting privileges.
 */

import * as os from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Pool } from 'pg';
import { DatabaseProvisioner } from './database-provisioner';
import { runPgDump } from './pg-dump';

// jest.mock factory is hoisted — keep the factory a pure jest.fn() stub so
// there are no TDZ references to module-level vars.  We configure the
// implementation in beforeEach instead.
jest.mock('pg', () => ({
  Pool: jest.fn(),
}));

// backupAndDeleteAppDatabase shells out via runPgDump — mock it so tests
// never spawn a real pg_dump process. createRoleSql is a pure function; the
// mock mirrors its real shape closely enough for assertions.
jest.mock('./pg-dump', () => ({
  runPgDump: jest.fn(),
  createRoleSql: jest.fn(
    (u: string, p: string) => `CREATE ROLE "${u}" LOGIN PASSWORD '${p}';`
  ),
}));

const MockPool = Pool as jest.MockedClass<typeof Pool>;
const mockRunPgDump = runPgDump as jest.Mock;

// ── PostgresServer mock ───────────────────────────────────────────────────────

function makeMockServer() {
  return {
    databaseExists: jest.fn().mockResolvedValue(false),
    createDatabase: jest.fn().mockResolvedValue(undefined),
    createUser: jest.fn().mockResolvedValue(undefined),
    grantPrivileges: jest.fn().mockResolvedValue(undefined),
    getSuperuserPoolConfig: jest.fn().mockReturnValue({ host: 'localhost', port: 5433 }),
    // Async, matching the real PostgresServer.getPool() signature. Defaults
    // to a pool whose query() resolves empty rows — tests that care about
    // specific queries override this with their own queryMock reference.
    getPool: jest.fn().mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
    getPort: jest.fn().mockReturnValue(5433),
    getSuperuserPassword: jest.fn().mockReturnValue('superpassword'),
  } as any;
}

/** Seed the bundled pg_dump binary path so the existence check in backupAndDeleteAppDatabase passes. */
async function seedPgDumpBinary(dropRoot: string): Promise<void> {
  const ext = process.platform === 'win32' ? '.exe' : '';
  const binDir = path.join(dropRoot, 'apps', 'drop-svc', 'pgsql', 'bin');
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, `pg_dump${ext}`), '');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Inject credentials directly (bypasses provisionAppDatabase) for fast unit tests. */
function injectCredentials(provisioner: DatabaseProvisioner, appName: string, password = 'testpassword') {
  const creds = {
    host: 'localhost',
    port: 5433,
    database: `drop_${appName}`,
    user: `drop_${appName}_user`,
    password,
    connectionString: `postgresql://drop_${appName}_user:${encodeURIComponent(password)}@localhost:5433/drop_${appName}`,
  };
  (provisioner as any).provisionedDatabases.set(appName, {
    appName,
    credentials: creds,
    createdAt: new Date(),
  });
  return creds;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DatabaseProvisioner.getEnvVars', () => {
  let provisioner: DatabaseProvisioner;
  let dropRoot: string;

  beforeEach(async () => {
    dropRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-prov-'));
    provisioner = new DatabaseProvisioner(makeMockServer(), dropRoot);
  });

  afterEach(async () => {
    await fs.rm(dropRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('returns null for an unknown app', () => {
    expect(provisioner.getEnvVars('no-such-app')).toBeNull();
  });

  it('returns env vars using stored credential host', () => {
    injectCredentials(provisioner, 'myapp');
    const vars = provisioner.getEnvVars('myapp');

    expect(vars).not.toBeNull();
    expect(vars!['PGHOST']).toBe('localhost');
    expect(vars!['DB_HOST']).toBe('localhost');
    expect(vars!['DATABASE_URL']).toContain('@localhost:');
    expect(vars!['PGPORT']).toBe('5433');
    expect(vars!['PGUSER']).toBe('drop_myapp_user');
    expect(vars!['PGPASSWORD']).toBe('testpassword');
  });

  it('rewrites PGHOST and DATABASE_URL when pgHost is provided', () => {
    injectCredentials(provisioner, 'myapp');
    const vars = provisioner.getEnvVars('myapp', { pgHost: 'host-gateway' });

    expect(vars!['PGHOST']).toBe('host-gateway');
    expect(vars!['DB_HOST']).toBe('host-gateway');
    expect(vars!['DATABASE_URL']).toContain('@host-gateway:');
    expect(vars!['DATABASE_URL']).not.toContain('@localhost:');
  });

  it('DATABASE_URL host rewrite preserves user, password, port, and dbname', () => {
    injectCredentials(provisioner, 'myapp');
    const vars = provisioner.getEnvVars('myapp', { pgHost: 'host-gateway' });

    const url = new URL(vars!['DATABASE_URL']);
    expect(url.hostname).toBe('host-gateway');
    expect(url.port).toBe('5433');
    expect(url.username).toBe('drop_myapp_user');
    expect(url.password).toBe('testpassword');
    expect(url.pathname).toBe('/drop_myapp');
  });

  it('returns null with pgHost opt when app is unknown', () => {
    expect(provisioner.getEnvVars('ghost', { pgHost: 'host-gateway' })).toBeNull();
  });

  it('returns a WHATWG-parseable socket DATABASE_URL when pgSocketDir is provided (DROP-066)', () => {
    injectCredentials(provisioner, 'myapp');
    const vars = provisioner.getEnvVars('myapp', { pgSocketDir: '/var/drop/data/db/pgdata' });

    expect(vars).not.toBeNull();
    // PGHOST must be the socket dir so libpq uses a unix domain socket.
    expect(vars!['PGHOST']).toBe('/var/drop/data/db/pgdata');
    expect(vars!['DB_HOST']).toBe('/var/drop/data/db/pgdata');

    // Regression (DROP-066): the socket DATABASE_URL MUST be parseable by the
    // WHATWG URL constructor. The old `postgresql://user:pw/db?host=<dir>&port=`
    // form had NO '@', so `new URL()` threw ERR_INVALID_URL and crash-looped
    // every Node app that validates DATABASE_URL at startup. The socket dir now
    // lives, percent-encoded, in the host (authority) position — no dangling
    // `?host=` query form.
    const url = vars!['DATABASE_URL'];
    expect(() => new URL(url)).not.toThrow();
    expect(url).toContain('@');
    expect(url).not.toContain('?host=');
    // A consumer that decodes the host (pg-connection-string, psycopg, libpq)
    // recovers the socket path; the `:<port>` selects the .s.PGSQL.<port> file.
    expect(decodeURIComponent(new URL(url).hostname)).toBe('/var/drop/data/db/pgdata');
    expect(new URL(url).port).toBe('5433');
  });

  it('socket DATABASE_URL preserves user, password, port, dbname', () => {
    injectCredentials(provisioner, 'myapp');
    const vars = provisioner.getEnvVars('myapp', { pgSocketDir: '/var/drop/data/db/pgdata' });

    // Parse the way `pg` / `node-pg-migrate` do at runtime (decode encoding).
    const url = new URL(vars!['DATABASE_URL']);
    expect(url.protocol).toBe('postgresql:');
    expect(url.username).toBe('drop_myapp_user');
    expect(decodeURIComponent(url.password)).toBe('testpassword');
    expect(decodeURIComponent(url.hostname)).toBe('/var/drop/data/db/pgdata');
    expect(url.port).toBe('5433');
    expect(url.pathname).toBe('/drop_myapp');

    // Discrete libpq vars stay aligned for apps that read them directly.
    expect(vars!['PGPORT']).toBe('5433');
    expect(vars!['PGUSER']).toBe('drop_myapp_user');
    expect(vars!['PGPASSWORD']).toBe('testpassword');
    expect(vars!['PGDATABASE']).toBe('drop_myapp');
  });

  it('socket DATABASE_URL survives a URL-hostile password (DROP-066)', () => {
    // '@', '/', '#', ':' and space in the password would corrupt the authority
    // if they leaked in raw — putting the password directly before '@<host>' in
    // the new form makes correct percent-encoding essential.
    const hostile = 'p@ss/w#rd:x y';
    injectCredentials(provisioner, 'hostileapp', hostile);
    const vars = provisioner.getEnvVars('hostileapp', { pgSocketDir: '/var/drop/data/db/pgdata' });

    const raw = vars!['DATABASE_URL'];
    expect(() => new URL(raw)).not.toThrow();
    const url = new URL(raw);
    expect(decodeURIComponent(url.password)).toBe(hostile);
    expect(decodeURIComponent(url.hostname)).toBe('/var/drop/data/db/pgdata');
    expect(url.pathname).toBe('/drop_hostileapp');
    // The raw password characters must not appear unescaped in the URL.
    expect(raw).not.toContain('p@ss');
  });

  it('returns null with pgSocketDir opt when app is unknown', () => {
    expect(provisioner.getEnvVars('ghost', { pgSocketDir: '/var/drop/data/db/pgdata' })).toBeNull();
  });
});

describe('DatabaseProvisioner.provisionAppDatabase — REVOKE FROM PUBLIC', () => {
  let provisioner: DatabaseProvisioner;
  let dropRoot: string;
  let mockQueryFn: jest.Mock;

  beforeEach(async () => {
    dropRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-prov-'));
    provisioner = new DatabaseProvisioner(makeMockServer(), dropRoot);

    mockQueryFn = jest.fn().mockResolvedValue({ rows: [] });
    MockPool.mockImplementation(() => ({
      query: mockQueryFn,
      end: jest.fn().mockResolvedValue(undefined),
    } as any));
  });

  afterEach(async () => {
    await fs.rm(dropRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    jest.clearAllMocks();
  });

  function capturedQueries(): string[] {
    return mockQueryFn.mock.calls.map((c: any[]) => (c[0] as string).trim());
  }

  it('revokes CONNECT on the database from PUBLIC', async () => {
    await provisioner.provisionAppDatabase('myapp');
    const hasRevoke = capturedQueries().some(
      (q) => /REVOKE\s+CONNECT\s+ON\s+DATABASE/i.test(q) && /FROM\s+PUBLIC/i.test(q)
    );
    expect(hasRevoke).toBe(true);
  });

  it('revokes ALL on the public schema from PUBLIC', async () => {
    await provisioner.provisionAppDatabase('myapp');
    const hasRevoke = capturedQueries().some(
      (q) => /REVOKE\s+ALL\s+ON\s+SCHEMA\s+public/i.test(q) && /FROM\s+PUBLIC/i.test(q)
    );
    expect(hasRevoke).toBe(true);
  });

  it('issues REVOKE after GRANT ALL ON SCHEMA', async () => {
    await provisioner.provisionAppDatabase('myapp');
    const queries = capturedQueries();
    const grantIdx = queries.findIndex((q) => /GRANT\s+ALL\s+ON\s+SCHEMA/i.test(q));
    const revokeIdx = queries.findIndex((q) => /REVOKE\s+CONNECT\s+ON\s+DATABASE/i.test(q));
    expect(grantIdx).toBeGreaterThanOrEqual(0);
    expect(revokeIdx).toBeGreaterThan(grantIdx);
  });
});

describe('DatabaseProvisioner.provisionAppDatabase — name-collision guard (cross-tenant)', () => {
  let dropRoot: string;

  beforeEach(async () => {
    dropRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-prov-'));
    MockPool.mockImplementation(
      () => ({ query: jest.fn().mockResolvedValue({ rows: [] }), end: jest.fn().mockResolvedValue(undefined) }) as any
    );
  });

  afterEach(async () => {
    await fs.rm(dropRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    jest.clearAllMocks();
  });

  it('refuses to take over a DB that exists but is not registered to this app', async () => {
    // Another app already created drop_my_app; this app ("my_app" — a
    // sanitized-name collision with "my-app") has no registry entry. Reusing it
    // would ALTER the other tenant's password and adopt their database.
    const server = makeMockServer();
    server.databaseExists.mockResolvedValue(true);
    const provisioner = new DatabaseProvisioner(server, dropRoot);

    await expect(provisioner.provisionAppDatabase('my_app')).rejects.toThrow(
      /already exists but is not registered/i
    );
    // The throw MUST precede every mutation — proving no takeover is possible.
    // createUser is the actual takeover vector (its "already exists" branch
    // rotates the password); createDatabase not being called proves ordering.
    expect(server.createDatabase).not.toHaveBeenCalled();
    expect(server.createUser).not.toHaveBeenCalled();
    expect(server.getPool).not.toHaveBeenCalled();
  });

  it('re-provisioning the SAME app returns its stored creds without re-creating', async () => {
    const server = makeMockServer();
    server.databaseExists.mockResolvedValue(true);
    const provisioner = new DatabaseProvisioner(server, dropRoot);
    const creds = injectCredentials(provisioner, 'my-app');

    const result = await provisioner.provisionAppDatabase('my-app');

    expect(result).toEqual(creds);
    expect(server.createDatabase).not.toHaveBeenCalled();
    expect(server.createUser).not.toHaveBeenCalled();
  });

  it('fresh provision (no existing DB) still creates the database and user', async () => {
    const server = makeMockServer(); // databaseExists defaults to false
    const provisioner = new DatabaseProvisioner(server, dropRoot);

    await provisioner.provisionAppDatabase('brand-new-app');

    expect(server.createDatabase).toHaveBeenCalledWith('drop_brand_new_app');
    expect(server.createUser).toHaveBeenCalled();
  });
});

describe('DatabaseProvisioner.backupAndDeleteAppDatabase', () => {
  let dropRoot: string;
  let queryMock: jest.Mock;
  let server: ReturnType<typeof makeMockServer>;
  let provisioner: DatabaseProvisioner;
  const prevRetentionEnv = process.env.DROP_PREDELETE_RETENTION_DAYS;

  beforeEach(async () => {
    delete process.env.DROP_PREDELETE_RETENTION_DAYS;
    dropRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-prov-del-'));
    await seedPgDumpBinary(dropRoot);

    queryMock = jest.fn().mockResolvedValue({ rows: [] });
    server = makeMockServer();
    server.getPool = jest.fn().mockResolvedValue({ query: queryMock });

    provisioner = new DatabaseProvisioner(server, dropRoot);
    mockRunPgDump.mockReset();
  });

  afterEach(async () => {
    if (prevRetentionEnv === undefined) {
      delete process.env.DROP_PREDELETE_RETENTION_DAYS;
    } else {
      process.env.DROP_PREDELETE_RETENTION_DAYS = prevRetentionEnv;
    }
    await fs.rm(dropRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    jest.clearAllMocks();
  });

  function preDeleteDir(): string {
    return path.join(dropRoot, 'data', 'backup', 'pre-delete');
  }

  async function listPreDeleteFiles(): Promise<string[]> {
    try {
      return await fs.readdir(preDeleteDir());
    } catch {
      return [];
    }
  }

  /** Default happy-path runPgDump stub: writes a valid PGDMP-magic file to outFile. */
  function stubSuccessfulDump(): void {
    mockRunPgDump.mockImplementation(async (_bin: string, opts: { outFile: string }) => {
      await fs.writeFile(opts.outFile, Buffer.from('PGDMP-fake-custom-format-dump'));
      return { ok: true };
    });
  }

  it('no provisioned entry -> no-op', async () => {
    const result = await provisioner.backupAndDeleteAppDatabase('ghost-app');

    expect(result).toEqual({ dropped: false, reason: 'no database provisioned' });
    expect(mockRunPgDump).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('happy path: dump ok + both drops succeed -> entry removed, dump + role-sql on disk', async () => {
    const creds = injectCredentials(provisioner, 'myapp');
    stubSuccessfulDump();

    const result = await provisioner.backupAndDeleteAppDatabase('myapp');

    expect(result.dropped).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.dumpPath).toBeDefined();
    expect(provisioner.isProvisioned('myapp')).toBe(false);

    const queries = queryMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(
      queries.some((q) => q.includes(`DROP DATABASE IF EXISTS "${creds.database}" WITH (FORCE)`))
    ).toBe(true);
    expect(queries.some((q) => q.includes(`DROP USER IF EXISTS "${creds.user}"`))).toBe(true);

    const files = await listPreDeleteFiles();
    expect(files.some((f) => f.endsWith('.dump'))).toBe(true);
    expect(files.some((f) => f.endsWith('.restore-role.sql'))).toBe(true);
    expect(files.some((f) => f.endsWith('.partial'))).toBe(false);
  });

  it('dump fails -> no drop issued, entry retained, no leftover .partial', async () => {
    injectCredentials(provisioner, 'myapp');
    mockRunPgDump.mockResolvedValue({ ok: false, error: 'disk full' });

    const result = await provisioner.backupAndDeleteAppDatabase('myapp');

    expect(result.dropped).toBe(false);
    expect(result.reason).toMatch(/dump failed/);
    expect(queryMock).not.toHaveBeenCalled();
    expect(provisioner.isProvisioned('myapp')).toBe(true);

    const files = await listPreDeleteFiles();
    expect(files.some((f) => f.endsWith('.partial'))).toBe(false);
    expect(files.some((f) => f.endsWith('.dump'))).toBe(false);
  });

  it('pg_dump binary missing -> dropped:false, reason mentions not found, entry retained', async () => {
    const ext = process.platform === 'win32' ? '.exe' : '';
    await fs.rm(path.join(dropRoot, 'apps', 'drop-svc', 'pgsql', 'bin', `pg_dump${ext}`), {
      force: true,
    });
    injectCredentials(provisioner, 'myapp');

    const result = await provisioner.backupAndDeleteAppDatabase('myapp');

    expect(result.dropped).toBe(false);
    expect(result.reason).toMatch(/not found/);
    expect(mockRunPgDump).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
    expect(provisioner.isProvisioned('myapp')).toBe(true);
  });

  it('DROP USER fails after a good dump + DROP DATABASE -> dropped:false, entry retained (both-gate)', async () => {
    injectCredentials(provisioner, 'myapp');
    stubSuccessfulDump();
    queryMock.mockImplementation((sql: string) => {
      if (/DROP USER/i.test(sql)) {
        return Promise.reject(new Error('role has dependent privileges'));
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await provisioner.backupAndDeleteAppDatabase('myapp');

    expect(result.dropped).toBe(false);
    expect(result.reason).toMatch(/database drop ok, role drop FAILED/);
    expect(provisioner.isProvisioned('myapp')).toBe(true);
    // The dump itself is still committed to disk — it's the safety net,
    // independent of whether the drop half-succeeded.
    const files = await listPreDeleteFiles();
    expect(files.some((f) => f.endsWith('.dump'))).toBe(true);
  });

  it('dump "succeeds" but is not a valid pg_dump archive -> verification fails, no drop, entry retained', async () => {
    injectCredentials(provisioner, 'myapp');
    mockRunPgDump.mockImplementation(async (_bin: string, opts: { outFile: string }) => {
      await fs.writeFile(opts.outFile, Buffer.from('NOT-A-REAL-DUMP'));
      return { ok: true };
    });

    const result = await provisioner.backupAndDeleteAppDatabase('myapp');

    expect(result.dropped).toBe(false);
    expect(result.reason).toMatch(/verification failed/);
    expect(queryMock).not.toHaveBeenCalled();
    expect(provisioner.isProvisioned('myapp')).toBe(true);

    const files = await listPreDeleteFiles();
    expect(files.some((f) => f.endsWith('.partial'))).toBe(false);
    expect(files.some((f) => f.endsWith('.dump'))).toBe(false);
  });

  it('retention: prunes pre-delete dumps older than DROP_PREDELETE_RETENTION_DAYS (default 3 days)', async () => {
    await fs.mkdir(preDeleteDir(), { recursive: true, mode: 0o700 });
    const oldDump = path.join(preDeleteDir(), 'drop_old-app-2020-01-01T00-00-00-000Z.dump');
    await fs.writeFile(oldDump, 'stale dump content');
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    await fs.utimes(oldDump, fourDaysAgo, fourDaysAgo);

    injectCredentials(provisioner, 'myapp');
    stubSuccessfulDump();

    await provisioner.backupAndDeleteAppDatabase('myapp');

    const files = await listPreDeleteFiles();
    expect(files).not.toContain('drop_old-app-2020-01-01T00-00-00-000Z.dump');
    expect(files.some((f) => f.startsWith('drop_myapp-') && f.endsWith('.dump'))).toBe(true);
  });
});

describe('DatabaseProvisioner.loadCredentials — corrupt-file quarantine', () => {
  let dropRoot: string;
  let svcDir: string;
  let credsPath: string;

  beforeEach(async () => {
    dropRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-prov-'));
    svcDir = path.join(dropRoot, 'data', 'drop-svc');
    await fs.mkdir(svcDir, { recursive: true });
    credsPath = path.join(svcDir, 'db-credentials.json');
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(dropRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function quarantineFiles(): Promise<string[]> {
    return (await fs.readdir(svcDir)).filter((f) => f.includes('.corrupt-'));
  }

  it('quarantines a corrupt (unparseable) db-credentials.json instead of overwriting it', async () => {
    await fs.writeFile(credsPath, '{ this is not: valid json');
    const p = new DatabaseProvisioner(makeMockServer(), dropRoot);
    await p.initialize();

    // Original renamed away — not left in place, not silently overwritten.
    await expect(fs.access(credsPath)).rejects.toThrow();
    const quarantined = await quarantineFiles();
    expect(quarantined).toHaveLength(1);
    // Contents preserved for recovery.
    expect(await fs.readFile(path.join(svcDir, quarantined[0]), 'utf-8')).toContain('not: valid json');
    expect(p.listDatabases()).toEqual([]);
  });

  it('quarantines a valid-JSON-but-wrong-shape file', async () => {
    await fs.writeFile(credsPath, JSON.stringify({ version: 1, notDatabases: [] }));
    const p = new DatabaseProvisioner(makeMockServer(), dropRoot);
    await p.initialize();
    expect(await quarantineFiles()).toHaveLength(1);
    expect(p.listDatabases()).toEqual([]);
  });

  it('loads a valid file without quarantining', async () => {
    await fs.writeFile(
      credsPath,
      JSON.stringify({
        version: 1,
        databases: [
          {
            appName: 'myapp',
            credentials: {
              host: 'localhost',
              port: 5433,
              database: 'drop_myapp',
              user: 'drop_myapp_user',
              password: 'p',
              connectionString: 'postgresql://x',
            },
            createdAt: new Date().toISOString(),
          },
        ],
      })
    );
    const p = new DatabaseProvisioner(makeMockServer(), dropRoot);
    await p.initialize();
    expect(await quarantineFiles()).toHaveLength(0);
    expect(p.getAppCredentials('myapp')).not.toBeNull();
  });

  it('first run (no file) starts empty and creates no quarantine file', async () => {
    const p = new DatabaseProvisioner(makeMockServer(), dropRoot);
    await p.initialize();
    expect(await quarantineFiles()).toHaveLength(0);
    expect(p.listDatabases()).toEqual([]);
  });
});
