/**
 * Disk space utilities.
 *
 * Used for deploy-time watermark enforcement and admin quota views.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
// Self-import so `hasEnoughDisk` calls `getDiskFreeMb` through the module's
// exports object rather than a direct closure reference — this lets tests
// `jest.spyOn` the module and have the mock actually take effect.
import * as self from './disk';

const execFileAsync = promisify(execFile);

/**
 * Returns the free disk space in MB on the filesystem containing `dirPath`.
 * Falls back to 0 if the query fails so callers can choose to block or allow.
 */
export async function getDiskFreeMb(dirPath: string): Promise<number> {
  // Ensure the path exists before querying
  try {
    await fs.access(dirPath);
  } catch {
    return 0;
  }

  if (process.platform === 'win32') {
    return getDiskFreeMbWindows(dirPath);
  }
  return getDiskFreeMbPosix(dirPath);
}

async function getDiskFreeMbPosix(dirPath: string): Promise<number> {
  try {
    // df -k outputs 1K blocks; available is column 4.
    const { stdout } = await execFileAsync('df', ['-k', dirPath]);
    const lines = stdout.trim().split('\n');
    const dataLine = lines[lines.length - 1]; // last line has the path
    const parts = dataLine.trim().split(/\s+/);
    const availableKb = parseInt(parts[3], 10);
    if (isNaN(availableKb)) return 0;
    return availableKb / 1024;
  } catch {
    return 0;
  }
}

async function getDiskFreeMbWindows(dirPath: string): Promise<number> {
  try {
    // Use PowerShell to query free space for the drive
    const drive = dirPath.slice(0, 2).toUpperCase(); // e.g. "C:"
    const { stdout } = await execFileAsync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `[math]::Round((Get-PSDrive ${drive[0]} | Select-Object -ExpandProperty Free) / 1MB)`,
    ]);
    const mb = parseInt(stdout.trim(), 10);
    return isNaN(mb) ? 0 : mb;
  } catch {
    return 0;
  }
}

/**
 * Reads the shared free-disk watermark (in MB) from the environment.
 * Single source of truth for the free-disk minimum, shared by the API route
 * and the platform build-boundary checks — avoids two independently-tunable
 * copies of the same threshold.
 */
export function getMinFreeDiskMb(): number {
  return parseInt(process.env.DROP_MIN_FREE_DISK_MB || '500', 10);
}

/**
 * Checks whether the filesystem containing `dir` has at least `minMb` free.
 *
 * FAIL-CLOSED BY DESIGN: `getDiskFreeMb` returns 0 both when the query fails
 * AND when the disk is genuinely full — the two cases are indistinguishable
 * to this function. Treating `freeMb === 0` as `ok: true` (fail-open) would
 * let deploys proceed on a full disk, which is exactly the condition this
 * check exists to guard against. Do not wrap this in a try/catch that flips
 * the result to fail-open; `getDiskFreeMb` never throws.
 */
export async function hasEnoughDisk(
  dir: string,
  minMb?: number
): Promise<{ ok: boolean; freeMb: number }> {
  const freeMb = await self.getDiskFreeMb(dir);
  const min = minMb ?? getMinFreeDiskMb();
  return { ok: freeMb >= min, freeMb };
}
