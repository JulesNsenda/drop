/**
 * `AppStateManager.setAccessGateUnapplied` — the three-state writer behind
 * `AppState.accessGateUnapplied` (DROP-152).
 *
 * It exists because `updateApp` is a spread merge and therefore cannot express
 * "remove this key". Without that, removing a gate left the last verdict
 * behind and the app read "gate not applied" forever — the exact trap
 * `readinessUnverified`'s own comment records, arrived at independently.
 *
 * The change guard is not an optimisation detail either: the callers run over
 * every app on every route configuration and over every config at boot, so an
 * unguarded write would fire an `app:updated` event and schedule a save per
 * app per pass for a value absent on almost all of them.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AppStateManager } from './state-manager';
import { eventBus } from '../../core/event-bus';

describe('AppStateManager.setAccessGateUnapplied', () => {
  let tempDir: string;
  let sm: AppStateManager;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-state-access-gate-'));
    sm = new AppStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    await sm.initialize();
    await sm.registerApp('myapp', path.join(tempDir, 'myapp'), 'nodejs');
  });

  afterEach(async () => {
    await sm.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('records true and false', async () => {
    await sm.setAccessGateUnapplied('myapp', true);
    expect(sm.getApp('myapp')?.accessGateUnapplied).toBe(true);

    await sm.setAccessGateUnapplied('myapp', false);
    expect(sm.getApp('myapp')?.accessGateUnapplied).toBe(false);
  });

  it('DELETES the key on undefined rather than leaving the last verdict', async () => {
    await sm.setAccessGateUnapplied('myapp', true);
    await sm.setAccessGateUnapplied('myapp', undefined);

    const app = sm.getApp('myapp');
    expect(app).toBeDefined();
    expect('accessGateUnapplied' in (app as object)).toBe(false);
  });

  it('the deletion survives a reload from disk', async () => {
    await sm.setAccessGateUnapplied('myapp', true);
    await sm.setAccessGateUnapplied('myapp', undefined);
    await sm.close();

    const reloaded = new AppStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    await reloaded.initialize();
    expect(reloaded.getApp('myapp')?.accessGateUnapplied).toBeUndefined();
    await reloaded.close();
  });

  it('is a no-op when the value is unchanged', async () => {
    const seen: unknown[] = [];
    const unsub = eventBus.subscribe('app:updated', p => {
      seen.push(p);
    });

    // Absent -> undefined: the common case, once per app per pass.
    await sm.setAccessGateUnapplied('myapp', undefined);
    expect(seen).toHaveLength(0);

    await sm.setAccessGateUnapplied('myapp', true);
    expect(seen).toHaveLength(1);

    await sm.setAccessGateUnapplied('myapp', true);
    expect(seen).toHaveLength(1);

    unsub();
  });

  it('returns null for an unknown app rather than throwing', async () => {
    // The sweep iterates CONFIGS, and a config can exist for an app with no
    // state entry yet.
    expect(await sm.setAccessGateUnapplied('ghost', true)).toBeNull();
  });
});
