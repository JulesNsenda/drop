/**
 * Health Check Routes
 *
 * Endpoints for platform health monitoring.
 */

import * as http from 'http';
import { Hono } from 'hono';
import { success, HealthDto, StatsDto, ComponentHealth } from '../types';
import { getAppRuntime } from '../../managers/runtime';
import { getStateManager, AppStateManager } from '../../managers/app/state-manager';
import { getCaddyAdminClient } from '../../managers/router/caddy-api';
import { getPlatformVersion } from '../../utils/version';
import { getAppsDirectory } from '../runtime-config';
import { authMiddleware } from '../middleware/auth';

const health = new Hono();

// Track startup time
const startTime = Date.now();

const platformVersion = getPlatformVersion();

/** Per-subsystem health probe timeout. A probe must never hang the endpoint. */
const PROBE_TIMEOUT_MS = 2000;

/** Max concurrent app pings for /health/apps so a large fleet can't self-DoS. */
const APP_PING_CONCURRENCY = 10;

const TIMED_OUT = Symbol('timed-out');

/**
 * Resolve to the probe's value, or to TIMED_OUT if it takes longer than `ms`.
 * A rejection propagates so the caller can report the real error message —
 * only a genuine hang is converted to a timeout.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

async function probeProcessManager(): Promise<ComponentHealth> {
  try {
    const processes = await withTimeout(getAppRuntime().getAllStatus(), PROBE_TIMEOUT_MS);
    if (processes === TIMED_OUT) return { status: 'down', message: 'process manager probe timed out' };
    return { status: 'up', message: `${processes.length} process(es) tracked` };
  } catch (err) {
    return { status: 'down', message: err instanceof Error ? err.message : 'Unknown error' };
  }
}

async function probeDatabase(): Promise<ComponentHealth> {
  try {
    const { getPostgresServer } = await import('../../managers/database');
    const pg = getPostgresServer();
    const pgStatus = pg.getStatus();
    return {
      status: pgStatus === 'running' ? 'up' : 'down',
      message: `PostgreSQL ${pgStatus} on port ${pg.getPort()}`,
    };
  } catch {
    return { status: 'unknown', message: 'Not initialized' };
  }
}

/** Run `fn` over `items` with at most `limit` in flight at once (order preserved). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

async function probeCaddy(): Promise<ComponentHealth> {
  try {
    const available = await withTimeout(getCaddyAdminClient().isAvailable(), PROBE_TIMEOUT_MS);
    if (available === TIMED_OUT) return { status: 'unknown', message: 'Caddy probe timed out' };
    return available
      ? { status: 'up', message: 'Caddy admin API reachable' }
      : { status: 'down', message: 'Caddy admin API unreachable' };
  } catch {
    return { status: 'unknown', message: 'Caddy not configured' };
  }
}

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
  // Probe subsystems in parallel, each time-bounded so a hung dependency (e.g.
  // an unresponsive PM2 daemon) degrades the report instead of hanging /health.
  const [processManager, database, caddy] = await Promise.all([
    probeProcessManager(),
    probeDatabase(),
    probeCaddy(),
  ]);

  // State-manager reachability (a lightweight proxy for platform liveness).
  let watcher: ComponentHealth = { status: 'unknown' };
  try {
    getStateManager().getAllApps();
    watcher = { status: 'up' };
  } catch {
    watcher = { status: 'unknown' };
  }

  // Degraded (not healthy) only if an always-required subsystem is down.
  // Caddy is reported for visibility but does NOT force 'degraded': it is
  // optional (localhost / no-HTTPS setups run without it), so treating it as
  // down-worthy would falsely degrade those. Whether a Caddy-expecting install
  // should degrade on Caddy-down is a config-aware policy left as a follow-up.
  const coreDown = processManager.status === 'down' || database.status === 'down';
  const overallStatus = coreDown ? 'degraded' : 'healthy';

  const response: HealthDto = {
    status: overallStatus,
    version: platformVersion,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    components: {
      platform: { status: 'up' },
      processManager,
      database,
      watcher,
      caddy,
    },
    system: {
      platform: process.platform,
      appsDirectory: getAppsDirectory(),
    },
  };

  const statusCode = overallStatus === 'healthy' ? 200 : 503;
  return c.json(success(response), statusCode);
});

// GET /health/stats - Detailed statistics
// Gated: exposes per-tenant app counts/status. Public before the drop-net
// reachability change made this endpoint reachable from every app container
// (docs/plans/2026-07-10-drop-api-reachability-from-containers.md, §3).
health.get('/stats', authMiddleware('readonly'), async (c) => {
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
// Gated: anonymously enumerates every tenant's app name/port/status. Public
// before the drop-net reachability change made this endpoint reachable from
// every app container (docs/plans/2026-07-10-drop-api-reachability-from-containers.md, §3).
health.get('/apps', authMiddleware('readonly'), async (c) => {
  let stateManager: AppStateManager | null = null;
  try {
    stateManager = getStateManager();
  } catch {
    return c.json(success({ apps: [] }));
  }

  const runningApps = stateManager.getRunningApps();
  const checks = await mapLimit(runningApps, APP_PING_CONCURRENCY, async (app) => {
    const healthy = app.port ? await httpPing(app.port) : false;
    return {
      name: app.name,
      status: app.status,
      port: app.port,
      healthy,
    };
  });

  const healthyCount = checks.filter((c) => c.healthy).length;

  return c.json(success(checks, { total: checks.length, healthy: healthyCount }));
});

// GET /health/ready - Readiness probe for k8s/orchestration
health.get('/ready', async (c) => {
  try {
    const status = await withTimeout(getAppRuntime().getAllStatus(), PROBE_TIMEOUT_MS);
    if (status === TIMED_OUT) {
      return c.json(success({ ready: false }), 503);
    }
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
