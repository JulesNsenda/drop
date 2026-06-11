/**
 * Atomic file writes.
 *
 * Plain fs.writeFile is a single syscall that leaves a truncated/zero-byte
 * file if the process dies mid-write — fatal for our JSON state stores
 * (api-credentials.json, secrets.json, apps.json, ...). This writes to a
 * sibling temp file, fsyncs it, then renames over the target (atomic on POSIX;
 * MoveFileEx replace on Windows). The temp file is created with the final mode
 * so 0600 stores stay 0600 after the rename.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

const RENAME_RETRIES = 3;
const RENAME_RETRY_DELAY_MS = 50;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/** Write `data` to `filePath` atomically, preserving `mode` on the final file. */
export async function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  options: { mode?: number } = {}
): Promise<void> {
  const dir = path.dirname(filePath);
  // Sibling temp file — must be on the same volume as the target, or rename
  // would fail with EXDEV.
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);

  const handle = await fs.open(tmpPath, 'w', options.mode ?? 0o644);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }

  // On Windows an antivirus/indexer can briefly hold the target open; retry.
  let lastErr: unknown;
  for (let attempt = 0; attempt < RENAME_RETRIES; attempt++) {
    try {
      await fs.rename(tmpPath, filePath);
      return;
    } catch (err) {
      lastErr = err;
      await delay(RENAME_RETRY_DELAY_MS * (attempt + 1));
    }
  }

  // Give up — clean up the temp file and surface the error.
  await fs.rm(tmpPath, { force: true }).catch(() => undefined);
  throw lastErr;
}

/** Serialize JSON (pretty) and write it atomically. */
export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
  options: { mode?: number } = {}
): Promise<void> {
  await writeFileAtomic(filePath, JSON.stringify(value, null, 2), options);
}
