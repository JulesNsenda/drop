/**
 * Apps Routes
 *
 * CRUD and management endpoints for applications.
 */

import { Hono } from 'hono';
import * as path from 'path';
import * as fs from 'fs/promises';
import { success, error, ErrorCodes, AppDto, CreateAppDto, UpdateAppDto } from '../types';
import { NotFoundError, ValidationError } from '../middleware/error';
import { getProcessManager } from '../../managers/process';
import { getStateManager, AppState } from '../../managers/app/state-manager';

const apps = new Hono();

// Helper to convert AppState to AppDto
function toAppDto(app: AppState): AppDto {
  return {
    name: app.name,
    type: app.type,
    status: app.status,
    port: app.port,
    pid: app.pid,
    path: app.path,
    framework: app.framework,
    hostname: app.hostname,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    lastDeployedAt: app.lastDeployedAt,
    buildDuration: app.buildDuration,
    error: app.error,
  };
}

// GET /apps - List all applications
apps.get('/', async (c) => {
  const stateManager = getStateManager();
  const allApps = stateManager.getAllApps();

  // Apply filters from query params
  const status = c.req.query('status');
  const type = c.req.query('type');

  let filtered = allApps;

  if (status) {
    filtered = filtered.filter((app) => app.status === status);
  }

  if (type) {
    filtered = filtered.filter((app) => app.type === type);
  }

  return c.json(
    success(filtered.map(toAppDto), {
      total: filtered.length,
    })
  );
});

// GET /apps/:name - Get application by name
apps.get('/:name', async (c) => {
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  // Get additional process info
  const pm = getProcessManager();
  try {
    const status = await pm.getStatus(name);
    if (status) {
      return c.json(
        success({
          ...toAppDto(app),
          pid: status.pid ?? app.pid,
          memory: status.memory,
          cpu: status.cpu,
          restarts: status.restarts,
        })
      );
    }
  } catch {
    // Process info not available
  }

  return c.json(success(toAppDto(app)));
});

// POST /apps - Deploy a new application
apps.post('/', async (c) => {
  const body = await c.req.json<CreateAppDto>();

  if (!body.path) {
    throw new ValidationError('Path is required');
  }

  // Validate path exists
  try {
    const stats = await fs.stat(body.path);
    if (!stats.isDirectory()) {
      throw new ValidationError('Path must be a directory');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ValidationError(`Path does not exist: ${body.path}`);
    }
    throw err;
  }

  const appName = body.name || path.basename(body.path);

  // Check if app already exists
  const stateManager = getStateManager();
  if (stateManager.hasApp(appName)) {
    return c.json(error(ErrorCodes.CONFLICT, `Application '${appName}' already exists`), 409);
  }

  // Register the app (it will be detected and built by the platform)
  const app = await stateManager.registerApp(appName, body.path);

  return c.json(success(toAppDto(app)), 201);
});

// PUT /apps/:name - Update application
apps.put('/:name', async (c) => {
  const name = c.req.param('name');
  const body = await c.req.json<UpdateAppDto>();

  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const updated = await stateManager.updateApp(name, body);
  if (!updated) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  return c.json(success(toAppDto(updated)));
});

// DELETE /apps/:name - Remove application
apps.delete('/:name', async (c) => {
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  // Stop the process if running
  const pm = getProcessManager();
  try {
    await pm.stop(name);
    await pm.delete(name);
  } catch {
    // Process might not exist in PM2
  }

  // Remove from state
  await stateManager.removeApp(name);

  return c.json(success({ message: `Application '${name}' removed` }));
});

// POST /apps/:name/start - Start application
apps.post('/:name/start', async (c) => {
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const pm = getProcessManager();

  try {
    const status = await pm.start({
      name,
      script: 'index.js',
      cwd: app.path,
      port: app.port,
      env: { NODE_ENV: 'production' },
    });

    await stateManager.setAppStatus(name, 'running', {
      port: status.port ?? undefined,
      pid: status.pid ?? undefined,
    });

    return c.json(success({ message: `Application '${name}' started`, status }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to start';
    await stateManager.setAppStatus(name, 'errored', { error: message });
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }
});

// POST /apps/:name/stop - Stop application
apps.post('/:name/stop', async (c) => {
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const pm = getProcessManager();

  try {
    await pm.stop(name);
    await stateManager.setAppStatus(name, 'stopped');

    return c.json(success({ message: `Application '${name}' stopped` }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to stop';
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }
});

// POST /apps/:name/restart - Restart application
apps.post('/:name/restart', async (c) => {
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const pm = getProcessManager();

  try {
    const status = await pm.restart(name);
    await stateManager.setAppStatus(name, 'running', {
      pid: status.pid ?? undefined,
    });

    return c.json(success({ message: `Application '${name}' restarted`, status }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to restart';
    await stateManager.setAppStatus(name, 'errored', { error: message });
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }
});

export default apps;
