/**
 * Procfile parser
 *
 * A Heroku-style `Procfile` declares named process types, one per line:
 *
 *   web: python3 -m uvicorn main:app --host 0.0.0.0 --port $PORT
 *   worker: celery -A app worker
 *
 * DROP cares primarily about the `web` process (the one that serves HTTP on
 * `$PORT`) — it is the authoritative user-provided start command and takes
 * precedence over any framework default the detector would guess. The file is
 * language-agnostic, so this module only parses; it never assumes Python/Node.
 *
 * Grammar (intentionally forgiving, matching Heroku's behaviour):
 *   - `<process>: <command>` where `<process>` is `[A-Za-z0-9_-]+`.
 *   - Leading/trailing whitespace is ignored; the command keeps its inner spaces.
 *   - Blank lines and full-line `#` comments are ignored. Inline comments are
 *     NOT stripped (a `#` inside a command is part of the command — Heroku does
 *     the same), so we don't accidentally truncate a legitimate argument.
 *   - A duplicate process name: last one wins (last definition in the file).
 */

import * as fs from 'fs/promises';
import * as path from 'path';

/** Parsed Procfile: process-type name → command string. */
export type ProcfileProcesses = Record<string, string>;

const PROCESS_LINE = /^([A-Za-z0-9_-]+):\s*(.+?)\s*$/;

/**
 * Read and parse the `Procfile` in `appPath`. Returns the map of process types
 * to commands, or `null` when the file is absent, unreadable, or contains no
 * valid process lines.
 */
export async function readProcfile(appPath: string): Promise<ProcfileProcesses | null> {
  let content: string;
  try {
    content = await fs.readFile(path.join(appPath, 'Procfile'), 'utf-8');
  } catch {
    return null;
  }
  return parseProcfileContent(content);
}

/** Parse raw Procfile text. Exposed for unit testing without touching disk. */
export function parseProcfileContent(content: string): ProcfileProcesses | null {
  const processes: ProcfileProcesses = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = PROCESS_LINE.exec(line);
    if (!match) continue;
    const [, name, command] = match;
    if (command) processes[name] = command;
  }
  return Object.keys(processes).length > 0 ? processes : null;
}

/**
 * The `web` process command from a parsed Procfile, or `null` if there's no
 * `web` entry (a worker-only Procfile has no HTTP start command).
 */
export function getWebCommand(processes: ProcfileProcesses | null): string | null {
  return processes?.web ?? null;
}

/** Convenience: read the Procfile in `appPath` and return its `web` command (or null). */
export async function getProcfileWebCommand(appPath: string): Promise<string | null> {
  return getWebCommand(await readProcfile(appPath));
}
