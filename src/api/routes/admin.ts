/**
 * Admin Routes
 *
 * Admin-only endpoints for platform management.
 */

import { Hono } from 'hono';
import { success } from '../types';
import { getActivityLog } from '../../managers/activity';

const admin = new Hono();

// GET /admin/activity - Activity log (paginated)
admin.get('/activity', async (c) => {
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const offset = parseInt(c.req.query('offset') || '0', 10);

  const log = getActivityLog();
  const { entries, total } = log.getEntries(limit, offset);

  return c.json(success(entries, { total, limit, offset }));
});

export default admin;
