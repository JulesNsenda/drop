/**
 * Audit trail for agent-token USE (Step 6f).
 *
 * Issuance was already logged; use was not. Every MCP tool call arrives as one
 * `POST /api/v1/mcp`, so the HTTP audit middleware records no tool name, no app
 * name and no principal — which meant that after a token leaked there was no
 * way to answer "which deploys were this token's". That is the exact question
 * a stable `principalId` exists to make answerable, so leaving it unrecorded
 * wasted the identity work entirely.
 */

import type { AuthContext } from '../middleware/auth';

const logged: Array<Record<string, unknown>> = [];

jest.mock('../../managers/activity', () => ({
  tryLogActivity: async (entry: Record<string, unknown>) => {
    logged.push(entry);
  },
}));

const apps = new Map<string, { name: string; userId?: string; status?: string }>();

jest.mock('../../managers/app/state-manager', () => ({
  getStateManager: () => ({
    getApp: (name: string) => apps.get(name),
    getAllApps: () => [...apps.values()],
  }),
}));

const restartApp = jest.fn().mockResolvedValue(undefined);
jest.mock('../platform-ops', () => ({
  getPlatformOps: () => ({ restartApp, isAppInProgress: () => false }),
  AppInProgressError: class extends Error {},
}));

import { handleRestartApp } from './tools';

const agentAuth: AuthContext = {
  userId: 'owner-1',
  username: 'deploy-bot',
  role: 'none',
  authMethod: 'apikey',
  scopes: ['app:mine:deploy'],
  kind: 'agent',
  principalId: 'key:token-abc',
};

const humanAuth: AuthContext = {
  userId: 'owner-1',
  username: 'alice',
  role: 'user',
  authMethod: 'jwt',
  principalId: 'jwt:owner-1',
};

describe('agent action audit', () => {
  beforeEach(() => {
    logged.length = 0;
    apps.clear();
    apps.set('mine', { name: 'mine', userId: 'owner-1', status: 'running' });
    restartApp.mockClear();
  });

  it('records WHICH CREDENTIAL acted, not just which human', async () => {
    await handleRestartApp(agentAuth, { name: 'mine' });

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      action: 'restart',
      appName: 'mine',
      userId: 'owner-1',
      principalId: 'key:token-abc',
      authMethod: 'apikey',
    });
  });

  it('distinguishes agent traffic from the SAME human acting directly', async () => {
    // The load-bearing assertion. Both entries carry userId 'owner-1', so
    // userId alone cannot separate them — which is precisely why an incident
    // could not attribute a leaked token's actions.
    await handleRestartApp(agentAuth, { name: 'mine' });
    await handleRestartApp(humanAuth, { name: 'mine' });

    expect(logged.map((e) => e.userId)).toEqual(['owner-1', 'owner-1']);
    expect(logged.map((e) => e.principalId)).toEqual(['key:token-abc', 'jwt:owner-1']);
  });

  it('names the app and the tool, which the HTTP audit cannot see', async () => {
    // Every tool call is one POST /api/v1/mcp to the middleware.
    await handleRestartApp(agentAuth, { name: 'mine' });

    expect(logged[0].appName).toBe('mine');
    expect(logged[0].detail).toContain('restart_app');
  });

  it('records nothing when the action was refused', async () => {
    // A refused call did not happen; logging it would make the trail claim
    // otherwise, and would let an unauthorized caller write audit noise.
    await handleRestartApp({ ...agentAuth, scopes: ['app:other:deploy'] }, { name: 'mine' });

    expect(restartApp).not.toHaveBeenCalled();
    expect(logged).toHaveLength(0);
  });
});
