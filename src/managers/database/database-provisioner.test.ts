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

// jest.mock factory is hoisted — keep the factory a pure jest.fn() stub so
// there are no TDZ references to module-level vars.  We configure the
// implementation in beforeEach instead.
jest.mock('pg', () => ({
  Pool: jest.fn(),
}));

const MockPool = Pool as jest.MockedClass<typeof Pool>;

// ── PostgresServer mock ───────────────────────────────────────────────────────

function makeMockServer() {
  return {
    databaseExists: jest.fn().mockResolvedValue(false),
    createDatabase: jest.fn().mockResolvedValue(undefined),
    createUser: jest.fn().mockResolvedValue(undefined),
    grantPrivileges: jest.fn().mockResolvedValue(undefined),
    getSuperuserPoolConfig: jest.fn().mockReturnValue({ host: 'localhost', port: 5433 }),
    getPool: jest.fn(),
    getPort: jest.fn().mockReturnValue(5433),
    getSuperuserPassword: jest.fn().mockReturnValue('superpassword'),
  } as any;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Inject credentials directly (bypasses provisionAppDatabase) for fast unit tests. */
function injectCredentials(provisioner: DatabaseProvisioner, appName: string) {
  const creds = {
    host: 'localhost',
    port: 5433,
    database: `drop_${appName}`,
    user: `drop_${appName}_user`,
    password: 'testpassword',
    connectionString: `postgresql://drop_${appName}_user:testpassword@localhost:5433/drop_${appName}`,
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
    await fs.rm(dropRoot, { recursive: true, force: true });
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
    await fs.rm(dropRoot, { recursive: true, force: true });
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
