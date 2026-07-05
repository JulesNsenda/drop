/**
 * API Server Tests
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { ApiServer, createApiServer } from './server';

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

      // Root endpoint either redirects to dashboard (302) or returns API info (200)
      expect([200, 302]).toContain(res.status);
      if (res.status === 200) {
        const data = (await res.json()) as RootResponse;
        expect(data.name).toBe('DROP API');
        expect(data.version).toBe('1.0.0');
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
  });
});
