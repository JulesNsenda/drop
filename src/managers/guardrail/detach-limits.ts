/**
 * Detach limits (Phase 3 — detach).
 *
 * Pure with respect to the platform, same shape as disk-ceiling.ts and
 * principal-quota.ts: this module decides nothing about app identity or
 * ownership and calls no provisioner. The platform computes `lastDetachAt`
 * and resolves the owner's dump DIRECTORY (via
 * `database-provisioner.ts`'s `ownerDumpDirName()`) and hands it in; this
 * module only does arithmetic and a FLAT filesystem read of that one
 * directory, which keeps it testable without a running platform.
 *
 * Two independent limiters — do not collapse them:
 * - `checkDetachCooldown` — per-SERVICE, keyed on `AppConfig.lastDetachAt[serviceId]`
 *   (no new store; survives restarts and is trivially test-resettable).
 * - `checkDumpByteBudget` / `pruneOwnerDumpsToFit` — per-OWNER, keyed on the
 *   pre-delete dump directory's own file sizes. Deliberately NOT a global
 *   ceiling: a single shared budget would let one tenant's detaches starve
 *   every other tenant's detach capacity, which is exactly the cross-tenant
 *   DoS shape CLAUDE.md forbids. Ownerless apps (and group children) share
 *   one bucket — an accepted, admin-only-surface gap, not an oversight.
 *
 * OWNER-DIRECTORY LAYOUT (DROP-151 Phase 3): the budget and
 * prune functions used to take a caller-built list of db-name PREFIXES and
 * flat-scan the whole (single, shared) pre-delete directory for matches.
 * That re-derived ownership from the live app list at read time — see
 * `ownerDumpDirName()`'s doc in `database-provisioner.ts` for the three
 * findings that came from it (evadable metering, cross-app eviction,
 * collision). They now take the owner's own DIRECTORY directly: every file
 * under it belongs to that owner by construction, so no prefix list is
 * needed for the budget check. `pruneOwnerDumpsToFit` additionally accepts
 * an OPTIONAL `dbNamePrefix` to further scope a prune to one app's own
 * dumps within that directory (used by the app-delete route so a delete
 * never evicts a sibling app's only surviving dump).
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { parsePositiveIntEnv } from '../../utils/env-int';
import { MB } from './disk-ceiling';
import { isPreDeleteDumpArtifact, restoreRoleSqlPathFor } from '../database/database-provisioner';

/** Default per-app cooldown between detaches, in minutes. */
const DEFAULT_COOLDOWN_MINUTES = 10;
/** Default per-owner pre-delete dump budget, in MB. */
const DEFAULT_MAX_MB = 2048;

/** `DROP_DETACH_COOLDOWN_MINUTES`, in ms. Invalid/unset -> the 10-minute default (fail closed). */
export function detachCooldownMs(): number {
  return parsePositiveIntEnv(process.env.DROP_DETACH_COOLDOWN_MINUTES, DEFAULT_COOLDOWN_MINUTES) * 60 * 1000;
}

/** `DROP_PREDELETE_MAX_MB`, in bytes. Invalid/unset -> the 2048MB default (fail closed). */
export function predeleteMaxBytes(): number {
  return parsePositiveIntEnv(process.env.DROP_PREDELETE_MAX_MB, DEFAULT_MAX_MB) * MB;
}

export interface CooldownCheck {
  /** Epoch ms of the app's last detach, or undefined/null if it has never been detached. */
  lastDetachAt?: number | null;
  now?: number;
  /** Defaults to `detachCooldownMs()`. Tests pass this explicitly rather than mutating env. */
  cooldownMs?: number;
}

export interface CooldownVerdict {
  allowed: boolean;
  /** Present only when refused — the client's one useful fact is when to retry. */
  retryAfterSeconds?: number;
}

/**
 * Per-app cooldown between detaches.
 *
 * An app with no recorded `lastDetachAt` has never been detached and is
 * always allowed. The RETRY exemption (intent already `'detached'` while
 * still provisioned — repair is not abuse) is the CALLER's decision, not
 * this function's: this only knows elapsed time, never provisioning state.
 */
export function checkDetachCooldown(opts: CooldownCheck): CooldownVerdict {
  const { lastDetachAt, now = Date.now(), cooldownMs = detachCooldownMs() } = opts;
  if (lastDetachAt === undefined || lastDetachAt === null) {
    return { allowed: true };
  }
  const elapsed = now - lastDetachAt;
  if (elapsed >= cooldownMs) {
    return { allowed: true };
  }
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((cooldownMs - elapsed) / 1000)) };
}

export interface DumpByteBudgetVerdict {
  allowed: boolean;
  usedBytes: number;
  limitBytes: number;
}

interface DumpFileEntry {
  name: string;
  path: string;
  bytes: number;
  mtimeMs: number;
}

/**
 * FLAT (non-recursive) listing of files directly under `ownerDir` whose name
 * matches `predicate` — every file directly under it belongs to this owner
 * by construction (see `database-provisioner.ts`'s `ownerDumpDirName()`), so
 * no prefix list is needed here any more. `dbNamePrefix`, when given,
 * further scopes the listing to one app's own files within the owner's
 * directory (the separator is required — without it `drop_app` would also
 * match a different app's `drop_app2`).
 *
 * No `measureTree` here on purpose: the owner directory is flat by
 * construction, and a recursive walk would be both the wrong tool and the
 * wrong failure mode — `measureTree`'s truncation-as-floor is right for a
 * disk sweep, but a refusal gate must never silently undercount what it's
 * gating on.
 */
async function listOwnerFiles(
  ownerDir: string,
  predicate: (name: string) => boolean,
  dbNamePrefix?: string
): Promise<DumpFileEntry[]> {
  let names: string[];
  try {
    names = await fs.readdir(ownerDir);
  } catch {
    return []; // no owner directory yet — nothing to charge
  }

  const candidates = names.filter(
    (name) => predicate(name) && (dbNamePrefix === undefined || name.startsWith(`${dbNamePrefix}-`))
  );

  const entries = await Promise.all(
    candidates.map(async (name): Promise<DumpFileEntry | null> => {
      const full = path.join(ownerDir, name);
      try {
        // lstat, not stat: a SYMLINK named like a dump would otherwise be
        // charged at its TARGET's size, letting an attacker inflate an
        // owner's counted usage (and permanently trip the budget refusal)
        // without actually writing that many bytes under ownerDir.
        const stat = await fs.lstat(full);
        return stat.isFile() ? { name, path: full, bytes: stat.size, mtimeMs: stat.mtimeMs } : null;
      } catch {
        // Vanished between readdir and lstat (a concurrent prune/delete) —
        // skip it rather than failing the whole check over one file.
        return null;
      }
    })
  );

  return entries.filter((entry): entry is DumpFileEntry => entry !== null);
}

/** `.dump` files only — the unit `pruneOwnerDumpsToFit` evicts (each alongside its `.restore-role.sql` sibling). */
async function listOwnerDumpFiles(ownerDir: string, dbNamePrefix?: string): Promise<DumpFileEntry[]> {
  return listOwnerFiles(ownerDir, (name) => name.endsWith('.dump'), dbNamePrefix);
}

/**
 * This owner's total pre-delete dump-artifact bytes (under their own
 * directory) against the configured ceiling. Per-owner, not global — see the
 * module doc. `ownerDir` is the CALLER's job to resolve (see
 * `ownerDumpDirName()`) — this module deliberately knows nothing about app
 * identity or ownership.
 *
 * Charges every artifact `isPreDeleteDumpArtifact` recognizes — `.dump`,
 * `.restore-role.sql`, AND `.dump.partial` — not just `.dump`. A fail-closed
 * budget that counted only completed dumps was undercounting what was
 * actually on disk (the same three suffixes `database-provisioner.ts`'s
 * age-based sweep already treats as one artifact family), the one failure
 * mode this gate must not have.
 */
export async function checkDumpByteBudget(
  ownerDir: string,
  ceilingBytes: number = predeleteMaxBytes()
): Promise<DumpByteBudgetVerdict> {
  const files = await listOwnerFiles(ownerDir, isPreDeleteDumpArtifact);
  const usedBytes = files.reduce((sum, f) => sum + f.bytes, 0);
  return { allowed: usedBytes <= ceilingBytes, usedBytes, limitBytes: ceilingBytes };
}

export interface PruneResult {
  prunedFiles: string[];
  prunedBytes: number;
}

/**
 * Delete this owner's OLDEST dumps — and their sibling `*.restore-role.sql`
 * (dead weight, and a stray plaintext credential besides, once its dump is
 * gone) — until the remaining total, plus `incomingEstimate` when the
 * caller knows roughly how big the next dump will be, fits under
 * `ceilingBytes`.
 *
 * `dbNamePrefix`, when given, scopes pruning to a single app's own dumps
 * within `ownerDir` — the app-delete route passes the app being deleted's
 * own db-name here specifically so a delete can never evict a SIBLING app's
 * only surviving dump, even though they share an owner directory (the
 * cross-app-eviction finding this per-owner layout otherwise still leaves
 * open within one owner's own files). Omit it to consider every dump under
 * `ownerDir`.
 *
 * Used by the app-delete route so a delete is never REFUSED by the budget —
 * deletes must always proceed; pruning old dumps is how the budget stays
 * bounded without a delete ever blocking on it. Best-effort: a failed prune
 * on one file is skipped, never thrown — the delete this exists to unblock
 * must not itself be blocked by a prune failure.
 */
export async function pruneOwnerDumpsToFit(
  ownerDir: string,
  ceilingBytes: number = predeleteMaxBytes(),
  incomingEstimate = 0,
  dbNamePrefix?: string
): Promise<PruneResult> {
  const files = await listOwnerDumpFiles(ownerDir, dbNamePrefix);
  files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

  let total = files.reduce((sum, f) => sum + f.bytes, 0) + incomingEstimate;
  const prunedFiles: string[] = [];
  let prunedBytes = 0;

  for (const file of files) {
    if (total <= ceilingBytes) break;
    try {
      await fs.rm(file.path, { force: true });
      await fs.rm(restoreRoleSqlPathFor(file.path), { force: true });
    } catch {
      continue; // best-effort — try the next file rather than aborting
    }
    prunedFiles.push(file.name);
    prunedBytes += file.bytes;
    total -= file.bytes;
  }

  return { prunedFiles, prunedBytes };
}
