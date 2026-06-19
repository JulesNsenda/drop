/**
 * Bundled-PostgreSQL superuser hardening.
 *
 * Out of the box the data dir is initialized with `-A trust` and a pg_hba that
 * trusts all local/loopback connections, so the `postgres` superuser has no
 * password — anything that can reach 127.0.0.1:5433 has superuser access.
 *
 * This module gives the superuser a random password (persisted 0600, outside
 * the data dir) and migrates pg_hba from `trust` to `scram-sha-256` for TCP
 * connections. The migration is ordered to be safe on a live, already-running
 * server: the password is set first (while trust still lets us connect), then
 * pg_hba is flipped and reloaded — so there is never a window where the
 * superuser lacks a password but pg_hba demands one.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { writeFileAtomic } from '../../utils/atomic-write';

/** Location of the persisted superuser password (kept with other secrets, not in the PG data dir). */
export function superuserPasswordPath(dropRoot: string): string {
  return path.join(dropRoot, 'data', 'drop-svc', '.pg-superuser');
}

/**
 * Read the persisted superuser password, generating and persisting one (0600)
 * if it doesn't exist yet. Idempotent across restarts.
 */
export async function resolveSuperuserPassword(dropRoot: string): Promise<string> {
  const file = superuserPasswordPath(dropRoot);
  try {
    const existing = (await fs.readFile(file, 'utf-8')).trim();
    if (existing.length > 0) return existing;
  } catch {
    // Not created yet.
  }
  const password = crypto.randomBytes(24).toString('hex');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, password, { mode: 0o600 });
  return password;
}

/**
 * True if any `host` (TCP) or `local` (unix-socket) line in pg_hba still
 * uses the `trust` method.
 *
 * We also migrate `local` lines because containerised apps access Postgres via
 * the bind-mounted unix socket; leaving them trusted would let any container
 * holding the socket mount connect as any user without a password.
 */
export function hbaNeedsMigration(content: string): boolean {
  return content
    .split('\n')
    .some((line) => /^\s*(host|local)\b/.test(line) && /\btrust\b/.test(line));
}

/**
 * Return pg_hba content with `trust` replaced by `scram-sha-256` on every
 * `host` (TCP) and `local` (unix-socket) line.
 */
export function toScramHbaConf(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      if (/^\s*(host|local)\b/.test(line) && /\btrust\b/.test(line)) {
        return line.replace(/\btrust\b/, 'scram-sha-256');
      }
      return line;
    })
    .join('\n');
}
