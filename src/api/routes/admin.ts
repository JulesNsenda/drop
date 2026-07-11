/**
 * Admin Routes
 *
 * Admin-only endpoints for platform management.
 */

import { Hono } from 'hono';
import { success, error, ErrorCodes } from '../types';
import { getActivityLog } from '../../managers/activity';
import { suspendUser, updateUser, listUsers, AuthContext } from '../middleware/auth';
import { getStateManager } from '../../managers/app/state-manager';
import { getAppRuntime } from '../../managers/runtime';
import { tryLogActivity } from '../../managers/activity';
import { getDiskFreeMb } from '../../utils/disk';
import { getSettingsManager } from '../../managers/settings/settings-manager';
import { normalizePublicUrl } from '../../utils/url-validator';
import { getPublicUrl, setPublicUrl } from '../runtime-config';

const admin = new Hono();

type SettingsSource = 'stored' | 'env' | 'unset';

/** Shared payload shape for GET /settings and the "cleared" branch of PUT /settings/public-url. */
function buildSettingsPayload(): { publicUrl: string | null; source: SettingsSource; storedPublicUrl: string | null } {
  const storedPublicUrl = getSettingsManager().getStoredPublicUrl() ?? null;
  const source: SettingsSource = storedPublicUrl ? 'stored' : process.env.DROP_PUBLIC_URL ? 'env' : 'unset';
  return {
    publicUrl: getPublicUrl() ?? null,
    source,
    storedPublicUrl,
  };
}

// GET /admin/activity - Activity log (paginated)
admin.get('/activity', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  const log = getActivityLog();
  const { entries, total } = log.getEntries(limit, offset);

  return c.json(success(entries, { total, limit, offset }));
});

// POST /admin/users/:id/suspend - Suspend a user account
// Disables login and stops all their running apps.
admin.post('/users/:id/suspend', async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext | undefined;
  const userId = c.req.param('id');

  try {
    const suspended = await suspendUser(userId);
    if (!suspended) {
      return c.json(error(ErrorCodes.NOT_FOUND, 'User not found'), 404);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Suspend failed';
    return c.json(error(ErrorCodes.BAD_REQUEST, msg), 400);
  }

  // Stop all running apps owned by this user
  const stateManager = getStateManager();
  const runtime = getAppRuntime();
  const userApps = stateManager.getAllApps().filter((a) => a.userId === userId);
  const stopErrors: string[] = [];
  for (const app of userApps) {
    try {
      await runtime.stop(app.name);
      await stateManager.setAppStatus(app.name, 'stopped');
    } catch (err) {
      stopErrors.push(`${app.name}: ${err instanceof Error ? err.message : 'stop failed'}`);
    }
  }

  await tryLogActivity({
    action: 'suspend',
    userId: authCtx?.userId,
    username: authCtx?.username,
    detail: `Suspended user ${userId}; stopped ${userApps.length} app(s)`,
  });

  return c.json(
    success({
      suspended: true,
      appsStoppedCount: userApps.length - stopErrors.length,
      stopErrors: stopErrors.length > 0 ? stopErrors : undefined,
    })
  );
});

// POST /admin/users/:id/unsuspend - Re-enable a suspended user account
admin.post('/users/:id/unsuspend', async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext | undefined;
  const userId = c.req.param('id');

  const updated = await updateUser(userId, { enabled: true });
  if (!updated) {
    return c.json(error(ErrorCodes.NOT_FOUND, 'User not found'), 404);
  }

  await tryLogActivity({
    action: 'unsuspend',
    userId: authCtx?.userId,
    username: authCtx?.username,
    detail: `Unsuspended user ${userId}`,
  });

  return c.json(success({ suspended: false }));
});

// GET /admin/quota - Platform-wide quota / resource summary (df-style)
admin.get('/quota', async (c) => {
  const stateManager = getStateManager();
  const allApps = stateManager.getAllApps();
  const users = listUsers();

  const appsDir = process.env.DROP_APPS_DIR || '';
  const freeDiskMb = appsDir ? await getDiskFreeMb(appsDir).catch(() => null) : null;

  const byUser = users.map((u) => {
    const uApps = allApps.filter((a) => a.userId === u.id);
    return {
      userId: u.id,
      username: u.username,
      enabled: (u as any).enabled !== false,
      appCount: uApps.length,
      runningCount: uApps.filter((a) => a.status === 'running').length,
    };
  });

  const buildingApps = allApps.filter((a) => a.status === 'building');

  return c.json(
    success({
      apps: {
        total: allApps.length,
        running: allApps.filter((a) => a.status === 'running').length,
        building: buildingApps.length,
        buildingApps: buildingApps.map((a) => a.name),
        errored: allApps.filter((a) => a.status === 'errored').length,
      },
      disk: freeDiskMb !== null ? { freeMb: Math.round(freeDiskMb) } : null,
      byUser,
    })
  );
});

// POST /admin/apps/:name/suspend - Stop an app and mark it suspended
admin.post('/apps/:name/suspend', async (c) => {
  const authCtx = (c.get as Function)('auth') as AuthContext | undefined;
  const appName = c.req.param('name');
  const stateManager = getStateManager();
  const app = stateManager.getApp(appName);

  if (!app) {
    return c.json(error(ErrorCodes.NOT_FOUND, `Application '${appName}' not found`), 404);
  }

  const runtime = getAppRuntime();
  try {
    await runtime.stop(appName);
  } catch {
    // Best-effort — app may already be stopped
  }
  await stateManager.setAppStatus(appName, 'stopped', { error: 'Suspended by admin' });

  await tryLogActivity({
    action: 'suspend',
    userId: authCtx?.userId,
    username: authCtx?.username,
    appName,
    detail: 'App suspended by admin',
  });

  return c.json(success({ appName, suspended: true }));
});

// GET /admin/settings - Platform settings (currently: the public base
// URL / OAuth issuer override — PRD-041).
admin.get('/settings', async (c) => {
  return c.json(success(buildSettingsPayload()));
});

// PUT /admin/settings/public-url - Set or clear the admin override for
// DROP_PUBLIC_URL (the OAuth issuer/resource base). Security-adjacent:
// validated HTTPS-only (except localhost) via normalizePublicUrl, and a
// bad/empty value fails CLOSED — it never derives an issuer from the Host
// header. Updates both the persisted store and the live runtime config so
// the change takes effect immediately, without a restart.
admin.put('/settings/public-url', async (c) => {
  const body = (await c.req.json()) as { publicUrl?: unknown };
  const input = body.publicUrl;

  if (input === null || input === undefined || input === '') {
    await getSettingsManager().setPublicUrl(undefined);
    setPublicUrl(undefined);
    return c.json(success(buildSettingsPayload()));
  }

  if (typeof input !== 'string') {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'publicUrl must be a string or null'), 400);
  }

  const result = normalizePublicUrl(input);
  if (!result.ok) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, result.reason), 400);
  }

  await getSettingsManager().setPublicUrl(result.value);
  setPublicUrl(result.value);

  return c.json(success({ publicUrl: result.value, source: 'stored' as const, storedPublicUrl: result.value }));
});

export default admin;
