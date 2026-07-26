/**
 * PostgresBinaries.getPaths() unit tests — DROP-072.
 *
 * getPaths() is a pure function (no I/O), so this only covers the path
 * shape it computes — specifically that the socket directory is a distinct
 * directory from the data directory, never nested inside it.
 */

import * as path from 'path';
import { PostgresBinaries } from './postgres-binaries';

describe('PostgresBinaries.getPaths — socketDir (DROP-072)', () => {
  it('returns a socketDir distinct from, and not nested inside, the data dir', () => {
    const dropRoot = path.join('C:', 'drop');
    const binaries = new PostgresBinaries({ dropRoot });
    const paths = binaries.getPaths();

    expect(paths.socketDir).toBe(path.join(dropRoot, 'data', 'pgsock'));
    expect(paths.dataDir).toBe(path.join(dropRoot, 'data', 'db', 'pgdata'));
    expect(paths.socketDir).not.toBe(paths.dataDir);
    // Not nested inside the data dir — a container mounting socketDir must
    // never also reach into dataDir's contents.
    expect(paths.socketDir.startsWith(paths.dataDir + path.sep)).toBe(false);
    expect(paths.dataDir.startsWith(paths.socketDir + path.sep)).toBe(false);
  });
});
