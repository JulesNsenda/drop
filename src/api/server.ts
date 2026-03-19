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
import { errorHandler, HttpError } from './middleware/error';
import { initializeAuth, authMiddleware, isAuthEnabled } from './middleware/auth';
import { rateLimitMiddleware, authRateLimitMiddleware } from './middleware/rate-limit';
import { securityHeadersMiddleware } from './middleware/security-headers';
import { auditMiddleware, initializeAuditLog, closeAuditLog } from './middleware/audit';
import { validateBodySize } from './middleware/validate';
import { error, ErrorCodes } from './types';
import healthRoutes from './routes/health';
import appsRoutes from './routes/apps';
import logsRoutes from './routes/logs';
import authRoutes from './routes/auth';
import certsRoutes from './routes/certs';
import secretsRoutes from './routes/secrets';
import webhooksRoutes from './routes/webhooks';
import gitDeployRoutes from './routes/git-deploy';

export interface ApiServerConfig {
  port: number;
  host?: string;
  corsOrigins?: string[];
  /** Path to store auth credentials */
  credentialsPath?: string;
  /** Enable authentication (default: true in production) */
  enableAuth?: boolean;
  /** Directory for log files (audit logs) */
  logDir?: string;
}

export class ApiServer {
  private readonly app: Hono;
  private readonly config: ApiServerConfig;
  private server: ReturnType<typeof serve> | null = null;

  constructor(config: ApiServerConfig) {
    this.config = {
      host: '0.0.0.0',
      corsOrigins: ['*'],
      enableAuth: process.env.NODE_ENV === 'production',
      ...config,
    };

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

    // Auth routes with stricter rate limiting
    v1.use('/auth/login', authRateLimitMiddleware());
    v1.route('/auth', authRoutes);

    // Protected routes (auth required if enabled)
    if (this.config.enableAuth && isAuthEnabled()) {
      // Apps routes require at least 'user' role for modifications
      const protectedApps = new Hono();
      protectedApps.get('/', authMiddleware('readonly'), async (c) => {
        const appsRouter = new Hono();
        appsRouter.route('/', appsRoutes);
        return appsRouter.fetch(c.req.raw);
      });
      protectedApps.get('/:name', authMiddleware('readonly'), async (c) => {
        const appsRouter = new Hono();
        appsRouter.route('/', appsRoutes);
        return appsRouter.fetch(c.req.raw);
      });
      protectedApps.post('/*', authMiddleware('user'), async (c) => {
        const appsRouter = new Hono();
        appsRouter.route('/', appsRoutes);
        return appsRouter.fetch(c.req.raw);
      });
      protectedApps.put('/*', authMiddleware('user'), async (c) => {
        const appsRouter = new Hono();
        appsRouter.route('/', appsRoutes);
        return appsRouter.fetch(c.req.raw);
      });
      protectedApps.delete('/*', authMiddleware('admin'), async (c) => {
        const appsRouter = new Hono();
        appsRouter.route('/', appsRoutes);
        return appsRouter.fetch(c.req.raw);
      });
      v1.route('/apps', protectedApps);

      // Logs routes require at least 'readonly' role
      v1.use('/logs/*', authMiddleware('readonly'));
      v1.route('/logs', logsRoutes);

      // Certs routes require at least 'readonly' role
      v1.use('/certs/*', authMiddleware('readonly'));
      v1.route('/certs', certsRoutes);

      // Secrets routes require 'admin' role
      v1.use('/secrets/*', authMiddleware('admin'));
      v1.route('/secrets', secretsRoutes);

      // Webhooks routes require 'admin' role
      v1.use('/webhooks/*', authMiddleware('admin'));
      v1.route('/webhooks', webhooksRoutes);

      // Git deploy: webhook endpoint is public, rest requires 'user' role
      v1.route('/git', gitDeployRoutes);
    } else {
      // No auth - all routes are public
      v1.route('/apps', appsRoutes);
      v1.route('/logs', logsRoutes);
      v1.route('/certs', certsRoutes);
      v1.route('/secrets', secretsRoutes);
      v1.route('/webhooks', webhooksRoutes);
      v1.route('/git', gitDeployRoutes);
    }

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
      // Serve static assets (CSS, JS, images)
      this.app.get('/dashboard/assets/*', async (c) => {
        const assetPath = c.req.path.replace('/dashboard/', '');
        const filePath = path.join(dashboardPath, assetPath);

        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath);
          const ext = path.extname(filePath);
          const mimeTypes: Record<string, string> = {
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.ico': 'image/x-icon',
          };
          const contentType = mimeTypes[ext] || 'application/octet-stream';
          return c.body(content, 200, { 'Content-Type': contentType });
        }
        return c.notFound();
      });

      // Serve favicon
      this.app.get('/dashboard/drop.svg', (c) => {
        const filePath = path.join(dashboardPath, 'drop.svg');
        if (fs.existsSync(filePath)) {
          const content = fs.readFileSync(filePath);
          return c.body(content, 200, { 'Content-Type': 'image/svg+xml' });
        }
        return c.notFound();
      });

      // SPA fallback - serve index.html for all dashboard routes
      this.app.get('/dashboard', (c) => {
        const html = fs.readFileSync(dashboardIndexPath, 'utf-8');
        return c.html(html);
      });

      this.app.get('/dashboard/*', (c) => {
        // Check if it's not an asset request
        if (!c.req.path.includes('/assets/') && !c.req.path.endsWith('.svg')) {
          const html = fs.readFileSync(dashboardIndexPath, 'utf-8');
          return c.html(html);
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
