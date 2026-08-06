/**
 * `mayUseConnectors` (DROP-131) — the single predicate enforced at all five
 * connector-policy sites (see the header comment in `connector-policy.ts`).
 * Exercised directly here, without an HTTP round-trip, because the sites
 * themselves are covered individually elsewhere (`oauth.flow.test.ts`,
 * `mcp-gateway.test.ts`); this file pins the shared predicate's own contract.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { mayUseConnectors } from './connector-policy';
import { getSettingsManager, resetSettingsManager } from '../managers/settings/settings-manager';

describe('mayUseConnectors', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-connector-policy-test-'));
    resetSettingsManager();
    getSettingsManager({ settingsFilePath: path.join(tempDir, 'settings.json') });
  });

  afterEach(async () => {
    resetSettingsManager();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('admits admin regardless of the setting — key absent, ON, and OFF', async () => {
    // Key absent is the deploy-day state: the carve-out must not depend on
    // the setting having ever been written, or an inverted default would
    // disconnect the live admin connector ~15 minutes post-deploy.
    expect(mayUseConnectors('admin')).toBe(true);

    await getSettingsManager().setUserConnectorsEnabled(true);
    expect(mayUseConnectors('admin')).toBe(true);

    await getSettingsManager().setUserConnectorsEnabled(false);
    expect(mayUseConnectors('admin')).toBe(true);
  });

  // `mayUseConnectors`'s parameter is deliberately narrowed away from a bare
  // `string` (see the type's own comment in connector-policy.ts) so no
  // well-typed call site can pass a role that isn't one of the four real
  // ones. The garbage-role case below still matters at runtime — the
  // function's own header documents "an unrecognized or malformed role fails
  // this equality and falls through to the setting" — so it is exercised
  // here via a cast, standing in for a value arriving some other way than a
  // typed call site (e.g. a malformed token claim).
  type Role = Parameters<typeof mayUseConnectors>[0];

  describe.each<[string, Role]>([
    ['user', 'user'],
    ['readonly', 'readonly'],
    ['none', 'none'],
    ['undefined', undefined],
    ['an unrecognized garbage role', 'totally-bogus-role' as unknown as Role],
  ])('%s', (_label, role) => {
    it('follows the setting: true when unset, false when OFF, true again when ON', async () => {
      // Unset (key absent) defaults to enabled.
      expect(mayUseConnectors(role)).toBe(true);

      await getSettingsManager().setUserConnectorsEnabled(false);
      expect(mayUseConnectors(role)).toBe(false);

      await getSettingsManager().setUserConnectorsEnabled(true);
      expect(mayUseConnectors(role)).toBe(true);
    });
  });

  it('reads the setting PER CALL — flipping it between two calls changes the return value without re-importing', async () => {
    await getSettingsManager().setUserConnectorsEnabled(true);
    expect(mayUseConnectors('user')).toBe(true);

    await getSettingsManager().setUserConnectorsEnabled(false);
    expect(mayUseConnectors('user')).toBe(false);

    await getSettingsManager().setUserConnectorsEnabled(true);
    expect(mayUseConnectors('user')).toBe(true);
  });
});
