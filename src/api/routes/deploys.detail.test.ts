/**
 * GET /api/v1/deploys/:deployId — ownership and disclosure discipline.
 *
 * The plan (SEC-10a) called this out specifically: v1 specified DTO stripping
 * but no ownership filter at all. The endpoint answers "why did this deploy
 * fail", so an unfiltered version hands one tenant another tenant's build
 * diagnostics — command lines, exit codes, the app's name.
 *
 * Own file: a second route-test describe block in one file hangs the Jest
 * worker.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer } from '../server';
import { createUser, resetAuth } from '../middleware/auth';
import { getTestToken } from '../__testutils__/auth';
import type { DeployDetail } from '../../managers/deploy-tracker';

// The route needs only getDetail from the store; getDeployTracker is still
// imported by the module under test, so it has to exist on the mock too.
const details = new Map<string, DeployDetail>();
jest.mock('../../managers/deploy-tracker', () => ({
  getDeployTracker: () => ({ getEpisodes: () => [] }),
  getDeployDetailStore: () => ({
    getDetail: (id: string) => details.get(id),
  }),
}));

jest.mock('../../managers/app/state-manager', () => ({
  getStateManager: () => ({ getApp: () => undefined }),
}));

function mkDetail(deployId: string, appName: string, userId: string | undefined): DeployDetail {
  return {
    deployId,
    appName,
    userId,
    phase: 'build',
    errorCode: 'INSTALL_FAILED',
    stage: 'install',
    exitCode: 127,
    command: 'npm ci',
    runtimeLog: {
      outFile: '/var/drop/data/logs/webapps/x/x-2026-07-27-out.log',
      errFile: '/var/drop/data/logs/webapps/x/x-2026-07-27-err.log',
      outStartOffset: 10,
      errStartOffset: 20,
    },
    createdAt: '2026-07-27T00:00:00.000Z',
  };
}

describe('GET /api/v1/deploys/:deployId', () => {
  let tempDir: string;
  let server: ApiServer;
  let app: ReturnType<ApiServer['getApp']>;
  let aliceId: string;
  let bobId: string;
  let aliceToken: string;
  let bobToken: string;
  let adminToken: string;

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-deploy-detail-route-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetAuth();
    details.clear();

    server = new ApiServer({
      port: 3094,
      enableAuth: true,
      credentialsPath: path.join(tempDir, 'credentials.json'),
    });
    await server.initialize();
    app = server.getApp();

    const alice = await createUser('alice', 'password123', 'readonly');
    const bob = await createUser('bob', 'password123', 'user');
    await createUser('root', 'password123', 'admin');
    aliceId = alice.id;
    bobId = bob.id;
    aliceToken = await getTestToken('alice', 'password123');
    bobToken = await getTestToken('bob', 'password123');
    adminToken = await getTestToken('root', 'password123');

    details.set('d-alice', mkDetail('d-alice', 'alice-app', aliceId));
    details.set('d-bob', mkDetail('d-bob', 'bob-app', bobId));
    details.set('d-legacy', mkDetail('d-legacy', 'legacy-app', undefined));
  });

  afterEach(async () => {
    if (server) await server.stop();
    resetAuth();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const get = (id: string, token: string) =>
    app.request(`/api/v1/deploys/${id}`, { headers: bearer(token) });

  it('returns the owner their own deploy detail', async () => {
    const res = await get('d-alice', aliceToken);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { deployId: string; exitCode: number; errorCode: string };
    };
    expect(body.data.deployId).toBe('d-alice');
    expect(body.data.exitCode).toBe(127);
    // The taxonomy is the point of the endpoint — a caller switches on this.
    expect(body.data.errorCode).toBe('INSTALL_FAILED');
  });

  it("404s on another tenant's deploy", async () => {
    // The load-bearing one — SEC-10a. Without the filter this hands bob
    // alice's build diagnostics.
    const res = await get('d-alice', bobToken);

    expect(res.status).toBe(404);
  });

  it('is indistinguishable between foreign, missing, and succeeded', async () => {
    // A 403-vs-404 split, or a different error code, would turn this endpoint
    // into an oracle for which deploy ids exist and which apps failed.
    //
    // Bodies are compared by SHAPE, not bytes: the message echoes the id the
    // caller itself supplied, so three different ids can never produce three
    // identical strings. Echoing the caller's own input leaks nothing — what
    // must not vary is the status and the code.
    const foreign = await get('d-alice', bobToken); // exists, not theirs
    const missing = await get('d-nope', bobToken); // never existed
    const succeeded = await get('d-succeeded', bobToken); // succeeded, so no detail

    const shape = async (r: Response) => {
      const body = (await r.json()) as { success: boolean; error: { code: string } };
      return { status: r.status, success: body.success, code: body.error.code };
    };

    const [a, b, c] = await Promise.all([shape(foreign), shape(missing), shape(succeeded)]);
    expect(a).toEqual({ status: 404, success: false, code: 'NOT_FOUND' });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('never names the app in the not-found message', async () => {
    // The id came from the caller; the app name did not. Echoing 'alice-app'
    // back to bob would confirm the deploy exists and say whose it is.
    const res = await get('d-alice', bobToken);

    expect(await res.text()).not.toContain('alice-app');
  });

  it('lets an admin read any deploy detail', async () => {
    expect((await get('d-alice', adminToken)).status).toBe(200);
    expect((await get('d-bob', adminToken)).status).toBe(200);
  });

  it('treats an unowned legacy deploy exactly as canAccess does', async () => {
    // userId undefined (folder-dropped / pre-ownership). canAccess makes those
    // admin-only, and the /deploys collection route filters them the same way.
    // Pinned so this route cannot silently diverge from the rest of the API in
    // either direction.
    expect((await get('d-legacy', aliceToken)).status).toBe(404);
    expect((await get('d-legacy', adminToken)).status).toBe(200);
  });

  it('never exposes the owner snapshot or the absolute log paths', async () => {
    // runtimeLog carries host paths (/var/drop/...). They are internal
    // plumbing for the log-tail tool; exposing them leaks the host filesystem
    // layout to a tenant.
    const res = await get('d-alice', aliceToken);
    const raw = await res.text();

    expect(raw).not.toContain(aliceId);
    expect(raw).not.toContain('/var/drop');
    expect(raw).not.toContain('runtimeLog');
  });
});
