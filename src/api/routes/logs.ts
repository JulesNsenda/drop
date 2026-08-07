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
      let closed = false;
      let stopTail: (() => void) | null = null;

      const send = (line: string, type: 'out' | 'err') => {
        if (closed) return;
        const payload = { line, type, timestamp: new Date().toISOString() };
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // Consumer went away mid-write; the abort handler tears the rest down.
        }
      };

      const shutdown = () => {
        if (closed) return;
        closed = true;
        try {
          stopTail?.();
        } catch {
          // Tailer already torn down.
        }
        try {
          controller.close();
        } catch {
          // Stream already closed.
        }
      };

      c.req.raw.signal.addEventListener('abort', shutdown);

      // Backfill, so a client attaching mid-life isn't staring at a blank pane.
      // Both runtimes prefix combined logs with [out]/[err]; lift that into the
      // `type` field and strip it, so backfilled and live lines have one shape.
      try {
        const initialLogs = await pm.getLogs(name, 50);
        for (const raw of (initialLogs || '').split('\n')) {
          if (!raw) continue;
          if (raw.startsWith('[err] ')) send(raw.slice(6), 'err');
          else if (raw.startsWith('[out] ')) send(raw.slice(6), 'out');
          else send(raw, 'out');
        }
      } catch {
        // No logs yet — the live tail below is still worth opening.
      }

      if (closed) return;

      // Live tail via the runtime's own follower. This replaces a 1s poll of
      // getLogs(name, 10) that compared the length of a fixed 10-line tail
      // window against a running counter: after the first tick the counter
      // equalled the window size, so `logLines.length > lastLogCount` never
      // held again and the stream silently went dead for the rest of its life.
      try {
        stopTail = await pm.streamLogs(
          name,
          (chunk, type) => {
            for (const line of chunk.split('\n')) {
              if (line) send(line, type);
            }
          },
          shutdown
        );
        // Aborted while the tailer was still being attached.
        if (closed) stopTail();
      } catch {
        shutdown();
      }
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
