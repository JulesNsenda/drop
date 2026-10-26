/**
 * OpenAPI 3.1 description of the REST API, GENERATED from the live route table
 * (#297).
 *
 * The published reference and llms.txt are hand-written copies of the route
 * table, and each drifts on its own. A hand-written spec would be one more copy.
 * This one is derived from `app.routes` — the same flattened (method, path)
 * list Hono's router is built from — so it cannot describe a route that is not
 * mounted, or miss one that is.
 *
 * ROLE FLOORS. They are not in the route files: they are `authMiddleware(role)`
 * lines in `server.ts#setupRoutes`. Each of those functions is tagged with its
 * floor (`authFloorOf`, auth.ts). To decide which floors apply to an operation,
 * the tagged middlewares are registered, in their original order and on their
 * original flattened paths, on a throwaway Hono app, and a sample request for
 * the operation is sent through it. Hono itself does the matching, on the same
 * inputs the real router gets — nothing here re-implements its path rules,
 * which are subtle enough that `server.ts` documents two separate surprises.
 *
 * What this does NOT know, and says so rather than guessing:
 *  - request/response bodies — there is no schema layer to read them from;
 *  - per-handler checks (ownership, `interactiveSessionOnly`, scope grants).
 *    A floor is the minimum, never a guarantee of access;
 *  - an operation with no middleware floor may still authenticate inside its
 *    handler (the auth, oauth and app-access routes do). Those are marked
 *    `x-drop-auth: handler` instead of being declared public.
 *
 * On a box with auth disabled no floor is enforced, and the document says so:
 * it describes the API as it is actually served.
 */

import { Hono } from 'hono';
import { authFloorOf, type AuthFloor, type AuthFloorRole } from './middleware/auth';

/** Structural subset of Hono's RouterRoute — all this module reads. */
export interface RouteEntry {
  method: string;
  path: string;
  handler: unknown;
}

export interface OpenApiOptions {
  version: string;
  /** Public base URL, when one is configured. Omitted otherwise. */
  serverUrl?: string;
  /** Only paths under this prefix are described. */
  prefix?: string;
  /**
   * False when the box runs with auth disabled. Route-level auth middleware is
   * still in the table then, but passes every request through, so no floor is
   * real and none is reported.
   */
  authEnabled: boolean;
}

export interface OperationFloor {
  role: AuthFloorRole | null;
  mcp: boolean;
}

const RANK: Record<AuthFloorRole, number> = { authenticated: 0, readonly: 1, user: 2, admin: 3 };
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const PARAM_RE = /:([A-Za-z0-9_]+)(\{[^}]*\})?\??/g;

/** A concrete path Hono will route like the pattern: every param and wildcard filled in. */
function samplePath(pattern: string): string {
  return pattern.replace(PARAM_RE, 'sample').replace(/\*/g, 'sample');
}

/** `/apps/:name` -> `/apps/{name}`; a bare `*` becomes a `{rest}` parameter. */
function toOpenApiPath(pattern: string): { path: string; params: string[] } {
  const params: string[] = [];
  const path = pattern
    .replace(PARAM_RE, (_m, name: string) => {
      params.push(name);
      return `{${name}}`;
    })
    .replace(/\*/g, () => {
      params.push('rest');
      return '{rest}';
    });
  return { path, params };
}

/**
 * The strictest floor applying to each (method, path), resolved by Hono.
 * Exported for tests; `buildOpenApiDocument` is the public entry point.
 */
export async function resolveFloors(
  routes: RouteEntry[],
  operations: Array<{ method: string; path: string }>
): Promise<Map<string, OperationFloor>> {
  const floors: AuthFloor[] = [];
  const probe = new Hono<{ Variables: { hits: number[] } }>();
  probe.use('*', async (c, next) => {
    c.set('hits', []);
    await next();
  });
  for (const r of routes) {
    const floor = r.method === 'ALL' ? authFloorOf(r.handler) : undefined;
    if (!floor) continue;
    const index = floors.push(floor) - 1;
    probe.use(r.path, async (c, next) => {
      c.get('hits').push(index);
      await next();
    });
  }
  probe.all('*', (c) => c.json(c.get('hits')));

  // Route-level floors: `auth.get('/users', authMiddleware('admin'), handler)`
  // lists the middleware as a GET entry on that exact path, not as an ALL one.
  const routeLevel = new Map<string, AuthFloor[]>();
  for (const r of routes) {
    const floor = r.method !== 'ALL' ? authFloorOf(r.handler) : undefined;
    if (!floor) continue;
    const key = `${r.method} ${r.path}`;
    routeLevel.set(key, [...(routeLevel.get(key) ?? []), floor]);
  }

  const result = new Map<string, OperationFloor>();
  for (const op of operations) {
    const res = await probe.request(samplePath(op.path), { method: op.method });
    const hits = (await res.json()) as number[];
    let role: AuthFloorRole | null = null;
    let mcp = false;
    const applicable = [
      ...hits.map((i) => floors[i]),
      ...(routeLevel.get(`${op.method} ${op.path}`) ?? []),
    ];
    for (const f of applicable) {
      if (f.methods && !f.methods.includes(op.method)) continue;
      if (role === null || RANK[f.role] > RANK[role]) role = f.role;
      if (f.credentials === 'mcp') mcp = true;
    }
    result.set(`${op.method} ${op.path}`, { role, mcp });
  }
  return result;
}

function operationId(method: string, path: string): string {
  const words = path
    .replace(/^\/api\/v1\/?/, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return method.toLowerCase() + (words.join('') || 'Root');
}

export async function buildOpenApiDocument(
  routes: RouteEntry[],
  opts: OpenApiOptions
): Promise<Record<string, unknown>> {
  const prefix = opts.prefix ?? '/api/v1';

  // One entry per (method, path): Hono lists a route once per handler.
  const seen = new Set<string>();
  const operations: Array<{ method: string; path: string }> = [];
  for (const r of routes) {
    if (!METHODS.has(r.method)) continue;
    if (r.path !== prefix && !r.path.startsWith(`${prefix}/`)) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    operations.push({ method: r.method, path: r.path });
  }

  const floors = opts.authEnabled
    ? await resolveFloors(routes, operations)
    : new Map<string, OperationFloor>();
  const paths: Record<string, Record<string, unknown>> = {};
  const usedIds = new Set<string>();

  for (const op of operations) {
    const { path, params } = toOpenApiPath(op.path);
    const floor = floors.get(`${op.method} ${op.path}`) ?? { role: null, mcp: false };
    const tag = op.path.slice(prefix.length).split('/').filter(Boolean)[0] ?? 'root';

    let id = operationId(op.method, op.path);
    for (let n = 2; usedIds.has(id); n++) id = `${operationId(op.method, op.path)}${n}`;
    usedIds.add(id);

    const operation: Record<string, unknown> = {
      operationId: id,
      tags: [tag],
      ...(params.length
        ? {
            parameters: params.map((name) => ({
              name,
              in: 'path',
              required: true,
              schema: { type: 'string' },
            })),
          }
        : {}),
      responses: {
        '200': { description: 'Success. Body shape: `{ success: true, data }`.' },
        default: {
          description: 'Error.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
        },
      },
    };

    if (floor.role) {
      operation.security = floor.mcp
        ? [{ agentToken: [] }, { bearerAuth: [] }, { apiKeyAuth: [] }]
        : [{ bearerAuth: [] }, { apiKeyAuth: [] }];
      operation['x-drop-min-role'] = floor.role;
    } else {
      // Deliberately NOT `security: []` — that would assert "public", and
      // several of these authenticate inside the handler.
      operation['x-drop-auth'] = 'handler';
    }

    (paths[path] ??= {})[op.method.toLowerCase()] = operation;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'DROP API',
      version: opts.version,
      description:
        'Generated from the mounted route table. `x-drop-min-role` is the role floor enforced by ' +
        'middleware; handlers may apply further checks (ownership, session-only). Operations marked ' +
        '`x-drop-auth: handler` have no middleware floor and authenticate, if at all, in the handler. ' +
        'Request and response bodies are not described.',
    },
    ...(opts.serverUrl ? { servers: [{ url: opts.serverUrl }] } : {}),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'A session JWT from POST /api/v1/auth/login, or an API key presented as a bearer token.',
        },
        apiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
        agentToken: {
          type: 'http',
          scheme: 'bearer',
          description:
            'An OAuth 2.1 access token audienced at the hosted MCP endpoint. Accepted at /api/v1/mcp ONLY; ' +
            'the general API rejects it.',
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          required: ['success', 'error'],
          properties: {
            success: { const: false },
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                details: {},
              },
            },
          },
        },
      },
    },
  };
}
