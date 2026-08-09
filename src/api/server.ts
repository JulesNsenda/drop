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
import {
  initializeAuth,
  authMiddleware,
  mcpAuthMiddleware,
  isAuthEnabled,
  setSignupEnabled,
} from './middleware/auth';
import {
  rateLimitMiddleware,
  authRateLimitMiddleware,
  uploadRateLimitMiddleware,
  mcpRateLimitMiddleware,
  oauthRateLimitMiddleware,
  dbRateLimitMiddleware,
} from './middleware/rate-limit';
import { securityHeadersMiddleware } from './middleware/security-headers';
import { auditMiddleware, initializeAuditLog, closeAuditLog } from './middleware/audit';
import { validateBodySize } from './middleware/validate';
import { setApiRuntimeConfig, getPublicUrl } from './runtime-config';
import { getSettingsManager } from '../managers/settings/settings-manager';
import { isPathWithin } from '../utils/paths';
import { buildProtectedResourceMetadata, buildAuthServerMetadata } from './oauth/metadata';
import { error, ErrorCodes } from './types';
import healthRoutes from './routes/health';
import appsRoutes from './routes/apps';
import logsRoutes from './routes/logs';
import authRoutes from './routes/auth';
import certsRoutes from './routes/certs';
import deploysRoutes from './routes/deploys';
import secretsRoutes from './routes/secrets';
import dbRoutes from './routes/db';
import webhooksRoutes from './routes/webhooks';
import gitDeployRoutes from './routes/git-deploy';
import adminRoutes from './routes/admin';
import usageRoutes from './routes/usage';
import oauthRoutes from './routes/oauth';
import mcpGatewayRoutes from './routes/mcp-gateway';
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
  /**
   * Override the resolved dashboard directory (normally dist/dashboard, or
   * src/dashboard as a dev fallback — see setupRoutes). Defaults to that
   * resolution when unset; exists so tests can point at an isolated fixture
   * instead of the real repo-relative dist/dashboard.
   */
  dashboardPath?: string;
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
      // Admin-stored override (PRD-041 settings UI) takes precedence over
      // DROP_PUBLIC_URL — see getPublicUrl()'s precedence. Reads whatever
      // the settings manager singleton has loaded so far: the real platform
      // (platform.ts) awaits settingsManager.load() before constructing
      // this server, so the stored value is already present; tests that
      // construct ApiServer directly without touching the settings manager
      // get an empty/default singleton, i.e. undefined here, which leaves
      // runtimeConfig.publicUrl untouched (see setApiRuntimeConfig above)
      // and getPublicUrl() falls back to the env var as before.
      publicUrl: getSettingsManager().getStoredPublicUrl(),
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
    // PUT /auth/password compares `currentPassword` and reports the mismatch,
    // so it is a password-guessing surface exactly like /auth/login and needs
    // the same bucket — the general /api/* limiter is far too generous for it.
    // The route is additionally interactive-session-only (see auth.ts), which
    // closes it to API keys; this bucket is what bounds the JWT path.
    v1.use('/auth/password', authRateLimitMiddleware());
    // Account creation (POST /auth/users) — reachable by a scoped provisioning
    // token now, so bound it with the strict auth limiter. POST only, so admin
    // GET listing of users is not throttled. Registered unconditionally like the
    // login limiter above.
    // Every mint appends to api-credentials.json and rewrites the whole file,
    // which every later auth check must parse and scan linearly. Same strict
    // bucket as the other credential-minting routes.
    v1.use('/auth/agent-tokens', authRateLimitMiddleware());
    const usersCreateRateLimit = authRateLimitMiddleware();
    v1.use('/auth/users', (c, next) =>
      c.req.method === 'POST' ? usersCreateRateLimit(c, next) : next()
    );
    v1.route('/auth', authRoutes);

    // Upload deploys get a stricter, route-specific rate limit (PRD-039),
    // registered unconditionally like the auth-login limiter above — an
    // auth-disabled (single-operator) box still gets flood protection.
    v1.use('/apps/*/source', uploadRateLimitMiddleware());

    // The hosted MCP endpoint gets its own bucket (PRD-040), also registered
    // unconditionally.
    v1.use('/mcp', mcpRateLimitMiddleware());

    // OAuth 2.1 endpoints (PRD-041) get their own bucket too, registered
    // unconditionally — the handlers themselves fail closed (503/400) when
    // OAuth isn't configured/enabled, but the rate limit applies regardless.
    v1.use('/oauth/*', oauthRateLimitMiddleware());

    // The database panel (DROP-120) gets an ADDITIONAL, tighter cap here —
    // not instead of the general bucket registered above (`/api/*`, which
    // `/db/*` still matches too): a request here is throttled by BOTH, this
    // one is just stricter (20/min vs 100/min) because it is sized for a
    // single shared PostgreSQL instance, not the whole API. Registered
    // unconditionally — an auth-disabled (single-operator) box still gets it.
    v1.use('/db/*', dbRateLimitMiddleware());

    // Apply auth middleware to protected routes when auth is enabled
    if (this.config.enableAuth && isAuthEnabled()) {
      // migrate-runtime is admin-only — register before the general /apps/* guard.
      v1.use('/apps/*/migrate-runtime', authMiddleware('admin'));
      // Granting/revoking an app's control-plane API capabilities (which mints a
      // scoped DROP_API_KEY) is admin-only — register before the general /apps/*
      // guard so a readonly/user token can't confer capabilities.
      v1.use('/apps/*/capabilities', authMiddleware('admin'));
      // start/stop/restart mutate runtime state (and, on restart, tear down
      // and recreate the process/container) — read-only tokens must not
      // reach them. Register before the general /apps/* guard.
      v1.use('/apps/*/start', authMiddleware('user'));
      v1.use('/apps/*/stop', authMiddleware('user'));
      v1.use('/apps/*/restart', authMiddleware('user'));
      // Promotion is a human decision (Step 6d). The role floor is enforced
      // here; the route ALSO rejects an agent credential outright, because a
      // role alone does not distinguish an agent token from a session.
      v1.use('/apps/*/promote', authMiddleware('user'));
      // Upload deploy is never anonymous, even on an auth-enabled box with a
      // readonly token in hand — it mutates the app the same way git-deploy
      // does. Register before the general /apps/* readonly guard.
      v1.use('/apps/*/source', authMiddleware('user'));
      // MCP tools mutate apps (deploy_files, restart_app, ...) — never
      // anonymous, same tier as upload/git deploy. mcpAuthMiddleware also
      // accepts an audience-bound OAuth access token (PRD-041), falling back
      // to the same session-JWT/API-key path authMiddleware('user') used.
      v1.use('/mcp', mcpAuthMiddleware());
      // OAuth 2.1 endpoints (PRD-041): selective auth only. /authorize and
      // /token are deliberately NOT gated here — /authorize self-gates via
      // the SPA session redirect and /token authenticates via PKCE; mounting
      // session auth on either would break claude.ai's calls. /revoke (RFC
      // 7009) is the same shape: for a public PKCE client the presented
      // token IS the credential — you can only revoke a token you already
      // hold — so a session adds nothing and gating it here made the
      // advertised revocation_endpoint 401 for the only caller that ever
      // hits it (claude.ai holds no DROP session, only the OAuth token
      // itself). See oauth.ts's own handler comment.
      v1.use('/oauth/approve', authMiddleware('user'));
      v1.use('/oauth/client', authMiddleware('admin'));
      // Read-only connector info (DROP-131 Item 4) — a separate, explicit
      // path so this never touches the /oauth/client line above: any
      // non-admin session may read the already-minted client_id, but minting
      // stays admin-only via POST /oauth/client.
      v1.use('/oauth/connector-info', authMiddleware('user'));
      // DELETE/PUT/PATCH on an app (delete, rename, re-domain) and POST on the
      // apps collection (deploy a new app) are destructive/mutating and must
      // not be reachable with a read-only token. DELETE/PUT/PATCH used to fall
      // through to the readonly guard below and rely on `canAccess` alone —
      // which was inert for API keys only because a key's userId was its own
      // id and therefore owned nothing. Now that a key resolves to its owner,
      // that accident no longer contains it, so the tier is stated explicitly.
      // Method-scoped: GET /apps/:name (and GET /apps) must stay readable at
      // `readonly`.
      v1.use('/apps/*', async (c, next) => {
        const method = c.req.method;
        if (method === 'DELETE' || method === 'PUT' || method === 'PATCH' || method === 'POST') {
          return authMiddleware('user')(c, next);
        }
        return next();
      });
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
      // Database panel reads (DROP-120) — 'user' floor so a `readonly` token
      // is rejected by this middleware before the route's own
      // interactiveSessionOnly guard ever runs; the route guard alone is not
      // enough since it only distinguishes session vs API key, not role.
      v1.use('/db/*', authMiddleware('user'));
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
    v1.route('/db', dbRoutes);
    v1.route('/webhooks', webhooksRoutes);
    v1.route('/git', gitDeployRoutes);
    v1.route('/admin', adminRoutes);
    v1.route('/oauth', oauthRoutes);
    // Caddy's forward_auth target for tenant MCP endpoints (Step 11). NOT
    // behind authMiddleware on purpose: it authenticates an app-audienced
    // bearer itself and must reject every other credential class, which a
    // general auth gate would instead admit.
    v1.route('/mcp-gateway', mcpGatewayRoutes);

    // Hosted MCP endpoint (PRD-040): stateless Streamable HTTP, POST only.
    // GET/DELETE have no meaning in stateless mode (no sessions/streams) —
    // answered with a JSON-RPC-shaped 405 rather than falling through to the
    // generic 404 handler.
    v1.post('/mcp', handleMcpRequest);
    v1.get('/mcp', methodNotAllowed);
    v1.delete('/mcp', methodNotAllowed);

    // OAuth 2.1 discovery metadata (PRD-041) — RFC 8414/9728 mandate these at
    // fixed ROOT paths (not under /api/v1), so they're mounted directly on
    // the app, before /api/v1. Public (no auth, no /api/* rate limiter — the
    // OAuth-specific bucket above only covers /api/v1/oauth/*), and fail
    // closed with 404 when the OAuth issuer isn't configured.
    const protectedResourceHandler = (c: import('hono').Context) => {
      const publicUrl = getPublicUrl();
      // Phase 5 observability: discovery probes are the fragile part of the
      // claude.ai handshake (resource-scoped vs root path is a known breakage
      // class) — log which path was hit and whether it resolved.
      console.log('[oauth] discovery probe', { path: c.req.path, resolved: Boolean(publicUrl) });
      if (!publicUrl) return c.notFound();
      return c.json(buildProtectedResourceMetadata(publicUrl));
    };
    this.app.get('/.well-known/oauth-protected-resource', protectedResourceHandler);
    this.app.get('/.well-known/oauth-protected-resource/api/v1/mcp', protectedResourceHandler);
    // Newer non-`oauth-`prefixed spelling some MCP clients probe — serve the
    // same doc so discovery can't 404 on either variant.
    this.app.get('/.well-known/protected-resource/api/v1/mcp', protectedResourceHandler);
    this.app.get('/.well-known/oauth-authorization-server', c => {
      const publicUrl = getPublicUrl();
      console.log('[oauth] discovery probe', { path: c.req.path, resolved: Boolean(publicUrl) });
      if (!publicUrl) return c.notFound();
      return c.json(buildAuthServerMetadata(publicUrl));
    });

    // Mount v1 under /api/v1
    this.app.route('/api/v1', v1);

    // Content-type map used by the dashboard's static-asset route below.
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

    /**
     * Icon files served at BOTH the platform root and under /dashboard, from
     * the dashboard bundle's public/ directory in both cases (DROP-139: the
     * marketing site — and its own copy of these files — moved to a separate
     * repo/app, so the dashboard build is now the only source).
     *
     * `drop.svg` is the source of truth for the mark; the rasters exist because
     * many icon consumers request `/favicon.ico` directly from the origin,
     * regardless of the `<link rel="icon">` tag, and many of them do not
     * render SVG. Regenerate with `node scripts/generate-favicons.js` if the
     * mark changes — nothing rebuilds them automatically.
     */
    const ICON_FILES: Record<string, string> = {
      'drop.svg': 'image/svg+xml',
      'favicon.ico': 'image/x-icon',
      'favicon-32.png': 'image/png',
      'apple-touch-icon.png': 'image/png',
    };

    // Dashboard static files
    // Prefer built dashboard (dist/dashboard) over source (src/dashboard),
    // unless a test/caller overrides the resolved path directly.
    const distDashboardPath = path.join(__dirname, '..', '..', 'dist', 'dashboard');
    const srcDashboardPath = path.join(__dirname, '..', 'dashboard');
    const dashboardPath =
      this.config.dashboardPath ??
      (fs.existsSync(path.join(distDashboardPath, 'index.html'))
        ? distDashboardPath
        : srcDashboardPath);
    const dashboardIndexPath = path.join(dashboardPath, 'index.html');
    const dashboardExists = fs.existsSync(dashboardIndexPath);

    console.log('[Dashboard] Path:', dashboardPath);
    console.log('[Dashboard] Index exists:', dashboardExists);

    if (dashboardExists) {
      const readIndexHtml = (): Promise<string> => fsp.readFile(dashboardIndexPath, 'utf-8');

      // Serve static assets. Vite emits content-hashed filenames under
      // /assets, so they can be cached immutably.
      this.app.get('/dashboard/assets/*', async c => {
        const assetPath = c.req.path.replace('/dashboard/', '');
        const filePath = path.join(dashboardPath, assetPath);
        // Containment: never serve outside the dashboard directory.
        // isPathWithin realpaths both sides, so a symlink/junction planted
        // under the dashboard dir can't escape it either (plain lexical
        // path.relative would miss that).
        if (!(await isPathWithin(dashboardPath, filePath))) {
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

      // Serve favicons (see the ICON_FILES comment above for why raster
      // fallbacks exist).
      for (const [file, contentType] of Object.entries(ICON_FILES)) {
        this.app.get(`/dashboard/${file}`, async c => {
          try {
            const content = await fsp.readFile(path.join(dashboardPath, file));
            return c.body(content, 200, {
              'Content-Type': contentType,
              'Cache-Control': 'public, max-age=86400',
            });
          } catch {
            return c.notFound();
          }
        });
      }

      // SPA fallback — index.html must never be cached, or clients get a stale
      // shell pointing at old asset hashes after a deploy.
      const serveIndex = async (c: import('hono').Context) => {
        const html = await readIndexHtml();
        c.header('Cache-Control', 'no-cache');
        return c.html(html);
      };

      this.app.get('/dashboard', serveIndex);

      // Moved public URLs (DROP-070, re-pointed by DROP-139): /docs and
      // /reference used to live under /dashboard, then moved to the
      // platform's own root, and now live on the public drop-site app —
      // the platform no longer serves either. Permanently redirect inbound
      // links and search-index entries to their new home. MUST be
      // registered immediately above the /dashboard/* fallback below — that
      // wildcard would otherwise match these two paths first and serve the
      // dashboard SPA shell instead of redirecting.
      this.app.get('/dashboard/docs', c => c.redirect('https://dropkit.sh/docs', 301));
      this.app.get('/dashboard/reference', c => c.redirect('https://dropkit.sh/docs/api', 301));

      this.app.get('/dashboard/*', async c => {
        if (!c.req.path.includes('/assets/') && !c.req.path.endsWith('.svg')) {
          return serveIndex(c);
        }
        return c.notFound();
      });
    }

    // Root icon routes (DROP-139). The marketing site used to serve these at
    // the platform root; it now lives in its own repo/app at dropkit.sh, so
    // the platform no longer builds or serves it. Browsers and link-preview
    // crawlers request `/favicon.ico` etc. from the origin regardless of
    // which app is mounted at `/` — see the ICON_FILES comment above — so
    // these stay registered at the root, reading from the dashboard bundle
    // (dashboardPath) instead of the now-gone site bundle.
    for (const [file, contentType] of Object.entries(ICON_FILES)) {
      this.app.get(`/${file}`, async c => {
        try {
          const content = await fsp.readFile(path.join(dashboardPath, file));
          return c.body(content, 200, {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400',
          });
        } catch {
          return c.notFound();
        }
      });
    }

    // Root (DROP-139): the marketing site, docs and API reference are no
    // longer built or served by the platform — they live at dropkit.sh,
    // served by their own drop-site app. A self-hosted install has nothing
    // of its own to show at `/`, so redirect straight to the dashboard
    // rather than 404ing or serving the old API-info JSON blob.
    this.app.get('/', c => c.redirect('/dashboard', 301));
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
