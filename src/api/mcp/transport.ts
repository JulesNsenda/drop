/**
 * Stateless Streamable HTTP bridge (PRD-040 §1).
 *
 * One McpServer + one StreamableHTTPServerTransport per request — no session
 * state is kept between calls (`sessionIdGenerator: undefined`), matching the
 * MCP SDK's documented stateless-server pattern. `@hono/node-server` exposes
 * the raw Node `IncomingMessage`/`ServerResponse` on `c.env` (`HttpBindings`);
 * the transport's `handleRequest` is handed those directly, along with the
 * JSON-RPC body already parsed by Hono — passing `parsedBody` explicitly
 * means the transport never re-reads the request stream itself, sidestepping
 * any question of whether upstream middleware already consumed it.
 *
 * Because `handleRequest` writes the response directly onto the raw
 * `ServerResponse`, the Hono handler must tell `@hono/node-server` not to
 * also write its own response for the returned `Response` object — done by
 * setting the `x-hono-already-sent` header, the adapter's documented bridge
 * for handlers that drive the raw Node response themselves.
 */

import type { Context } from 'hono';
import type { IncomingMessage, ServerResponse } from 'http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthContext } from '../middleware/auth';
import { buildMcpServer } from './tools';
import { error, ErrorCodes } from '../types';

interface NodeHttpBindings {
  incoming: IncomingMessage;
  outgoing: ServerResponse;
}

/** Tells @hono/node-server the raw `outgoing` response was already written to directly. */
const ALREADY_SENT_RESPONSE = new Response(null, {
  status: 200,
  headers: { 'x-hono-already-sent': 'true' },
});

/** JSON-RPC-shaped 405 for GET/DELETE — stateless mode has no sessions/streams to address. */
export function methodNotAllowed(c: Context): Response {
  return c.json(
    { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
    405
  );
}

/** Handle one POST /api/v1/mcp request end to end. */
export async function handleMcpRequest(c: Context): Promise<Response> {
  const bindings = c.env as Partial<NodeHttpBindings> | undefined;
  if (!bindings?.incoming || !bindings?.outgoing) {
    // No raw Node req/res available — e.g. an in-memory app.fetch()/request()
    // test harness that bypasses @hono/node-server. The transport needs a
    // real IncomingMessage/ServerResponse to stream the JSON-RPC response;
    // there is no meaningful degraded mode, so fail loudly rather than hang.
    return c.json(
      error(ErrorCodes.SERVICE_UNAVAILABLE, 'MCP transport requires the Node HTTP server adapter'),
      503
    );
  }
  const { incoming, outgoing } = bindings as NodeHttpBindings;

  let parsedBody: unknown;
  try {
    parsedBody = await c.req.json();
  } catch {
    return c.json(
      { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
      400
    );
  }

  const auth = c.get('auth') as AuthContext | undefined;
  const server = buildMcpServer(auth);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  // Stateless mode: tear the per-request server/transport down once the
  // underlying connection closes (mirrors the SDK's own stateless example).
  outgoing.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(incoming, outgoing, parsedBody);
  } catch (err) {
    console.error('[mcp] request handling failed:', err);
    if (!outgoing.headersSent) {
      outgoing.writeHead(500, { 'Content-Type': 'application/json' });
      outgoing.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error' },
          id: null,
        })
      );
    }
  }

  return ALREADY_SENT_RESPONSE;
}
