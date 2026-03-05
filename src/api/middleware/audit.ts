/**
 * Audit Logging Middleware
 *
 * Logs security-relevant API operations for compliance and debugging.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Context, Next } from 'hono';
import { AuthContext } from './auth';
import { sanitizeForLog } from './validate';

export interface AuditLogEntry {
  timestamp: string;
  action: string;
  method: string;
  path: string;
  ip: string;
  userId?: string;
  username?: string;
  role?: string;
  authMethod?: string;
  statusCode: number;
  duration: number;
}

let auditStream: fs.WriteStream | null = null;

/**
 * Initialize audit logging
 */
export function initializeAuditLog(logDir: string): void {
  const auditDir = path.join(logDir, 'audit');
  fs.mkdirSync(auditDir, { recursive: true });

  const logFile = path.join(auditDir, `audit-${getDateString()}.log`);
  auditStream = fs.createWriteStream(logFile, { flags: 'a' });
}

function getDateString(): string {
  return new Date().toISOString().split('T')[0];
}

function getClientIp(c: Context): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    'unknown'
  );
}

/**
 * Write an audit log entry
 */
function writeAuditEntry(entry: AuditLogEntry): void {
  if (!auditStream) return;

  const line = JSON.stringify(entry);
  auditStream.write(line + '\n');
}

/** Methods and path patterns that should be audited */
const AUDIT_PATTERNS: Array<{ method: string; pathPattern: RegExp; action: string }> = [
  { method: 'POST', pathPattern: /\/auth\/login/, action: 'auth.login' },
  { method: 'POST', pathPattern: /\/auth\/api-keys/, action: 'auth.create_api_key' },
  { method: 'DELETE', pathPattern: /\/auth\/api-keys/, action: 'auth.delete_api_key' },
  { method: 'POST', pathPattern: /\/auth\/users/, action: 'auth.create_user' },
  { method: 'POST', pathPattern: /\/apps\/.*\/start/, action: 'app.start' },
  { method: 'POST', pathPattern: /\/apps\/.*\/stop/, action: 'app.stop' },
  { method: 'POST', pathPattern: /\/apps\/.*\/restart/, action: 'app.restart' },
  { method: 'DELETE', pathPattern: /\/apps\//, action: 'app.delete' },
  { method: 'POST', pathPattern: /\/apps\/.*\/deploy/, action: 'app.deploy' },
  { method: 'PUT', pathPattern: /\/apps\/.*\/secrets/, action: 'secret.set' },
  { method: 'DELETE', pathPattern: /\/apps\/.*\/secrets/, action: 'secret.delete' },
];

function matchAction(method: string, reqPath: string): string | null {
  for (const pattern of AUDIT_PATTERNS) {
    if (pattern.method === method && pattern.pathPattern.test(reqPath)) {
      return pattern.action;
    }
  }
  return null;
}

/**
 * Audit logging middleware
 * Only logs security-relevant operations (auth, app lifecycle, secrets)
 */
export function auditMiddleware() {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const method = c.req.method;
    const reqPath = c.req.path;
    const action = matchAction(method, reqPath);

    // Only audit matching operations
    if (!action) {
      return next();
    }

    const start = Date.now();

    await next();

    const authContext = c.get('auth') as AuthContext | undefined;
    const duration = Date.now() - start;

    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      action,
      method,
      path: sanitizeForLog(reqPath),
      ip: getClientIp(c),
      userId: authContext?.userId,
      username: authContext?.username,
      role: authContext?.role,
      authMethod: authContext?.authMethod,
      statusCode: c.res.status,
      duration,
    };

    writeAuditEntry(entry);
  };
}

/**
 * Close audit log stream
 */
export function closeAuditLog(): void {
  if (auditStream) {
    auditStream.end();
    auditStream = null;
  }
}
