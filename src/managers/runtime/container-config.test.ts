/**
 * containerPolicyFingerprint unit tests — DROP-072.
 *
 * Coverage goals:
 * - Adding `pgSocketDir` changes the fingerprint whenever it's a real path
 *   (docker isolation), so a stale (pre-fix, or pointing at the old data
 *   dir) recorded fingerprint is detected as stale by boot reconciliation
 *   (decideBootReconciliationCheap's `runtimeSpecCurrent` check).
 * - `pgSocketDir: undefined` (PM2 / non-docker isolation) produces the exact
 *   same fingerprint as a payload that never had the key at all — so this
 *   field cannot, on its own, force a PM2 app to redeploy.
 */

import {
  containerPolicyFingerprint,
  fingerprintPayloadForTest,
  ContainerPolicyInputs,
} from './container-config';

const baseInputs: ContainerPolicyInputs = {
  apiPort: 3000,
  maxMemoryMbPerApp: 0,
  maxCpusPerApp: 0,
  pgSocketDir: undefined,
};

describe('containerPolicyFingerprint — pgSocketDir (DROP-072)', () => {
  it('changes when pgSocketDir changes from the old data dir to the new dedicated socket dir', () => {
    const oldFingerprint = containerPolicyFingerprint({
      ...baseInputs,
      pgSocketDir: '/var/drop/data/db/pgdata',
    });
    const newFingerprint = containerPolicyFingerprint({
      ...baseInputs,
      pgSocketDir: '/var/drop/data/pgsock',
    });

    expect(newFingerprint).not.toBe(oldFingerprint);
  });

  it('changes between undefined (no docker socket dir known yet) and a real docker socket dir', () => {
    const withoutSocketDir = containerPolicyFingerprint(baseInputs);
    const withSocketDir = containerPolicyFingerprint({
      ...baseInputs,
      pgSocketDir: '/var/drop/data/pgsock',
    });

    expect(withSocketDir).not.toBe(withoutSocketDir);
  });

  it('is stable for the same pgSocketDir value across calls', () => {
    const a = containerPolicyFingerprint({ ...baseInputs, pgSocketDir: '/var/drop/data/pgsock' });
    const b = containerPolicyFingerprint({ ...baseInputs, pgSocketDir: '/var/drop/data/pgsock' });

    expect(a).toBe(b);
  });

  it('pgSocketDir: undefined never causes a mismatch for a PM2 app on its own', () => {
    // The property, stated over two calls rather than against a hand-copied
    // payload: an `undefined` value must hash the same as the key being absent,
    // which is what `JSON.stringify` dropping undefined-valued keys buys.
    // Without it, adding this field would have redeployed every PM2 app in the
    // fleet on the first boot after DROP-072.
    //
    // This USED to reconstruct the whole pre-DROP-072 payload by hand and
    // assert a byte-identical hash. That version could only ever be true until
    // the next policy field, and DROP-160 (Tier B) is that next field: pinning
    // digests, a read-only rootfs, the tmpfs set and the fixed data-dir target
    // all joined the payload, which rotates the hash for EVERY app exactly
    // once. That rotation is not a regression — recreating the container is the
    // only way any of those reaches an already-running app, and boot
    // reconciliation would otherwise skip every running docker app and leave it
    // on the old policy. Asserting the property instead of the constants keeps
    // this test alive across the next one.
    const withUndefinedKey = containerPolicyFingerprint(baseInputs);

    const withoutKey = containerPolicyFingerprint({
      apiPort: baseInputs.apiPort,
      maxMemoryMbPerApp: baseInputs.maxMemoryMbPerApp,
      maxCpusPerApp: baseInputs.maxCpusPerApp,
    } as ContainerPolicyInputs);

    expect(withUndefinedKey).toBe(withoutKey);
  });

  it('covers the Tier B container policy, so hardening reaches already-running apps', () => {
    // Each of these is applied at `docker create` time and nowhere else, so an
    // app that is already running only picks it up when boot reconciliation
    // sees a fingerprint mismatch and forces a redeploy. If the payload stops
    // covering them, the hardening silently applies to new apps only — which
    // looks exactly like success on a fresh box and exactly like nothing on a
    // real fleet.
    const payloadKeys = Object.keys(
      JSON.parse(
        JSON.stringify({
          ...(fingerprintPayloadForTest() as Record<string, unknown>),
        })
      )
    );

    expect(payloadKeys).toEqual(
      expect.arrayContaining(['imageDigests', 'readonlyRootfs', 'tmpfs', 'containerDataDir'])
    );
  });
});
