/**
 * Disk space utilities.
 *
 * Used for deploy-time watermark enforcement and admin quota views.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';

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
 * Compute the total size of a directory tree in MB.
 * Returns 0 on error.  This is a best-effort estimate (hard links, etc. are
 * counted multiple times), suitable for quota displays, not accounting.
 */
export async function getDirSizeMb(dirPath: string): Promise<number> {
  try {
    let total = 0;
    const walk = async (p: string): Promise<void> => {
      const entries = await fs.readdir(p, { withFileTypes: true });
      await Promise.all(
        entries.map(async (e) => {
          const full = `${p}/${e.name}`;
          if (e.isDirectory()) {
            await walk(full);
          } else if (e.isFile() || e.isSymbolicLink()) {
            const st = await fs.stat(full).catch(() => null);
            if (st) total += st.size;
          }
        })
      );
    };
    await walk(dirPath);
    return total / (1024 * 1024);
  } catch {
    return 0;
  }
}
