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
  baseImageTags,
  selectBaseImage,
  selectBuildImage,
  healthCheckTest,
} from './container-config';
import { toolchainIdFromImage } from '../../core/builder/toolchain';
import { NODE_RUNTIME_TYPES } from '../../core/builder/node-types';
import type { AppType } from '../../core/detector/detector.types';

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

describe('node images and the toolchain ABI table', () => {
  const stripDigest = (image: string): string => image.split('@')[0];
  const isNodeImage = (image: string): boolean => stripDigest(image).startsWith('node:');

  // Exhaustive over AppType on purpose: a new type is a compile error here
  // until someone decides which image it runs in.
  const ALL_TYPES: Record<AppType, true> = {
    nodejs: true, nextjs: true, nuxt: true, sveltekit: true, remix: true, astro: true,
    express: true, fastify: true, hono: true, nest: true, static: true, spa: true,
    python: true, django: true, flask: true, fastapi: true, go: true, rust: true,
    php: true, docker: true, proxy: true, unknown: true,
  };

  it('every node image tag DROP runs has an ABI entry', () => {
    const nodeTags = baseImageTags().filter(isNodeImage);
    expect(nodeTags.length).toBeGreaterThan(0);
    for (const tag of nodeTags) {
      expect({ tag, known: toolchainIdFromImage(tag) !== null }).toEqual({ tag, known: true });
    }
  });

  it('build image and runtime image are the same tag for every node-runtime type', () => {
    for (const type of NODE_RUNTIME_TYPES) {
      expect(isNodeImage(selectBaseImage(type))).toBe(true);
      expect(stripDigest(selectBuildImage(type))).toBe(stripDigest(selectBaseImage(type)));
    }
  });

  it('static/spa are served by nginx, not node, but are built in a node image', () => {
    for (const type of ['static', 'spa'] as const) {
      expect(isNodeImage(selectBaseImage(type))).toBe(false);
      expect(toolchainIdFromImage(selectBuildImage(type))).not.toBeNull();
    }
  });

  it('every type that runs in a node image builds in the same tag', () => {
    for (const type of Object.keys(ALL_TYPES) as AppType[]) {
      if (!isNodeImage(selectBaseImage(type))) continue;
      expect(stripDigest(selectBuildImage(type))).toBe(stripDigest(selectBaseImage(type)));
    }
  });
});

describe('healthCheckTest', () => {
  it('runs an exec-form sh with the URL as $1, never spliced into the script', () => {
    const test = healthCheckTest(3004, '/health');
    expect(test.slice(0, 3)).toEqual(['CMD', 'sh', '-c']);
    expect(test[4]).toBe('healthcheck');
    expect(test[5]).toBe('http://localhost:3004/health');
    expect(test[3]).not.toContain('/health');
  });

  it('keeps a hostile path out of the shell text', () => {
    const test = healthCheckTest(3004, '/x"; rm -rf / #');
    expect(test[3]).not.toContain('rm -rf');
    expect(test[5]).toBe('http://localhost:3004/x"; rm -rf / #');
  });

  it('falls back from curl to wget to node, so images without curl still probe', () => {
    const script = healthCheckTest(80, '/').at(3)!;
    expect(script.indexOf('curl')).toBeLessThan(script.indexOf('wget'));
    expect(script.indexOf('wget')).toBeLessThan(script.indexOf('node -e'));
  });
});
