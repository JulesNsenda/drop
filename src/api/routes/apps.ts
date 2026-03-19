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
import { AuthContext, listUsers, getUserById } from '../middleware/auth';
import { getProcessManager } from '../../managers/process';
import { getStateManager, AppState } from '../../managers/app/state-manager';
import { getAppConfigService } from '../../managers/app/app-config';
import { getActivityLog } from '../../managers/activity';

const apps = new Hono();

// Cache userId → username mapping
function resolveUsername(userId?: string): string | undefined {
  if (!userId) return undefined;
  try {
    const users = listUsers();
    return users.find((u) => u.id === userId)?.username;
  } catch {
    return undefined;
  }
}

// Helper to convert AppState to AppDto (role-aware)
function toAppDto(app: AppState, isAdmin = false): AppDto {
  return {
    name: app.name,
    type: app.type,
    status: app.status,
    port: app.port,
    pid: isAdmin ? app.pid : undefined,
    path: isAdmin ? app.path : undefined as unknown as string,
    framework: app.framework,
    hostname: app.hostname,
    createdAt: app.createdAt,
    updatedAt: app.updatedAt,
    lastDeployedAt: app.lastDeployedAt,
    buildDuration: app.buildDuration,
    error: app.error,
    gitSource: app.gitSource,
    userId: app.userId,
    ownerName: isAdmin ? resolveUsername(app.userId) : undefined,
    customDomain: app.customDomain,
  };
}

/** Get effective app limit for a user (per-user override > global default) */
function getAppLimit(userId?: string): number {
  const globalMax = parseInt(process.env.DROP_MAX_APPS_PER_USER || '5', 10);
  if (!userId) return globalMax;
  try {
    const user = getUserById(userId) as any;
    if (user?.maxApps && user.maxApps > 0) return user.maxApps;
  } catch {}
  return globalMax;
}

/** Check if the current user can access an app (owns it or is admin) */
function canAccess(auth: AuthContext | undefined, app: AppState): boolean {
  if (!auth) return true; // No auth enabled
  if (auth.role === 'admin') return true;
  return app.userId === auth.userId;
}

// GET /apps - List applications (filtered by user unless admin)
apps.get('/', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const stateManager = getStateManager();
  const allApps = stateManager.getAllApps();

  // Filter by ownership
  let filtered = allApps.filter((app) => canAccess(auth, app));

  // Apply query param filters
  const status = c.req.query('status');
  const type = c.req.query('type');

  if (status) {
    filtered = filtered.filter((app) => app.status === status);
  }

  if (type) {
    filtered = filtered.filter((app) => app.type === type);
  }

  return c.json(
    success(filtered.map((a) => toAppDto(a, auth?.role === 'admin')), {
      total: filtered.length,
    })
  );
});

// GET /apps/:name - Get application by name
apps.get('/:name', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  // Get additional process info
  const pm = getProcessManager();
  try {
    const status = await pm.getStatus(name);
    if (status) {
      const isAdmin = auth?.role === 'admin';
      return c.json(
        success({
          ...toAppDto(app, isAdmin),
          pid: isAdmin ? (status.pid ?? app.pid) : undefined,
          memory: isAdmin ? status.memory : undefined,
          cpu: isAdmin ? status.cpu : undefined,
          restarts: status.restarts,
        })
      );
    }
  } catch {
    // Process info not available
  }

  return c.json(success(toAppDto(app, auth?.role === 'admin')));
});

// POST /apps - Deploy a new application
apps.post('/', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
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

  // Check per-user app limit
  if (auth?.userId && auth.role !== 'admin') {
    const maxApps = getAppLimit(auth.userId);
    if (maxApps > 0) {
      const userApps = stateManager.getAllApps().filter((a) => a.userId === auth.userId);
      if (userApps.length >= maxApps) {
        return c.json(error(ErrorCodes.RATE_LIMITED, `App limit reached (${maxApps}). Delete an app or contact admin.`), 429);
      }
    }
  }

  // Register the app (it will be detected and built by the platform)
  const app = await stateManager.registerApp(appName, body.path);

  // Set owner
  if (auth?.userId) {
    await stateManager.updateApp(appName, { userId: auth.userId });
  }

  try { await getActivityLog().log({ action: 'deploy', userId: auth?.userId, username: auth?.username, appName }); } catch {}
  return c.json(success(toAppDto({ ...app, userId: auth?.userId }, auth?.role === 'admin')), 201);
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

  const authCtx = (c.get as Function)('auth') as AuthContext | undefined;
  return c.json(success(toAppDto(updated, authCtx?.role === 'admin')));
});

// DELETE /apps/:name - Remove application
apps.delete('/:name', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
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

  // Remove app config (e.g. appconf/webapps/ezsign.yaml)
  try {
    const configService = getAppConfigService();
    await configService.deleteConfig(name);
  } catch {
    // Config may not exist
  }

  // Delete the app folder from the filesystem so the watcher doesn't re-detect it
  if (app.path) {
    try {
      await fs.rm(app.path, { recursive: true, force: true });
    } catch {
      // Folder may already be gone
    }
  }

  try { await getActivityLog().log({ action: 'delete', userId: auth?.userId, username: auth?.username, appName: name }); } catch {}
  return c.json(success({ message: `Application '${name}' removed` }));
});

// POST /apps/:name/start - Start application
apps.post('/:name/start', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
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

    try { await getActivityLog().log({ action: 'start', userId: auth?.userId, username: auth?.username, appName: name }); } catch {}
    return c.json(success({ message: `Application '${name}' started`, status }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to start';
    await stateManager.setAppStatus(name, 'errored', { error: message });
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }
});

// POST /apps/:name/stop - Stop application
apps.post('/:name/stop', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const pm = getProcessManager();

  try {
    await pm.stop(name);
    await stateManager.setAppStatus(name, 'stopped');

    try { await getActivityLog().log({ action: 'stop', userId: auth?.userId, username: auth?.username, appName: name }); } catch {}
    return c.json(success({ message: `Application '${name}' stopped` }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to stop';
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }
});

// POST /apps/:name/restart - Restart application
apps.post('/:name/restart', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const pm = getProcessManager();

  try {
    const status = await pm.restart(name);
    await stateManager.setAppStatus(name, 'running', {
      pid: status.pid ?? undefined,
    });

    try { await getActivityLog().log({ action: 'restart', userId: auth?.userId, username: auth?.username, appName: name }); } catch {}
    return c.json(success({ message: `Application '${name}' restarted`, status }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to restart';
    await stateManager.setAppStatus(name, 'errored', { error: message });
    return c.json(error(ErrorCodes.INTERNAL_ERROR, message), 500);
  }
});

// PUT /apps/:name/domain - Set custom domain
apps.put('/:name/domain', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const body = await c.req.json<{ domain?: string }>();
  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  const domain = body.domain?.trim() || undefined;

  // Basic domain validation
  if (domain && !/^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
    throw new ValidationError('Invalid domain format');
  }

  await stateManager.updateApp(name, { customDomain: domain || ('' as unknown as undefined) });

  return c.json(success({ message: domain ? `Domain set to ${domain}` : 'Domain removed', domain }));
});

// GET /apps/:name/usage - Get user app count and limit
apps.get('/:name/usage', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  if (!auth?.userId) return c.json(success({ used: 0, limit: 0 }));

  const stateManager = getStateManager();
  const used = stateManager.getAllApps().filter((a) => a.userId === auth.userId).length;

  return c.json(success({ used, limit: auth.role === 'admin' ? 0 : getAppLimit(auth.userId) }));
});

export default apps;
