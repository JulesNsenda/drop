/**
 * Health Check Routes
 *
 * Endpoints for platform health monitoring.
 */

import { Hono } from 'hono';
import { success, HealthDto, StatsDto } from '../types';
import { getProcessManager } from '../../managers/process';
import { getStateManager, AppStateManager } from '../../managers/app/state-manager';

const health = new Hono();

// Track startup time
const startTime = Date.now();

// GET /health - Basic health check
health.get('/', async (c) => {
  let pmStatus: 'up' | 'down' = 'unknown' as 'up' | 'down';
  let pmMessage: string | undefined;

  try {
    const pm = getProcessManager();
    const processes = await pm.getAllStatus();
    pmStatus = 'up';
    pmMessage = `${processes.length} processes tracked`;
  } catch (err) {
    pmStatus = 'down';
    pmMessage = err instanceof Error ? err.message : 'Unknown error';
  }

  const response: HealthDto = {
    status: pmStatus === 'up' ? 'healthy' : 'degraded',
    version: process.env.npm_package_version || '0.1.0',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    components: {
      platform: { status: 'up' },
      processManager: { status: pmStatus, message: pmMessage },
    },
  };

  return c.json(success(response));
});

// GET /health/stats - Detailed statistics
health.get('/stats', async (c) => {
  let stateManager: AppStateManager | null = null;
  try {
    stateManager = getStateManager();
  } catch {
    // State manager not initialized
  }

  const stats = stateManager?.getStats() || { total: 0, running: 0, stopped: 0, errored: 0 };

  const response: StatsDto = {
    apps: stats,
    system: {
      platform: process.platform,
      nodeVersion: process.version,
      uptime: Math.floor((Date.now() - startTime) / 1000),
    },
  };

  return c.json(success(response));
});

// GET /health/ready - Readiness probe for k8s/orchestration
health.get('/ready', (c) => {
  return c.json(success({ ready: true }));
});

// GET /health/live - Liveness probe
health.get('/live', (c) => {
  return c.json(success({ alive: true }));
});

export default health;
