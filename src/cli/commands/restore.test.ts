/**
 * `drop restore` tests.
 *
 * Mocks `child_process.spawn` (like backup.test.ts — no real Postgres client
 * binaries are invoked) and `./serve`'s `getDaemonStatus` (the offline guard
 * this command reuses). Uses a real temp dir for the DROP root and backup
 * dir fixtures so file-store copy/mode behavior is exercised for real.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as http from 'http';
import { EventEmitter } from 'events';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('./serve', () => ({ getDaemonStatus: jest.fn() }));

import { spawn } from 'child_process';
import { getDaemonStatus } from './serve';
import { createRestoreCommand } from './restore';

const mockSpawn = spawn as unknown as jest.Mock;
const mockGetDaemonStatus = getDaemonStatus as jest.Mock;

const isWindows = process.platform === 'win32';
const PSQL_NAME = isWindows ? 'psql.exe' : 'psql';
const PG_RESTORE_NAME = isWindows ? 'pg_restore.exe' : 'pg_restore';

// ── Fake child_process helper ───────────────────────────────────────────────

/** Configurable fake child good enough for restore.ts's spawn handling. */
function makeFakeChild(opts: { code?: number; errorMsg?: string; stderr?: string }) {
  const child: any = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  process.nextTick(() => {
    if (opts.errorMsg) {
      child.emit('error', new Error(opts.errorMsg));
      return;
    }
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    child.emit('close', opts.code ?? 0);
  });
  return child;
}

// ── Fixture helpers ──────────────────────────────────────────────────────────

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Bind an ephemeral port, then close it — a port that is now (almost certainly) refused. */
function getClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function svcDirOf(dropRoot: string): string {
  return path.join(dropRoot, 'data', 'drop-svc');
}

async function seedCurrentSuperuser(dropRoot: string, password: string): Promise<void> {
  const dir = svcDirOf(dropRoot);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, '.pg-superuser'), password, { mode: 0o600 });
}

async function seedPgBinaries(dropRoot: string): Promise<void> {
  const binDir = path.join(dropRoot, 'apps', 'drop-svc', 'pgsql', 'bin');
  await fs.mkdir(binDir, { recursive: true });
  await fs.writeFile(path.join(binDir, PSQL_NAME), '');
  await fs.writeFile(path.join(binDir, PG_RESTORE_NAME), '');
}

async function seedBackupFileStores(
  backupDir: string,
  opts: { superuserPassword?: string } = {}
): Promise<void> {
  await fs.mkdir(backupDir, { recursive: true });
  await fs.writeFile(
    path.join(backupDir, '.pg-superuser'),
    opts.superuserPassword ?? 'backup-superuser-pw',
    {
      mode: 0o600,
    }
  );
  await fs.writeFile(path.join(backupDir, 'apps.json'), JSON.stringify({ apps: [] }), {
    mode: 0o600,
  });
}

async function seedBackupDatabases(backupDir: string): Promise<void> {
  const dbDir = path.join(backupDir, 'databases');
  await fs.mkdir(dbDir, { recursive: true });
  await fs.writeFile(
    path.join(dbDir, 'restore-roles.sql'),
    'CREATE ROLE "drop_myapp_user" LOGIN PASSWORD \'x\';\n'
  );
  await fs.writeFile(path.join(dbDir, 'drop_internal.dump'), 'FAKE-INTERNAL-DUMP');
  await fs.writeFile(path.join(dbDir, 'drop_myapp.dump'), 'FAKE-APP-DUMP');
}

async function runRestore(
  dropRoot: string,
  backupDir: string,
  extraArgs: string[] = []
): Promise<void> {
  const cmd = createRestoreCommand();
  await cmd.parseAsync([backupDir, '--root', dropRoot, ...extraArgs], { from: 'user' });
}

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

function consoleText(): string {
  const log = (console.log as jest.Mock).mock.calls.map(c => c.join(' ')).join('\n');
  const warn = console.warn
    ? (console.warn as jest.Mock).mock.calls.map(c => c.join(' ')).join('\n')
    : '';
  const err = (console.error as jest.Mock).mock.calls.map(c => c.join(' ')).join('\n');
  return `${log}\n${warn}\n${err}`;
}

/** Parse a psql/pg_restore argv for the flags this suite cares about. */
function parseArgs(args: string[]): {
  isRoles: boolean;
  isRestore: boolean;
  isProbe: boolean;
  target?: string;
} {
  const isRoles = args.includes('-f');
  const isRestore = args.includes('--create');
  const isProbe = args.includes('-c');
  const target = args[args.length - 1];
  return { isRoles, isRestore, isProbe, target };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('drop restore', () => {
  let dropRoot: string;
  let backupDir: string;
  let priorApiPort: string | undefined;
  let healthServer: http.Server | undefined;

  beforeEach(async () => {
    dropRoot = await makeTempDir('drop-restore-root-');
    backupDir = await makeTempDir('drop-restore-backup-');
    process.exitCode = undefined;

    // Point the API health-probe (second offline-guard signal) at a closed
    // port so it deterministically reports "not running" — tests that want a
    // live platform override DROP_API_PORT with a real listener's port.
    priorApiPort = process.env.DROP_API_PORT;
    process.env.DROP_API_PORT = String(await getClosedPort());
    healthServer = undefined;

    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'info').mockImplementation();

    mockGetDaemonStatus.mockReset();
    mockGetDaemonStatus.mockResolvedValue({ running: false });

    mockSpawn.mockReset();
    // Default: every spawned client succeeds (reachable, roles ok, restores ok).
    mockSpawn.mockImplementation(() => makeFakeChild({ code: 0 }));
  });

  afterEach(async () => {
    if (healthServer) {
      await new Promise<void>(resolve => healthServer!.close(() => resolve()));
    }
    if (priorApiPort === undefined) delete process.env.DROP_API_PORT;
    else process.env.DROP_API_PORT = priorApiPort;

    jest.restoreAllMocks();
    process.exitCode = undefined;
    await fs.rm(dropRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fs.rm(backupDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('refuses when the platform is running, before writing anything', async () => {
    await seedBackupFileStores(backupDir);
    mockGetDaemonStatus.mockResolvedValue({ running: true, pid: 4242 });

    await runRestore(dropRoot, backupDir, ['--confirm']);

    expect(process.exitCode).toBe(1);
    expect(consoleText()).toMatch(/stop the platform first/i);
    expect(consoleText()).toContain('4242');

    // Nothing was written — the offline guard runs before any write.
    expect(await readDirSafe(svcDirOf(dropRoot))).toEqual([]);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('refuses when a FOREGROUND platform is serving the API (daemon check alone misses it)', async () => {
    await seedBackupFileStores(backupDir);
    // The PM2 daemon check says "not running" — a foreground `drop serve` is
    // invisible to it — but the platform is answering /api/v1/health.
    mockGetDaemonStatus.mockResolvedValue({ running: false });
    const port = await new Promise<number>(resolve => {
      healthServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });
      healthServer.listen(0, '127.0.0.1', () => {
        const addr = healthServer!.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    process.env.DROP_API_PORT = String(port);

    await runRestore(dropRoot, backupDir, ['--confirm']);

    expect(process.exitCode).toBe(1);
    expect(consoleText()).toMatch(/responding on the API port/i);
    expect(await readDirSafe(svcDirOf(dropRoot))).toEqual([]);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('errors on a directory that does not look like a backup', async () => {
    // backupDir exists but is empty — no DROP_SVC_FILES, no databases/.
    await runRestore(dropRoot, backupDir, ['--confirm']);

    expect(process.exitCode).toBe(1);
    expect(consoleText()).toMatch(/does not look like a drop backup/i);
    expect(await readDirSafe(svcDirOf(dropRoot))).toEqual([]);
  });

  it('without --confirm: prints the plan and writes nothing, exit code 0', async () => {
    await seedBackupFileStores(backupDir);
    await seedBackupDatabases(backupDir);

    await runRestore(dropRoot, backupDir);

    expect(process.exitCode).toBeUndefined();
    expect(consoleText()).toMatch(/re-run with --confirm to execute/i);
    expect(await readDirSafe(svcDirOf(dropRoot))).toEqual([]);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('--confirm --dry-run together: still only prints the plan, writes nothing', async () => {
    await seedBackupFileStores(backupDir);

    await runRestore(dropRoot, backupDir, ['--confirm', '--dry-run']);

    expect(process.exitCode).toBeUndefined();
    expect(consoleText()).toMatch(/re-run with --confirm to execute/i);
    expect(await readDirSafe(svcDirOf(dropRoot))).toEqual([]);
  });

  it('--confirm: copies file stores back, preserving mode on POSIX', async () => {
    await seedBackupFileStores(backupDir);

    await runRestore(dropRoot, backupDir, ['--confirm']);

    const restoredFiles = await readDirSafe(svcDirOf(dropRoot));
    expect(restoredFiles).toContain('.pg-superuser');
    expect(restoredFiles).toContain('apps.json');

    if (process.platform !== 'win32') {
      const stat = await fs.stat(path.join(svcDirOf(dropRoot), '.pg-superuser'));
      expect(stat.mode & 0o777).toBe(0o600);
      const statApps = await fs.stat(path.join(svcDirOf(dropRoot), 'apps.json'));
      expect(statApps.mode & 0o777).toBe(0o600);
    }
  });

  it('copies backupDir/webapps to data/appconf/webapps recursively', async () => {
    await seedBackupFileStores(backupDir);
    const webappsSrc = path.join(backupDir, 'webapps', 'myapp');
    await fs.mkdir(webappsSrc, { recursive: true });
    await fs.writeFile(path.join(webappsSrc, 'config.json'), '{}');

    await runRestore(dropRoot, backupDir, ['--confirm']);

    const dest = path.join(dropRoot, 'data', 'appconf', 'webapps', 'myapp', 'config.json');
    await expect(fs.readFile(dest, 'utf-8')).resolves.toBe('{}');
  });

  it('uses the CURRENT superuser password (not the backup copy) for DB commands, roles first then per-dump restores', async () => {
    await seedCurrentSuperuser(dropRoot, 'CURRENT-PW');
    await seedBackupFileStores(backupDir, { superuserPassword: 'STALE-BACKUP-PW' });
    await seedBackupDatabases(backupDir);
    await seedPgBinaries(dropRoot);

    await runRestore(dropRoot, backupDir, ['--confirm']);

    expect(process.exitCode).toBeUndefined();

    // Every psql/pg_restore invocation used PGPASSWORD=CURRENT-PW, never the backup's.
    for (const call of mockSpawn.mock.calls) {
      const env = call[2]?.env;
      if (env && 'PGPASSWORD' in env) {
        expect(env.PGPASSWORD).toBe('CURRENT-PW');
        expect(env.PGPASSWORD).not.toBe('STALE-BACKUP-PW');
      }
    }

    // Classify calls, ignoring the reachability probe.
    const restoreCalls = mockSpawn.mock.calls
      .map(call => parseArgs(call[1] as string[]))
      .filter(c => !c.isProbe);

    expect(restoreCalls[0].isRoles).toBe(true);
    const rest = restoreCalls.slice(1);
    expect(rest.length).toBe(2);
    for (const c of rest) {
      expect(c.isRestore).toBe(true);
    }
    const restoredTargets = rest.map(c => c.target);
    expect(restoredTargets.some(t => t?.endsWith('drop_internal.dump'))).toBe(true);
    expect(restoredTargets.some(t => t?.endsWith('drop_myapp.dump'))).toBe(true);

    // No db name/path ever appears bare on argv in a way requiring shell interpretation —
    // spawn is never invoked with shell:true anywhere in this suite's calls.
    for (const call of mockSpawn.mock.calls) {
      expect(call[2]?.shell).toBeFalsy();
    }
  });

  it('Postgres unreachable: no destructive pg_restore runs, manual commands are printed, file stores still restored', async () => {
    await seedCurrentSuperuser(dropRoot, 'CURRENT-PW');
    await seedBackupFileStores(backupDir);
    await seedBackupDatabases(backupDir);
    await seedPgBinaries(dropRoot);

    // Every spawned client (including the reachability probe) fails.
    mockSpawn.mockImplementation(() => makeFakeChild({ code: 1, stderr: 'connection refused' }));

    await runRestore(dropRoot, backupDir, ['--confirm']);

    expect(process.exitCode).toBe(1);
    expect(consoleText()).toMatch(/not reachable/i);
    expect(consoleText()).toMatch(/run these manually/i);

    // No -f (roles) or --create (pg_restore) call was made — only the probe ran.
    const destructiveCalls = mockSpawn.mock.calls
      .map(call => parseArgs(call[1] as string[]))
      .filter(c => c.isRoles || c.isRestore);
    expect(destructiveCalls.length).toBe(0);

    // File stores were still restored despite the DB skip.
    const restoredFiles = await readDirSafe(svcDirOf(dropRoot));
    expect(restoredFiles).toContain('.pg-superuser');
    expect(restoredFiles).toContain('apps.json');
  });

  it('missing psql/pg_restore binaries: skips DB restore, prints manual commands, still restores file stores', async () => {
    await seedCurrentSuperuser(dropRoot, 'CURRENT-PW');
    await seedBackupFileStores(backupDir);
    await seedBackupDatabases(backupDir);
    // Intentionally do NOT seed the pgsql/bin binaries.

    await runRestore(dropRoot, backupDir, ['--confirm']);

    expect(process.exitCode).toBe(1);
    expect(consoleText()).toMatch(/not found/i);
    expect(consoleText()).toMatch(/run these manually/i);
    expect(mockSpawn).not.toHaveBeenCalled();

    const restoredFiles = await readDirSafe(svcDirOf(dropRoot));
    expect(restoredFiles).toContain('.pg-superuser');
  });

  it('falls back to the backup copy of .pg-superuser with a warning when no current one exists', async () => {
    // No seedCurrentSuperuser call — current file is absent.
    await seedBackupFileStores(backupDir, { superuserPassword: 'ONLY-BACKUP-PW' });
    await seedBackupDatabases(backupDir);
    await seedPgBinaries(dropRoot);

    await runRestore(dropRoot, backupDir, ['--confirm']);

    expect(consoleText()).toMatch(/falling back to the backup/i);

    const rolesCall = mockSpawn.mock.calls.find(call => (call[1] as string[]).includes('-f'));
    expect(rolesCall).toBeDefined();
    expect(rolesCall![2]?.env?.PGPASSWORD).toBe('ONLY-BACKUP-PW');
  });

  it('a failed pg_restore step is loud and non-fatal to the remaining steps', async () => {
    await seedCurrentSuperuser(dropRoot, 'CURRENT-PW');
    await seedBackupFileStores(backupDir);
    await seedBackupDatabases(backupDir);
    await seedPgBinaries(dropRoot);

    mockSpawn.mockImplementation((_cmd: string, args: string[]) => {
      const target = args[args.length - 1] as string;
      if (typeof target === 'string' && target.endsWith('drop_myapp.dump')) {
        return makeFakeChild({ code: 1, stderr: 'simulated pg_restore failure' });
      }
      return makeFakeChild({ code: 0 });
    });

    await runRestore(dropRoot, backupDir, ['--confirm']);

    expect(process.exitCode).toBe(1);
    expect(consoleText()).toContain('drop_myapp.dump');

    // drop_internal.dump was still attempted despite drop_myapp.dump's failure.
    const restoreCalls = mockSpawn.mock.calls
      .map(call => parseArgs(call[1] as string[]))
      .filter(c => c.isRestore);
    expect(restoreCalls.some(c => c.target?.endsWith('drop_internal.dump'))).toBe(true);
  });
});
