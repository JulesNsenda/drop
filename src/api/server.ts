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
import { rateLimitMiddleware, authRateLimitMiddleware } from './middleware/rate-limit';
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
import secretsRoutes from './routes/secrets';
import webhooksRoutes from './routes/webhooks';
import gitDeployRoutes from './routes/git-deploy';
import adminRoutes from './routes/admin';
import usageRoutes from './routes/usage';

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
      const fromEnv = process.env.DROP_CORS_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean);
      this.config.corsOrigins = fromEnv && fromEnv.length > 0 ? fromEnv : [];
    }

    setApiRuntimeConfig({ appsDirectory: this.config.appsDirectory });

    this.app = new Hono();
  }

  async initialize(): Promise<void> {
    // Initialize authentication if enabled
    if (this.config.enableAuth && this.config.credentialsPath) {
      await initializeAuth({
        credentialsPath: this.config.credentialsPath,
        enableJwt: true,
        enableApiKeys: true,
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

    // Request body size limit (1MB)
    this.app.use('*', validateBodySize());

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
    v1.route('/auth', authRoutes);

    // Apply auth middleware to protected routes when auth is enabled
    if (this.config.enableAuth && isAuthEnabled()) {
      // migrate-runtime is admin-only — register before the general /apps/* guard.
      v1.use('/apps/*/migrate-runtime', authMiddleware('admin'));
      v1.use('/apps/*', authMiddleware('readonly'));
      v1.use('/apps', authMiddleware('readonly'));
      v1.use('/usage', authMiddleware('readonly'));
      v1.use('/logs/*', authMiddleware('readonly'));
      v1.use('/certs/*', authMiddleware('readonly'));
      v1.use('/secrets/*', authMiddleware('admin'));
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
    v1.route('/secrets', secretsRoutes);
    v1.route('/webhooks', webhooksRoutes);
    v1.route('/git', gitDeployRoutes);
    v1.route('/admin', adminRoutes);

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
      this.app.get('/dashboard/assets/*', async (c) => {
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
      this.app.get('/dashboard/drop.svg', async (c) => {
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
      this.app.get('/dashboard/*', async (c) => {
        if (!c.req.path.includes('/assets/') && !c.req.path.endsWith('.svg')) {
          return serveIndex(c);
        }
        return c.notFound();
      });
    }

    // Root - redirect to dashboard if available, otherwise show API info
    this.app.get('/', (c) => {
      const dashboardExists = fs.existsSync(path.join(distDashboardPath, 'index.html'))
        || fs.existsSync(path.join(srcDashboardPath, 'index.html'));
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
        return c.json(error(err.code, err.message), err.statusCode as 400 | 401 | 403 | 404 | 409 | 500);
      }

      return c.json(error(ErrorCodes.INTERNAL_ERROR, err.message || 'Internal server error'), 500);
    });

    // Handle 404
    this.app.notFound((c) => {
      console.log('[404] Route not found:', c.req.path);
      return c.json(error(ErrorCodes.NOT_FOUND, `Route not found: ${c.req.path}`), 404);
    });
  }

  async start(): Promise<void> {
    // Ensure initialized
    if (!this.app.routes.length) {
      await this.initialize();
    }

    return new Promise((resolve) => {
      this.server = serve(
        {
          fetch: this.app.fetch,
          port: this.config.port,
          hostname: this.config.host,
        },
        (info) => {
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
