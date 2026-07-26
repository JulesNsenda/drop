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

import * as crypto from 'crypto';
import { containerPolicyFingerprint, ContainerPolicyInputs } from './container-config';

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

  it('pgSocketDir: undefined never causes a mismatch for a PM2 app on its own — matches the fingerprint of the pre-DROP-072 payload shape (no pgSocketDir key at all)', () => {
    // Reconstruct the OLD payload shape by hand (same hashing recipe, same
    // keys minus pgSocketDir) — this is what every already-recorded PM2
    // AppConfig.runtimeSpecFingerprint on disk was computed from before this
    // field existed. If containerPolicyFingerprint's pgSocketDir: undefined
    // case produced anything OTHER than this exact hash, every PM2 app in
    // the fleet would spuriously redeploy on the first boot after this ships
    // — JSON.stringify dropping `undefined`-valued keys is what prevents that.
    const oldShapePayload = {
      capDrop: ['ALL'],
      securityOpt: ['no-new-privileges:true'],
      pidsLimit: 256,
      baseImages: {
        nodejs: 'node:20-slim',
        python: 'python:3.12-slim',
        django: 'python:3.12-slim',
        flask: 'python:3.12-slim',
        fastapi: 'python:3.12-slim',
        go: 'golang:1.22-alpine',
        static: 'nginx:alpine',
        spa: 'nginx:alpine',
      },
      imageUsers: {
        nodejs: 'node',
        python: '1000:1000',
        go: '1000:1000',
        static: '101:101',
        spa: '101:101',
      },
      netSubnet: process.env.DROP_NET_SUBNET ?? '10.83.0.0/24',
      netGateway: process.env.DROP_NET_GATEWAY ?? '10.83.0.1',
      apiPort: baseInputs.apiPort,
      maxMemoryMbPerApp: baseInputs.maxMemoryMbPerApp,
      maxCpusPerApp: baseInputs.maxCpusPerApp,
    };
    const oldShapeHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(oldShapePayload))
      .digest('hex');

    expect(containerPolicyFingerprint(baseInputs)).toBe(oldShapeHash);
  });
});
