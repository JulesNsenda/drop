/**
 * Usage Route
 *
 * Reports the current user's app count against their limit, for the dashboard
 * app-limit indicator (PRD-027).
 */

import { Hono } from 'hono';
import { success } from '../types';
import { AuthContext, getUserById } from '../middleware/auth';
import { getStateManager } from '../../managers/app/state-manager';

const usage = new Hono();

/** Effective limit for a user: per-user override > global default. 0 = unlimited. */
function getAppLimit(userId?: string): number {
  const globalMax = parseInt(process.env.DROP_MAX_APPS_PER_USER || '5', 10);
  if (!userId) return globalMax;
  try {
    const user = getUserById(userId) as { maxApps?: number } | undefined;
    if (user?.maxApps && user.maxApps > 0) return user.maxApps;
  } catch {
    // Fall back to the global limit
  }
  return globalMax;
}

// GET /usage - current user's app count and limit
usage.get('/', (c) => {
  const auth = (c.get as (k: string) => AuthContext | undefined)('auth');

  // No auth (single-user mode) or admin: unlimited.
  if (!auth?.userId || auth.role === 'admin') {
    return c.json(success({ used: 0, limit: 0 }));
  }

  const used = getStateManager()
    .getAllApps()
    .filter((a) => a.userId === auth.userId).length;

  return c.json(success({ used, limit: getAppLimit(auth.userId) }));
});

export default usage;
