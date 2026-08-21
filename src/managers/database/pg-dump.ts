/**
 * Shared pg_dump helper.
 *
 * Single source of truth for invoking the bundled `pg_dump` binary. This is
 * security-sensitive: the superuser/role password MUST be passed via the
 * `PGPASSWORD` environment variable, never as a command-line argument (argv
 * is visible to other local users via `ps`/Task Manager). Every caller that
 * needs to shell out to `pg_dump` — the `drop backup` CLI command today, and
 * the dump-then-drop-on-delete path — should go through `runPgDump` here so
 * that invariant only has to be maintained in one place.
 *
 * Also exports `createRoleSql`, the matching pure-function SQL builder for
 * recreating a dumped database's owning role (`pg_dump -Fc` does not capture
 * roles), with the same defensive escaping used at backup time.
 */

import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import { parsePositiveIntEnv } from '../../utils/env-int';

/** Result of a single pg_dump invocation. */
export interface DumpResult {
  ok: boolean;
  error?: string;
}

export interface RunPgDumpOptions {
  /** Defaults to '127.0.0.1'. */
  host?: string;
  port: number;
  user: string;
  dbName: string;
  outFile: string;
  /** Passed via PGPASSWORD env — never argv. */
  password?: string;
}

const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Wall-clock budget for a single `pg_dump` invocation, in ms.
 *
 * Without this, a tenant holding an `ACCESS EXCLUSIVE` lock on its own
 * database can make `pg_dump` await forever — and with it, the caller's
 * `appsInProgress` entry for that app, wedged until a platform restart.
 * Exported (not just read inline) so tests can assert against the same
 * value the runner uses.
 */
export function pgDumpTimeoutMs(): number {
  return parsePositiveIntEnv(process.env.DROP_PG_DUMP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
}

/**
 * Run `pg_dump -Fc <dbName>` to `outFile`.
 *
 * Intentionally omits `-C` — it's a no-op in custom format; `pg_restore
 * --create` is the real restore-time lever (and carries the per-DB
 * REVOKE CONNECT FROM PUBLIC).
 *
 * Bounded by `DROP_PG_DUMP_TIMEOUT_MS` (default 10min): on expiry the child
 * is SIGKILLed and any partial `outFile` is removed before resolving with a
 * failure — a half-written dump must never be mistaken for a real one, and a
 * hung dump must never hold the caller open indefinitely.
 */
export function runPgDump(pgDumpPath: string, opts: RunPgDumpOptions): Promise<DumpResult> {
  const host = opts.host ?? '127.0.0.1';
  const timeoutMs = pgDumpTimeoutMs();
  return new Promise((resolve) => {
    const args = [
      '-h', host,
      '-p', String(opts.port),
      '-U', opts.user,
      '-Fc',
      '-f', opts.outFile,
      opts.dbName,
    ];
    const child = spawn(pgDumpPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      // Password goes via env, never argv.
      env: opts.password ? { ...process.env, PGPASSWORD: opts.password } : process.env,
    });
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (result: DumpResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      finish({ ok: false, error: `pg_dump failed to run: ${err.message}` });
    });
    child.on('close', (code) => {
      if (timedOut) {
        // The partial file is worthless (and may be large) — clean it up
        // best-effort so a killed pg_dump never leaves a half-written .dump
        // behind for the caller to mistake for a real one.
        fs.rm(opts.outFile, { force: true }).finally(() => {
          finish({ ok: false, error: `pg_dump timed out after ${timeoutMs}ms and was killed` });
        });
        return;
      }
      if (code === 0) {
        finish({ ok: true });
      } else {
        finish({ ok: false, error: `pg_dump exited with code ${code}: ${stderr.trim()}` });
      }
    });
  });
}

/**
 * Build a `CREATE ROLE ... LOGIN PASSWORD ...` statement for restoring a
 * dumped database's owning role. Pure function — no I/O.
 *
 * Defensive escaping — role names are sanitized at provisioning time and
 * passwords are base64-with-no-quotes, but don't rely on that forever.
 */
export function createRoleSql(user: string, password: string): string {
  const safeUser = user.replace(/"/g, '""');
  const safePassword = password.replace(/'/g, "''");
  return `CREATE ROLE "${safeUser}" LOGIN PASSWORD '${safePassword}';`;
}
