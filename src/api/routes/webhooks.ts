/**
 * Webhook Routes
 *
 * API endpoints for managing webhook registrations.
 */

import { Hono } from 'hono';
import { success, error, ErrorCodes } from '../types';
import { getWebhookManager, WebhookEvent } from '../../core/webhooks';
import { ValidationError } from '../middleware/error';

const VALID_EVENTS: WebhookEvent[] = [
  'app:created', 'app:started', 'app:stopped', 'app:errored', 'app:removed',
  'build:started', 'build:completed', 'build:failed',
];

const webhooks = new Hono();

// GET /webhooks - List all webhooks
webhooks.get('/', (c) => {
  try {
    const wm = getWebhookManager();
    const hooks = wm.getAll().map(({ secret: _, ...wh }) => ({
      ...wh,
      hasSecret: !!_,
    }));
    return c.json(success(hooks));
  } catch {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'Webhook manager not available'), 500);
  }
});

// GET /webhooks/:id - Get a webhook
webhooks.get('/:id', (c) => {
  const id = c.req.param('id');
  try {
    const wm = getWebhookManager();
    const wh = wm.get(id);
    if (!wh) {
      return c.json(error(ErrorCodes.NOT_FOUND, 'Webhook not found'), 404);
    }
    const { secret: _, ...safe } = wh;
    return c.json(success({ ...safe, hasSecret: !!_ }));
  } catch {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'Webhook manager not available'), 500);
  }
});

// POST /webhooks - Register a webhook
webhooks.post('/', async (c) => {
  const body = await c.req.json<{
    name: string;
    url: string;
    events: WebhookEvent[];
    secret?: string;
    active?: boolean;
  }>();

  if (!body.name || typeof body.name !== 'string') {
    throw new ValidationError('name is required');
  }

  if (!body.url || typeof body.url !== 'string') {
    throw new ValidationError('url is required');
  }

  try {
    new URL(body.url);
  } catch {
    throw new ValidationError('url must be a valid URL');
  }

  if (!Array.isArray(body.events) || body.events.length === 0) {
    throw new ValidationError('events must be a non-empty array');
  }

  for (const event of body.events) {
    if (!VALID_EVENTS.includes(event)) {
      throw new ValidationError(`Invalid event: ${event}. Valid events: ${VALID_EVENTS.join(', ')}`);
    }
  }

  try {
    const wm = getWebhookManager();
    const wh = await wm.register({
      name: body.name,
      url: body.url,
      events: body.events,
      secret: body.secret,
      active: body.active ?? true,
    });

    const { secret: _, ...safe } = wh;
    return c.json(success({ ...safe, hasSecret: !!_ }), 201);
  } catch {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'Failed to register webhook'), 500);
  }
});

// PUT /webhooks/:id - Update a webhook
webhooks.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Partial<{
    name: string;
    url: string;
    events: WebhookEvent[];
    secret: string;
    active: boolean;
  }>>();

  if (body.url) {
    try {
      new URL(body.url);
    } catch {
      throw new ValidationError('url must be a valid URL');
    }
  }

  if (body.events) {
    for (const event of body.events) {
      if (!VALID_EVENTS.includes(event)) {
        throw new ValidationError(`Invalid event: ${event}`);
      }
    }
  }

  try {
    const wm = getWebhookManager();
    const wh = await wm.update(id, body);
    if (!wh) {
      return c.json(error(ErrorCodes.NOT_FOUND, 'Webhook not found'), 404);
    }
    const { secret: _, ...safe } = wh;
    return c.json(success({ ...safe, hasSecret: !!_ }));
  } catch {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'Failed to update webhook'), 500);
  }
});

// DELETE /webhooks/:id - Remove a webhook
webhooks.delete('/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const wm = getWebhookManager();
    const deleted = await wm.remove(id);
    if (!deleted) {
      return c.json(error(ErrorCodes.NOT_FOUND, 'Webhook not found'), 404);
    }
    return c.json(success({ message: 'Webhook deleted' }));
  } catch {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'Failed to delete webhook'), 500);
  }
});

// GET /webhooks/:id/deliveries - Get delivery history
webhooks.get('/:id/deliveries', (c) => {
  const id = c.req.param('id');
  const limitParam = c.req.query('limit');
  const limit = limitParam ? parseInt(limitParam, 10) : 20;

  try {
    const wm = getWebhookManager();
    if (!wm.get(id)) {
      return c.json(error(ErrorCodes.NOT_FOUND, 'Webhook not found'), 404);
    }
    const deliveries = wm.getDeliveries(id, limit);
    return c.json(success(deliveries));
  } catch {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'Webhook manager not available'), 500);
  }
});

export default webhooks;
