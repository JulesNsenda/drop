/**
 * Apps Routes
 *
 * CRUD and management endpoints for applications.
 */

import { Hono } from 'hono';
import * as path from 'path';
import * as fs from 'fs/promises';
import { success, error, ErrorCodes, AppDto, CreateAppDto } from '../types';
import { NotFoundError, ValidationError } from '../middleware/error';
import { AuthContext, listUsers, getUserById } from '../middleware/auth';
import { canAccess } from '../access';
import { getAppRuntime } from '../../managers/runtime';
import { getStateManager, AppState } from '../../managers/app/state-manager';
import { getAppConfigService } from '../../managers/app/app-config';
import { tryLogActivity } from '../../managers/activity';
import { getAppsDirectory } from '../runtime-config';
import { isPathWithin } from '../../utils/paths';

const apps = new Hono();

/**
 * Fields a client may set via PUT /apps/:name. Deliberately excludes
 * userId (ownership takeover), path (escape the webapps dir), and
 * port/status/pid/name/type (platform-managed invariants). Status changes
 * go through the start/stop/restart endpoints; domains through /domain.
 */
const UPDATABLE_APP_FIELDS = ['framework', 'customDomain'] as const;

function pickUpdatableFields(body: Record<string, unknown>): Partial<AppState> {
  const updates: Partial<AppState> = {};
  for (const field of UPDATABLE_APP_FIELDS) {
    if (body[field] !== undefined) {
      (updates as Record<string, unknown>)[field] = body[field];
    }
  }
  return updates;
}

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
  } catch {
    // User lookup failed — fall back to the global limit
  }
  return globalMax;
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
  const pm = getAppRuntime();
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

  // Validate path exists and is a directory
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

  // Containment: the deploy path must live inside the webapps directory.
  // Admins (e.g. local CLI) are exempt — they are trusted to register paths
  // from anywhere on the host (e.g. `drop deploy ./my-app`).
  const isAdmin = auth?.role === 'admin';
  if (!isAdmin && !(await isPathWithin(getAppsDirectory(), body.path))) {
    throw new ValidationError('Path must be inside the webapps directory');
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

  await tryLogActivity({ action: 'deploy', userId: auth?.userId, username: auth?.username, appName });
  return c.json(success(toAppDto({ ...app, userId: auth?.userId }, auth?.role === 'admin')), 201);
});

// PUT /apps/:name - Update application
apps.put('/:name', async (c) => {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name');
  const body = (await c.req.json()) as Record<string, unknown>;

  const stateManager = getStateManager();
  const app = stateManager.getApp(name);

  if (!app || !canAccess(auth, app)) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  // Only allow a strict set of user-editable fields; ignore everything else
  // (userId, path, port, status, pid, ...) to prevent ownership takeover
  // and escape of platform-managed invariants.
  const updates = pickUpdatableFields(body);

  const updated = await stateManager.updateApp(name, updates);
  if (!updated) {
    throw new NotFoundError(`Application '${name}' not found`);
  }

  return c.json(success(toAppDto(updated, auth?.role === 'admin')));
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
  const pm = getAppRuntime();
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

  await tryLogActivity({ action: 'delete', userId: auth?.userId, username: auth?.username, appName: name });
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

  const pm = getAppRuntime();

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

    await tryLogActivity({ action: 'start', userId: auth?.userId, username: auth?.username, appName: name });
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

  const pm = getAppRuntime();

  try {
    await pm.stop(name);
    await stateManager.setAppStatus(name, 'stopped');

    await tryLogActivity({ action: 'stop', userId: auth?.userId, username: auth?.username, appName: name });
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

  const pm = getAppRuntime();

  try {
    const status = await pm.restart(name);
    await stateManager.setAppStatus(name, 'running', {
      pid: status.pid ?? undefined,
    });

    await tryLogActivity({ action: 'restart', userId: auth?.userId, username: auth?.username, appName: name });
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

export default apps;
