/**
 * Secrets Routes
 *
 * API endpoints for managing encrypted app secrets/environment variables.
 */

import { Hono } from 'hono';
import { success, error, ErrorCodes } from '../types';
import { getSecretManager } from '../../managers/secret';
import { ValidationError } from '../middleware/error';
import { isValidAppName } from '../middleware/validate';

const secrets = new Hono();

// GET /secrets/:name - List secret keys for an app
secrets.get('/:name', (c) => {
  const name = c.req.param('name');

  if (!isValidAppName(name)) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Invalid app name'), 400);
  }

  try {
    const sm = getSecretManager();
    const keys = sm.list(name);
    return c.json(success({ appName: name, keys }));
  } catch {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'Secret manager not available'), 500);
  }
});

// PUT /secrets/:name - Set a secret for an app
secrets.put('/:name', async (c) => {
  const name = c.req.param('name');

  if (!isValidAppName(name)) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Invalid app name'), 400);
  }

  const body = await c.req.json<{ key: string; value: string }>();

  if (!body.key || typeof body.key !== 'string') {
    throw new ValidationError('Secret key is required');
  }

  if (body.value === undefined || body.value === null) {
    throw new ValidationError('Secret value is required');
  }

  // Validate key format: uppercase alphanumeric with underscores
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(body.key)) {
    throw new ValidationError(
      'Secret key must be uppercase alphanumeric with underscores (e.g., DATABASE_URL)'
    );
  }

  try {
    const sm = getSecretManager();
    await sm.set(name, body.key, String(body.value));
    return c.json(success({ appName: name, key: body.key, message: 'Secret set' }));
  } catch {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'Failed to set secret'), 500);
  }
});

// DELETE /secrets/:name/:key - Delete a specific secret
secrets.delete('/:name/:key', async (c) => {
  const name = c.req.param('name');
  const key = c.req.param('key');

  if (!isValidAppName(name)) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Invalid app name'), 400);
  }

  try {
    const sm = getSecretManager();
    const deleted = await sm.delete(name, key);

    if (!deleted) {
      return c.json(error(ErrorCodes.NOT_FOUND, `Secret '${key}' not found for app '${name}'`), 404);
    }

    return c.json(success({ appName: name, key, message: 'Secret deleted' }));
  } catch {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'Failed to delete secret'), 500);
  }
});

// DELETE /secrets/:name - Delete all secrets for an app
secrets.delete('/:name', async (c) => {
  const name = c.req.param('name');

  if (!isValidAppName(name)) {
    return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Invalid app name'), 400);
  }

  try {
    const sm = getSecretManager();
    await sm.deleteAll(name);
    return c.json(success({ appName: name, message: 'All secrets deleted' }));
  } catch {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'Failed to delete secrets'), 500);
  }
});

export default secrets;
