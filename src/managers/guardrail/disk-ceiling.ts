/**
 * Per-app disk ceiling (Step 8c).
 *
 * ACCOUNTING-BASED, NOT A HARD CAP, and the difference must not be glossed:
 * Docker's `StorageOpt: {size}` is a real cap but works only on overlay2+xfs
 * with pquota, or devicemapper. On overlay2/ext4 — the common default — it
 * FAILS AT CONTAINER CREATE, which would break every deploy on the box. The
 * driver cannot be determined from here, so this measures instead of capping:
 * it sizes each app's tree on a sweep and stops an app that has gone over.
 *
 * What that buys and what it does not: growth is bounded to whatever an app
 * can write between sweeps, not to the ceiling itself. An app that writes
 * 50 GB in a minute still writes it. This stops a slow leak from filling the
 * box, which is the realistic failure — it is not a defence against a tenant
 * deliberately trying to fill the disk as fast as possible.
 *
 * A hard cap remains available on a box whose driver supports it; that path is
 * gated on running, on the host:
 *   docker info --format '{{.Driver}} {{.DriverStatus}}'
 *   findmnt -no FSTYPE,OPTIONS /var/lib/docker
 */

import * as path from 'path';
import * as fsp from 'fs/promises';
import type { Dirent } from 'fs';

export const MB = 1024 * 1024;
/** Default ceiling per app, in MB. Generous — this catches a leak, not a spike. */
const DEFAULT_MAX_APP_DISK_MB = 2048;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/**
 * Depth bound on the walk. A deep tree costs a sweep, not correctness — an
 * unbounded walk on a pathological tree would hold the event loop.
 */
const MAX_WALK_DEPTH = 12;
/** Entries visited per app before the measurement is abandoned as too costly. */
const MAX_ENTRIES = 200_000;

export interface DiskUsage {
  bytes: number;
  /** True when the walk hit its entry or depth bound, so `bytes` is a FLOOR. */
  truncated: boolean;
}

/**
 * Total size of a directory tree.
 *
 * Symlinks are never followed and their target size is never counted: an app
 * can create a symlink to anywhere, and following it would both escape the
 * measured tree and let an app charge someone else's bytes to itself — or, on
 * a loop, never terminate.
 */
export async function measureTree(root: string): Promise<DiskUsage> {
  let bytes = 0;
  let visited = 0;
  let truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_WALK_DEPTH || truncated) {
      truncated = true;
      return;
    }
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subtree — measure what we can, never throw
    }
    for (const entry of entries) {
      if (++visited > MAX_ENTRIES) {
        truncated = true;
        return;
      }
      // isDirectory()/isFile() on a Dirent do NOT follow symlinks, so a link is
      // neither descended into nor sized by its target.
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile()) {
        try {
          const st = await fsp.lstat(full);
          bytes += st.size;
        } catch {
          // Vanished mid-walk (a build writing underneath us) — skip it.
        }
      }
    }
  };

  await walk(root, 0);
  return { bytes, truncated };
}

/** Global ceiling in bytes; 0 disables the sweep entirely. */
export function configuredCeilingBytes(): number {
  const raw = process.env.DROP_MAX_APP_DISK_MB;
  if (raw === undefined || raw === '') return DEFAULT_MAX_APP_DISK_MB * MB;
  const parsed = parseInt(raw, 10);
  // A nonsense value must not silently mean "no limit" NOR "zero allowance".
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_APP_DISK_MB * MB;
  return parsed * MB;
}

export interface DiskCeilingTarget {
  name: string;
  /** Directories charged to this app. Usually the app tree and its data dir. */
  paths: string[];
  /** Per-app override in MB, if the operator set one. 0 exempts the app. */
  maxDiskMb?: number;
}

export interface DiskCeilingVerdict {
  name: string;
  bytes: number;
  ceilingBytes: number;
  overBy: number;
  truncated: boolean;
}

/**
 * Measure every target and report those over their ceiling.
 *
 * Pure with respect to the platform: it decides nothing and stops nothing. The
 * caller parks, so the policy and the measurement stay separable and the
 * measurement stays testable without a running platform.
 */
export async function findOverCeiling(
  targets: DiskCeilingTarget[]
): Promise<DiskCeilingVerdict[]> {
  const globalCeiling = configuredCeilingBytes();
  if (globalCeiling <= 0) return [];

  const over: DiskCeilingVerdict[] = [];
  for (const target of targets) {
    // An explicit per-app 0 exempts. Distinguished from "unset" on purpose, so
    // an operator can exempt one app without disabling the sweep globally.
    if (target.maxDiskMb === 0) continue;
    const ceilingBytes =
      target.maxDiskMb && target.maxDiskMb > 0 ? target.maxDiskMb * MB : globalCeiling;

    let bytes = 0;
    let truncated = false;
    for (const p of target.paths) {
      const usage = await measureTree(p);
      bytes += usage.bytes;
      truncated = truncated || usage.truncated;
    }

    if (bytes > ceilingBytes) {
      over.push({
        name: target.name,
        bytes,
        ceilingBytes,
        overBy: bytes - ceilingBytes,
        truncated,
      });
    }
  }
  return over;
}

/** Human-readable MB, for the park reason an operator reads. */
export function toMb(bytes: number): number {
  return Math.round((bytes / MB) * 10) / 10;
}

export { SWEEP_INTERVAL_MS as DISK_SWEEP_INTERVAL_MS };
