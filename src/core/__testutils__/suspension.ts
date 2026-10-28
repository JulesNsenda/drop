/**
 * An EMPTY, LOADED suspension store for tests that build a platform without
 * starting it.
 *
 * An unloaded store fails CLOSED (every app reads as suspended), which is right
 * in production and wrong for a test that never calls `platform.start()` - the
 * thing that loads it - and still drives a start path. The path does not exist,
 * so the load finds no file and nothing is ever written to it.
 */
import * as os from 'os';
import * as path from 'path';
import { getSuspensionStore, resetSuspensionStore } from '../../managers/suspension';

export async function loadEmptySuspensionStore(): Promise<void> {
  resetSuspensionStore();
  await getSuspensionStore(path.join(os.tmpdir(), 'drop-test-no-suspensions', 'suspensions.json')).load();
}
