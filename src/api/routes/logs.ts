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
import { getProcessManager } from '../../managers/process';
import { getStateManager } from '../../managers/app/state-manager';

const logs = new Hono();

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

  const pm = getProcessManager();

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

  const pm = getProcessManager();

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

export default logs;
