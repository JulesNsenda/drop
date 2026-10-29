/**
 * POST /apps registers a folder already on the server, so it is admin-only: a
 * non-admin could otherwise register another tenant's app folder under a new
 * name and read it back through GET /apps/:name/source, or take over the name
 * of a folder-dropped app. Admins keep registering folders they dropped.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from './../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import * as runtimeConfigModule from '../runtime-config';
import * as diskUtils from '../../utils/disk';

describe('POST /apps is admin-only', () => {
  let tempDir: string;
  let webapps: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let userToken: string;
  let adminToken: string;

  const authHeader = (token: string) => ({
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-create-existing-test-'));
    webapps = path.join(tempDir, 'webapps');
    await fs.mkdir(path.join(webapps, 'dropped'), { recursive: true });
    await fs.mkdir(path.join(webapps, 'other'), { recursive: true });
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(diskUtils, 'hasEnoughDisk').mockResolvedValue({ ok: true, freeMb: 10000 });
    jest.spyOn(runtimeConfigModule, 'getAppsDirectory').mockReturnValue(webapps);

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

    await createUser({ username: 'alice', role: 'user', credential: { password: 'password123' } });
    await createUser({ username: 'root', role: 'admin', credential: { password: 'password123' } });
    userToken = await getTestToken('alice', 'password123');
    adminToken = await getTestToken('root', 'password123');
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetAuth();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const create = (token: string, body: Record<string, unknown>) =>
    app.request('/api/v1/apps', {
      method: 'POST',
      headers: authHeader(token),
      body: JSON.stringify(body),
    });

  it('refuses a non-admin for an existing folder, and registers nothing', async () => {
    const res = await create(userToken, { path: path.join(webapps, 'dropped') });

    expect(res.status).toBe(403);
    expect(getStateManager().hasApp('dropped')).toBe(false);
  });

  it('refuses a non-admin for a folder that is new to the webapps directory', async () => {
    await fs.mkdir(path.join(webapps, 'fresh'));
    const res = await create(userToken, { path: path.join(webapps, 'fresh'), name: 'brand-new' });

    expect(res.status).toBe(403);
    expect(getStateManager().hasApp('brand-new')).toBe(false);
    expect(getStateManager().hasApp('fresh')).toBe(false);
  });

  it("refuses a non-admin pointing a new name at another tenant's app folder", async () => {
    await getStateManager().registerApp('victim', path.join(webapps, 'other'));

    const res = await create(userToken, { path: path.join(webapps, 'other'), name: 'x' });

    expect(res.status).toBe(403);
    expect(getStateManager().hasApp('x')).toBe(false);
  });

  it('still lets an admin register an existing folder', async () => {
    const res = await create(adminToken, { path: path.join(webapps, 'dropped') });

    expect(res.status).toBe(201);
    expect(getStateManager().hasApp('dropped')).toBe(true);
  });
});
