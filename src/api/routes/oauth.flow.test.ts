/**
 * End-to-end flow tests for the OAuth 2.1 authorization-code + PKCE routes
 * (PRD-041, integration unit).
 *
 * Starts a REAL ApiServer bound to a real TCP port (auth ENABLED), with
 * `DROP_PUBLIC_URL` pointed at that same bind address — mirrors
 * `src/api/mcp/mcp.integration.test.ts`'s pattern for proving the wiring
 * works end to end (route mounting, selective auth, the /mcp gate swap),
 * not just that it type-checks.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { ApiServer } from '../server';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { setPlatformOps, resetPlatformOps, PlatformOps } from '../platform-ops';
import { resetRateLimits } from '../middleware/rate-limit';
import { resetUploadPreflightState } from '../upload-preflight';
import { createUser, resetAuth } from '../middleware/auth';
import { __resetAuthCodeStore } from '../oauth/authorization-code';

const PORT = 39481;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CLAUDE_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

function makeOps(overrides?: Partial<PlatformOps>): PlatformOps {
  return {
    restartApp: jest.fn(),
    isAppInProgress: jest.fn().mockReturnValue(false),
    removeGroup: jest.fn().mockResolvedValue({ removed: [] }),
    purgeAppArtifacts: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

describe('OAuth 2.1 flow (PRD-041 integration)', () => {
  let tempDir: string;
  let server: ApiServer;
  let credentialsPath: string;
  let adminToken: string;
  let userToken: string;
  let clientId: string;

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

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-oauth-flow-test-'));
    credentialsPath = path.join(tempDir, 'credentials.json');
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetRateLimits();
    resetStateManager();
    resetPlatformOps();
    resetUploadPreflightState();
    resetAuth();
    __resetAuthCodeStore();

    process.env.DROP_PUBLIC_URL = BASE_URL;

    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    setPlatformOps(makeOps());

    server = new ApiServer({
      port: PORT,
      host: '127.0.0.1',
      enableAuth: true,
      credentialsPath,
    });
    await server.start();

    // Seed an admin (mints/reads the static client_id) and a regular user
    // (consents + exchanges tokens) via the real auth module — mirrors how
    // an operator + an already-logged-in browser session would exist.
    await createUser('oauth-admin', 'adminpass123', 'admin');
    await createUser('oauth-user', 'userpass123', 'user');

    adminToken = await login('oauth-admin', 'adminpass123');
    userToken = await login('oauth-user', 'userpass123');

    const clientRes = await fetch(`${BASE_URL}/api/v1/oauth/client`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const clientBody = (await clientRes.json()) as ApiEnvelope<{
      client_id: string;
      redirect_uri: string;
    }>;
    if (!clientBody.success || !clientBody.data?.client_id) {
      throw new Error(`client mint failed: ${JSON.stringify(clientBody)}`);
    }
    clientId = clientBody.data.client_id;
  });

  afterEach(async () => {
    delete process.env.DROP_PUBLIC_URL;
    await server.stop();
    resetPlatformOps();
    resetUploadPreflightState();
    await getStateManager().close();
    resetStateManager();
    resetAuth();
    __resetAuthCodeStore();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('full happy path: authorize -> approve -> token -> mcp call -> refresh', async () => {
    const { codeVerifier, codeChallenge } = makePkcePair();

    const authorizeUrl = new URL(`${BASE_URL}/api/v1/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', CLAUDE_REDIRECT_URI);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', 'xyz-state');

    const authorizeRes = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(authorizeRes.status).toBe(302);
    const consentLocation = new URL(authorizeRes.headers.get('location')!);
    expect(consentLocation.pathname).toBe('/dashboard/oauth-consent');
    expect(consentLocation.searchParams.get('resource')).toBe(`${BASE_URL}/api/v1/mcp`);

    // The SPA would read these validated params off its own URL and forward
    // them into /approve — do the same here.
    const approveRes = await fetch(`${BASE_URL}/api/v1/oauth/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({
        client_id: consentLocation.searchParams.get('client_id'),
        redirect_uri: consentLocation.searchParams.get('redirect_uri'),
        state: consentLocation.searchParams.get('state'),
        code_challenge: consentLocation.searchParams.get('code_challenge'),
        code_challenge_method: consentLocation.searchParams.get('code_challenge_method'),
        resource: consentLocation.searchParams.get('resource'),
      }),
    });
    expect(approveRes.status).toBe(200);
    const approveBody = (await approveRes.json()) as ApiEnvelope<{ redirect: string }>;
    expect(approveBody.success).toBe(true);
    expect(approveBody.data!.redirect).toContain('code=');

    const redirectUrl = new URL(approveBody.data!.redirect);
    expect(redirectUrl.origin + redirectUrl.pathname).toBe(CLAUDE_REDIRECT_URI);
    expect(redirectUrl.searchParams.get('state')).toBe('xyz-state');
    const code = redirectUrl.searchParams.get('code')!;
    expect(code).toBeTruthy();

    const tokenRes = await fetch(`${BASE_URL}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        client_id: clientId,
        redirect_uri: CLAUDE_REDIRECT_URI,
      }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    expect(tokenRes.headers.get('cache-control')).toBe('no-store');
    const tokenBody = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      refresh_token: string;
      scope?: string;
    };
    expect(tokenBody.access_token).toBeTruthy();
    expect(tokenBody.token_type).toBe('Bearer');
    expect(tokenBody.expires_in).toBe(900);
    expect(tokenBody.refresh_token).toBeTruthy();
    // Must NOT be wrapped in DROP's { success, data } envelope.
    expect((tokenBody as unknown as { success?: boolean }).success).toBeUndefined();

    // The minted access_token works on the real MCP endpoint (tools/list).
    const mcpClient = new Client({ name: 'oauth-flow-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/api/v1/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokenBody.access_token}` } },
    });
    try {
      await mcpClient.connect(transport);
      const { tools } = await mcpClient.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await mcpClient.close();
    }

    // Refresh grant returns a fresh access/refresh pair, and the old refresh
    // token is now invalid (rotation).
    const refreshRes = await fetch(`${BASE_URL}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenBody.refresh_token,
        client_id: clientId,
      }).toString(),
    });
    expect(refreshRes.status).toBe(200);
    const refreshBody = (await refreshRes.json()) as { access_token: string; refresh_token: string };
    expect(refreshBody.access_token).toBeTruthy();
    expect(refreshBody.refresh_token).toBeTruthy();
    expect(refreshBody.refresh_token).not.toBe(tokenBody.refresh_token);

    const reuseRes = await fetch(`${BASE_URL}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenBody.refresh_token,
        client_id: clientId,
      }).toString(),
    });
    expect(reuseRes.status).toBe(400);
    const reuseBody = (await reuseRes.json()) as { error: string };
    expect(reuseBody.error).toBe('invalid_grant');
  });

  it('redirect_uri mismatch is a 400 error page, not a redirect', async () => {
    const { codeChallenge } = makePkcePair();
    const authorizeUrl = new URL(`${BASE_URL}/api/v1/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', 'https://evil.example.com/callback');
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    const res = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
    const body = (await res.json()) as ApiEnvelope<never>;
    expect(body.success).toBe(false);
  });

  it('PKCE downgrade (missing code_challenge) redirects with error=invalid_request', async () => {
    const authorizeUrl = new URL(`${BASE_URL}/api/v1/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', CLAUDE_REDIRECT_URI);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('state', 'downgrade-state');
    // Deliberately no code_challenge / code_challenge_method.

    const res = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(CLAUDE_REDIRECT_URI);
    expect(location.searchParams.get('error')).toBe('invalid_request');
    expect(location.searchParams.get('state')).toBe('downgrade-state');
  });

  it('a minted oauth access_token is rejected on a general API route (GET /apps) with 401', async () => {
    const { codeVerifier, codeChallenge } = makePkcePair();

    const approveRes = await fetch(`${BASE_URL}/api/v1/oauth/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({
        client_id: clientId,
        redirect_uri: CLAUDE_REDIRECT_URI,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: 's1',
      }),
    });
    const approveBody = (await approveRes.json()) as ApiEnvelope<{ redirect: string }>;
    const code = new URL(approveBody.data!.redirect).searchParams.get('code')!;

    const tokenRes = await fetch(`${BASE_URL}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        client_id: clientId,
        redirect_uri: CLAUDE_REDIRECT_URI,
      }).toString(),
    });
    const tokenBody = (await tokenRes.json()) as { access_token: string };
    expect(tokenBody.access_token).toBeTruthy();

    const appsRes = await fetch(`${BASE_URL}/api/v1/apps`, {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    });
    expect(appsRes.status).toBe(401);
  });

  it('resource mismatch at /authorize yields error=invalid_target', async () => {
    const { codeChallenge } = makePkcePair();
    const authorizeUrl = new URL(`${BASE_URL}/api/v1/oauth/authorize`);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', CLAUDE_REDIRECT_URI);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', 'resource-state');
    authorizeUrl.searchParams.set('resource', 'https://not-this-server.example.com/api/v1/mcp');

    const res = await fetch(authorizeUrl, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('invalid_target');
    expect(location.searchParams.get('state')).toBe('resource-state');
  });

  describe('discovery', () => {
    it('unauthenticated POST /api/v1/mcp returns 401 with a WWW-Authenticate header naming the protected-resource metadata', async () => {
      const res = await fetch(`${BASE_URL}/api/v1/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });
      expect(res.status).toBe(401);
      const wwwAuth = res.headers.get('WWW-Authenticate');
      expect(wwwAuth).toBeTruthy();
      expect(wwwAuth).toContain('resource_metadata=');
      expect(wwwAuth).toContain(`${BASE_URL}/.well-known/oauth-protected-resource`);
    });

    it('serves the RFC 9728 protected-resource metadata at the root well-known path', async () => {
      const res = await fetch(`${BASE_URL}/.well-known/oauth-protected-resource`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { resource: string; authorization_servers: string[] };
      expect(body.resource).toBe(`${BASE_URL}/api/v1/mcp`);
      expect(body.authorization_servers).toEqual([BASE_URL]);
    });

    it('serves the same document at the resource-scoped well-known path', async () => {
      const res = await fetch(`${BASE_URL}/.well-known/oauth-protected-resource/api/v1/mcp`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { resource: string };
      expect(body.resource).toBe(`${BASE_URL}/api/v1/mcp`);
    });

    it('serves the same document at the non-oauth-prefixed resource-scoped path (variant)', async () => {
      const res = await fetch(`${BASE_URL}/.well-known/protected-resource/api/v1/mcp`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { resource: string };
      expect(body.resource).toBe(`${BASE_URL}/api/v1/mcp`);
    });

    it('an INVALID bearer token on /mcp still returns 401 with an invalid_token WWW-Authenticate hint (RFC 6750)', async () => {
      const res = await fetch(`${BASE_URL}/api/v1/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer not-a-real-token',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      });
      expect(res.status).toBe(401);
      const wwwAuth = res.headers.get('WWW-Authenticate');
      expect(wwwAuth).toBeTruthy();
      expect(wwwAuth).toContain('error="invalid_token"');
      expect(wwwAuth).toContain(`${BASE_URL}/.well-known/oauth-protected-resource`);
    });

    it('serves the RFC 8414 authorization-server metadata (no registration_endpoint)', async () => {
      const res = await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        issuer: string;
        authorization_endpoint: string;
        token_endpoint: string;
        registration_endpoint?: string;
      };
      expect(body.issuer).toBe(BASE_URL);
      expect(body.authorization_endpoint).toBe(`${BASE_URL}/api/v1/oauth/authorize`);
      expect(body.token_endpoint).toBe(`${BASE_URL}/api/v1/oauth/token`);
      expect(body.registration_endpoint).toBeUndefined();
    });
  });
});
