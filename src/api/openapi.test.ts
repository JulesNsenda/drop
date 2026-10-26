/**
 * GET /api/v1/openapi.json (#297) — generated from the mounted route table.
 *
 * Three things are pinned here:
 *  - the document is structurally valid 3.1 (params match templates, ids are
 *    unique, every security reference resolves);
 *  - the role floors it reports are the ones setupRoutes actually enforces,
 *    including method-scoped and route-level ones;
 *  - the set of operations with NO middleware floor is exactly the reviewed
 *    list below. setupRoutes has no default-deny, so a new route mounted
 *    without an auth line is anonymous — this is where that becomes visible.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { Hono } from 'hono';
import { ApiServer } from './server';
import { resetAuth, authMiddleware, authMiddlewareForMethods } from './middleware/auth';
import { resetStateManager } from '../managers/app/state-manager';
import { resolveFloors } from './openapi';

type Operation = Record<string, unknown> & {
  operationId: string;
  parameters?: Array<{ name: string; in: string }>;
  security?: Array<Record<string, unknown>>;
  responses: Record<string, unknown>;
};
interface Doc {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes: Record<string, unknown> };
}

/**
 * Operations with no middleware role floor, each reviewed: public by design, or
 * authenticated inside the handler by something a role cannot express (a
 * signed webhook, PKCE, an app-audienced token, an invite secret).
 *
 * Adding a route here is a security decision. If a new route shows up in the
 * failure instead, it is reachable anonymously — add an authMiddleware line in
 * server.ts#setupRoutes rather than extending this list, unless it truly must
 * be public.
 */
const NO_FLOOR = [
  'GET /api/v1/health',
  'GET /api/v1/health/ready',
  'GET /api/v1/health/live',
  'GET /api/v1/openapi.json',
  'GET /api/v1/auth/status',
  'POST /api/v1/auth/signup',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/mfa/verify',
  'POST /api/v1/git/webhook',
  'GET /api/v1/oauth/authorize',
  'POST /api/v1/oauth/token',
  'POST /api/v1/oauth/revoke',
  'GET /api/v1/mcp-gateway/verify',
  'GET /api/v1/app-access/{app}/verify',
  'GET /api/v1/app-access/authorize',
  'GET /api/v1/app-access/invite/{id}',
  'POST /api/v1/app-access/invite-redeem',
  'POST /api/v1/app-access/guest-code',
  'GET /api/v1/app-access/{app}/exchange',
];

describe('GET /api/v1/openapi.json (#297)', () => {
  let tempDir: string;
  let server: ApiServer;
  let doc: Doc;

  const op = (method: string, p: string): Operation => {
    const found = doc.paths[p]?.[method.toLowerCase()];
    if (!found) throw new Error(`no operation ${method} ${p} in the document`);
    return found;
  };

  async function boot(enableAuth: boolean): Promise<Doc> {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-openapi-'));
    resetAuth();
    resetStateManager();
    const prev = process.env.DROP_DISABLE_AUTH;
    if (!enableAuth) process.env.DROP_DISABLE_AUTH = 'true';
    try {
      server = new ApiServer({
        port: 3197,
        enableAuth,
        credentialsPath: path.join(tempDir, 'credentials.json'),
      });
      await server.initialize();
    } finally {
      if (prev === undefined) delete process.env.DROP_DISABLE_AUTH;
      else process.env.DROP_DISABLE_AUTH = prev;
    }
    // Unauthenticated on purpose: the document is public.
    const res = await server.getApp().request('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    return (await res.json()) as Doc;
  }

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
  });

  afterEach(async () => {
    await server.stop();
    resetAuth();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('with auth enabled', () => {
    beforeEach(async () => {
      doc = await boot(true);
    });

    it('is a structurally valid OpenAPI 3.1 document', () => {
      expect(doc.openapi).toBe('3.1.0');
      const ids = new Set<string>();
      const schemes = Object.keys(doc.components.securitySchemes);
      let count = 0;
      for (const [p, ops] of Object.entries(doc.paths)) {
        const templated = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]).sort();
        for (const operation of Object.values(ops)) {
          count++;
          const declared = (operation.parameters ?? []).map((x) => x.name).sort();
          expect({ path: p, params: declared }).toEqual({ path: p, params: templated });
          expect(ids.has(operation.operationId)).toBe(false);
          ids.add(operation.operationId);
          expect(Object.keys(operation.responses).length).toBeGreaterThan(0);
          for (const requirement of operation.security ?? []) {
            for (const name of Object.keys(requirement)) expect(schemes).toContain(name);
          }
        }
      }
      expect(count).toBeGreaterThan(50);
    });

    it.each([
      ['GET', '/api/v1/apps', 'readonly'],
      // Method-scoped: the same /apps/* line gives GET readonly and DELETE user.
      ['GET', '/api/v1/apps/{name}', 'readonly'],
      ['DELETE', '/api/v1/apps/{name}', 'user'],
      ['POST', '/api/v1/apps', 'user'],
      ['POST', '/api/v1/apps/{name}/source', 'user'],
      ['DELETE', '/api/v1/apps/{name}/share/guests/{guestId}', 'user'],
      ['GET', '/api/v1/certs/{domain}', 'readonly'],
      // Strictest wins: /certs/renew is admin although /certs/* is readonly.
      ['POST', '/api/v1/certs/renew', 'admin'],
      ['GET', '/api/v1/limits', 'readonly'],
      // Route-level (auth.get('/users', authMiddleware('admin'), ...)).
      ['GET', '/api/v1/auth/users', 'admin'],
      ['GET', '/api/v1/auth/me', 'authenticated'],
      ['GET', '/api/v1/health/stats', 'readonly'],
    ])('%s %s has floor %s', (method, p, role) => {
      const operation = op(method, p);
      expect(operation['x-drop-min-role']).toBe(role);
      expect(operation.security).toEqual([{ bearerAuth: [] }, { apiKeyAuth: [] }]);
    });

    it('declares the agent token at /mcp and nowhere else', () => {
      expect(op('POST', '/api/v1/mcp').security).toContainEqual({ agentToken: [] });
      for (const [p, ops] of Object.entries(doc.paths)) {
        if (p === '/api/v1/mcp') continue;
        for (const operation of Object.values(ops)) {
          expect(operation.security ?? []).not.toContainEqual({ agentToken: [] });
        }
      }
    });

    it('has no floor ONLY on the reviewed public and self-authenticating routes', () => {
      const actual: string[] = [];
      for (const [p, ops] of Object.entries(doc.paths)) {
        for (const [method, operation] of Object.entries(ops)) {
          if (!operation['x-drop-min-role']) {
            expect(operation['x-drop-auth']).toBe('handler');
            // Never `security: []`, which would assert the route is public.
            expect(operation.security).toBeUndefined();
            actual.push(`${method.toUpperCase()} ${p}`);
          }
        }
      }
      const unreviewed = actual.filter((x) => !NO_FLOOR.includes(x));
      const gone = NO_FLOOR.filter((x) => !actual.includes(x));
      if (unreviewed.length || gone.length) {
        throw new Error(
          (unreviewed.length
            ? `Reachable with NO auth middleware: ${unreviewed.join(', ')}. Add an authMiddleware ` +
              'line in server.ts#setupRoutes, or — only if it must be public — add it to NO_FLOOR.\n'
            : '') + (gone.length ? `No longer floorless (remove from NO_FLOOR): ${gone.join(', ')}` : '')
        );
      }
    });

    it('does not swallow the OAuth discovery routes', async () => {
      const res = await server.getApp().request('/.well-known/oauth-authorization-server');
      // No public URL is configured in this test, so discovery fails closed —
      // with its own 404, not with the OpenAPI document.
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('openapi');
    });
  });

  it('reports no floors on a box with auth disabled', async () => {
    doc = await boot(false);

    for (const ops of Object.values(doc.paths)) {
      for (const operation of Object.values(ops)) {
        expect(operation['x-drop-min-role']).toBeUndefined();
      }
    }
  });
});

describe('resolveFloors', () => {
  it('uses Hono to match, applies method scoping, and takes the strictest floor', async () => {
    const app = new Hono();
    app.use('/x/*', authMiddlewareForMethods(['POST'], 'user'));
    app.use('/x/*', authMiddleware('readonly'));
    app.use('/x/admin', authMiddleware('admin'));
    app.get('/x/:id', (c) => c.text(''));
    app.post('/x/:id', (c) => c.text(''));
    app.get('/x/admin', (c) => c.text(''));
    app.get('/y', (c) => c.text(''));

    const floors = await resolveFloors(app.routes, [
      { method: 'GET', path: '/x/:id' },
      { method: 'POST', path: '/x/:id' },
      { method: 'GET', path: '/x/admin' },
      { method: 'GET', path: '/y' },
    ]);

    expect(floors.get('GET /x/:id')).toEqual({ role: 'readonly', mcp: false });
    expect(floors.get('POST /x/:id')).toEqual({ role: 'user', mcp: false });
    expect(floors.get('GET /x/admin')).toEqual({ role: 'admin', mcp: false });
    expect(floors.get('GET /y')).toEqual({ role: null, mcp: false });
  });
});
