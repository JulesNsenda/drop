/**
 * Source download (#315): the app's SOURCE folder as a gzipped tarball, so an
 * app that only ever existed on DROP (deployed by an agent with deploy_files,
 * or uploaded from a laptop that is gone) can be saved elsewhere — a git
 * repository, a backup, another host.
 *
 * WHAT IS IN IT. The source folder (`webapps/<app>`, never a release directory
 * or a build work dir), minus what can be reinstalled or must not leave:
 *  - `node_modules`, `.venv` — reinstalled by any build;
 *  - `.git` — a git-deployed app's `.git/config` can carry the credential the
 *    clone used, embedded in the remote URL.
 * Entries sit at the archive ROOT, the same shape `POST /apps/:name/source`
 * and `deploy_files` accept, so a download can be edited and uploaded back.
 *
 * LINKS ARE NEVER FOLLOWED. A git-deployed tree can contain a symlink to any
 * path on the host (`leak -> /etc/shadow`, `-> ../other-app/.env`); following
 * it would turn a download into an arbitrary file read. A symlink is archived
 * AS a link, its target never read. The upload path refuses symlinks
 * outright, so an archive that contains one downloads fine but will not
 * upload back as-is.
 *
 * Anything that is not a regular file, directory or symlink (a FIFO, a socket,
 * a device node) is left out: reading a FIFO would block the stream forever.
 */

import * as path from 'path';
import type { Stats } from 'fs';
import * as fs from 'fs/promises';
import { Readable } from 'stream';
import * as tar from 'tar';

/** Path segments never archived, at any depth. See the file header. */
export const SOURCE_ARCHIVE_EXCLUDED: ReadonlySet<string> = new Set(['.git', 'node_modules', '.venv']);

/** Whether a path (relative to the source root) is excluded by segment. */
export function isExcludedFromSourceArchive(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((segment) => SOURCE_ARCHIVE_EXCLUDED.has(segment));
}

export class EmptySourceError extends Error {
  constructor(appName: string) {
    super(`Application '${appName}' has no source files to download`);
    this.name = 'EmptySourceError';
  }
}

/**
 * A gzipped tar stream of `sourceDir`. Resolves once the top level has been
 * listed; throws EmptySourceError when there is nothing to archive, and lets a
 * missing directory's ENOENT through for the caller to map.
 */
export async function createSourceArchive(
  appName: string,
  sourceDir: string
): Promise<Readable> {
  const topLevel = (await fs.readdir(sourceDir)).filter((name) => !isExcludedFromSourceArchive(name));
  if (topLevel.length === 0) throw new EmptySourceError(appName);

  const pack = tar.create(
    {
      gzip: true,
      cwd: sourceDir,
      // No uid/gid/uname or mtime beyond what a reader needs.
      portable: true,
      // Explicit, though it is tar's default: archive links as links.
      follow: false,
      filter: (entryPath: string, stat: Stats | tar.ReadEntry) => {
        if (isExcludedFromSourceArchive(path.normalize(entryPath))) return false;
        if (!('isFile' in stat)) return true;
        return stat.isFile() || stat.isDirectory() || stat.isSymbolicLink();
      },
    },
    topLevel
  );
  // tar's Pack is a Minipass stream; as an async iterable it adapts to a Node
  // Readable, which the route converts to a web stream. A pack error rejects
  // the iteration and so errors the Readable, aborting the response.
  return Readable.from(pack as AsyncIterable<Buffer>);
}
