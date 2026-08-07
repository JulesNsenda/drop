/**
 * DROP-135: registration-time rejection of a reserved derived hostname.
 *
 * `handleConfigureRoute` (platform.ts) is the load-bearing gate — it refuses
 * to emit a Caddy route for a reserved hostname regardless of how the app got
 * registered (see platform.test.ts's "reserved derived hostname" suite). This
 * file covers the OTHER half: POST /apps should refuse the name up front with
 * a clear 400 rather than let the app register and then silently end up with
 * no route at all.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from './../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { setPublicUrl } from '../runtime-config';
import * as diskUtils from '../../utils/disk';

describe('POST /apps rejects a name that collides with a reserved host (DROP-135)', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let adminToken: string;

  const authHeader = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-reserved-host-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    // POST /apps' disk preflight shells out to the OS for free space (P2-5).
    jest.spyOn(diskUtils, 'hasEnoughDisk').mockResolvedValue({ ok: true, freeMb: 10000 });

    resetStateManager();
    resetAuth();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    server = new ApiServer({
      port: 3098,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
      domainSuffix: 'dropkit.sh',
    });
    await server.initialize();
    app = server.getApp();
    // Live-update, matching how the admin settings route applies it — the
    // control plane's public host once it moves off the apex (DROP-135 plan
    // item 6).
    setPublicUrl('https://dashboard.dropkit.sh');

    await createUser('root', 'password123', 'admin');
    adminToken = await getTestToken('root', 'password123');
  });

  afterEach(async () => {
    setPublicUrl(undefined);
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('rejects a name whose derived hostname (<name>.<suffix>) equals the platform public host', async () => {
    const dir = path.join(tempDir, 'dashboard-dir');
    await fs.mkdir(dir, { recursive: true });

    const res = await app.request('/api/v1/apps', {
      method: 'POST',
      headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir, name: 'dashboard' }),
    });

    expect(res.status).toBe(400);
    // Pin the REASON, not just the status — 400 alone doesn't distinguish
    // this from the name-format or disk-watermark checks above it.
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/reserved/i);
    // Never registered — a rejected creation must not leave a dangling entry.
    expect(getStateManager().hasApp('dashboard')).toBe(false);
  });

  it('still allows an ordinary, non-colliding app name (no regression)', async () => {
    const dir = path.join(tempDir, 'ok-dir');
    await fs.mkdir(dir, { recursive: true });

    const res = await app.request('/api/v1/apps', {
      method: 'POST',
      headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: dir, name: 'my-cool-app' }),
    });

    expect(res.status).toBe(201);
  });
});
