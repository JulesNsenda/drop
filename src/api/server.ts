/**
 * REST API Server
 *
 * Hono-based REST API server for DROP platform.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { errorHandler, HttpError } from './middleware/error';
import { initializeAuth, authMiddleware, isAuthEnabled, setSignupEnabled } from './middleware/auth';
import {
  rateLimitMiddleware,
  authRateLimitMiddleware,
  uploadRateLimitMiddleware,
  mcpRateLimitMiddleware,
} from './middleware/rate-limit';
import { securityHeadersMiddleware } from './middleware/security-headers';
import { auditMiddleware, initializeAuditLog, closeAuditLog } from './middleware/audit';
import { validateBodySize } from './middleware/validate';
import { setApiRuntimeConfig } from './runtime-config';
import { error, ErrorCodes } from './types';
import healthRoutes from './routes/health';
import appsRoutes from './routes/apps';
import logsRoutes from './routes/logs';
import authRoutes from './routes/auth';
import certsRoutes from './routes/certs';
import deploysRoutes from './routes/deploys';
import secretsRoutes from './routes/secrets';
import webhooksRoutes from './routes/webhooks';
import gitDeployRoutes from './routes/git-deploy';
import adminRoutes from './routes/admin';
import usageRoutes from './routes/usage';
import { handleMcpRequest, methodNotAllowed } from './mcp/transport';

/** Matches POST /api/v1/apps/:name/source — the upload-deploy endpoint (PRD-039). */
const UPLOAD_SOURCE_PATH_RE = /^\/api\/v1\/apps\/[A-Za-z0-9_-]+\/source$/;
/** Matches /api/v1/mcp — the hosted MCP endpoint (PRD-040). */
const MCP_PATH_RE = /^\/api\/v1\/mcp$/;
/** deploy_files allows up to 1.5 MB of summed file content — comfortably over the global 1 MB body cap. */
const MCP_MAX_BODY_BYTES = 2 * 1024 * 1024;

export interface ApiServerConfig {
  port: number;
  host?: string;
  corsOrigins?: string[];
  /** Path to store auth credentials */
  credentialsPath?: string;
  /** Enable authentication (default: true unless DROP_DISABLE_AUTH=true) */
  enableAuth?: boolean;
  /** Directory for log files (audit logs) */
  logDir?: string;
  /** Webapps directory — used to contain user-supplied deploy paths */
  appsDirectory?: string;
  /**
   * Allow self-service signup via POST /auth/signup.
   * Default false — requires isolation: docker + auth enabled at startup too.
   */
  allowSignup?: boolean;
  /** Whether HTTPS is enabled (passed through to runtime-config for URL generation). */
  enableHttps?: boolean;
  /** Active domain suffix (e.g. "example.com"). */
  domainSuffix?: string;
  /** Path to the platform encryption key (for MFA secret at rest). */
  masterKeyPath?: string;
  /** Directory for ephemeral build/upload staging (outside the watched webapps tree). */
  tempDirectory?: string;
  /** Cap on the compressed (as-uploaded) archive size for POST /apps/:name/source, in MB. */
  maxUploadSizeMb?: number;
}

export class ApiServer {
  private readonly app: Hono;
  private readonly config: ApiServerConfig;
  private server: ReturnType<typeof serve> | null = null;

  constructor(config: ApiServerConfig) {
    this.config = {
      host: '0.0.0.0',
      // Auth is on by default (fail-safe). Disable explicitly with
      // DROP_DISABLE_AUTH=true. Callers (the platform) pass enableAuth
      // explicitly; this default only governs direct/test construction.
      enableAuth: process.env.DROP_DISABLE_AUTH !== 'true',
      ...config,
    };
    // Default CORS to same-origin only unless explicitly configured. A
    // multi-tenant API must not reflect arbitrary origins by default.
    if (!this.config.corsOrigins) {
      const fromEnv = process.env.DROP_CORS_ORIGINS?.split(',')
        .map(o => o.trim())
        .filter(Boolean);
      this.config.corsOrigins = fromEnv && fromEnv.length > 0 ? fromEnv : [];
    }

    setApiRuntimeConfig({
      appsDirectory: this.config.appsDirectory,
      enableHttps: this.config.enableHttps,
      domainSuffix: this.config.domainSuffix,
      tempDirectory: this.config.tempDirectory,
      maxUploadSizeMb: this.config.maxUploadSizeMb,
    });

    this.app = new Hono();
  }

  async initialize(): Promise<void> {
    // Initialize authentication if enabled
    if (this.config.enableAuth && this.config.credentialsPath) {
      await initializeAuth({
        credentialsPath: this.config.credentialsPath,
        enableJwt: true,
        enableApiKeys: true,
        masterKeyPath: this.config.masterKeyPath,
      });
    }

    // Signup gate — off by default; on only when platform config allows it.
    setSignupEnabled(this.config.allowSignup === true);

    // Initialize audit logging
    if (this.config.logDir) {
      initializeAuditLog(this.config.logDir);
    }

    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  private setupMiddleware(): void {
    // Security headers
    this.app.use('*', securityHeadersMiddleware());

    // CORS
    this.app.use(
      '*',
      cors({
        origin: this.config.corsOrigins || ['*'],
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
      })
    );

    // Request body size limit (1MB) — carved out for the upload-source route
    // (PRD-039): a gzipped tarball is far larger than 1MB, and this
    // Content-Length header check would otherwise reject it before the route
    // ever runs. The route's own streamed byte cap (routes/apps.ts,
    // getUploadMaxBytes) is the real enforcement — it never trusts
    // Content-Length either. Every other path's behavior is unchanged.
    const bodySizeLimit = validateBodySize();
    // MCP gets a bigger cap (2MB), not a skip — deploy_files' 1.5MB summed
    // content cap plus JSON-RPC/protocol overhead comfortably exceeds the
    // global 1MB limit, but MCP requests are still ordinary JSON (unlike the
    // upload-source route's raw tarball stream, which is fully carved out).
    const mcpBodySizeLimit = validateBodySize(MCP_MAX_BODY_BYTES);
    this.app.use('*', async (c, next) => {
      if (UPLOAD_SOURCE_PATH_RE.test(c.req.path)) {
        return next();
      }
      if (MCP_PATH_RE.test(c.req.path)) {
        return mcpBodySizeLimit(c, next);
      }
      return bodySizeLimit(c, next);
    });

    // Rate limiting
    this.app.use('/api/*', rateLimitMiddleware());

    // Request logging
    this.app.use('*', logger());

    // Audit logging
    this.app.use('/api/*', auditMiddleware());

    // Global error handler
    this.app.use('*', errorHandler);
  }

  private setupRoutes(): void {
    // API v1 routes
    const v1 = new Hono();

    // Public routes (no auth required)
    v1.route('/health', healthRoutes);

    // Auth routes with stricter rate limiting (brute-force / signup-flood)
    v1.use('/auth/login', authRateLimitMiddleware());
    v1.use('/auth/signup', authRateLimitMiddleware());
    v1.use('/auth/mfa/*', authRateLimitMiddleware());
    v1.route('/auth', authRoutes);

    // Upload deploys get a stricter, route-specific rate limit (PRD-039),
    // registered unconditionally like the auth-login limiter above — an
    // auth-disabled (single-operator) box still gets flood protection.
    v1.use('/apps/*/source', uploadRateLimitMiddleware());

    // The hosted MCP endpoint gets its own bucket (PRD-040), also registered
    // unconditionally.
    v1.use('/mcp', mcpRateLimitMiddleware());

    // Apply auth middleware to protected routes when auth is enabled
    if (this.config.enableAuth && isAuthEnabled()) {
      // migrate-runtime is admin-only — register before the general /apps/* guard.
      v1.use('/apps/*/migrate-runtime', authMiddleware('admin'));
      // start/stop/restart mutate runtime state (and, on restart, tear down
      // and recreate the process/container) — read-only tokens must not
      // reach them. Register before the general /apps/* guard.
      v1.use('/apps/*/start', authMiddleware('user'));
      v1.use('/apps/*/stop', authMiddleware('user'));
      v1.use('/apps/*/restart', authMiddleware('user'));
      // Upload deploy is never anonymous, even on an auth-enabled box with a
      // readonly token in hand — it mutates the app the same way git-deploy
      // does. Register before the general /apps/* readonly guard.
      v1.use('/apps/*/source', authMiddleware('user'));
      // MCP tools mutate apps (deploy_files, restart_app, ...) — never
      // anonymous, same tier as upload/git deploy.
      v1.use('/mcp', authMiddleware('user'));
      v1.use('/apps/*', authMiddleware('readonly'));
      v1.use('/apps', authMiddleware('readonly'));
      v1.use('/usage', authMiddleware('readonly'));
      v1.use('/logs/*', authMiddleware('readonly'));
      v1.use('/deploys/*', authMiddleware('readonly'));
      v1.use('/deploys', authMiddleware('readonly'));
      // Renewal triggers a platform-wide ACME pass (Let's Encrypt rate-limit
      // risk) — admin-only. Register before the general /certs/* guard.
      v1.use('/certs/renew', authMiddleware('admin'));
      v1.use('/certs/*', authMiddleware('readonly'));
      v1.use('/secrets/*', authMiddleware('user'));
      v1.use('/webhooks/*', authMiddleware('admin'));
      v1.use('/git/deploy', authMiddleware('user'));
      v1.use('/git/redeploy/*', authMiddleware('user'));
      v1.use('/git/tokens', authMiddleware('user'));
      v1.use('/git/tokens/*', authMiddleware('user'));
      v1.use('/admin/*', authMiddleware('admin'));
    }

    // Mount all routes (auth middleware applied above when enabled)
    v1.route('/apps', appsRoutes);
    v1.route('/usage', usageRoutes);
    v1.route('/logs', logsRoutes);
    v1.route('/certs', certsRoutes);
    v1.route('/deploys', deploysRoutes);
    v1.route('/secrets', secretsRoutes);
    v1.route('/webhooks', webhooksRoutes);
    v1.route('/git', gitDeployRoutes);
    v1.route('/admin', adminRoutes);

    // Hosted MCP endpoint (PRD-040): stateless Streamable HTTP, POST only.
    // GET/DELETE have no meaning in stateless mode (no sessions/streams) —
    // answered with a JSON-RPC-shaped 405 rather than falling through to the
    // generic 404 handler.
    v1.post('/mcp', handleMcpRequest);
    v1.get('/mcp', methodNotAllowed);
    v1.delete('/mcp', methodNotAllowed);

    // Mount v1 under /api/v1
    this.app.route('/api/v1', v1);

    // Dashboard static files
    // Prefer built dashboard (dist/dashboard) over source (src/dashboard)
    const distDashboardPath = path.join(__dirname, '..', '..', 'dist', 'dashboard');
    const srcDashboardPath = path.join(__dirname, '..', 'dashboard');
    const dashboardPath = fs.existsSync(path.join(distDashboardPath, 'index.html'))
      ? distDashboardPath
      : srcDashboardPath;
    const dashboardIndexPath = path.join(dashboardPath, 'index.html');
    const dashboardExists = fs.existsSync(dashboardIndexPath);

    console.log('[Dashboard] Path:', dashboardPath);
    console.log('[Dashboard] Index exists:', dashboardExists);

    if (dashboardExists) {
      const MIME_TYPES: Record<string, string> = {
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.css': 'text/css',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.ico': 'image/x-icon',
        '.json': 'application/json',
        '.map': 'application/json',
        '.woff': 'font/woff',
        '.woff2': 'font/woff2',
        '.ttf': 'font/ttf',
      };

      const readIndexHtml = (): Promise<string> => fsp.readFile(dashboardIndexPath, 'utf-8');

      // Serve static assets. Vite emits content-hashed filenames under
      // /assets, so they can be cached immutably.
      this.app.get('/dashboard/assets/*', async c => {
        const assetPath = c.req.path.replace('/dashboard/', '');
        const filePath = path.join(dashboardPath, assetPath);
        // Containment: never serve outside the dashboard directory.
        if (!path.resolve(filePath).startsWith(path.resolve(dashboardPath))) {
          return c.notFound();
        }
        try {
          const content = await fsp.readFile(filePath);
          const contentType = MIME_TYPES[path.extname(filePath)] || 'application/octet-stream';
          return c.body(content, 200, {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=31536000, immutable',
          });
        } catch {
          return c.notFound();
        }
      });

      // Serve favicon
      this.app.get('/dashboard/drop.svg', async c => {
        try {
          const content = await fsp.readFile(path.join(dashboardPath, 'drop.svg'));
          return c.body(content, 200, {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'public, max-age=86400',
          });
        } catch {
          return c.notFound();
        }
      });

      // SPA fallback — index.html must never be cached, or clients get a stale
      // shell pointing at old asset hashes after a deploy.
      const serveIndex = async (c: import('hono').Context) => {
        const html = await readIndexHtml();
        c.header('Cache-Control', 'no-cache');
        return c.html(html);
      };

      this.app.get('/dashboard', serveIndex);
      this.app.get('/dashboard/*', async c => {
        if (!c.req.path.includes('/assets/') && !c.req.path.endsWith('.svg')) {
          return serveIndex(c);
        }
        return c.notFound();
      });
    }

    // Root - redirect to dashboard if available, otherwise show API info
    this.app.get('/', c => {
      const dashboardExists =
        fs.existsSync(path.join(distDashboardPath, 'index.html')) ||
        fs.existsSync(path.join(srcDashboardPath, 'index.html'));
      if (dashboardExists) {
        return c.redirect('/dashboard');
      }
      return c.json({
        name: 'DROP API',
        version: '1.0.0',
        docs: '/api/v1',
        auth: this.config.enableAuth ? 'enabled' : 'disabled',
      });
    });
  }

  private setupErrorHandling(): void {
    // Handle HTTP errors
    this.app.onError((err, c) => {
      console.error('API Error:', err);

      if (err instanceof HttpError) {
        // HttpErrors carry deliberate, client-safe messages.
        return c.json(
          error(err.code, err.message),
          err.statusCode as 400 | 401 | 403 | 404 | 409 | 500
        );
      }

      // Unexpected error: the real message/stack is logged above. Return a
      // generic message so internal details (filesystem paths, DB/driver
      // errors, stack text) never leak to API clients.
      return c.json(error(ErrorCodes.INTERNAL_ERROR, 'Internal server error'), 500);
    });

    // Handle 404
    this.app.notFound(c => {
      console.log('[404] Route not found:', c.req.path);
      return c.json(error(ErrorCodes.NOT_FOUND, `Route not found: ${c.req.path}`), 404);
    });
  }

  async start(): Promise<void> {
    // Ensure initialized
    if (!this.app.routes.length) {
      await this.initialize();
    }

    return new Promise(resolve => {
      this.server = serve(
        {
          fetch: this.app.fetch,
          port: this.config.port,
          hostname: this.config.host,
        },
        info => {
          console.log(`API server running on http://${info.address}:${info.port}`);
          if (this.config.enableAuth) {
            console.log('Authentication: ENABLED');
          } else {
            console.log('Authentication: DISABLED (set NODE_ENV=production to enable)');
          }
          resolve();
        }
      );
    });
  }

  async stop(): Promise<void> {
    closeAuditLog();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  getApp(): Hono {
    return this.app;
  }
}

// Factory function
export function createApiServer(config: ApiServerConfig): ApiServer {
  return new ApiServer(config);
}
