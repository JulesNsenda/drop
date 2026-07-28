/**
 * The MCP gateway verify endpoint (Step 11, PR 2).
 *
 * This is the ONLY unauthenticated surface the feature adds, and under
 * `forward_auth` its answer decides whether a request reaches a tenant app. The
 * properties pinned here:
 *  - it admits ONLY an `app_mcp` token, for THIS app, from a user who may
 *    access it — never a session JWT, an API key, or a DROP-scoped token;
 *  - the app identity comes from the QUERY STRING, never a request header;
 *  - every refusal looks identical, and nothing throws a 5xx.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Hono } from 'hono';
import mcpGateway from './mcp-gateway';
import {
  initializeAuth,
  resetAuth,
  createUser,
  createApiKey,
  mintAppMcpAccessToken,
  mintOAuthAccessToken,
  type User,
} from '../middleware/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { getAppConfigService, resetAppConfigService } from '../../managers/app/app-config';
import { setApiRuntimeConfig } from '../runtime-config';

const APP = 'alpha';
const AUD = 'https://alpha.example.test/mcp';

describe('GET /mcp-gateway/verify', () => {
  let tempDir: string;
  let app: Hono;
  let owner: User;
  let stranger: User;

  const get = (query: string, headers: Record<string, string> = {}) =>
    app.request(`/verify${query}`, { headers });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-mcp-gateway-'));
    resetAuth();
    resetStateManager();
    resetAppConfigService();

    await initializeAuth({
      credentialsPath: path.join(tempDir, 'credentials.json'),
      enableJwt: true,
      enableApiKeys: true,
    });
    owner = await createUser('owner', 'correct-horse-battery-staple', 'user');
    stranger = await createUser('stranger', 'correct-horse-battery-staple', 'user');

    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    await getStateManager().initialize();
    await getStateManager().registerApp(APP, path.join(tempDir, APP));
    await getStateManager().updateApp(APP, { userId: owner.id } as Record<string, unknown>);

    await getAppConfigService({
      configDir: path.join(tempDir, 'appconf'),
      webappsDir: tempDir,
    }).initialize();
    await getAppConfigService().upsertConfig(APP, {
      type: 'nodejs',
      mcp: { path: '/mcp', auth: 'drop', source: 'declared' },
    });

    setApiRuntimeConfig({ domainSuffix: 'example.test', enableHttps: true });

    app = new Hono();
    app.route('/', mcpGateway);
  });

  afterEach(async () => {
    resetAuth();
    resetStateManager();
    resetAppConfigService();
    setApiRuntimeConfig({ domainSuffix: 'localhost', enableHttps: false });
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  });

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  it('admits the app’s own token from a user who may access it', async () => {
    const token = await mintAppMcpAccessToken(owner, AUD, APP, 'sid-1');

    const res = await get(`?app=${APP}`, bearer(token));

    expect(res.status).toBe(204);
    expect(res.headers.get('X-Drop-User-Id')).toBe(owner.id);
    expect(res.headers.get('X-Drop-Username')).toBe('owner');
  });

  it('REFUSES a valid token from a user who cannot access the app', async () => {
    // Authentication is not authorization. Without this the gate in front of a
    // tenant's endpoint means "any enabled DROP account".
    const token = await mintAppMcpAccessToken(stranger, AUD, APP, 'sid-2');

    const res = await get(`?app=${APP}`, bearer(token));

    expect(res.status).toBe(401);
  });

  it('REFUSES a DROP-scoped OAuth token', async () => {
    // The SEC-1 separation at the request layer: a control-plane token must not
    // authorize anything at a tenant's endpoint.
    const token = await mintOAuthAccessToken(owner, AUD, 'sid-3');

    const res = await get(`?app=${APP}`, bearer(token));

    expect(res.status).toBe(401);
  });

  it('REFUSES an API key', async () => {
    const key = await createApiKey('gateway-probe', 'user', undefined, undefined, owner.id);

    const res = await get(`?app=${APP}`, bearer(key.key));

    expect(res.status).toBe(401);
  });

  it('REFUSES a token minted for a DIFFERENT app', async () => {
    // The ?app= binding. A token for another app must not authorize here even
    // though it is a perfectly valid app_mcp token for its own audience.
    const token = await mintAppMcpAccessToken(owner, 'https://beta.example.test/mcp', 'beta', 's');

    const res = await get(`?app=${APP}`, bearer(token));

    expect(res.status).toBe(401);
  });

  it('ignores Host and X-Forwarded-Host — identity comes from ?app=', async () => {
    // SEC-2. If the app were derived from a header, a client could present its
    // own valid token while claiming to be someone else's endpoint.
    const token = await mintAppMcpAccessToken(owner, 'https://beta.example.test/mcp', 'beta', 's');

    const res = await get(`?app=${APP}`, {
      ...bearer(token),
      Host: 'beta.example.test',
      'X-Forwarded-Host': 'beta.example.test',
    });

    expect(res.status).toBe(401);
  });

  it('REFUSES when the app has not opted in (auth: none)', async () => {
    await getAppConfigService().upsertConfig(APP, {
      mcp: { path: '/mcp', auth: 'none', source: 'declared' },
    });
    const token = await mintAppMcpAccessToken(owner, AUD, APP, 'sid-4');

    const res = await get(`?app=${APP}`, bearer(token));

    expect(res.status).toBe(401);
  });

  it('REFUSES when the endpoint was only INFERRED', async () => {
    // Inference must never put a login gate in front of an app whose owner
    // declared nothing — it exists to label, not to enrol.
    await getAppConfigService().upsertConfig(APP, {
      mcp: { path: '/mcp', auth: 'drop', source: 'inferred' },
    });
    const token = await mintAppMcpAccessToken(owner, AUD, APP, 'sid-5');

    const res = await get(`?app=${APP}`, bearer(token));

    expect(res.status).toBe(401);
  });

  it.each([
    ['no token', ''],
    ['unknown app', '?app=nope'],
    ['malformed app name', '?app=../etc'],
    ['missing app param', ''],
  ])('refuses uniformly: %s', async (_label, query) => {
    const res = await get(query || `?app=${APP}`);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
  });

  it('never answers 5xx, even when the app URL cannot be built', async () => {
    // A customDomain WHATWG URL rejects used to throw out of the handler. The
    // contract is 204 or 401 — a 5xx is a distinguishable signal on an
    // unauthenticated surface and, under forward_auth, an auth-server error.
    await getStateManager().updateApp(APP, { customDomain: 'a b.example.test' } as Record<
      string,
      unknown
    >);
    const token = await mintAppMcpAccessToken(owner, AUD, APP, 'sid-6');

    const res = await get(`?app=${APP}`, bearer(token));

    expect(res.status).toBe(401);
  });
});
