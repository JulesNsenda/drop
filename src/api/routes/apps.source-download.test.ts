/**
 * GET /apps/:name/source — source download (#315).
 *
 * Real ApiServer, real archive: what the route admits and refuses, and that a
 * download round-trips into the shape the upload path takes. What goes into
 * the archive is source-archive.test.ts's.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as tar from 'tar';
import { ApiServer } from '../server';
import { createUser, resetAuth, createApiKey } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import * as runtimeConfigModule from '../runtime-config';
import * as activity from '../../managers/activity';
import { resetRateLimits } from '../middleware/rate-limit';

describe('GET /apps/:name/source (source download)', () => {
  let tempDir: string;
  let webapps: string;
  let server: ApiServer;
  let hono: ReturnType<ApiServer['getApp']>;
  let aliceId: string;
  let aliceToken: string;
  let bobToken: string;
  let readerToken: string;
  let adminToken: string;
  let activitySpy: jest.SpyInstance;

  const download = (name: string, headers: Record<string, string>) =>
    hono.request(`/api/v1/apps/${name}/source`, { method: 'GET', headers });
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function startServer(enableAuth: boolean): Promise<void> {
    server = new ApiServer({
      port: 3097,
      enableAuth,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    hono = server.getApp();
  }

  async function registerApp(name: string, dir: string, userId?: string): Promise<void> {
    await getStateManager().registerApp(name, dir);
    if (userId) await getStateManager().updateApp(name, { userId });
  }

  async function entriesOf(res: Response): Promise<string[]> {
    const file = path.join(tempDir, `dl-${Date.now()}.tar.gz`);
    await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
    const names: string[] = [];
    await tar.t({ file, onReadEntry: (e) => names.push(e.path) });
    return names;
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-source-dl-'));
    webapps = path.join(tempDir, 'webapps');
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    resetRateLimits();
    resetStateManager();
    resetAuth();
    jest.spyOn(runtimeConfigModule, 'getAppsDirectory').mockReturnValue(webapps);
    activitySpy = jest.spyOn(activity, 'logActivityFor').mockResolvedValue();
    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });

    await startServer(true);
    aliceId = (await createUser('alice', 'password123', 'user')).id;
    await createUser('bob', 'password123', 'user');
    await createUser('reader', 'password123', 'readonly');
    await createUser('sysadmin', 'password123', 'admin');
    aliceToken = await getTestToken('alice', 'password123');
    bobToken = await getTestToken('bob', 'password123');
    readerToken = await getTestToken('reader', 'password123');
    adminToken = await getTestToken('sysadmin', 'password123');

    const appDir = path.join(webapps, 'alice-app');
    await fs.mkdir(path.join(appDir, 'node_modules', 'x'), { recursive: true });
    await fs.writeFile(path.join(appDir, 'index.html'), '<h1>hi</h1>');
    await fs.writeFile(path.join(appDir, 'drop.yaml'), 'type: static\n');
    await fs.writeFile(path.join(appDir, 'node_modules', 'x', 'i.js'), 'dep');
    await registerApp('alice-app', appDir, aliceId);
  });

  afterEach(async () => {
    if (server) await server.stop();
    await getStateManager().close();
    resetStateManager();
    resetAuth();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('streams the owner a gzipped tarball of the source, root-level, without dependencies', async () => {
    const res = await download('alice-app', bearer(aliceToken));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="alice-app-source.tar.gz"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const names = await entriesOf(res);
    expect(names).toEqual(expect.arrayContaining(['index.html', 'drop.yaml']));
    expect(names.some((n) => n.includes('node_modules'))).toBe(false);
    expect(activitySpy).toHaveBeenCalledWith(
      expect.objectContaining({ userId: aliceId }),
      { action: 'source-download', appName: 'alice-app' }
    );
  });

  it("answers someone else's app exactly like a missing one", async () => {
    expect((await download('alice-app', bearer(bobToken))).status).toBe(404);
    expect((await download('no-such-app', bearer(bobToken))).status).toBe(404);
  });

  it('lets an admin download any app', async () => {
    expect((await download('alice-app', bearer(adminToken))).status).toBe(200);
  });

  it('accepts the owner\'s API key', async () => {
    const key = await createApiKey('ci', 'user', undefined, undefined, aliceId);
    expect((await download('alice-app', { 'X-API-Key': key.key })).status).toBe(200);
  });

  it('refuses an agent credential, even one that owns the app', async () => {
    const key = await createApiKey('agent', 'user', undefined, undefined, aliceId, { kind: 'agent' });

    const res = await download('alice-app', { 'X-API-Key': key.key });

    expect(res.status).toBe(403);
    expect(activitySpy).not.toHaveBeenCalled();
  });

  it('refuses a readonly token and an anonymous caller', async () => {
    expect((await download('alice-app', bearer(readerToken))).status).toBe(403);
    expect((await download('alice-app', {})).status).toBe(401);
  });

  it('refuses a non-admin whose app path is outside the webapps directory', async () => {
    const outside = path.join(tempDir, 'elsewhere');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'x');
    await registerApp('odd-app', outside, aliceId);

    expect((await download('odd-app', bearer(aliceToken))).status).toBe(404);
    // An admin registered it there; an admin may take it back out.
    expect((await download('odd-app', bearer(adminToken))).status).toBe(200);
  });

  it('refuses a non-admin whose app path IS the webapps directory', async () => {
    await registerApp('everything', webapps, aliceId);

    expect((await download('everything', bearer(aliceToken))).status).toBe(404);
  });

  it('404s an app whose source folder is gone or empty', async () => {
    await registerApp('gone', path.join(webapps, 'gone'), aliceId);
    const empty = path.join(webapps, 'empty');
    await fs.mkdir(path.join(empty, 'node_modules'), { recursive: true });
    await registerApp('empty', empty, aliceId);

    expect((await download('gone', bearer(aliceToken))).status).toBe(404);
    expect((await download('empty', bearer(aliceToken))).status).toBe(404);
  });

  it('fails closed when authentication is disabled', async () => {
    await server.stop();
    await startServer(false);

    const res = await download('alice-app', {});

    expect(res.status).toBe(403);
  });
});
