/**
 * Health Check Routes
 *
 * Endpoints for platform health monitoring.
 */

import * as http from 'http';
import { Hono } from 'hono';
import { success, HealthDto, StatsDto } from '../types';
import { getProcessManager } from '../../managers/process';
import { getStateManager, AppStateManager } from '../../managers/app/state-manager';

const health = new Hono();

// Track startup time
const startTime = Date.now();

/** Quick HTTP ping to check if an app is responding */
function httpPing(port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

// GET /health - Full health check with all components
health.get('/', async (c) => {
  let pmStatus: 'up' | 'down' = 'unknown' as 'up' | 'down';
  let pmMessage: string | undefined;
  let dbStatus: 'up' | 'down' | 'unknown' = 'unknown';
  let dbMessage: string | undefined;

  // Check process manager
  try {
    const pm = getProcessManager();
    const processes = await pm.getAllStatus();
    pmStatus = 'up';
    pmMessage = `${processes.length} process(es) tracked`;
  } catch (err) {
    pmStatus = 'down';
    pmMessage = err instanceof Error ? err.message : 'Unknown error';
  }

  // Check PostgreSQL
  try {
    const { getPostgresServer } = await import('../../managers/database');
    const pg = getPostgresServer();
    const pgStatus = pg.getStatus();
    dbStatus = pgStatus === 'running' ? 'up' : 'down';
    dbMessage = `PostgreSQL ${pgStatus} on port ${pg.getPort()}`;
  } catch {
    dbStatus = 'unknown';
    dbMessage = 'Not initialized';
  }

  // Check watcher
  let watcherStatus: 'up' | 'down' | 'unknown' = 'unknown';
  try {
    const stateManager = getStateManager();
    const apps = stateManager.getAllApps();
    watcherStatus = apps.length >= 0 ? 'up' : 'unknown';
  } catch {
    watcherStatus = 'unknown';
  }

  // Determine overall status
  const allUp = pmStatus === 'up' && dbStatus === 'up';
  const anyDown = pmStatus === 'down' || dbStatus === 'down';
  const overallStatus = allUp ? 'healthy' : anyDown ? 'degraded' : 'healthy';

  const response: HealthDto = {
    status: overallStatus,
    version: process.env.npm_package_version || '0.4.0',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    components: {
      platform: { status: 'up' },
      processManager: { status: pmStatus, message: pmMessage },
      database: { status: dbStatus, message: dbMessage },
      watcher: { status: watcherStatus },
    },
  };

  const statusCode = overallStatus === 'healthy' ? 200 : 503;
  return c.json(success(response), statusCode);
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

// GET /health/apps - Per-app health checks (HTTP ping each running app)
health.get('/apps', async (c) => {
  let stateManager: AppStateManager | null = null;
  try {
    stateManager = getStateManager();
  } catch {
    return c.json(success({ apps: [] }));
  }

  const runningApps = stateManager.getRunningApps();
  const checks = await Promise.all(
    runningApps.map(async (app) => {
      const healthy = app.port ? await httpPing(app.port) : false;
      return {
        name: app.name,
        status: app.status,
        port: app.port,
        healthy,
      };
    })
  );

  const healthyCount = checks.filter((c) => c.healthy).length;

  return c.json(success(checks, { total: checks.length, healthy: healthyCount }));
});

// GET /health/ready - Readiness probe for k8s/orchestration
health.get('/ready', async (c) => {
  try {
    const pm = getProcessManager();
    await pm.getAllStatus();
    return c.json(success({ ready: true }));
  } catch {
    return c.json(success({ ready: false }), 503);
  }
});

// GET /health/live - Liveness probe
health.get('/live', (c) => {
  return c.json(success({ alive: true }));
});

export default health;
