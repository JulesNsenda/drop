/**
 * Read approximately the last `lines` lines of a file without loading the whole
 * thing into memory.
 *
 * Production log files grow to gigabytes and a tenant controls how fast, so a
 * plain `readFile` here is a memory-exhaustion lever in the single-process
 * platform, not merely a slow response. The read window is therefore bounded
 * twice: by the requested line count at an assumed average width, and by a hard
 * byte cap regardless of what was asked for.
 *
 * "Approximately" is deliberate and callers must handle it: the window is sliced
 * by BYTES, so the first element is usually a partial line, and a file of very
 * long lines yields fewer than `lines` entries. Callers that need an exact count
 * take a `.slice(-lines)` of the result.
 *
 * Extracted from ProcessManager so the container runtime can read the same
 * DROP-owned log files the same way — `AppRuntime`'s contract is that both
 * adapters present logs identically, and two hand-rolled tails would drift.
 */

import * as fs from 'fs/promises';

/** Assumed average line width when sizing the read window. */
const AVG_LINE_BYTES = 512;

/** Hard ceiling on the read window, whatever line count was requested. */
export const MAX_TAIL_BYTES = 2 * 1024 * 1024;

export async function tailFile(filePath: string, lines: number): Promise<string[]> {
  const readBytes = Math.min(Math.max(lines, 0) * AVG_LINE_BYTES, MAX_TAIL_BYTES);
  if (readBytes <= 0) return [];

  const handle = await fs.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - readBytes);
    const length = size - start;
    if (length <= 0) return [];
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    return buffer.toString('utf-8').split('\n');
  } finally {
    await handle.close();
  }
}
