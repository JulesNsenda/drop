/**
 * Path containment helpers.
 *
 * Used to keep user-supplied filesystem paths inside an allowed root
 * (e.g. the webapps directory) so the API can't be coaxed into operating
 * on arbitrary host locations.
 */

import * as path from 'path';
import * as fs from 'fs/promises';

const isWindows = process.platform === 'win32';

/** Resolve symlinks/junctions; fall back to a lexical resolve if the path doesn't exist yet. */
async function safeRealpath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** Normalize for comparison — Windows paths are case-insensitive. */
function normalizeForCompare(p: string): string {
  return isWindows ? p.toLowerCase() : p;
}

/**
 * True if `child` resolves to `parent` itself or a descendant of it.
 *
 * Resolves both paths through `fs.realpath` first so symlinks, junctions,
 * `..` segments, UNC paths and Windows drive-letter casing can't escape the
 * containment check.
 */
export async function isPathWithin(parent: string, child: string): Promise<boolean> {
  const resolvedParent = normalizeForCompare(await safeRealpath(parent));
  const resolvedChild = normalizeForCompare(await safeRealpath(child));

  if (resolvedChild === resolvedParent) return true;

  const rel = path.relative(resolvedParent, resolvedChild);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}
