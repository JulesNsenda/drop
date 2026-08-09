/**
 * API Server Tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer, createApiServer } from './server';
import { isPathWithin } from '../utils/paths';

interface ApiResponse<T = unknown> {
  success: boolean;
  data: T;
}

interface HealthResponse {
  status: string;
  version: string;
  uptime: number;
  timestamp: string;
  components: Record<string, unknown>;
}

describe('ApiServer', () => {
  let tempDir: string;
  let credentialsPath: string;
  let server: ApiServer;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-api-server-test-'));
    credentialsPath = path.join(tempDir, 'credentials.json');
    jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  describe('constructor', () => {
    it('should create server with default config', () => {
      server = new ApiServer({
        port: 3001,
      });

      expect(server).toBeInstanceOf(ApiServer);
    });

    it('should create server with custom config', () => {
      server = new ApiServer({
        port: 3002,
        host: '127.0.0.1',
        corsOrigins: ['http://localhost:3000'],
        enableAuth: false,
      });

      expect(server).toBeInstanceOf(ApiServer);
    });
  });

  describe('initialize', () => {
    it('should initialize without auth', async () => {
      server = new ApiServer({
        port: 3003,
        enableAuth: false,
      });

      await server.initialize();
      const app = server.getApp();
      expect(app).toBeDefined();
    });

    it('should initialize with auth', async () => {
      server = new ApiServer({
        port: 3004,
        enableAuth: true,
        credentialsPath,
      });

      await server.initialize();
      const app = server.getApp();
      expect(app).toBeDefined();
    });
  });

  describe('routes', () => {
    beforeEach(async () => {
      server = new ApiServer({
        port: 3005,
        enableAuth: false,
      });
      await server.initialize();
    });

    it('should respond to root endpoint with a redirect to /dashboard', async () => {
      const app = server.getApp();
      // DROP-139: the marketing site (and its API-info JSON fallback) no
      // longer lives in the platform — it's a separate app at dropkit.sh.
      // The platform root now always 301s to /dashboard.
      const res = await app.request('/', { redirect: 'manual' });

      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('/dashboard');
    });

    it('should respond to health check without hanging', async () => {
      const app = server.getApp();
      // A standalone server has no PM2/Postgres/Caddy running, so health is
      // legitimately 'degraded' (503) — the point is it responds promptly with
      // a valid report rather than hanging on an unresponsive subsystem probe.
      const res = await app.request('/api/v1/health');

      expect([200, 503]).toContain(res.status);
      const data = (await res.json()) as ApiResponse<HealthResponse>;
      expect(data.success).toBe(true);
      expect(data.data.status).toBeDefined();
    });

    it('should return 404 for unknown routes', async () => {
      const app = server.getApp();
      const res = await app.request('/api/v1/unknown');

      expect(res.status).toBe(404);
      const data = (await res.json()) as ApiResponse;
      expect(data.success).toBe(false);
    });
  });

  describe('root/dashboard static routes (DROP-070 dashboard split, DROP-139 site removal)', () => {
    describe('isPathWithin (asset containment, src/utils/paths.ts)', () => {
      // Guaranteed not to exist on disk, so isPathWithin's realpath step
      // always falls back to a lexical resolve on both sides — keeps this
      // deterministic regardless of whatever a local build happens to have
      // left under the repo's real dist/.
      const base = path.join(os.tmpdir(), 'drop-test-nonexistent-dist-site');

      it('accepts the base directory itself and paths inside it', async () => {
        expect(await isPathWithin(base, base)).toBe(true);
        expect(await isPathWithin(base, path.join(base, 'assets', 'index.js'))).toBe(true);
      });

      it('rejects a sibling directory that merely shares a string prefix', async () => {
        // The bug this guards against: `startsWith(base)` with no trailing
        // separator accepts `dist/site-backup` because the raw STRING
        // "dist/site-backup" starts with "dist/site". A real HTTP request
        // can't exercise this directly — the URL layer normalizes `..`/
        // encoded-dot traversal before a route handler ever sees it — so
        // this is tested at the predicate level instead.
        const sibling = `${base}-backup`;
        expect(await isPathWithin(base, path.join(sibling, 'secret.txt'))).toBe(false);
      });

      it('rejects a `..` escape out of the base directory', async () => {
        const escaped = path.join(base, '..', '..', 'etc', 'passwd');
        expect(await isPathWithin(base, escaped)).toBe(false);
      });
    });

    describe('root routes do not swallow other origin routes (DROP-139)', () => {
      // DROP-139: the marketing site (which used to own /, /docs and
      // /reference and was gated on an explicit-routes-only registration for
      // this exact reason) is gone — the root now only redirects to
      // /dashboard and serves the four favicon files. These assertions used
      // to matter only when a site fixture was registered (siteExists true);
      // now the root routes are always registered, so the well-known and API
      // routes still needing to win is the invariant worth keeping.
      it('does not let the root redirect swallow /.well-known/oauth-protected-resource', async () => {
        server = new ApiServer({ port: 3009, enableAuth: false });
        await server.initialize();
        const app = server.getApp();
        const res = await app.request('/.well-known/oauth-protected-resource');

        // No DROP_PUBLIC_URL is configured on this test server, so the
        // well-known handler itself 404s — the point is this is a JSON 404
        // from the registered well-known route, never a redirect/HTML shell
        // from a root catch-all that would otherwise shadow it.
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type') || '').not.toContain('text/html');
      });

      it('does not let the root redirect swallow /api/v1/health', async () => {
        server = new ApiServer({ port: 3013, enableAuth: false });
        await server.initialize();
        const app = server.getApp();
        const res = await app.request('/api/v1/health');

        expect(res.headers.get('content-type') || '').not.toContain('text/html');
      });
    });

    describe('root icon routes read from the dashboard bundle (DROP-139)', () => {
      // Isolated fixture via ApiServerConfig.dashboardPath, same reasoning as
      // the old sitePath fixture it replaces: never touch the repo's real
      // dist/dashboard, which every ApiServer in the suite would otherwise
      // share as mutable global state.
      let dashboardDir: string;

      beforeEach(async () => {
        dashboardDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-dashboard-fixture-'));
        await fs.writeFile(path.join(dashboardDir, 'index.html'), '<html><body>DASHBOARD-SHELL</body></html>', 'utf-8');
        await fs.writeFile(path.join(dashboardDir, 'favicon.ico'), 'FAVICON-BYTES', 'utf-8');
      });

      afterEach(async () => {
        await fs.rm(dashboardDir, { recursive: true, force: true });
      });

      it('serves /favicon.ico at the root from the dashboard bundle', async () => {
        server = new ApiServer({ port: 3011, enableAuth: false, dashboardPath: dashboardDir });
        await server.initialize();
        const app = server.getApp();

        const res = await app.request('/favicon.ico');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('image/x-icon');
        expect(await res.text()).toBe('FAVICON-BYTES');
      });

      it('404s an icon route the fixture does not provide (drop.svg)', async () => {
        server = new ApiServer({ port: 3012, enableAuth: false, dashboardPath: dashboardDir });
        await server.initialize();
        const app = server.getApp();

        const res = await app.request('/drop.svg');
        expect(res.status).toBe(404);
      });
    });

    describe('/dashboard still serves', () => {
      it('serves 200 HTML at /dashboard (checked-in src/dashboard/index.html, no build required)', async () => {
        server = new ApiServer({ port: 3007, enableAuth: false });
        await server.initialize();
        const app = server.getApp();
        const res = await app.request('/dashboard');

        expect(res.status).toBe(200);
        expect(res.headers.get('content-type') || '').toContain('text/html');
      });
    });

    describe('301 redirects for the moved public URLs', () => {
      beforeEach(async () => {
        server = new ApiServer({ port: 3008, enableAuth: false });
        await server.initialize();
      });

      // DROP-139: the docs/reference site no longer lives in the platform
      // at all — these now point off-box at the public drop-site app.
      it('redirects /dashboard/docs to https://dropkit.sh/docs', async () => {
        const app = server.getApp();
        const res = await app.request('/dashboard/docs', { redirect: 'manual' });

        expect(res.status).toBe(301);
        expect(res.headers.get('location')).toBe('https://dropkit.sh/docs');
      });

      it('redirects /dashboard/reference to https://dropkit.sh/docs/api', async () => {
        const app = server.getApp();
        const res = await app.request('/dashboard/reference', { redirect: 'manual' });

        expect(res.status).toBe(301);
        expect(res.headers.get('location')).toBe('https://dropkit.sh/docs/api');
      });
    });
  });

  describe('body-size carve-out for upload-source (PRD-039)', () => {
    beforeEach(async () => {
      server = new ApiServer({
        port: 3097,
        enableAuth: true,
        credentialsPath,
      });
      await server.initialize();
    });

    it('does not 413 a large Content-Length on the upload-source path (falls through to auth instead)', async () => {
      const app = server.getApp();
      const res = await app.request('/api/v1/apps/foo/source', {
        method: 'POST',
        headers: { 'content-length': String(5 * 1024 * 1024) },
      });
      // The global validateBodySize() middleware is carved out for this exact
      // path — it must never 413 here. No Authorization header means the
      // request is rejected by auth instead (401), never by the body-size gate.
      expect(res.status).not.toBe(413);
      expect(res.status).toBe(401);
    });

    it('still 413s a large Content-Length on any other route (byte-identical elsewhere)', async () => {
      const app = server.getApp();
      const res = await app.request('/api/v1/apps', {
        method: 'POST',
        headers: { 'content-length': String(5 * 1024 * 1024), 'Content-Type': 'application/json' },
      });
      expect(res.status).toBe(413);
    });

    it('still 413s a large Content-Length on a path that merely looks similar (e.g. nested /source)', async () => {
      const app = server.getApp();
      const res = await app.request('/api/v1/apps/foo/source/nested', {
        method: 'POST',
        headers: { 'content-length': String(5 * 1024 * 1024) },
      });
      expect(res.status).toBe(413);
    });
  });

  describe('createApiServer factory', () => {
    it('should create server instance', () => {
      server = createApiServer({ port: 3006 });
      expect(server).toBeInstanceOf(ApiServer);
    });
  });

  describe('error handling', () => {
    beforeEach(async () => {
      server = new ApiServer({
        port: 3007,
        enableAuth: false,
      });
      await server.initialize();
    });

    it('should handle invalid JSON body', async () => {
      const app = server.getApp();
      const res = await app.request('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });

      expect(res.status).toBe(500);
    });

    it('does not leak internal error messages to clients (P3-3)', async () => {
      const app = server.getApp();
      jest.spyOn(console, 'error').mockImplementation(); // the handler logs the real error
      // Inject a route that throws a raw (non-HttpError) Error carrying a sensitive detail.
      app.get('/__test_throw', () => {
        throw new Error('sensitive internal detail: /var/drop/data/drop-svc/.pg-superuser');
      });

      const res = await app.request('/__test_throw');
      expect(res.status).toBe(500);
      const body = (await res.json()) as { success: boolean; error: { message: string } };
      expect(body.success).toBe(false);
      expect(body.error.message).toBe('Internal server error');
      // The raw error text must never appear anywhere in the client response.
      expect(JSON.stringify(body)).not.toContain('sensitive internal detail');
    });
  });
});
