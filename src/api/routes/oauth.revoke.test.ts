/**
 * RFC 7009 tests for POST /oauth/revoke (DROP-131 Gate-2 pass-2 finding).
 *
 * Starts a REAL ApiServer bound to a real TCP port (auth ENABLED), mirroring
 * `oauth.flow.test.ts`'s harness — the interesting behaviour here (no
 * Authorization header still reaching the handler, a real refresh token
 * actually dying) needs the real route stack, not a unit test of the
 * handler in isolation.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as crypto from 'crypto';

import { ApiServer } from '../server';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { getSettingsManager, resetSettingsManager } from '../../managers/settings/settings-manager';
import { setPlatformOps, resetPlatformOps, PlatformOps } from '../platform-ops';
import { resetRateLimits } from '../middleware/rate-limit';
import { resetUploadPreflightState } from '../upload-preflight';
import { createUser, resetAuth } from '../middleware/auth';
import { __resetAuthCodeStore } from '../oauth/authorization-code';

const PORT = 39483;
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
    promoteApp: jest.fn(),
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

describe('POST /oauth/revoke (RFC 7009, DROP-131)', () => {
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

  // Mints a fresh, real refresh token end to end (authorize -> approve -> token),
  // so revocation is exercised against a grant the server itself issued.
  async function mintRefreshToken(): Promise<string> {
    const { codeVerifier, codeChallenge } = makePkcePair();
    const approveRes = await fetch(`${BASE_URL}/api/v1/oauth/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({
        client_id: clientId,
        redirect_uri: CLAUDE_REDIRECT_URI,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: 'revoke-test-state',
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
    const tokenBody = (await tokenRes.json()) as { refresh_token: string };
    if (!tokenBody.refresh_token) {
      throw new Error(`mintRefreshToken failed: ${JSON.stringify(tokenBody)}`);
    }
    return tokenBody.refresh_token;
  }

  async function attemptRefresh(refreshToken: string): Promise<Response> {
    return fetch(`${BASE_URL}/api/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }).toString(),
    });
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-oauth-revoke-test-'));
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
    // identical comment: without this the singleton leaks across test files.
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

    await createUser('revoke-admin', 'adminpass123', 'admin');
    await createUser('revoke-user', 'userpass123', 'user');
    adminToken = await login('revoke-admin', 'adminpass123');
    userToken = await login('revoke-user', 'userpass123');

    const clientRes = await fetch(`${BASE_URL}/api/v1/oauth/client`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const clientBody = (await clientRes.json()) as ApiEnvelope<{ client_id: string }>;
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
    resetSettingsManager();
    resetAuth();
    __resetAuthCodeStore();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('regression tripwire: the advertised revocation_endpoint is reachable with NO Authorization header and is never 401 — this is the whole finding', async () => {
    const metaRes = await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`);
    const meta = (await metaRes.json()) as { revocation_endpoint: string };
    expect(meta.revocation_endpoint).toBeTruthy();

    // No Authorization header at all — exactly what claude.ai's disconnect
    // flow sends. Missing `token` in the body makes this a 400 (the one
    // malformed-request case that's allowed to be non-200), but it must never
    // be 401: claude.ai holds no DROP session, only the OAuth token itself.
    const res = await fetch(meta.revocation_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}).toString(),
    });
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(400);
  });

  it("the metadata's advertised revocation_endpoint is the actually-mounted path (derived, not hardcoded twice)", async () => {
    const metaRes = await fetch(`${BASE_URL}/.well-known/oauth-authorization-server`);
    const meta = (await metaRes.json()) as { revocation_endpoint: string; token_endpoint: string };
    // Derived from the ALSO-advertised, independently-verified token_endpoint
    // (oauth.flow.test.ts's discovery tests already pin that one to the real
    // mounted route) rather than a second `${BASE_URL}/api/v1/oauth/revoke`
    // literal in this file.
    expect(meta.revocation_endpoint).toBe(meta.token_endpoint.replace('/token', '/revoke'));

    const refreshToken = await mintRefreshToken();
    const res = await fetch(meta.revocation_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
    expect(res.status).toBe(200);
  });

  it('form-encoded token=<valid refresh token> -> 200, and the token no longer works at grant_type=refresh_token', async () => {
    const refreshToken = await mintRefreshToken();

    const revokeRes = await fetch(`${BASE_URL}/api/v1/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken, client_id: clientId }).toString(),
    });
    expect(revokeRes.status).toBe(200);
    const revokeText = await revokeRes.text();
    expect(revokeText).toBe('');

    const refreshRes = await attemptRefresh(refreshToken);
    expect(refreshRes.status).toBe(400);
    const refreshBody = (await refreshRes.json()) as { error: string };
    expect(refreshBody.error).toBe('invalid_grant');
  });

  it('form-encoded token=garbage -> 200 (no token-existence oracle)', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'not-a-real-token-at-all' }).toString(),
    });
    expect(res.status).toBe(200);
  });

  it('legacy JSON { refresh_token } shape still works', async () => {
    const refreshToken = await mintRefreshToken();

    const revokeRes = await fetch(`${BASE_URL}/api/v1/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    expect(revokeRes.status).toBe(200);

    const refreshRes = await attemptRefresh(refreshToken);
    expect(refreshRes.status).toBe(400);
  });

  it('missing token entirely -> 400 (the one case allowed to be non-200)', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({}).toString(),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiEnvelope<never>;
    expect(body.success).toBe(false);
  });

  it('a mismatched client_id does not revoke, but still answers 200 (no oracle on client_id either)', async () => {
    const refreshToken = await mintRefreshToken();

    const revokeRes = await fetch(`${BASE_URL}/api/v1/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: refreshToken, client_id: 'some-other-client' }).toString(),
    });
    expect(revokeRes.status).toBe(200);

    // Not revoked — the mismatched client_id made this a no-op.
    const refreshRes = await attemptRefresh(refreshToken);
    expect(refreshRes.status).toBe(200);
  });
});
