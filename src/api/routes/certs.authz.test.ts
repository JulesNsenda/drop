/**
 * Authorization regression tests for /certs (P0-8).
 *
 * Proves a non-admin user sees only certificates for domains they own (no
 * cross-tenant domain enumeration), an admin sees all, and renewal — which
 * triggers a platform-wide ACME pass — is admin-only.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from './../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';

const CERTS = [
  {
    domain: 'alice.example.com',
    issuer: 'LE',
    notBefore: null,
    notAfter: null,
    daysUntilExpiry: 40,
    status: 'valid' as const,
    sans: [],
    managed: true,
  },
  {
    domain: 'bob.example.com',
    issuer: 'LE',
    notBefore: null,
    notAfter: null,
    daysUntilExpiry: 40,
    status: 'valid' as const,
    sans: [],
    managed: true,
  },
];

jest.mock('../../managers/router/caddy-api', () => ({
  getCaddyAdminClient: () => ({
    isAvailable: async () => true,
    getCertificates: async () => CERTS,
    getExpiringCertificates: async () => CERTS,
    getCertificateForDomain: async (d: string) => CERTS.find((c) => c.domain === d) || null,
    triggerRenewal: async () => true,
  }),
}));

describe('certs authorization (P0-8)', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let aliceToken: string;
  let adminToken: string;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-certs-authz-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetStateManager();
    resetAuth();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    server = new ApiServer({
      port: 3096,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    const alice = await createUser('alice', 'password123', 'user');
    await createUser('root', 'password123', 'admin');
    aliceToken = await getTestToken('alice', 'password123');
    adminToken = await getTestToken('root', 'password123');

    const sm = getStateManager();
    await sm.registerApp('alice-app', path.join(tempDir, 'alice-app'));
    await sm.updateApp('alice-app', { userId: alice.id, customDomain: 'alice.example.com' });
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetAuth();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('a non-admin sees only certificates for domains they own', async () => {
    const res = await app.request('/api/v1/certs', { headers: authHeader(aliceToken) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ domain: string }> };
    expect(json.data.map((c) => c.domain)).toEqual(['alice.example.com']);
  });

  it('an admin sees all certificates', async () => {
    const res = await app.request('/api/v1/certs', { headers: authHeader(adminToken) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Array<{ domain: string }> };
    expect(json.data.map((c) => c.domain).sort()).toEqual(['alice.example.com', 'bob.example.com']);
  });

  it("returns 404 for another tenant's cert (no existence disclosure)", async () => {
    const res = await app.request('/api/v1/certs/bob.example.com', { headers: authHeader(aliceToken) });
    expect(res.status).toBe(404);
  });

  it('POST /certs/renew is admin-only', async () => {
    const denied = await app.request('/api/v1/certs/renew', {
      method: 'POST',
      headers: authHeader(aliceToken),
    });
    expect(denied.status).toBe(403);

    const allowed = await app.request('/api/v1/certs/renew', {
      method: 'POST',
      headers: authHeader(adminToken),
    });
    expect(allowed.status).toBe(200);
  });
});
