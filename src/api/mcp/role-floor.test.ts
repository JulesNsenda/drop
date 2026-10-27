/**
 * The `user` role floor on MUTATING MCP tools.
 *
 * The OAuth branch of `mcpAuthMiddleware` admits a connector grant without
 * ranking the role, so a user demoted to `readonly` after granting a connector
 * kept restart/rollback/deploy/custom_domain. The floor lives in
 * `registerTool` (tools.ts), the one place every tool is registered; these
 * tests drive the REAL registered callbacks, not the handlers directly, so a
 * tool registered with the wrong `mutating` flag is caught.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthContext } from '../middleware/auth';

jest.mock('../../managers/app/state-manager', () => ({
  getStateManager: () => ({
    getApp: () => undefined,
    getAllApps: () => [],
  }),
}));

jest.mock('../../core/git-deploy', () => ({
  getGitDeployService: () => ({
    isAvailable: () => false,
    deployFromGit: jest.fn(),
  }),
}));

import { buildMcpServer } from './tools';

const MUTATING = [
  'custom_domain',
  'deploy_files',
  'deploy_from_git',
  'redeploy_app',
  'restart_app',
  'rollback_app',
];
const READ_ONLY = ['app_logs', 'app_status', 'get_deploy_logs', 'list_apps', 'verify_deployment'];

type Cb = (...a: unknown[]) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>;

/** Register against a spy and hand back each tool's real (guarded) callback. */
function toolsFor(auth: AuthContext | undefined): Map<string, Cb> {
  const cbs = new Map<string, Cb>();
  const spy = jest
    .spyOn(McpServer.prototype, 'registerTool')
    .mockImplementation(function (this: McpServer, name: string, _config: unknown, cb: unknown) {
      cbs.set(name, cb as Cb);
      return {} as ReturnType<McpServer['registerTool']>;
    } as unknown as McpServer['registerTool']);
  try {
    buildMcpServer(auth);
  } finally {
    spy.mockRestore();
  }
  return cbs;
}

const ARGS: Record<string, unknown> = {
  custom_domain: { name: 'demo' },
  deploy_files: { name: 'demo', files: [] },
  deploy_from_git: { url: 'https://github.com/x/y' },
  redeploy_app: { name: 'demo' },
  restart_app: { name: 'demo' },
  rollback_app: { name: 'demo' },
  app_logs: { name: 'demo' },
  app_status: { name: 'demo' },
  get_deploy_logs: { deploy_id: 'nope' },
  list_apps: undefined,
  verify_deployment: { name: 'demo' },
};

const FLOOR_MESSAGE = 'requires at least the user role';

const call = async (cbs: Map<string, Cb>, name: string): Promise<string> => {
  const cb = cbs.get(name) as Cb;
  const res = ARGS[name] === undefined ? await cb({}) : await cb(ARGS[name], {});
  return (res.content ?? []).map(c => c.text ?? '').join('');
};

const principal = (role: AuthContext['role'], extra: Partial<AuthContext> = {}): AuthContext => ({
  userId: 'u1',
  username: 'bob',
  role,
  authMethod: 'oauth',
  ...extra,
});

describe('MCP mutating-tool role floor', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('classifies every registered tool (a new tool must be added to this test)', () => {
    const names = [...toolsFor(undefined).keys()].sort();
    expect(names).toEqual([...MUTATING, ...READ_ONLY].sort());
  });

  it.each(MUTATING)('refuses %s to a readonly OAuth principal', async name => {
    const cbs = toolsFor(principal('readonly'));
    expect(await call(cbs, name)).toContain(FLOOR_MESSAGE);
  });

  it.each(READ_ONLY)('still allows %s to a readonly OAuth principal', async name => {
    const cbs = toolsFor(principal('readonly'));
    expect(await call(cbs, name)).not.toContain(FLOOR_MESSAGE);
  });

  it.each([...MUTATING, ...READ_ONLY])('allows %s to a user OAuth principal', async name => {
    const cbs = toolsFor(principal('user'));
    expect(await call(cbs, name)).not.toContain(FLOOR_MESSAGE);
  });

  it.each(MUTATING)('allows %s past the floor for an admin', async name => {
    const cbs = toolsFor(principal('admin'));
    expect(await call(cbs, name)).not.toContain(FLOOR_MESSAGE);
  });

  it('refuses a principal whose role is not a recognised role', async () => {
    const cbs = toolsFor(principal('bogus' as never));
    expect(await call(cbs, 'restart_app')).toContain(FLOOR_MESSAGE);
  });

  describe('scoped agent token (role none) is governed by scopes, not rank', () => {
    const agent = principal('none', {
      authMethod: 'apikey',
      kind: 'agent',
      scopes: ['app:demo:read'],
      principalId: 'key:k1',
    });

    it.each(MUTATING)('%s is not stopped by the floor', async name => {
      const cbs = toolsFor(agent);
      expect(await call(cbs, name)).not.toContain(FLOOR_MESSAGE);
    });

    it('is still stopped by its scopes (read-only grant cannot restart)', async () => {
      const cbs = toolsFor(agent);
      const cb = cbs.get('restart_app') as Cb;
      const res = await cb({ name: 'demo' }, {});
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('not found');
    });
  });

  it('auth disabled (no principal) is unchanged', async () => {
    const cbs = toolsFor(undefined);
    expect(await call(cbs, 'restart_app')).not.toContain(FLOOR_MESSAGE);
  });
});
