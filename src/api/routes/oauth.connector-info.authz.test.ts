/**
 * Authorization-boundary tests for GET /oauth/connector-info (DROP-131 Item 4).
 *
 * Starts a REAL ApiServer bound to a real TCP port (auth ENABLED), mirroring
 * `oauth.flow.test.ts`'s harness — the read-only lookup this endpoint uses
 * (`getOAuthClientId`) only returns a value once `POST /oauth/client` has
 * minted one, so most of the interesting states (never-minted, toggle OFF,
 * role floors) need the real route stack, not a unit test of the handler.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

import { ApiServer } from '../server';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { getSettingsManager, resetSettingsManager } from '../../managers/settings/settings-manager';
import { setPlatformOps, resetPlatformOps, PlatformOps } from '../platform-ops';
import { makePlatformOpsStub } from '../__testutils__/platform-ops';
import { resetRateLimits } from '../middleware/rate-limit';
import { resetUploadPreflightState } from '../upload-preflight';
import { createUser, resetAuth } from '../middleware/auth';
import { __resetAuthCodeStore } from '../oauth/authorization-code';

const PORT = 39482;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CLAUDE_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

function makeOps(overrides?: Partial<PlatformOps>): PlatformOps {
  return makePlatformOpsStub(overrides);
}

describe('GET /oauth/connector-info (DROP-131 Item 4)', () => {
  let tempDir: string;
  let server: ApiServer;
  let credentialsPath: string;
  let adminToken: string;
  let userToken: string;
  let readonlyToken: string;

  async function login(username: string, password: string): Promise<string> {
    const res = await fetch(`${BASE_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = (await res.json()) as ApiEnvelope<{ token: string }>;
    if (!body.success || !body.data?.token) {
      throw new Error(`login failed for ${username}: ${JSON.stringify(body)}`);
    }
    return body.data.token;
  }

  async function mintClient(bearerToken: string): Promise<Response> {
    return fetch(`${BASE_URL}/api/v1/oauth/client`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
  }

  async function connectorInfo(bearerToken?: string): Promise<Response> {
    return fetch(`${BASE_URL}/api/v1/oauth/connector-info`, {
      headers: bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {},
    });
  }

  // DROP-131 Item 3: flips the admin-settable multi-user-connectors toggle
  // through the REAL admin route, matching oauth.flow.test.ts.
  async function setUserConnectorsEnabled(enabled: boolean): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/v1/admin/settings/user-connectors`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ enabled }),
    });
    if (res.status !== 200) {
      throw new Error(`setUserConnectorsEnabled(${enabled}) failed with status ${res.status}`);
    }
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-oauth-connector-info-test-'));
    credentialsPath = path.join(tempDir, 'credentials.json');
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetRateLimits();
    resetStateManager();
    resetPlatformOps();
    resetUploadPreflightState();
    resetAuth();
    __resetAuthCodeStore();
    // Must run BEFORE `new ApiServer(...)` below — see oauth.flow.test.ts's
    // identical comment: without this the singleton (and setUserConnectorsEnabled's
    // writes) leaks across tests in this file and across other test files.
    resetSettingsManager();

    process.env.DROP_PUBLIC_URL = BASE_URL;

    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    getSettingsManager({ settingsFilePath: path.join(tempDir, 'settings.json') });
    setPlatformOps(makeOps());

    server = new ApiServer({
      port: PORT,
      host: '127.0.0.1',
      enableAuth: true,
      credentialsPath,
    });
    await server.start();

    await createUser('ci-admin', 'adminpass123', 'admin');
    await createUser('ci-user', 'userpass123', 'user');
    await createUser('ci-readonly', 'readonlypass123', 'readonly');

    adminToken = await login('ci-admin', 'adminpass123');
    userToken = await login('ci-user', 'userpass123');
    readonlyToken = await login('ci-readonly', 'readonlypass123');
  });

  afterEach(async () => {
    delete process.env.DROP_PUBLIC_URL;
    await server.stop();
    resetPlatformOps();
    resetUploadPreflightState();
    await getStateManager().close();
    resetStateManager();
    resetSettingsManager();
    resetAuth();
    __resetAuthCodeStore();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('no credential -> 401', async () => {
    await mintClient(adminToken);
    const res = await connectorInfo(undefined);
    expect(res.status).toBe(401);
  });

  it('readonly role -> 403', async () => {
    await mintClient(adminToken);
    const res = await connectorInfo(readonlyToken);
    expect(res.status).toBe(403);
  });

  it('user role, toggle default (unset) -> 200 with all four fields, client_secret null', async () => {
    const mintRes = await mintClient(adminToken);
    const mintBody = (await mintRes.json()) as ApiEnvelope<{ client_id: string }>;
    const clientId = mintBody.data!.client_id;

    const res = await connectorInfo(userToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiEnvelope<{
      client_id: string;
      client_secret: string | null;
      redirect_uri: string;
      mcp_url: string;
    }>;
    expect(body.success).toBe(true);
    expect(body.data!.client_id).toBe(clientId);
    expect(body.data!.client_secret).toBeNull();
    expect(body.data!.redirect_uri).toBe(CLAUDE_REDIRECT_URI);
    expect(body.data!.mcp_url).toBe(`${BASE_URL}/api/v1/mcp`);
  });

  it('user role, toggle OFF -> 403', async () => {
    await mintClient(adminToken);
    await setUserConnectorsEnabled(false);

    const res = await connectorInfo(userToken);
    expect(res.status).toBe(403);
  });

  it('admin, toggle OFF -> 200 (the admin carve-out)', async () => {
    await mintClient(adminToken);
    await setUserConnectorsEnabled(false);

    const res = await connectorInfo(adminToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiEnvelope<{ client_id: string }>;
    expect(body.success).toBe(true);
    expect(body.data!.client_id).toBeTruthy();
  });

  it('client never minted -> 404', async () => {
    // No POST /oauth/client in this test — getOAuthClientId() has nothing to read.
    const res = await connectorInfo(userToken);
    expect(res.status).toBe(404);
    const body = (await res.json()) as ApiEnvelope<never>;
    expect(body.success).toBe(false);
  });

  it('POST /oauth/client with a `user` credential -> still 403 (line 309 was not weakened)', async () => {
    const res = await mintClient(userToken);
    expect(res.status).toBe(403);
  });

  describe('regression tripwire: the new middleware did not land on /oauth/*', () => {
    it('GET /oauth/authorize with no Authorization header still reaches its handler and redirects to the consent SPA (302, never 401)', async () => {
      // A REAL client_id + valid PKCE challenge, not a placeholder — so this
      // can only pass by actually traversing the open-redirect guard and the
      // response-type/PKCE checks unauthenticated, not by landing on some
      // other 400 branch that happens to not be 401. Proves the request
      // reaches deep into the handler with no bearer token at all.
      const mintRes = await mintClient(adminToken);
      const mintBody = (await mintRes.json()) as ApiEnvelope<{ client_id: string }>;
      const clientId = mintBody.data!.client_id;

      const authorizeUrl = new URL(`${BASE_URL}/api/v1/oauth/authorize`);
      authorizeUrl.searchParams.set('client_id', clientId);
      authorizeUrl.searchParams.set('redirect_uri', CLAUDE_REDIRECT_URI);
      authorizeUrl.searchParams.set('response_type', 'code');
      authorizeUrl.searchParams.set('code_challenge', 'a-valid-looking-challenge');
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
      authorizeUrl.searchParams.set('state', 'tripwire-state');

      const res = await fetch(authorizeUrl, { redirect: 'manual' });
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location')!);
      expect(location.pathname).toBe('/dashboard/oauth-consent');
    });

    it('POST /oauth/token with no Authorization header still reaches its handler (OAuth-shaped 400, never 401)', async () => {
      const res = await fetch(`${BASE_URL}/api/v1/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'not-a-real-code',
          code_verifier: 'x',
          client_id: 'whatever',
          redirect_uri: CLAUDE_REDIRECT_URI,
        }).toString(),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_grant');
    });
  });
});
