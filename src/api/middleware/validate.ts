/**
 * Input Validation Middleware
 *
 * Sanitization and validation for API inputs.
 */

import { Context, Next } from 'hono';
import { error, ErrorCodes } from '../types';

/** Valid app name for CREATION: alphanumeric, hyphens, underscores, 1-64 chars (no dots). */
const APP_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * Valid app name for a :name ROUTE PARAM — deliberately looser than
 * APP_NAME_RE, because folder-drop persists a directory name almost verbatim
 * (path-parser only bars empty/`.`/`..`/leading-dot/known-dirs). It must not
 * 400 an existing app on its own management routes, so the first char allows
 * a leading `_`/`-` (e.g. `_worker`, `-cache`) and dots are allowed mid-name
 * (`my.app`). Leading `.` stays barred (not in the first-char class) and
 * `..`/path separators are still rejected by PATH_TRAVERSAL_RE below.
 *
 * It is INTENTIONALLY stricter than folder-drop in two safe ways: it rejects
 * spaces/other punctuation and caps length at 64. Those are pathological
 * directory names; bounding them on a URL param is defense-in-depth, not a
 * regression of any realistic app.
 */
const APP_NAME_PARAM_RE = /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,63}$/;

/** Characters that could enable path traversal */
const PATH_TRAVERSAL_RE = /\.\.|[/\\]/;

/**
 * Validate a :name route param (defense-in-depth on the management routes).
 * Rejects a malformed name before it can reach any downstream path/SQL
 * construction, without regressing legitimately-dotted folder-drop apps.
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

    if (!APP_NAME_PARAM_RE.test(name)) {
      return c.json(
        error(
          ErrorCodes.VALIDATION_ERROR,
          'Invalid app name: must be 1-64 characters of letters, digits, dot, hyphen, or underscore, starting with a letter or digit'
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
