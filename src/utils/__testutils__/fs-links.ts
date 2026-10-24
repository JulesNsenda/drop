/**
 * Link helpers shared by the tests that probe hostile app trees.
 *
 * File symlinks need elevated rights on Windows and there is no mkfifo, so
 * those cases are POSIX-only (they run in Linux CI, the platform the bind-mount
 * threat exists on). Directory links use a junction on Windows, which needs no
 * elevation, so those run everywhere.
 */

import * as fs from 'fs/promises';

export const itPosix = process.platform === 'win32' ? it.skip : it;

export const dirLink = (target: string, link: string): Promise<void> =>
  fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
