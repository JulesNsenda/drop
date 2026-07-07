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

/**
 * Run `pg_dump -Fc <dbName>` to `outFile`.
 *
 * Intentionally omits `-C` — it's a no-op in custom format; `pg_restore
 * --create` is the real restore-time lever (and carries the per-DB
 * REVOKE CONNECT FROM PUBLIC).
 */
export function runPgDump(pgDumpPath: string, opts: RunPgDumpOptions): Promise<DumpResult> {
  const host = opts.host ?? '127.0.0.1';
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
