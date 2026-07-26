/**
 * API Server Tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer, createApiServer } from './server';
import { isPathWithin } from '../utils/paths';
import { getPlatformVersion } from '../utils/version';

interface ApiResponse<T = unknown> {
  success: boolean;
  data: T;
}

interface RootResponse {
  name: string;
  version: string;
  docs: string;
  auth: string;
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

    it('should respond to root endpoint', async () => {
      const app = server.getApp();
      const res = await app.request('/');

      // DROP-070: the root no longer redirects to /dashboard (never 302) —
      // it serves the marketing site bundle directly when dist/site has been
      // built, or falls back to API-info JSON otherwise. Tolerant of both,
      // same as the pre-DROP-070 test was tolerant of [200, 302]: whether
      // dist/site exists depends on local build state (CI always runs tests
      // before building the frontend, but a dev running `npm test` after
      // `npm run build` will see the built branch).
      expect(res.status).toBe(200);
      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const data = (await res.json()) as RootResponse;
        expect(data.name).toBe('DROP API');
        // Assert against package.json, not a literal. This assertion used to
        // hardcode '1.0.0' and matched only because server.ts hardcoded the
        // same stale string — it would have gone on passing while the endpoint
        // reported a version the platform hadn't been for two majors. Note it
        // is reached only on the JSON branch above, i.e. when dist/site is NOT
        // built: that is CI, but not a dev box that has run `npm run build`.
        expect(data.version).toBe(getPlatformVersion());
      } else {
        expect(contentType).toContain('text/html');
      }
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

  describe('marketing site split (DROP-070)', () => {
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

    describe('serving / (isolated site fixture via ApiServerConfig.sitePath)', () => {
      // ApiServerConfig.sitePath overrides the resolved site directory, so
      // this never touches the repo's real dist/site — that path is shared,
      // mutable global state: 18 test files construct an ApiServer, Jest
      // runs files in parallel workers, and a backup/rm/restore dance around
      // one real, fixed directory is exactly the kind of shared state that
      // can be observed mid-mutation by an unrelated parallel test, or left
      // clobbered if a run is interrupted before the restore step.
      let siteDir: string;

      beforeEach(async () => {
        siteDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-site-fixture-'));
        await fs.writeFile(path.join(siteDir, 'index.html'), '<html><body>SITE-SHELL</body></html>', 'utf-8');
      });

      afterEach(async () => {
        await fs.rm(siteDir, { recursive: true, force: true });
      });

      it('serves the site bundle at /, /docs, and /reference when the site path exists', async () => {
        server = new ApiServer({ port: 3006, enableAuth: false, sitePath: siteDir });
        await server.initialize();
        const app = server.getApp();

        for (const route of ['/', '/docs', '/reference']) {
          const res = await app.request(route);
          expect(res.status).toBe(200);
          expect(res.headers.get('content-type') || '').toContain('text/html');
          expect(await res.text()).toContain('SITE-SHELL');
        }
      });

      it('301-redirects the trailing-slash variants /docs/ and /reference/ to their canonical form', async () => {
        server = new ApiServer({ port: 3010, enableAuth: false, sitePath: siteDir });
        await server.initialize();
        const app = server.getApp();

        const docsSlash = await app.request('/docs/', { redirect: 'manual' });
        expect(docsSlash.status).toBe(301);
        expect(docsSlash.headers.get('location')).toBe('/docs');

        const refSlash = await app.request('/reference/', { redirect: 'manual' });
        expect(refSlash.status).toBe(301);
        expect(refSlash.headers.get('location')).toBe('/reference');
      });

      // These two assertions only mean something when the site's own root-
      // level routes (/, /docs, /reference) are actually registered — CI
      // runs `npm test` before `npm run build:site` (deploy.yml), so without
      // this fixture, siteExists is false and the site routes never exist at
      // all, which would make "not swallowed" trivially, vacuously true.
      it('does not let the site routes swallow /.well-known/oauth-protected-resource', async () => {
        server = new ApiServer({ port: 3009, enableAuth: false, sitePath: siteDir });
        await server.initialize();
        const app = server.getApp();
        const res = await app.request('/.well-known/oauth-protected-resource');

        // No DROP_PUBLIC_URL is configured on this test server, so the
        // well-known handler itself 404s — the point is this is a JSON 404
        // from the registered well-known route, never a 200 HTML shell from
        // a root catch-all that would otherwise shadow it.
        expect(res.status).toBe(404);
        expect(res.headers.get('content-type') || '').not.toContain('text/html');
      });

      it('does not let the site routes swallow /api/v1/health', async () => {
        server = new ApiServer({ port: 3013, enableAuth: false, sitePath: siteDir });
        await server.initialize();
        const app = server.getApp();
        const res = await app.request('/api/v1/health');

        expect(res.headers.get('content-type') || '').not.toContain('text/html');
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

      it('redirects /dashboard/docs to /docs', async () => {
        const app = server.getApp();
        const res = await app.request('/dashboard/docs', { redirect: 'manual' });

        expect(res.status).toBe(301);
        expect(res.headers.get('location')).toBe('/docs');
      });

      it('redirects /dashboard/reference to /reference', async () => {
        const app = server.getApp();
        const res = await app.request('/dashboard/reference', { redirect: 'manual' });

        expect(res.status).toBe(301);
        expect(res.headers.get('location')).toBe('/reference');
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
