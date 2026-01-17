/**
 * REST API Server
 *
 * Hono-based REST API server for DROP platform.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { errorHandler, HttpError } from './middleware/error';
import { initializeAuth, authMiddleware, isAuthEnabled } from './middleware/auth';
import { error, ErrorCodes } from './types';
import healthRoutes from './routes/health';
import appsRoutes from './routes/apps';
import logsRoutes from './routes/logs';
import authRoutes from './routes/auth';

export interface ApiServerConfig {
  port: number;
  host?: string;
  corsOrigins?: string[];
  /** Path to store auth credentials */
  credentialsPath?: string;
  /** Enable authentication (default: true in production) */
  enableAuth?: boolean;
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

    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
  }

  private setupMiddleware(): void {
    // CORS
    this.app.use(
      '*',
      cors({
        origin: this.config.corsOrigins || ['*'],
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
      })
    );

    // Request logging
    this.app.use('*', logger());

    // Global error handler
    this.app.use('*', errorHandler);
  }

  private setupRoutes(): void {
    // API v1 routes
    const v1 = new Hono();

    // Public routes (no auth required)
    v1.route('/health', healthRoutes);
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
    } else {
      // No auth - all routes are public
      v1.route('/apps', appsRoutes);
      v1.route('/logs', logsRoutes);
    }

    // Mount v1 under /api/v1
    this.app.route('/api/v1', v1);

    // Root info
    this.app.get('/', (c) => {
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
