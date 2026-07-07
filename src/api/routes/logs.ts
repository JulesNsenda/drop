/**
 * Logs Routes
 *
 * Endpoints for application logs.
 */

import { Hono } from 'hono';
import { success, AppLogsDto } from '../types';
import { NotFoundError } from '../middleware/error';
import { AuthContext } from '../middleware/auth';
import { canAccess } from '../access';
import { getAppRuntime } from '../../managers/runtime';
import { getStateManager } from '../../managers/app/state-manager';
import { getBuildLogService } from '../../managers/build-log/build-log';
import { validateAppName } from '../middleware/validate';

const logs = new Hono();

// Defense-in-depth: reject a malformed :name param before any handler runs.
logs.use('/:name', validateAppName());
logs.use('/:name/*', validateAppName());

// GET /logs/:name - Get application logs
logs.get('/:name', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const lines = parseInt(c.req.query('lines') || '100', 10);
  const type = (c.req.query('type') || 'combined') as 'stdout' | 'stderr' | 'combined';

  const pm = getAppRuntime();

  let logLines: string[] = [];
  try {
    const logContent = await pm.getLogs(name, lines);
    logLines = logContent ? logContent.split('\n').filter(Boolean) : [];
  } catch {
    // No logs available yet — return empty
  }

  const response: AppLogsDto = {
    name,
    logs: logLines,
    type,
  };

  return c.json(success(response));
});

// GET /logs/:name/stream - Stream logs (SSE)
logs.get('/:name/stream', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  // Set up SSE headers
  c.header('Content-Type', 'text/event-stream');
  c.header('Cache-Control', 'no-cache');
  c.header('Connection', 'keep-alive');

  const pm = getAppRuntime();

  // Create a readable stream
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      // Send initial logs
      try {
        const initialLogs = await pm.getLogs(name, 50);
        if (initialLogs) {
          const lines = initialLogs.split('\n').filter(Boolean);
          for (const line of lines) {
            const data = `data: ${JSON.stringify({ line, timestamp: new Date().toISOString() })}\n\n`;
            controller.enqueue(encoder.encode(data));
          }
        }
      } catch {
        // Continue even if initial logs fail
      }

      // Set up log tailing interval
      let lastLogCount = 0;
      const interval = setInterval(async () => {
        try {
          const logContent = await pm.getLogs(name, 10);
          if (logContent) {
            const logLines = logContent.split('\n').filter(Boolean);
            if (logLines.length > lastLogCount) {
              const newLogs = logLines.slice(lastLogCount);
              for (const line of newLogs) {
                const data = `data: ${JSON.stringify({ line, timestamp: new Date().toISOString() })}\n\n`;
                controller.enqueue(encoder.encode(data));
              }
              lastLogCount = logLines.length;
            }
          }
        } catch {
          // Ignore errors during streaming
        }
      }, 1000);

      // Clean up on close
      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(interval);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
});

// GET /logs/:name/builds - List build logs for an app (newest first)
logs.get('/:name/builds', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  let buildLogs: { id: string; appName: string; timestamp: string }[] = [];
  try {
    const svc = getBuildLogService();
    const entries = await svc.listBuilds(name);
    buildLogs = entries.map(({ id, appName, timestamp }) => ({ id, appName, timestamp }));
  } catch {
    // Service not initialized yet — return empty list
  }

  return c.json(success({ name, builds: buildLogs }));
});

// GET /logs/:name/build - Latest build log content
logs.get('/:name/build', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  let content: string | null = null;
  try {
    const svc = getBuildLogService();
    content = await svc.getLatestBuildLog(name);
  } catch {
    // Service not initialized yet
  }

  if (content === null) {
    throw new NotFoundError(`No build logs found for '${name}'`);
  }

  return c.json(success({ name, log: content }));
});

export default logs;
