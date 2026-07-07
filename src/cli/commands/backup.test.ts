/**
 * `drop backup` — per-app database backup tests.
 *
 * See docs/plans/2026-07-07-per-app-db-backup.md. Mocks the `pg` Pool (so no
 * real Postgres is needed to test enumeration) and `child_process.spawn` (so
 * pg_dump "runs" without a real binary — the bundled pg_dump path just needs
 * to exist on disk for the missing-binary check; a successful mocked run
 * writes a stub file to the `-f` target to simulate pg_dump's output).
 *
 * Coverage:
 *  (a) dumps each per-app DB, excluding drop_internal/postgres/templates.
 *  (b) a failing per-app dump -> exitCode 1, summary names it, others still attempted.
 *  (c) enumeration (Pool.query) throwing -> exitCode 1 but the file-store backup is still committed.
 *  (d) restore-roles.sql has one CREATE ROLE per db-credentials.json entry, none for postgres.
 *  (e) Pool.end() is called even when query throws.
 *  (f) an enumerated name like `drop_../evil` is rejected by the allowlist (not dumped).
 *  (g) missing pg_dump binary -> exitCode 1 (not a silent skip).
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import { EventEmitter } from 'events';
import { Pool } from 'pg';

// jest.mock factories are hoisted — keep them pure jest.fn() stubs (mirrors
// database-provisioner.test.ts) and configure implementations in beforeEach.
jest.mock('pg', () => ({ Pool: jest.fn() }));
jest.mock('child_process', () => ({ spawn: jest.fn() }));

import { spawn } from 'child_process';
import { createBackupCommand } from './backup';

const MockPool = Pool as unknown as jest.Mock;
const mockSpawn = spawn as unknown as jest.Mock;

const isWindows = process.platform === 'win32';
const PG_DUMP_NAME = isWindows ? 'pg_dump.exe' : 'pg_dump';
const INTERNAL_DB = process.env.DROP_DB_NAME || 'drop_internal';

// ── Fake child_process helpers ──────────────────────────────────────────────

/**
 * A fake ChildProcess good enough for backup.ts's spawn handling: an
 * EventEmitter with a `.stderr` EventEmitter, emitting `close`/`error`
 * asynchronously. On a "successful" close it writes a stub file to the
 * dump's `-f` target so file-existence assertions behave like a real
 * pg_dump run would.
 */
function makeFakeChild(opts: { code?: number; errorMsg?: string; stderr?: string; outFile?: string }) {
  const child: any = new EventEmitter();
  child.stderr = new EventEmitter();
  process.nextTick(() => {
    if (opts.errorMsg) {
      child.emit('error', new Error(opts.errorMsg));
      return;
    }
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    const code = opts.code ?? 0;
    if (code === 0 && opts.outFile) {
      try {
        fssync.writeFileSync(opts.outFile, 'FAKE-DUMP');
      } catch {
        // ignore — not the point of the test
      }
    }
    child.emit('close', code);
  });
  return child;
}

/** Extract the `-f <outFile>` target and the trailing db-name arg from a pg_dump argv. */
function parseDumpArgs(args: string[]): { outFile?: string; dbName: string } {
  const fIdx = args.indexOf('-f');
  return {
    outFile: fIdx >= 0 ? args[fIdx + 1] : undefined,
    dbName: args[args.length - 1],
  };
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

async function seedDropRoot(
  dropRoot: string,
  opts: { withPgDump?: boolean; dbCredentials?: unknown; superuserPassword?: string } = {}
): Promise<void> {
  const svcDir = path.join(dropRoot, 'data', 'drop-svc');
  await fs.mkdir(svcDir, { recursive: true });
  await fs.writeFile(path.join(svcDir, '.pg-superuser'), opts.superuserPassword ?? 'test-superuser-pw');
  if (opts.dbCredentials !== undefined) {
    await fs.writeFile(path.join(svcDir, 'db-credentials.json'), JSON.stringify(opts.dbCredentials));
  }
  if (opts.withPgDump !== false) {
    const binDir = path.join(dropRoot, 'apps', 'drop-svc', 'pgsql', 'bin');
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(path.join(binDir, PG_DUMP_NAME), '');
  }
}

function backupRootOf(dropRoot: string): string {
  return path.join(dropRoot, 'data', 'backup');
}

async function listBackupDirs(dropRoot: string): Promise<string[]> {
  try {
    return await fs.readdir(backupRootOf(dropRoot));
  } catch {
    return [];
  }
}

async function findFinalBackupDir(dropRoot: string): Promise<string | undefined> {
  const dirs = await listBackupDirs(dropRoot);
  return dirs.find((d) => d.startsWith('backup-') && !d.endsWith('.partial'));
}

async function runBackup(dropRoot: string, extraArgs: string[] = []): Promise<void> {
  const cmd = createBackupCommand();
  await cmd.parseAsync(['--root', dropRoot, ...extraArgs], { from: 'user' });
}

function consoleLogText(): string {
  return (console.log as jest.Mock).mock.calls.map((c) => c.join(' ')).join('\n');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('drop backup — per-app database backup', () => {
  let dropRoot: string;
  let mockQueryFn: jest.Mock;
  let mockEndFn: jest.Mock;
  let failingDbNames: Set<string>;

  beforeEach(async () => {
    dropRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-backup-'));
    process.exitCode = undefined;
    failingDbNames = new Set();

    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    mockQueryFn = jest.fn().mockResolvedValue({ rows: [] });
    mockEndFn = jest.fn().mockResolvedValue(undefined);
    MockPool.mockImplementation(() => ({ query: mockQueryFn, end: mockEndFn }));

    mockSpawn.mockReset();
    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const { outFile, dbName } = parseDumpArgs(args);
      const fail = failingDbNames.has(dbName);
      return makeFakeChild({
        code: fail ? 1 : 0,
        stderr: fail ? `simulated pg_dump failure for ${dbName}` : undefined,
        outFile,
      });
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    process.exitCode = undefined;
    await fs.rm(dropRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  // (a) ------------------------------------------------------------------
  it('dumps each per-app database, excluding drop_internal/postgres/templates', async () => {
    await seedDropRoot(dropRoot);
    mockQueryFn.mockResolvedValue({
      rows: [
        { datname: 'postgres' },
        { datname: 'drop_internal' },
        { datname: 'drop_myapp' },
        { datname: 'drop_otherapp' },
        { datname: 'template0' },
        { datname: 'template1' },
        { datname: 'unrelated_db' },
      ],
    });

    await runBackup(dropRoot);

    expect(process.exitCode).toBeUndefined();

    const finalDir = await findFinalBackupDir(dropRoot);
    expect(finalDir).toBeDefined();

    const dbFiles = await fs.readdir(path.join(backupRootOf(dropRoot), finalDir!, 'databases'));
    expect(dbFiles).toContain(`${INTERNAL_DB}.dump`);
    expect(dbFiles).toContain('drop_myapp.dump');
    expect(dbFiles).toContain('drop_otherapp.dump');
    expect(dbFiles).not.toContain('postgres.dump');
    expect(dbFiles).not.toContain('template0.dump');
    expect(dbFiles).not.toContain('template1.dump');
    expect(dbFiles).not.toContain('unrelated_db.dump');
  });

  // (b) ------------------------------------------------------------------
  it('a failing per-app dump sets exitCode 1, names it in the summary, and still attempts others', async () => {
    await seedDropRoot(dropRoot);
    mockQueryFn.mockResolvedValue({
      rows: [{ datname: 'drop_myapp' }, { datname: 'drop_other' }],
    });
    failingDbNames.add('drop_myapp');

    await runBackup(dropRoot);

    expect(process.exitCode).toBe(1);

    const finalDir = await findFinalBackupDir(dropRoot);
    expect(finalDir).toBeDefined();

    const dbFiles = await fs.readdir(path.join(backupRootOf(dropRoot), finalDir!, 'databases'));
    expect(dbFiles).not.toContain('drop_myapp.dump');
    expect(dbFiles).toContain('drop_other.dump');
    expect(dbFiles).toContain(`${INTERNAL_DB}.dump`);

    expect(consoleLogText()).toContain('drop_myapp');

    // drop_other was still attempted despite drop_myapp's failure.
    const attemptedDbNames = mockSpawn.mock.calls.map((call) => parseDumpArgs(call[1]).dbName);
    expect(attemptedDbNames).toContain('drop_other');
    expect(attemptedDbNames).toContain('drop_myapp');
  });

  // (c) ------------------------------------------------------------------
  it('enumeration failure is non-fatal: exitCode 1 but the file-store backup is still committed', async () => {
    await seedDropRoot(dropRoot);
    mockQueryFn.mockRejectedValue(new Error('connection refused'));

    await runBackup(dropRoot);

    // Loud: enumeration failure forces a non-zero exit and is named in output.
    expect(process.exitCode).toBe(1);
    expect((console.error as jest.Mock).mock.calls.join('\n')).toMatch(/enumeration failed/i);

    // But the file stores (the most non-reconstructable state) ARE committed —
    // losing them because Postgres happened to be down is the regression this
    // guards against.
    const finalDir = await findFinalBackupDir(dropRoot);
    expect(finalDir).toBeDefined();
    const contents = await fs.readdir(path.join(backupRootOf(dropRoot), finalDir!));
    expect(contents).toContain('.pg-superuser');

    // No per-app dumps were attempted (we couldn't enumerate them); only the
    // internal DB was targeted.
    const attemptedDbNames = mockSpawn.mock.calls.map((call) => parseDumpArgs(call[1]).dbName);
    expect(attemptedDbNames).toEqual([INTERNAL_DB]);

    // And no orphan .partial is left behind (it was renamed to the final dir).
    const dirs = await listBackupDirs(dropRoot);
    expect(dirs.some((d) => d.endsWith('.partial'))).toBe(false);
  });

  // (d) ------------------------------------------------------------------
  it('restore-roles.sql has one CREATE ROLE per db-credentials.json entry and none for postgres', async () => {
    await seedDropRoot(dropRoot, {
      dbCredentials: {
        version: 1,
        updatedAt: new Date().toISOString(),
        databases: [
          {
            appName: 'app1',
            credentials: { user: 'drop_app1_user', password: "pa'ss" },
            createdAt: new Date().toISOString(),
          },
          {
            appName: 'app2',
            credentials: { user: 'drop_app2_user', password: 'plainpw' },
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
    mockQueryFn.mockResolvedValue({ rows: [] });

    await runBackup(dropRoot);

    const finalDir = await findFinalBackupDir(dropRoot);
    expect(finalDir).toBeDefined();

    const rolesSql = await fs.readFile(
      path.join(backupRootOf(dropRoot), finalDir!, 'databases', 'restore-roles.sql'),
      'utf-8'
    );

    expect(rolesSql).toContain('CREATE ROLE "drop_app1_user" LOGIN PASSWORD \'pa\'\'ss\';');
    expect(rolesSql).toContain('CREATE ROLE "drop_app2_user" LOGIN PASSWORD \'plainpw\';');
    expect(rolesSql).not.toMatch(/CREATE ROLE "postgres"/);
  });

  // (e) ------------------------------------------------------------------
  it('Pool.end() is called even when query throws', async () => {
    await seedDropRoot(dropRoot);
    mockQueryFn.mockRejectedValue(new Error('connection refused'));

    await runBackup(dropRoot);

    expect(mockEndFn).toHaveBeenCalledTimes(1);
  });

  // (f) ------------------------------------------------------------------
  it('rejects an enumerated name that fails the allowlist (not dumped)', async () => {
    await seedDropRoot(dropRoot);
    mockQueryFn.mockResolvedValue({
      rows: [{ datname: 'drop_../evil' }, { datname: 'drop_good' }],
    });

    await runBackup(dropRoot);

    // The malicious name never reaches spawn as an argument.
    const attemptedDbNames = mockSpawn.mock.calls.map((call) => parseDumpArgs(call[1]).dbName);
    expect(attemptedDbNames).not.toContain('drop_../evil');
    expect(attemptedDbNames).toContain('drop_good');

    const finalDir = await findFinalBackupDir(dropRoot);
    expect(finalDir).toBeDefined();
    const dbFiles = await fs.readdir(path.join(backupRootOf(dropRoot), finalDir!, 'databases'));
    expect(dbFiles).not.toContain('drop_../evil.dump');

    // A real database exists but wasn't captured — that's a gap, so it's loud.
    expect(process.exitCode).toBe(1);
    expect(consoleLogText()).toContain('drop_../evil');
  });

  // (g) ------------------------------------------------------------------
  it('missing pg_dump binary is a loud non-zero failure, not a silent skip', async () => {
    await seedDropRoot(dropRoot, { withPgDump: false });
    mockQueryFn.mockResolvedValue({ rows: [] });

    await runBackup(dropRoot);

    expect(process.exitCode).toBe(1);
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(consoleLogText() + (console.error as jest.Mock).mock.calls.join('\n')).toMatch(/pg_dump/i);

    // File stores are still captured — write what you can.
    const finalDir = await findFinalBackupDir(dropRoot);
    expect(finalDir).toBeDefined();
  });
});
