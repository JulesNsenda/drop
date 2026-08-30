/**
 * Audit Logging Middleware
 *
 * Logs security-relevant API operations for compliance and debugging.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Context, Next } from 'hono';
import { AuthContext } from './auth';
import { getClientIp } from './rate-limit';
import { sanitizeForLog } from './validate';

export interface AuditLogEntry {
  timestamp: string;
  action: string;
  method: string;
  path: string;
  ip: string;
  userId?: string;
  username?: string;
  /** WHICH credential acted — see ActivityEntry.principalId for the rationale; this is the second forensic surface that needs it. */
  principalId?: string;
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

  // Secrets. These two patterns read `/apps/<name>/secrets` until DROP-160 —
  // a path this API has never served. `secretsRoutes` is mounted at
  // `v1.route('/secrets', …)` (`server.ts`), so every request is
  // `/api/v1/secrets/<app>`, nothing is mounted under `/apps/*/secrets`, and
  // the two patterns had therefore never matched a single request. The
  // DROP-130 residual recorded this as "secrets.ts emits no audit rows"; the
  // mechanism is that the patterns pointed at the wrong URL shape, which is
  // invisible in a test that exercises the pattern rather than the mount.
  //
  // The per-key delete must precede the whole-app one: `matchAction` returns
  // the FIRST match, and `/secrets/<app>` is a prefix of `/secrets/<app>/<key>`
  // under a non-anchored pattern. Both are anchored with `$` anyway, so the
  // ordering is belt-and-braces rather than load-bearing — but the next
  // pattern added here will not necessarily be anchored.
  { method: 'PUT', pathPattern: /\/secrets\/[^/]+$/, action: 'secret.set' },
  { method: 'DELETE', pathPattern: /\/secrets\/[^/]+\/[^/]+$/, action: 'secret.delete' },
  { method: 'DELETE', pathPattern: /\/secrets\/[^/]+$/, action: 'secret.delete_all' },

  // Webhooks: a webhook is a deploy trigger with a shared secret, so creating
  // or repointing one is a durable grant of deploy capability to whoever holds
  // the URL. DROP-130 named this surface alongside secrets.
  { method: 'POST', pathPattern: /\/webhooks\/?$/, action: 'webhook.create' },
  { method: 'PUT', pathPattern: /\/webhooks\/[^/]+$/, action: 'webhook.update' },
  { method: 'DELETE', pathPattern: /\/webhooks\/[^/]+$/, action: 'webhook.delete' },

  // Certificates: the one mutating route on the surface. A renew reaches an
  // external ACME provider and can be rate-limited by it, so "which credential
  // triggered this" is the question asked after an unexplained issuance stall.
  { method: 'POST', pathPattern: /\/certs\/renew$/, action: 'cert.renew' },

  // The database panel's reads (DROP-120). `db.ts` is GET-only, so unlike the
  // surfaces above there is nothing to audit as a mutation — but these routes
  // return a tenant's own table names and row counts, and "who read this app's
  // database" is exactly the question a leak investigation opens with. Volume
  // is bounded: the panel is on-demand with no polling, behind its own 20/min
  // bucket.
  { method: 'GET', pathPattern: /\/db\/[^/]+\/tables$/, action: 'db.read_tables' },
  { method: 'GET', pathPattern: /\/db\/[^/]+$/, action: 'db.read_overview' },
  // The access gate's credential-minting hops (DROP-152). Without these the
  // surface that hands out app sessions produces no audit trail at all — the
  // access log is a different store, with a different retention and a byte
  // cap, and is not a substitute for the durable one.
  { method: 'POST', pathPattern: /\/app-access\/code$/, action: 'app_access.mint_code' },
  { method: 'GET', pathPattern: /\/app-access\/[^/]+\/exchange$/, action: 'app_access.exchange' },
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
      principalId: authContext?.principalId,
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
