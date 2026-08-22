/**
 * Integration (proof-of-life) test for the hosted MCP endpoint (PRD-040).
 *
 * Starts a REAL ApiServer bound to a real TCP port via @hono/node-server
 * (auth disabled), then connects with the MCP SDK's own `Client` +
 * `StreamableHTTPClientTransport` — this is the arbiter that the raw
 * Node req/res transport bridge in transport.ts actually works end to end,
 * not just that it type-checks. Services are mocked/seeded at the singleton
 * layer the same way the REST route tests do.
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { ApiServer } from '../server';
import { getStateManager, resetStateManager } from '../../managers/app/state-manager';
import { setPlatformOps, resetPlatformOps, PlatformOps } from '../platform-ops';
import { makePlatformOpsStub } from '../__testutils__/platform-ops';
import { resetRateLimits } from '../middleware/rate-limit';
import { resetUploadPreflightState } from '../upload-preflight';

const PORT = 39471;
const MCP_URL = `http://127.0.0.1:${PORT}/api/v1/mcp`;

// Delegates to the shared stub rather than hand-rolling the object: this copy
// broke on three separate PlatformOps additions, which is exactly what
// `__testutils__/platform-ops.ts` exists to prevent. The overrides below keep
// this suite's own deliberate defaults.
function makeOps(overrides?: Partial<PlatformOps>): PlatformOps {
  return makePlatformOpsStub({
    restartApp: jest.fn(),
    attachService: jest.fn(),
    detachService: jest.fn(),
    getServiceIntent: jest.fn(),
    promoteApp: jest.fn(),
    ...overrides,
  });
}

describe('Hosted MCP endpoint (integration)', () => {
  let tempDir: string;
  let server: ApiServer;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'drop-mcp-integration-test-'));
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();

    resetRateLimits();
    resetStateManager();
    resetPlatformOps();
    resetUploadPreflightState();

    getStateManager({ stateFilePath: path.join(tempDir, 'apps.json') });
    await getStateManager().registerApp('demo-app', path.join(tempDir, 'demo-app'));
    setPlatformOps(makeOps());

    server = new ApiServer({ port: PORT, host: '127.0.0.1', enableAuth: false });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    resetPlatformOps();
    resetUploadPreflightState();
    await getStateManager().close();
    resetStateManager();
    jest.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('lists exactly the 7 MCP tools', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const names = tools.map(t => t.name).sort();
      expect(names).toEqual(
        [
          'app_logs',
          'app_status',
          'deploy_files',
          'deploy_from_git',
          'get_deploy_logs',
          'list_apps',
          'restart_app',
        ].sort()
      );
    } finally {
      await client.close();
    }
  });

  it('round-trips a list_apps call end to end', async () => {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: 'list_apps', arguments: {} });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.text).toContain('demo-app');
    } finally {
      await client.close();
    }
  });

  it('405s a raw GET request (stateless mode has no sessions/streams to address)', async () => {
    const res = await fetch(MCP_URL);
    expect(res.status).toBe(405);
    const body = (await res.json()) as { jsonrpc: string };
    expect(body).toMatchObject({ jsonrpc: '2.0' });
  });
});
