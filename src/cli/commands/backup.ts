/**
 * Backup Command
 *
 * Snapshots DROP's critical, non-reconstructable state: the file-based stores
 * (credentials, secrets, encryption key, webhooks, app state/config), a
 * pg_dump of the internal database, and — critically — a pg_dump of every
 * provisioned per-app database plus a restore-roles.sql to recreate their
 * owning roles. Operators own the schedule — wire this into cron / Task
 * Scheduler (see docs).
 *
 * Safety properties (see docs/plans/2026-07-07-per-app-db-backup.md):
 *  - Hardened permissions: umask(0o077) + 0700 dirs, so dumps/creds are never
 *    world-readable.
 *  - Atomic: written to `backup-<ts>.partial/`, renamed to `backup-<ts>/`
 *    only once everything has been attempted — pruneBackups() never sees a
 *    truncated-looking backup.
 *  - Loud failure: any gap (enumeration, a per-app dump, the internal dump,
 *    a missing pg_dump binary) is collected and reported, and sets a non-zero
 *    exit code — never a silent "0 databases" backup. Even when PostgreSQL is
 *    unreachable, the file stores (encryption.key, secrets, api-credentials, …)
 *    are still committed: they're the single most non-reconstructable state, so
 *    a DB-down backup that saves them (loud + non-zero) beats saving nothing —
 *    which is exactly the emergency the tool exists for.
 */

import { Command } from 'commander';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import { Pool } from 'pg';
import * as output from '../utils/output';

const isWindows = process.platform === 'win32';
const DEFAULT_DROP_ROOT = isWindows ? 'C:\\drop' : '/var/drop';
const PG_PORT = 5433;
const INTERNAL_DB = process.env.DROP_DB_NAME || 'drop_internal';
const APP_DB_PREFIX = 'drop_';
const DB_CREDENTIALS_FILE = 'db-credentials.json';
/** Defense-in-depth: enumerated names must match before touching a path or spawn arg. */
const DB_NAME_ALLOWLIST = /^[a-z0-9_]+$/;

function resolveDropRoot(rootOpt?: string): string {
  return rootOpt || process.env.DROP_ROOT || DEFAULT_DROP_ROOT;
}

/** Files under data/drop-svc that hold critical state. */
const DROP_SVC_FILES = [
  'apps.json',
  'secrets.json',
  'webhooks.json',
  'activity-log.json',
  'api-credentials.json',
  'db-credentials.json',
  'encryption.key',
  '.pg-superuser',
];

async function copyIfExists(src: string, destDir: string): Promise<boolean> {
  try {
    await fs.access(src);
  } catch {
    return false;
  }
  await fs.cp(src, path.join(destDir, path.basename(src)), { recursive: true });
  return true;
}

/** Read the bundled superuser password (0600 file). Undefined if absent — caller decides. */
function readSuperuserPassword(dropRoot: string): string | undefined {
  try {
    return fssync.readFileSync(path.join(dropRoot, 'data', 'drop-svc', '.pg-superuser'), 'utf-8').trim();
  } catch {
    return undefined;
  }
}

function resolvePgDumpPath(dropRoot: string): string {
  const ext = isWindows ? '.exe' : '';
  return path.join(dropRoot, 'apps', 'drop-svc', 'pgsql', 'bin', `pg_dump${ext}`);
}

/**
 * Enumerate every non-template, per-app database via a live superuser query
 * (drift-proof — does not trust the possibly-stale/corrupt credentials
 * registry). Callers MUST let a thrown error propagate: enumeration failure
 * must be a hard, fatal error, never silently swallowed into "0 databases".
 */
async function enumerateAppDatabases(pgPassword: string | undefined): Promise<string[]> {
  const pool = new Pool({
    host: '127.0.0.1',
    port: PG_PORT,
    user: 'postgres',
    password: pgPassword,
    database: 'postgres',
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  try {
    const result = await pool.query('SELECT datname FROM pg_database WHERE datistemplate = false');
    const rows = result.rows as Array<{ datname: string }>;
    return rows
      .map((row) => row.datname)
      .filter((name) => name.startsWith(APP_DB_PREFIX) && name !== INTERNAL_DB && name !== 'postgres');
  } finally {
    // An un-ended Pool keeps the event loop open — a cron `drop backup`
    // would hang forever. Must run on every path, including the throw above.
    await pool.end();
  }
}

/** Result of a single pg_dump invocation. */
interface DumpResult {
  ok: boolean;
  error?: string;
}

/**
 * Run `pg_dump -Fc <dbName>` to `outFile`. Parameterized over dbName so it
 * can dump the internal database as well as every per-app database.
 * Intentionally omits `-C` — it's a no-op in custom format; `pg_restore
 * --create` is the real restore-time lever (and carries the per-DB
 * REVOKE CONNECT FROM PUBLIC).
 */
function runPgDump(
  pgDumpPath: string,
  dbName: string,
  outFile: string,
  pgPassword?: string
): Promise<DumpResult> {
  return new Promise((resolve) => {
    const args = [
      '-h', '127.0.0.1',
      '-p', String(PG_PORT),
      '-U', 'postgres',
      '-Fc',
      '-f', outFile,
      dbName,
    ];
    const child = spawn(pgDumpPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      // Password goes via env, never argv.
      env: pgPassword ? { ...process.env, PGPASSWORD: pgPassword } : process.env,
    });
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      resolve({ ok: false, error: `pg_dump failed to run: ${err.message}` });
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: `pg_dump exited with code ${code}: ${stderr.trim()}` });
      }
    });
  });
}

/**
 * Generate `databases/restore-roles.sql` from db-credentials.json — one
 * `CREATE ROLE ... LOGIN PASSWORD ...` per app user. These are all
 * non-superuser roles (postgres itself is never stored in this file), so
 * there is no conflict with the bundled superuser. If the credentials file
 * is missing or unparseable this is NOT a fatal error — an app may simply
 * have no databases — but an empty file + warning is returned.
 */
async function generateRestoreRolesSql(
  dropRoot: string,
  outFile: string
): Promise<{ count: number; warning?: string }> {
  const credsPath = path.join(dropRoot, 'data', 'drop-svc', DB_CREDENTIALS_FILE);
  const lines: string[] = [];
  let warning: string | undefined;

  try {
    const raw = await fs.readFile(credsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    const databases = Array.isArray(parsed?.databases) ? parsed.databases : [];
    for (const entry of databases) {
      const user = entry?.credentials?.user;
      const password = entry?.credentials?.password;
      if (typeof user !== 'string' || !user || typeof password !== 'string') continue;
      // Defensive escaping — role names are sanitized at provisioning time and
      // passwords are base64-with-no-quotes, but don't rely on that forever.
      const safeUser = user.replace(/"/g, '""');
      const safePassword = password.replace(/'/g, "''");
      lines.push(`CREATE ROLE "${safeUser}" LOGIN PASSWORD '${safePassword}';`);
    }
  } catch {
    warning = `${DB_CREDENTIALS_FILE} missing or unparseable — restore-roles.sql is empty (apps may have no databases)`;
  }

  await fs.writeFile(outFile, lines.length ? lines.join('\n') + '\n' : '', { mode: 0o600 });
  return { count: lines.length, warning };
}

/** Keep only the newest `keep` COMPLETE backup-* directories (never a `.partial`). */
async function pruneBackups(backupRoot: string, keep: number): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(backupRoot);
  } catch {
    return;
  }
  const backups = entries.filter((e) => e.startsWith('backup-') && !e.endsWith('.partial')).sort();
  const excess = backups.slice(0, Math.max(0, backups.length - keep));
  for (const dir of excess) {
    await fs.rm(path.join(backupRoot, dir), { recursive: true, force: true });
  }
  // Sweep orphan `.partial` dirs left by a hard-killed run (SIGKILL/power loss,
  // which bypasses the action's own cleanup). The current run's partial has
  // already been renamed to its final name by the time this runs.
  for (const stale of entries.filter((e) => e.startsWith('backup-') && e.endsWith('.partial'))) {
    await fs.rm(path.join(backupRoot, stale), { recursive: true, force: true });
  }
}

export function createBackupCommand(): Command {
  return new Command('backup')
    .description('Back up DROP state (file stores + internal database + every per-app database)')
    .option('-r, --root <dir>', 'DROP root directory')
    .option('-k, --keep <n>', 'Number of backups to retain', '7')
    .action(async (options) => {
      // Must run before any dump/write in this action: children (pg_dump)
      // inherit it, so their `-f` output is born 0600. Captured and restored in
      // the finally below — process.umask is process-GLOBAL, so leaving it at
      // 0o077 would corrupt unrelated file creation in any embedding process
      // (jest workers, a future in-process caller). Harmless to leak in the
      // one-shot CLI, but wrong everywhere else, so we don't leak it.
      const prevUmask = process.umask(0o077);

      const dropRoot = resolveDropRoot(options.root);
      const dataDir = path.join(dropRoot, 'data');
      const backupRoot = path.join(dataDir, 'backup');

      // A filesystem-safe timestamp (no colons) generated once.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const partialDir = path.join(backupRoot, `backup-${stamp}.partial`);
      const finalDir = path.join(backupRoot, `backup-${stamp}`);
      const databasesDir = path.join(partialDir, 'databases');

      /** Non-fatal gaps: collected, reported, and force a non-zero exit — but the backup still completes. */
      const failures: string[] = [];

      try {
        await fs.mkdir(partialDir, { recursive: true, mode: 0o700 });
        await fs.mkdir(databasesDir, { recursive: true, mode: 0o700 });

        // 1. File-based stores
        const svcDir = path.join(dataDir, 'drop-svc');
        let filesCopied = 0;
        for (const file of DROP_SVC_FILES) {
          if (await copyIfExists(path.join(svcDir, file), partialDir)) filesCopied++;
        }

        // 2. Per-app config files (canonical port assignments)
        const appconfWebapps = path.join(dataDir, 'appconf', 'webapps');
        if (await copyIfExists(appconfWebapps, partialDir)) filesCopied++;

        // 3. Enumerate per-app databases. Enumeration failure (typically:
        // PostgreSQL is down) is NON-fatal — it's recorded as a failure (loud
        // summary + non-zero exit) but we STILL commit the file-store backup.
        // The file stores (encryption.key, secrets, …) are the most
        // non-reconstructable state; a DB-down "emergency" backup is exactly
        // when losing them would be catastrophic, so saving them beats saving
        // nothing. It is never silently swallowed into a clean "0 databases".
        const pgPassword = readSuperuserPassword(dropRoot);
        let enumerated: string[] = [];
        try {
          enumerated = await enumerateAppDatabases(pgPassword);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          output.error(`Per-app database enumeration failed (is PostgreSQL running?): ${msg}`);
          failures.push(`per-app DB enumeration failed — per-app databases NOT captured: ${msg}`);
        }

        // 4. Allowlist enumerated names before they touch a path or spawn arg.
        const safeDbNames: string[] = [];
        for (const name of enumerated) {
          if (DB_NAME_ALLOWLIST.test(name)) {
            safeDbNames.push(name);
          } else {
            output.warn(`Skipping database with unexpected name (failed allowlist): ${name}`);
            failures.push(`${name}: rejected by name allowlist — NOT dumped`);
          }
        }

        // 5. Dump the internal database and every per-app database.
        const pgDumpPath = resolvePgDumpPath(dropRoot);
        const pgDumpExists = fssync.existsSync(pgDumpPath);
        const dbTargets = [INTERNAL_DB, ...safeDbNames];
        let dbDumpCount = 0;

        if (!pgDumpExists) {
          output.error(`Bundled pg_dump not found at ${pgDumpPath} — no database dumps were captured.`);
          failures.push(`pg_dump binary not found at ${pgDumpPath}`);
          for (const name of dbTargets) {
            failures.push(`${name}: not dumped (pg_dump binary missing)`);
          }
        } else {
          for (const name of dbTargets) {
            const outFile = path.join(databasesDir, `${name}.dump`);
            const result = await runPgDump(pgDumpPath, name, outFile, pgPassword);
            if (result.ok) {
              dbDumpCount++;
            } else {
              output.warn(`pg_dump failed for ${name}: ${result.error}`);
              failures.push(`${name}: ${result.error}`);
            }
          }
        }

        // 6. restore-roles.sql (app roles only — no superuser conflict).
        const rolesFile = path.join(databasesDir, 'restore-roles.sql');
        const rolesResult = await generateRestoreRolesSql(dropRoot, rolesFile);
        if (rolesResult.warning) output.warn(rolesResult.warning);

        // 7. Everything has been attempted — commit the backup atomically.
        await fs.rename(partialDir, finalDir);

        const keep = parseInt(options.keep, 10) || 7;
        await pruneBackups(backupRoot, keep);

        // 8. Accurate summary of what was captured (replaces the old
        // "per-app databases are NOT included" warning).
        output.success(`Backup written to ${finalDir}`);
        output.print(`  Platform files copied:   ${filesCopied}`);
        output.print(`  Databases dumped:        ${dbDumpCount} of ${dbTargets.length} (internal + ${safeDbNames.length} per-app)`);
        output.print(`  Restore roles captured:  ${rolesResult.count}`);
        output.print(`  Retained backups:        last ${keep}`);
        output.print('  Restore steps: see README "Restore round-trip" (databases/restore-roles.sql, then pg_restore --create per DB).');

        if (failures.length > 0) {
          output.warn(`${failures.length} item(s) were NOT captured:`);
          for (const f of failures) output.warn(`  - ${f}`);
          process.exitCode = 1;
        }
      } catch (err) {
        output.error('Backup failed', err instanceof Error ? err : undefined);
        try {
          await fs.rm(partialDir, { recursive: true, force: true });
        } catch {
          // Best effort — don't let cleanup failure mask the real error.
        }
        process.exitCode = 1;
      } finally {
        // Restore the umask so the 0o077 above never leaks past this action
        // (see the capture site). No-op on Windows.
        process.umask(prevUmask);
      }
    });
}
