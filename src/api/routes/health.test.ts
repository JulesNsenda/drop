/**
 * Health Routes Tests
 */

import { Hono } from 'hono';
import healthRoutes from './health';
import { resetAppRuntime } from '../../managers/runtime';
import { resetStateManager, getStateManager } from '../../managers/app/state-manager';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

interface ApiResponse<T = unknown> {
  success: boolean;
  data: T;
}

interface HealthResponse {
  status: string;
  version: string;
  uptime: number;
  timestamp: string;
  components: {
    platform: { status: string };
    processManager: { status: string; message?: string };
  };
}

interface StatsResponse {
  apps: { total: number; running: number; stopped: number; errored: number };
  system: { platform: string; nodeVersion: string; uptime: number };
}

describe('Health Routes', () => {
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.route('/health', healthRoutes);
    resetAppRuntime();
    resetStateManager();
  });

  afterEach(() => {
    resetAppRuntime();
    resetStateManager();
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const res = await app.request('/health');

      expect(res.status).toBe(200);
      const data = (await res.json()) as ApiResponse<HealthResponse>;
      expect(data.success).toBe(true);
      expect(data.data.status).toBeDefined();
      expect(data.data.version).toBeDefined();
      expect(data.data.uptime).toBeGreaterThanOrEqual(0);
      expect(data.data.timestamp).toBeDefined();
      expect(data.data.components).toBeDefined();
      expect(data.data.components.platform.status).toBe('up');
    }, 10000);
  });

  describe('GET /health/stats', () => {
    it('should return stats without state manager', async () => {
      const res = await app.request('/health/stats');

      expect(res.status).toBe(200);
      const data = (await res.json()) as ApiResponse<StatsResponse>;
      expect(data.success).toBe(true);
      expect(data.data.apps).toEqual({ total: 0, running: 0, stopped: 0, errored: 0 });
      expect(data.data.system.platform).toBe(process.platform);
      expect(data.data.system.nodeVersion).toBe(process.version);
    });

    it('should return stats with initialized state manager', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-health-test-'));
      try {
        const stateManager = getStateManager({ stateFilePath: path.join(tempDir, 'state.json') });
        await stateManager.initialize();
        await stateManager.registerApp('test-app', '/path', 'nodejs');
        await stateManager.setAppStatus('test-app', 'running');

        const res = await app.request('/health/stats');
        const data = (await res.json()) as ApiResponse<StatsResponse>;

        expect(data.data.apps.total).toBe(1);
        expect(data.data.apps.running).toBe(1);

        // Close state manager before cleanup
        await stateManager.close();
        resetStateManager();
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('GET /health/ready', () => {
    it('should return ready status', async () => {
      const res = await app.request('/health/ready');

      expect(res.status).toBe(200);
      const data = (await res.json()) as ApiResponse<{ ready: boolean }>;
      expect(data.success).toBe(true);
      expect(data.data.ready).toBe(true);
    });
  });

  describe('GET /health/live', () => {
    it('should return alive status', async () => {
      const res = await app.request('/health/live');

      expect(res.status).toBe(200);
      const data = (await res.json()) as ApiResponse<{ alive: boolean }>;
      expect(data.success).toBe(true);
      expect(data.data.alive).toBe(true);
    });
  });
});
