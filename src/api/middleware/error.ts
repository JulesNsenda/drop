/**
 * Error Handling Middleware
 *
 * Global error handler for the API.
 */

import { Context, Next } from 'hono';
import { error, ErrorCodes } from '../types';

export async function errorHandler(c: Context, next: Next): Promise<Response | void> {
  try {
    await next();
  } catch (err) {
    console.error('API Error:', err);

    // Handle custom HTTP errors — these messages are developer-authored and
    // safe to surface to the client.
    if (err instanceof HttpError) {
      return c.json(
        error(err.code, err.message),
        err.statusCode as 400 | 401 | 403 | 404 | 409 | 500
      );
    }

    // Unexpected errors may carry internal details (paths, table names, stack
    // info). Log the real error server-side; return a generic message.
    return c.json(error(ErrorCodes.INTERNAL_ERROR, 'An unexpected error occurred'), 500);
  }
}

// Custom HTTP error class
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string) {
    super(404, ErrorCodes.NOT_FOUND, message);
  }
}

export class ValidationError extends HttpError {
  constructor(message: string) {
    super(400, ErrorCodes.VALIDATION_ERROR, message);
  }
}

export class ConflictError extends HttpError {
  constructor(message: string) {
    super(409, ErrorCodes.CONFLICT, message);
  }
}

export class RateLimitedError extends HttpError {
  constructor(message: string) {
    super(429, ErrorCodes.RATE_LIMITED, message);
  }
}

/** Disk watermark reached — 507 Insufficient Storage (mirrors the pre-PRD-040 inline check in apps.ts). */
export class InsufficientDiskError extends HttpError {
  constructor(freeMb: number, requiredMb: number) {
    super(
      507,
      ErrorCodes.INTERNAL_ERROR,
      `Insufficient disk space (${Math.round(freeMb)} MB free, need ${requiredMb} MB)`
    );
  }
}
