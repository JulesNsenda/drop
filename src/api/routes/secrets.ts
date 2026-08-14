/**
 * Secrets Routes
 *
 * API endpoints for managing encrypted app secrets/environment variables.
 */

import { Hono, type Context } from 'hono';
import { success, error, ErrorCodes } from '../types';
import { getSecretManager } from '../../managers/secret';
import { NotFoundError, ValidationError } from '../middleware/error';
import { isValidAppName } from '../middleware/validate';
import { canAccess } from '../access';
import { getStateManager } from '../../managers/app/state-manager';
import { getDatabaseProvisioner } from '../../managers/database';
import type { AuthContext } from '../middleware/auth';

// Keys that platform controls and must never be overridden by user secrets.
// DATABASE_URL is deliberately NOT here: an app with no DROP-provisioned
// database is free to hold its own (Supabase/Neon/RDS/external MySQL) as an
// encrypted secret — see the contextual check in the PUT handler below. The
// defence against a tenant hijacking an injected DATABASE_URL is precedence
// (`dbEnvVars` spread last in platform.ts's start env), not this set.
const RESERVED_KEYS = new Set([
  'PORT', 'DROP_DATA_DIR', 'NODE_ENV',
  'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE',
]);

const MAX_SECRET_VALUE_BYTES = 64 * 1024; // 64 KiB

const secrets = new Hono();

function resolveApp(c: Context) {
  const auth = (c.get as Function)('auth') as AuthContext | undefined;
  const name = c.req.param('name') as string;
  if (!isValidAppName(name)) return { validationError: true as const, name, app: null, auth };
  const app = getStateManager().getApp(name);
  if (!app || !canAccess(auth, app)) return { notFound: true as const, name, app: null, auth };
  return { name, app, auth };
}

// GET /secrets/:name - List secret keys for an app
secrets.get('/:name', (c) => {
  const r = resolveApp(c);
  if (r.validationError) return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Invalid app name'), 400);
  if (r.notFound) throw new NotFoundError(`Application '${r.name}' not found`);

  try {
    const keys = getSecretManager().list(r.name);
    return c.json(success({ appName: r.name, keys }));
  } catch {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'Secret manager not available'), 500);
  }
});

// PUT /secrets/:name - Set a secret for an app
secrets.put('/:name', async (c) => {
  const r = resolveApp(c);
  if (r.validationError) return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Invalid app name'), 400);
  if (r.notFound) throw new NotFoundError(`Application '${r.name}' not found`);

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
      'Secret key must be uppercase alphanumeric with underscores (e.g., MY_SECRET)'
    );
  }

  // Deny reserved platform keys
  if (RESERVED_KEYS.has(body.key.toUpperCase())) {
    throw new ValidationError(`'${body.key}' is a reserved platform key and cannot be stored as a secret`);
  }

  // DATABASE_URL is refused CONTEXTUALLY, not unconditionally: an app that
  // already has a DROP-provisioned database still cannot be repointed by a
  // secret (dbEnvVars is spread last and would override it either way), so
  // storing one here would be silently ineffective. There is no way to
  // deprovision a database without deleting the whole app, so the message
  // must not suggest that as a next step. Fails OPEN if the provisioner is
  // unavailable (e.g. auth-disabled/test paths where the DB layer never
  // booted) — the precedence still protects a provisioned app either way.
  if (body.key.toUpperCase() === 'DATABASE_URL' && getDatabaseProvisioner()?.isProvisioned(r.name)) {
    throw new ValidationError(
      `'${r.name}' already has a DROP-managed database; its DATABASE_URL is platform-owned and would override this secret`
    );
  }

  // Cap value size
  if (Buffer.byteLength(String(body.value), 'utf8') > MAX_SECRET_VALUE_BYTES) {
    throw new ValidationError('Secret value exceeds the 64 KiB limit');
  }

  try {
    await getSecretManager().set(r.name, body.key, String(body.value));
    return c.json(success({ appName: r.name, key: body.key, message: 'Secret set' }));
  } catch {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'Failed to set secret'), 500);
  }
});

// DELETE /secrets/:name/:key - Delete a specific secret
secrets.delete('/:name/:key', async (c) => {
  const r = resolveApp(c);
  if (r.validationError) return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Invalid app name'), 400);
  if (r.notFound) throw new NotFoundError(`Application '${r.name}' not found`);

  const key = c.req.param('key');

  try {
    const deleted = await getSecretManager().delete(r.name, key);

    if (!deleted) {
      return c.json(error(ErrorCodes.NOT_FOUND, `Secret '${key}' not found for app '${r.name}'`), 404);
    }

    return c.json(success({ appName: r.name, key, message: 'Secret deleted' }));
  } catch {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'Failed to delete secret'), 500);
  }
});

// DELETE /secrets/:name - Delete all secrets for an app
secrets.delete('/:name', async (c) => {
  const r = resolveApp(c);
  if (r.validationError) return c.json(error(ErrorCodes.VALIDATION_ERROR, 'Invalid app name'), 400);
  if (r.notFound) throw new NotFoundError(`Application '${r.name}' not found`);

  try {
    await getSecretManager().deleteAll(r.name);
    return c.json(success({ appName: r.name, message: 'All secrets deleted' }));
  } catch {
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'Failed to delete secrets'), 500);
  }
});

export default secrets;
