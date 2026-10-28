/**
 * An EMPTY, LOADED suspension store for tests that build a platform without
 * starting it.
 *
 * An unloaded store fails CLOSED (every app reads as suspended), which is right
 * in production and wrong for a test that never calls `platform.start()` - the
 * thing that loads it - and still drives a start path. Each call gets its own
 * fresh directory, so a test that DOES write a suspension cannot leak it into
 * the next test (or a parallel worker) through a shared file.
 */
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { getSuspensionStore, resetSuspensionStore } from '../../managers/suspension';

export async function loadEmptySuspensionStore(): Promise<void> {
  resetSuspensionStore();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-test-suspensions-'));
  await getSuspensionStore(path.join(dir, 'suspensions.json')).load();
}
