/**
 * Backup Command
 *
 * Snapshots DROP's critical, non-reconstructable state: the file-based stores
 * (credentials, secrets, encryption key, webhooks, app state/config) and a
 * pg_dump of the internal database. Operators own the schedule — wire this
 * into cron / Task Scheduler (see docs).
 */

import { Command } from 'commander';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as fssync from 'fs';
import * as output from '../utils/output';

const isWindows = process.platform === 'win32';
const DEFAULT_DROP_ROOT = isWindows ? 'C:\\drop' : '/var/drop';
const PG_PORT = 5433;
const INTERNAL_DB = process.env.DROP_DB_NAME || 'drop_internal';

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

function runPgDump(dropRoot: string, outFile: string): Promise<boolean> {
  const ext = isWindows ? '.exe' : '';
  const pgDump = path.join(dropRoot, 'apps', 'drop-svc', 'pgsql', 'bin', `pg_dump${ext}`);

  if (!fssync.existsSync(pgDump)) {
    output.warn('Bundled pg_dump not found — skipping internal database dump.');
    return Promise.resolve(false);
  }

  // The superuser now requires a password (scram). Read it from the 0600 file
  // and pass it via PGPASSWORD.
  let pgPassword: string | undefined;
  try {
    pgPassword = fssync.readFileSync(path.join(dropRoot, 'data', 'drop-svc', '.pg-superuser'), 'utf-8').trim();
  } catch {
    // No password file — server may still be on trust; pg_dump will try without one.
  }

  return new Promise((resolve) => {
    const args = [
      '-h', '127.0.0.1',
      '-p', String(PG_PORT),
      '-U', 'postgres',
      '-Fc',
      '-f', outFile,
      INTERNAL_DB,
    ];
    const child = spawn(pgDump, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: pgPassword ? { ...process.env, PGPASSWORD: pgPassword } : process.env,
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      output.warn(`pg_dump failed to run: ${err.message}`);
      resolve(false);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        output.warn(`pg_dump exited with code ${code}: ${stderr.trim()}`);
        resolve(false);
      }
    });
  });
}

/** Keep only the newest `keep` backup-* directories. */
async function pruneBackups(backupRoot: string, keep: number): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(backupRoot);
  } catch {
    return;
  }
  const backups = entries.filter((e) => e.startsWith('backup-')).sort();
  const excess = backups.slice(0, Math.max(0, backups.length - keep));
  for (const dir of excess) {
    await fs.rm(path.join(backupRoot, dir), { recursive: true, force: true });
  }
}

export function createBackupCommand(): Command {
  return new Command('backup')
    .description('Back up DROP state (file stores + internal database)')
    .option('-r, --root <dir>', 'DROP root directory')
    .option('-k, --keep <n>', 'Number of backups to retain', '7')
    .action(async (options) => {
      const dropRoot = resolveDropRoot(options.root);
      const dataDir = path.join(dropRoot, 'data');
      const backupRoot = path.join(dataDir, 'backup');

      // A filesystem-safe timestamp (no colons) generated once.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const destDir = path.join(backupRoot, `backup-${stamp}`);

      try {
        await fs.mkdir(destDir, { recursive: true });

        // 1. File-based stores
        const svcDir = path.join(dataDir, 'drop-svc');
        let copied = 0;
        for (const file of DROP_SVC_FILES) {
          if (await copyIfExists(path.join(svcDir, file), destDir)) copied++;
        }

        // 2. Per-app config files (canonical port assignments)
        const appconfWebapps = path.join(dataDir, 'appconf', 'webapps');
        if (await copyIfExists(appconfWebapps, destDir)) copied++;

        // 3. Internal database
        const dumpOk = await runPgDump(dropRoot, path.join(destDir, `${INTERNAL_DB}.dump`));

        const keep = parseInt(options.keep, 10) || 7;
        await pruneBackups(backupRoot, keep);

        output.success(`Backup written to ${destDir}`);
        output.print(`  Files copied:   ${copied}`);
        output.print(`  Database dump:  ${dumpOk ? 'ok' : 'skipped/failed'}`);
        output.print(`  Retained:       last ${keep}`);
      } catch (err) {
        output.error('Backup failed', err instanceof Error ? err : undefined);
        process.exitCode = 1;
      }
    });
}
