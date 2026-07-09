/**
 * Restore Command
 *
 * Reverses `drop backup`: copies the file-based state stores back into
 * `data/drop-svc/` + `data/appconf/webapps/`, and (best-effort) replays the
 * per-database `pg_dump` snapshots via the bundled `pg_restore`/`psql`.
 *
 * This is DESTRUCTIVE and the Postgres round-trip is not covered by
 * automated tests (no bundled Postgres in CI), so every rail here exists to
 * keep a mistaken or half-configured run from doing more damage than good:
 *
 *  - Offline guard: refuses outright if a `drop serve` is running (reuses
 *    serve.ts's own daemon-status check) — a live platform holds state in
 *    memory and would stomp the restore the moment it next writes a file.
 *  - Current-vs-backup superuser password: the DB steps authenticate against
 *    the RUNNING bundled Postgres server's *current* `.pg-superuser`, read
 *    before any file is touched — never the backup's copy, which may be
 *    stale (e.g. after a prior restore or manual rotation). Only if the
 *    current file is missing do we fall back to the backup's copy, loudly.
 *  - Plan-then-confirm: without `--confirm` (or with `--dry-run`), this
 *    prints exactly what it would do and writes nothing.
 *  - Best-effort DB restore: a missing bundled binary or an unreachable
 *    Postgres prints the equivalent manual commands and skips execution
 *    rather than failing the whole restore — the file-store restore (the
 *    least reconstructable part) still completes.
 *  - Loud, non-aborting failures: a failed role/dump restore step is
 *    reported and forces a non-zero exit, but does not stop the remaining
 *    steps — mirrors backup.ts's philosophy.
 */

import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as http from 'http';
import { spawn } from 'child_process';
import * as output from '../utils/output';
import { getDaemonStatus } from './serve';
import * as pm2Client from '../../managers/process/pm2-client';
import { DROP_SVC_FILES } from './backup';
import { superuserPasswordPath } from '../../managers/database/superuser-auth';

const isWindows = process.platform === 'win32';
const DEFAULT_DROP_ROOT = isWindows ? 'C:\\drop' : '/var/drop';
const PG_PORT = 5433;
/** Reachability probe budget — must be short: this runs on every restore attempt. */
const PROBE_TIMEOUT_MS = 5000;
/** API health-probe budget — even shorter; it's just checking for a live listener. */
const API_PROBE_TIMEOUT_MS = 1500;

function resolveDropRoot(rootOpt?: string): string {
  return rootOpt || process.env.DROP_ROOT || DEFAULT_DROP_ROOT;
}

/** The API port a running platform binds — same resolution the platform uses. */
function resolveApiPort(): number {
  const fromEnv = process.env.DROP_API_PORT ? parseInt(process.env.DROP_API_PORT, 10) : NaN;
  return Number.isFinite(fromEnv) ? fromEnv : 3000;
}

/**
 * Second offline-guard signal: getDaemonStatus() only sees a PM2-registered
 * daemon (`drop serve -d`). A FOREGROUND `drop serve` is a plain Node process
 * PM2 never knows about — but it still binds the API port and serves an
 * (unauthenticated) health endpoint. Probing it catches the foreground case
 * the daemon check misses. Any HTTP response at all means something is
 * listening — refuse (fail-safe): better to abort a destructive restore than
 * to stomp a live platform's state.
 */
function probeApiHealth(port: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const done = (result: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/v1/health', timeout: API_PROBE_TIMEOUT_MS },
      res => {
        res.resume(); // drain and discard the body
        done(true);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false)); // ECONNREFUSED etc. → nothing listening
  });
}

function resolvePsqlPath(dropRoot: string): string {
  const ext = isWindows ? '.exe' : '';
  return path.join(dropRoot, 'apps', 'drop-svc', 'pgsql', 'bin', `psql${ext}`);
}

function resolvePgRestorePath(dropRoot: string): string {
  const ext = isWindows ? '.exe' : '';
  return path.join(dropRoot, 'apps', 'drop-svc', 'pgsql', 'bin', `pg_restore${ext}`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** True if `backupDir` has at least one known DROP_SVC_FILES entry or a `databases/` dir. */
async function isValidBackupDir(backupDir: string): Promise<boolean> {
  for (const file of DROP_SVC_FILES) {
    if (await pathExists(path.join(backupDir, file))) return true;
  }
  return pathExists(path.join(backupDir, 'databases'));
}

/** Copy a file-store entry, preserving the source's mode (secrets land 0600, since backup.ts writes them under umask 0o077). */
async function copyFileStorePreservingMode(src: string, dest: string): Promise<void> {
  const stat = await fs.stat(src);
  await fs.copyFile(src, dest);
  try {
    await fs.chmod(dest, stat.mode & 0o777);
  } catch {
    // Best-effort — chmod is a partial/no-op on platforms without real POSIX modes (Windows).
  }
}

interface RunResult {
  ok: boolean;
  error?: string;
}

/**
 * Run a bundled Postgres client binary (psql / pg_restore). Password goes
 * via PGPASSWORD env only — never argv (argv is visible to other local users
 * via ps/Task Manager). No shell is used, so nothing here is shell-injectable.
 */
function runBinary(
  bin: string,
  args: string[],
  password: string | undefined,
  timeoutMs?: number
): Promise<RunResult> {
  return new Promise(resolve => {
    let settled = false;
    const child = spawn(bin, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: password ? { ...process.env, PGPASSWORD: password } : process.env,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve({ ok: false, error: `timed out after ${timeoutMs}ms` });
      }, timeoutMs);
    }

    let stderr = '';
    child.stderr?.on('data', d => (stderr += d.toString()));

    child.on('error', err => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok: false, error: `failed to run: ${err.message}` });
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: `exited with code ${code}: ${stderr.trim()}` });
      }
    });
  });
}

/** Quick reachability probe against the bundled Postgres — short timeout, not a full connection test. */
async function probePostgres(psqlPath: string, password: string | undefined): Promise<boolean> {
  const result = await runBinary(
    psqlPath,
    ['-h', '127.0.0.1', '-p', String(PG_PORT), '-U', 'postgres', '-c', 'SELECT 1'],
    password,
    PROBE_TIMEOUT_MS
  );
  return result.ok;
}

/** The exact manual commands an operator can run when automatic DB restore is skipped. */
function buildManualCommands(
  dropRoot: string,
  databasesDir: string,
  hasRolesSql: boolean,
  dumpFiles: string[]
): string[] {
  const bin = path.join(dropRoot, 'apps', 'drop-svc', 'pgsql', 'bin');
  const cmds: string[] = [];
  cmds.push(
    `BIN="${bin}"; export PGPASSWORD="<current superuser password, from data/drop-svc/.pg-superuser>"`
  );
  if (hasRolesSql) {
    cmds.push(
      `"$BIN/psql" -h 127.0.0.1 -p ${PG_PORT} -U postgres -d postgres -f "${path.join(databasesDir, 'restore-roles.sql')}"`
    );
  }
  for (const dumpFile of dumpFiles) {
    cmds.push(
      `"$BIN/pg_restore" -h 127.0.0.1 -p ${PG_PORT} -U postgres --create -d postgres "${path.join(databasesDir, dumpFile)}"`
    );
  }
  return cmds;
}

function printManualInstructions(commands: string[], reason: string): void {
  output.print(`  Run these manually (${reason}):`);
  for (const c of commands) output.print(`    ${c}`);
}

export function createRestoreCommand(): Command {
  return new Command('restore')
    .description(
      'Restore DROP state from a `drop backup` snapshot (DESTRUCTIVE — stop the platform first)'
    )
    .argument('<backupDir>', 'Path to a backup-<timestamp>/ directory produced by `drop backup`')
    .option('-r, --root <dir>', 'DROP root directory')
    .option('--confirm', 'Execute the restore (without this, only the plan is printed)')
    .option('--dry-run', 'Print the plan without executing, even if --confirm is also given')
    .action(async (backupDirArg: string, options) => {
      try {
        const backupDir = path.resolve(backupDirArg);
        const dropRoot = resolveDropRoot(options.root);

        // 1. Validate the backup dir before touching anything else.
        if (!(await isValidBackupDir(backupDir))) {
          output.error(
            `${backupDir} does not look like a DROP backup — no known file store (${DROP_SVC_FILES.join(', ')}) or a databases/ directory was found.`
          );
          process.exitCode = 1;
          return;
        }

        // 2. Offline guard — MUST run before any write. Two signals, because
        // neither alone is complete: getDaemonStatus() (serve.ts's own check)
        // catches a PM2 daemon (`drop serve -d`); the API health-probe catches
        // a FOREGROUND `drop serve` that PM2 never registered. Refuse if
        // EITHER fires.
        let daemonRunning = false;
        let daemonPid: number | undefined;
        try {
          const status = await getDaemonStatus();
          daemonRunning = status.running;
          daemonPid = status.pid;
        } finally {
          pm2Client.disconnect();
        }
        const apiPort = resolveApiPort();
        const apiResponding = daemonRunning ? false : await probeApiHealth(apiPort);
        if (daemonRunning || apiResponding) {
          const how = daemonRunning
            ? `running${daemonPid ? ` (PID: ${daemonPid})` : ''}`
            : `responding on the API port (:${apiPort})`;
          output.error(
            `DROP appears to be ${how} — stop the platform first: a running "drop serve" holds state in memory and would overwrite the restore.`
          );
          output.info(
            'Run "drop server stop" (or Ctrl+C a foreground `drop serve`), then re-run this command.'
          );
          process.exitCode = 1;
          return;
        }

        // 3. Capture the CURRENT superuser password now, before any
        // file-store overwrite — the DB step must authenticate against the
        // running server's current password, not the backup's copy.
        let currentPassword: string | undefined;
        let usedBackupPassword = false;
        try {
          currentPassword = (await fs.readFile(superuserPasswordPath(dropRoot), 'utf-8')).trim();
        } catch {
          try {
            currentPassword = (
              await fs.readFile(path.join(backupDir, '.pg-superuser'), 'utf-8')
            ).trim();
            usedBackupPassword = true;
          } catch {
            currentPassword = undefined;
          }
        }
        if (usedBackupPassword) {
          output.warn(
            "Current data/drop-svc/.pg-superuser not found — falling back to the backup's copy. " +
              "If the live server's password differs (e.g. after a prior restore or manual rotation), the database restore step will fail to authenticate."
          );
        } else if (currentPassword === undefined) {
          output.warn(
            'No superuser password found (current or backup) — the database restore step will attempt an unauthenticated connection and likely fail.'
          );
        }

        // Build the plan.
        const filesToRestore: string[] = [];
        for (const file of DROP_SVC_FILES) {
          if (await pathExists(path.join(backupDir, file))) filesToRestore.push(file);
        }
        const webappsSrc = path.join(backupDir, 'webapps');
        const hasWebapps = await pathExists(webappsSrc);
        const databasesDir = path.join(backupDir, 'databases');
        const hasDatabases = await pathExists(databasesDir);
        let hasRolesSql = false;
        let dumpFiles: string[] = [];
        if (hasDatabases) {
          const entries = await fs.readdir(databasesDir);
          hasRolesSql = entries.includes('restore-roles.sql');
          dumpFiles = entries.filter(e => e.endsWith('.dump')).sort();
        }

        // 4. Plan/confirm gate.
        output.print(`Restore plan for ${backupDir}`);
        output.print(`  DROP root:               ${dropRoot}`);
        output.print(
          `  File stores to restore:  ${filesToRestore.length ? filesToRestore.join(', ') : '(none found in backup)'}`
        );
        output.print(
          `  Per-app config:           ${hasWebapps ? 'data/appconf/webapps (recursive copy)' : 'not present in backup'}`
        );
        if (hasDatabases) {
          output.print(
            `  Database restore:        ${hasRolesSql ? 'restore-roles.sql, then ' : '(no restore-roles.sql — roles NOT recreated) '}${dumpFiles.length} dump(s): ${dumpFiles.join(', ') || '(none)'}`
          );
        } else {
          output.print('  Database restore:        no databases/ directory in backup — skipped');
        }

        if (!options.confirm || options.dryRun) {
          output.print('');
          output.info('Dry run — nothing was written. Re-run with --confirm to execute.');
          return;
        }

        // ---- Execution begins here. Everything above this line is read-only. ----
        output.warn(
          'Proceeding with a DESTRUCTIVE restore — this overwrites current platform state.'
        );

        const failures: string[] = [];
        let filesRestored = 0;

        // 5. File-store restore.
        const svcDir = path.join(dropRoot, 'data', 'drop-svc');
        await fs.mkdir(svcDir, { recursive: true, mode: 0o700 });
        for (const file of filesToRestore) {
          try {
            await copyFileStorePreservingMode(path.join(backupDir, file), path.join(svcDir, file));
            filesRestored++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            output.error(`Failed to restore ${file}: ${msg}`);
            failures.push(`${file}: ${msg}`);
          }
        }

        if (hasWebapps) {
          const appconfWebappsDest = path.join(dropRoot, 'data', 'appconf', 'webapps');
          try {
            await fs.mkdir(path.dirname(appconfWebappsDest), { recursive: true });
            await fs.cp(webappsSrc, appconfWebappsDest, { recursive: true, force: true });
            filesRestored++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            output.error(`Failed to restore appconf/webapps: ${msg}`);
            failures.push(`appconf/webapps: ${msg}`);
          }
        }

        // 6. Database restore (only with --confirm, already established above).
        let dbRestoredCount = 0;
        let dbSkipped = false;
        if (hasDatabases) {
          const psqlPath = resolvePsqlPath(dropRoot);
          const pgRestorePath = resolvePgRestorePath(dropRoot);
          const psqlExists = fssync.existsSync(psqlPath);
          const pgRestoreExists = fssync.existsSync(pgRestorePath);
          const manualCommands = buildManualCommands(
            dropRoot,
            databasesDir,
            hasRolesSql,
            dumpFiles
          );

          if (!psqlExists || !pgRestoreExists) {
            const missing = [
              !psqlExists ? 'psql' : undefined,
              !pgRestoreExists ? 'pg_restore' : undefined,
            ]
              .filter((v): v is string => Boolean(v))
              .join(', ');
            output.warn(`Bundled ${missing} not found — skipping automatic database restore.`);
            printManualInstructions(manualCommands, 'the bundled binaries are missing');
            dbSkipped = true;
            failures.push(`database restore skipped — missing binaries: ${missing}`);
          } else {
            const reachable = await probePostgres(psqlPath, currentPassword);
            if (!reachable) {
              const pgCtl = path.join(
                dropRoot,
                'apps',
                'drop-svc',
                'pgsql',
                'bin',
                `pg_ctl${isWindows ? '.exe' : ''}`
              );
              const pgData = path.join(dropRoot, 'data', 'db');
              output.warn(
                'PostgreSQL is not reachable at 127.0.0.1:5433 — skipping automatic database restore.'
              );
              output.info(
                'This is expected right after stopping the platform: `drop server stop` also stops the bundled Postgres. ' +
                  'To restore the databases automatically, start Postgres standalone and re-run this command:'
              );
              output.print(`    "${pgCtl}" -D "${pgData}" start`);
              output.info('...or run the per-database commands yourself:');
              printManualInstructions(manualCommands, 'PostgreSQL unreachable');
              dbSkipped = true;
              failures.push('database restore skipped — PostgreSQL unreachable');
            } else {
              // a. Recreate app roles first — the dumps' ownership grants rely on them existing.
              if (hasRolesSql) {
                const rolesFile = path.join(databasesDir, 'restore-roles.sql');
                const result = await runBinary(
                  psqlPath,
                  [
                    '-h',
                    '127.0.0.1',
                    '-p',
                    String(PG_PORT),
                    '-U',
                    'postgres',
                    '-d',
                    'postgres',
                    '-f',
                    rolesFile,
                  ],
                  currentPassword
                );
                if (!result.ok) {
                  output.error(`Role restore failed: ${result.error}`);
                  failures.push(`restore-roles.sql: ${result.error}`);
                }
              } else {
                output.warn(
                  'No restore-roles.sql in backup — app database roles were NOT recreated.'
                );
              }

              // b. Restore drop_internal.dump and every per-app dump.
              for (const dumpFile of dumpFiles) {
                const dumpPath = path.join(databasesDir, dumpFile);
                const result = await runBinary(
                  pgRestorePath,
                  [
                    '-h',
                    '127.0.0.1',
                    '-p',
                    String(PG_PORT),
                    '-U',
                    'postgres',
                    '--create',
                    '-d',
                    'postgres',
                    dumpPath,
                  ],
                  currentPassword
                );
                if (result.ok) {
                  dbRestoredCount++;
                } else {
                  output.error(`pg_restore failed for ${dumpFile}: ${result.error}`);
                  failures.push(`${dumpFile}: ${result.error}`);
                }
              }
            }
          }
        }

        // 7. Summary.
        output.print('');
        if (failures.length === 0) {
          output.success('Restore complete.');
        } else {
          output.warn(`Restore completed with ${failures.length} issue(s).`);
        }
        output.print(`  File stores restored:  ${filesRestored}`);
        if (hasDatabases) {
          output.print(
            `  Databases restored:    ${dbRestoredCount} of ${dumpFiles.length}${dbSkipped ? ' (automatic restore skipped — see manual commands above)' : ''}`
          );
        }
        if (failures.length > 0) {
          output.warn('Issues:');
          for (const f of failures) output.warn(`  - ${f}`);
        }
        output.print('');
        output.warn("Same-platform only — a Windows backup won't restore on Linux and vice-versa.");
        output.warn(
          'Re-running over existing databases needs --clean --if-exists added to pg_restore.'
        );
        output.warn(
          'VALIDATE on a non-production box first; the DB restore round-trip is not covered by automated tests.'
        );

        if (failures.length > 0) {
          process.exitCode = 1;
        }
      } catch (err) {
        output.error('Restore failed', err instanceof Error ? err : undefined);
        process.exitCode = 1;
      }
    });
}
