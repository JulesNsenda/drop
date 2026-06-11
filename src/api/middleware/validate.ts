/**
 * Input Validation Middleware
 *
 * Sanitization and validation for API inputs.
 */

import { Context, Next } from 'hono';
import { error, ErrorCodes } from '../types';

/** Valid app name: alphanumeric, hyphens, underscores, 1-64 chars */
const APP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** Characters that could enable path traversal */
const PATH_TRAVERSAL_RE = /\.\.|[/\\]/;

/**
 * Validate and sanitize an app name parameter
 */
export function validateAppName() {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const name = c.req.param('name');
    if (!name) return next();

    if (PATH_TRAVERSAL_RE.test(name)) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, 'Invalid app name: path traversal detected'),
        400
      );
    }

    if (!APP_NAME_RE.test(name)) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          'Invalid app name: must be 1-64 alphanumeric characters, hyphens, or underscores'
        ),
        400
      );
    }

    return next();
  };
}

/**
 * Validate that a JSON body doesn't exceed a max size
 */
export function validateBodySize(maxBytes: number = 1_048_576) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const contentLength = c.req.header('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      return c.json(
        error(ErrorCodes.VALIDATION_ERROR, `Request body too large. Maximum: ${maxBytes} bytes`),
        413 as any
      );
    }
    return next();
  };
}

/**
 * Validate an app name string directly (for use outside middleware)
 */
export function isValidAppName(name: string): boolean {
  return APP_NAME_RE.test(name) && !PATH_TRAVERSAL_RE.test(name);
}

/**
 * Sanitize a string for safe logging (strip control characters)
 */
export function sanitizeForLog(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\x00-\x1f\x7f]/g, '').substring(0, 500);
}
